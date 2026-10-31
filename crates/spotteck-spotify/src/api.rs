//! A small client for `https://api.spotify.com/v1`: bearer token, one retry after a
//! refresh on 401, failures reduced to [`Failure`]. Tokens and responses are never logged.

use crate::auth::{self, AuthError, Tokens};
use crate::engine::CredentialStore;
use reqwest::header::{CONTENT_LENGTH, RETRY_AFTER};
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde_json::Value;
use spotteck_core::webapi::Failure;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub(crate) const API: &str = "https://api.spotify.com/v1";
const TIMEOUT: Duration = Duration::from_secs(12);

pub(crate) struct Api {
    http: reqwest::Client,
    store: Arc<dyn CredentialStore>,
    /// `None` = not loaded from the keychain yet; `Some(None)` = signed out.
    tokens: Mutex<Option<Option<Tokens>>>,
    refreshing: tokio::sync::Mutex<()>,
}

impl Api {
    pub fn new(store: Arc<dyn CredentialStore>) -> Api {
        let http = reqwest::Client::builder()
            .user_agent(concat!("Spotteck/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default();
        Api { http, store, tokens: Mutex::new(None), refreshing: tokio::sync::Mutex::new(()) }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// The saved login. A blob that isn't ours (e.g. the credentials Spotteck 2 kept) is
    /// deleted, so the user simply signs in again.
    pub fn tokens(&self) -> Option<Tokens> {
        let mut cached = self.tokens.lock().unwrap();
        if cached.is_none() {
            let loaded = self.store.load().and_then(|saved| match serde_json::from_str::<Tokens>(&saved) {
                Ok(tokens) => Some(tokens),
                Err(_) => {
                    self.store.delete();
                    None
                }
            });
            *cached = Some(loaded);
        }
        cached.clone().flatten()
    }

    pub fn set_tokens(&self, tokens: Tokens) {
        match serde_json::to_string(&tokens) {
            Ok(secret) => {
                if let Err(e) = self.store.save(&secret) {
                    log::warn!("Could not save the Spotify login: {e}");
                }
            }
            Err(_) => log::warn!("Could not encode the Spotify login"),
        }
        *self.tokens.lock().unwrap() = Some(Some(tokens));
    }

    pub fn clear(&self) {
        self.store.delete();
        *self.tokens.lock().unwrap() = Some(None);
    }

    /// A valid access token. `stale` is a token Spotify just refused, which forces a refresh
    /// unless another request already replaced it.
    async fn access_token(&self, stale: Option<&str>) -> Result<String, Failure> {
        let usable = |t: &Tokens| t.fresh() && stale != Some(t.access_token.as_str());
        let current = self.tokens().ok_or(Failure::SignedOut)?;
        if usable(&current) {
            return Ok(current.access_token);
        }
        let _single_flight = self.refreshing.lock().await;
        let current = self.tokens().ok_or(Failure::SignedOut)?;
        if usable(&current) {
            return Ok(current.access_token);
        }
        match auth::refresh(&self.http, &current).await {
            Ok(tokens) => {
                // Logged out or switched account while refreshing: drop the result.
                if self.tokens().is_some_and(|t| t.refresh_token == current.refresh_token) {
                    let access = tokens.access_token.clone();
                    self.set_tokens(tokens);
                    Ok(access)
                } else {
                    Err(Failure::SignedOut)
                }
            }
            Err(AuthError::Rejected) => {
                self.clear();
                Err(Failure::SignedOut)
            }
            Err(AuthError::Transient) => Err(Failure::Transient),
        }
    }

    fn url(path: &str) -> Result<String, Failure> {
        if path.starts_with('/') {
            Ok(format!("{API}{path}"))
        } else if path.starts_with(&format!("{API}/")) {
            // `next` links of paged lists.
            Ok(path.to_owned())
        } else {
            Err(Failure::NotFound)
        }
    }

    /// Sends one request. `Ok(None)` is an empty answer (204, or 2xx without a body).
    pub async fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<Option<Vec<u8>>, Failure> {
        let url = Self::url(path)?;
        let mut token = self.access_token(None).await?;
        for attempt in 0..2 {
            let mut request = self.http.request(method.clone(), &url).bearer_auth(&token).query(query).timeout(TIMEOUT);
            request = match body {
                Some(json) => request.json(json),
                // The player endpoints answer 411 to a PUT/POST without Content-Length.
                None if method != Method::GET => request.header(CONTENT_LENGTH, 0).body(Vec::new()),
                None => request,
            };
            let response = request.send().await.map_err(|_| Failure::Transient)?;
            let status = response.status().as_u16();
            let retry_after = response.headers().get(RETRY_AFTER).and_then(|v| v.to_str().ok()?.trim().parse().ok());
            let bytes = response.bytes().await.map_err(|_| Failure::Transient)?;
            if (200..300).contains(&status) {
                return Ok((status != 204 && !bytes.is_empty()).then(|| bytes.to_vec()));
            }
            if status == 401 && attempt == 0 {
                token = self.access_token(Some(&token)).await?;
                continue;
            }
            return Err(Failure::from_response(status, &bytes, retry_after));
        }
        Err(Failure::SignedOut)
    }

    /// `GET` and decode. `Ok(None)` when Spotify answered with no content.
    pub async fn get<T: DeserializeOwned>(&self, path: &str, query: &[(&str, String)]) -> Result<Option<T>, Failure> {
        match self.request(Method::GET, path, query, None).await? {
            Some(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| {
                log::warn!("Unexpected Web API response for {}: {e}", path.split('?').next().unwrap_or(path));
                Failure::Transient
            }),
            None => Ok(None),
        }
    }

    /// An unauthenticated official endpoint (oEmbed).
    pub async fn public_get<T: DeserializeOwned>(&self, url: &str) -> Option<T> {
        let response = self.http.get(url).timeout(TIMEOUT).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.json().await.ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_api_urls_are_requested() {
        assert_eq!(Api::url("/me").unwrap(), "https://api.spotify.com/v1/me");
        let next = "https://api.spotify.com/v1/me/playlists?offset=50&limit=50";
        assert_eq!(Api::url(next).unwrap(), next);
        assert!(Api::url("https://example.com/v1/me").is_err());
        assert!(Api::url("https://api.spotify.com.evil/v1/me").is_err());
    }
}
