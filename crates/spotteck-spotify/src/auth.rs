//! The official Spotify login: Authorization Code with PKCE in the user's browser, with the
//! user's own Client ID, and the token refresh. Tokens are never logged.

use serde::{Deserialize, Serialize};
use spotteck_core::pkce::{parse_callback, Callback, Pkce, REDIRECT_PORT, REDIRECT_URI, TOKEN_URL};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const PAGE: &str = r#"<!doctype html><html lang="it"><meta charset="utf-8"><title>Spotteck</title>
<body style="font:15px -apple-system,sans-serif;background:#141413;color:#eee;display:grid;place-items:center;height:90vh">
<p>{message}</p></body></html>"#;

/// The saved login, stored as JSON in the system keychain.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Tokens {
    pub client_id: String,
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds.
    pub expires_at: u64,
}

impl Tokens {
    /// Valid for at least another minute.
    pub fn fresh(&self) -> bool {
        self.expires_at > now() + 60
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AuthError {
    /// Spotify refused the code or the refresh token: sign in again.
    Rejected,
    Transient,
}

async fn token_request(
    http: &reqwest::Client,
    form: &[(&str, &str)],
    client_id: &str,
    previous_refresh: Option<&str>,
) -> Result<Tokens, AuthError> {
    let response = http
        .post(TOKEN_URL)
        .form(form)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| AuthError::Transient)?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(if matches!(status, 400 | 401) { AuthError::Rejected } else { AuthError::Transient });
    }
    let data: TokenResponse = response.json().await.map_err(|_| AuthError::Transient)?;
    let refresh_token =
        data.refresh_token.or_else(|| previous_refresh.map(str::to_owned)).ok_or(AuthError::Rejected)?;
    Ok(Tokens {
        client_id: client_id.to_owned(),
        access_token: data.access_token,
        refresh_token,
        expires_at: now() + data.expires_in.max(60),
    })
}

pub(crate) async fn refresh(http: &reqwest::Client, tokens: &Tokens) -> Result<Tokens, AuthError> {
    token_request(
        http,
        &[("grant_type", "refresh_token"), ("refresh_token", &tokens.refresh_token), ("client_id", &tokens.client_id)],
        &tokens.client_id,
        Some(&tokens.refresh_token),
    )
    .await
}

async fn bind() -> Result<TcpListener, String> {
    // A login that was just cancelled may still hold the port for a moment.
    for _ in 0..10 {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", REDIRECT_PORT)).await {
            return Ok(listener);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    Err(format!("La porta {REDIRECT_PORT} per l’accesso è occupata: chiudi l’altra app che la usa e riprova."))
}

async fn respond(mut socket: TcpStream, status: &str, message: &str) {
    let body = PAGE.replace("{message}", message);
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}

async fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String, String> {
    loop {
        let Ok((mut socket, _)) = listener.accept().await else { continue };
        let mut buffer = vec![0u8; 8192];
        let read = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut buffer)).await;
        let Ok(Ok(n)) = read else { continue };
        let request = String::from_utf8_lossy(&buffer[..n]);
        let target = request.split_whitespace().nth(1).unwrap_or_default();
        match parse_callback(target, state) {
            Callback::Code(code) => {
                respond(socket, "200 OK", "Accesso completato. Puoi chiudere questa scheda e tornare a Spotteck.")
                    .await;
                return Ok(code);
            }
            Callback::Denied(reason) => {
                respond(socket, "200 OK", "Accesso annullato. Puoi tornare a Spotteck.").await;
                return Err(if reason == "access_denied" {
                    "Accesso a Spotify annullato.".into()
                } else {
                    "Spotify ha rifiutato l’accesso: controlla il Client ID e il Redirect URI della tua app.".into()
                });
            }
            Callback::Ignored => respond(socket, "404 Not Found", "Pagina non trovata.").await,
        }
    }
}

/// Opens the Spotify login in the browser and waits for the user to finish it.
pub(crate) async fn authorize(http: &reqwest::Client, client_id: &str) -> Result<Tokens, String> {
    let pkce = Pkce::new();
    let listener = bind().await?;
    open::that_detached(pkce.authorize_url(client_id)).map_err(|_| "Impossibile aprire il browser.".to_owned())?;
    let code = tokio::time::timeout(LOGIN_TIMEOUT, wait_for_code(&listener, &pkce.state))
        .await
        .map_err(|_| "Accesso scaduto: completa il login nel browser entro cinque minuti.".to_owned())??;
    drop(listener);
    token_request(
        http,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", client_id),
            ("code_verifier", &pkce.verifier),
        ],
        client_id,
        None,
    )
    .await
    .map_err(|e| match e {
        AuthError::Rejected => {
            "Spotify ha rifiutato l’accesso: controlla il Client ID e il Redirect URI della tua app.".into()
        }
        AuthError::Transient => "Spotify non è raggiungibile. Controlla la connessione e riprova.".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn freshness_leaves_a_minute_of_margin() {
        let mut tokens = Tokens {
            client_id: "c".into(),
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: now() + 30,
        };
        assert!(!tokens.fresh());
        tokens.expires_at = now() + 3600;
        assert!(tokens.fresh());
    }

    #[test]
    fn spotteck_2_logins_do_not_parse_as_tokens() {
        let v2 = r#"{"username":"u","auth_type":1,"auth_data":"AAAA"}"#;
        assert!(serde_json::from_str::<Tokens>(v2).is_err());
    }

    #[tokio::test]
    async fn the_loopback_listener_returns_the_code_and_ignores_strays() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = tokio::spawn(async move {
            for target in ["/favicon.ico", "/callback?code=c0de&state=forged", "/callback?code=c0de&state=s1"] {
                let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                socket.write_all(format!("GET {target} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await.unwrap();
                let mut reply = String::new();
                socket.read_to_string(&mut reply).await.unwrap();
                assert!(reply.starts_with("HTTP/1.1 "));
            }
        });
        assert_eq!(wait_for_code(&listener, "s1").await.unwrap(), "c0de");
        client.await.unwrap();
    }
}
