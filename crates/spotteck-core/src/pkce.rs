//! Authorization Code with PKCE (RFC 7636), the official Spotify login for apps that can't
//! keep a client secret. Only the user's own Client ID is needed.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sha2::{Digest, Sha256};

/// Where the browser returns after the login. Each user registers exactly this URI in their
/// Spotify developer app (loopback addresses must be literal IPs).
pub const REDIRECT_URI: &str = "http://127.0.0.1:43821/callback";
pub const REDIRECT_PORT: u16 = 43821;
pub const AUTHORIZE_URL: &str = "https://accounts.spotify.com/authorize";
pub const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
/// Reading the account and plan, reading and controlling playback, listing the user's playlists.
pub const SCOPES: &str = "user-read-private user-read-playback-state user-modify-playback-state \
user-read-currently-playing playlist-read-private playlist-read-collaborative";

fn random_url_safe(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).expect("system random source");
    URL_SAFE_NO_PAD.encode(buffer)
}

/// One login attempt: the secret verifier, its challenge and the anti-CSRF state.
#[derive(Clone, Debug)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

impl Pkce {
    pub fn new() -> Pkce {
        // 48 random bytes → 64 characters, inside the 43–128 range RFC 7636 requires.
        let verifier = random_url_safe(48);
        Pkce { challenge: challenge(&verifier), verifier, state: random_url_safe(24) }
    }

    /// The `accounts.spotify.com/authorize` URL to open in the browser.
    pub fn authorize_url(&self, client_id: &str) -> String {
        let query = [
            ("client_id", client_id),
            ("response_type", "code"),
            ("redirect_uri", REDIRECT_URI),
            ("scope", SCOPES),
            ("state", &self.state),
            ("code_challenge_method", "S256"),
            ("code_challenge", &self.challenge),
            // Lets "Cambia Account" pick another account instead of reusing the last one.
            ("show_dialog", "true"),
        ]
        .iter()
        .map(|(k, v)| format!("{k}={}", encode(v)))
        .collect::<Vec<_>>()
        .join("&");
        format!("{AUTHORIZE_URL}?{query}")
    }
}

impl Default for Pkce {
    fn default() -> Self {
        Pkce::new()
    }
}

pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// A Client ID as shown in the Spotify developer dashboard: 32 hexadecimal characters.
pub fn is_client_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Percent-encoding for query values (RFC 3986 unreserved characters pass through).
pub fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let escaped = (bytes[i] == b'%')
            .then(|| value.get(i + 1..i + 3))
            .flatten()
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match (bytes[i], escaped) {
            (_, Some(byte)) => {
                out.push(byte);
                i += 3;
                continue;
            }
            (b'+', None) => out.push(b' '),
            (byte, None) => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What the browser brought back to the loopback redirect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Callback {
    Code(String),
    /// The user refused, or Spotify reported an error (e.g. a wrong redirect URI).
    Denied(String),
    /// Not our callback (a favicon request, a stale tab, a forged state).
    Ignored,
}

/// Parses the request target of `GET /callback?code=…&state=…`.
pub fn parse_callback(target: &str, expected_state: &str) -> Callback {
    let Some((path, query)) = target.split_once('?') else {
        return Callback::Ignored;
    };
    if path != "/callback" {
        return Callback::Ignored;
    }
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match key {
            "code" => code = Some(decode(value)),
            "state" => state = Some(decode(value)),
            "error" => error = Some(decode(value)),
            _ => {}
        }
    }
    if state.as_deref() != Some(expected_state) {
        return Callback::Ignored;
    }
    match (code, error) {
        (Some(code), None) if !code.is_empty() => Callback::Code(code),
        (_, Some(error)) => Callback::Denied(error),
        _ => Callback::Denied("missing_code".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_matches_rfc_7636_appendix_b() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn new_attempts_are_random_and_well_formed() {
        let a = Pkce::new();
        let b = Pkce::new();
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(a.state, b.state);
        assert!((43..=128).contains(&a.verifier.len()));
        assert_eq!(a.challenge, challenge(&a.verifier));
    }

    #[test]
    fn authorize_url_carries_the_users_client_id_and_scopes() {
        let pkce = Pkce::new();
        let url = pkce.authorize_url("0123456789abcdef0123456789abcdef");
        assert!(url.starts_with("https://accounts.spotify.com/authorize?client_id=0123456789abcdef0123456789abcdef&"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A43821%2Fcallback"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("user-modify-playback-state"));
        assert!(!url.contains(' '));
    }

    #[test]
    fn client_ids_are_32_hex_characters() {
        assert!(is_client_id("0123456789abcdef0123456789ABCDEF"));
        assert!(!is_client_id("0123456789abcdef"));
        assert!(!is_client_id("0123456789abcdef0123456789abcdeg"));
    }

    #[test]
    fn callbacks_need_the_right_path_and_state() {
        assert_eq!(parse_callback("/callback?code=abc%2Fd&state=s1", "s1"), Callback::Code("abc/d".into()));
        assert_eq!(
            parse_callback("/callback?error=access_denied&state=s1", "s1"),
            Callback::Denied("access_denied".into())
        );
        assert_eq!(parse_callback("/callback?code=abc&state=forged", "s1"), Callback::Ignored);
        assert_eq!(parse_callback("/favicon.ico", "s1"), Callback::Ignored);
        assert_eq!(parse_callback("/other?code=abc&state=s1", "s1"), Callback::Ignored);
        assert_eq!(parse_callback("/callback?state=s1", "s1"), Callback::Denied("missing_code".into()));
    }

    #[test]
    fn percent_decoding_tolerates_broken_escapes() {
        assert_eq!(decode("a%zzb%4"), "a%zzb%4");
        assert_eq!(decode("a+b%20c"), "a b c");
    }
}
