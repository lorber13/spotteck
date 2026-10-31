//! Spotteck as a remote control for the user's own Spotify apps, through the official Web
//! API. It polls the playback state, sends commands to the active Spotify Connect device
//! and keeps the account readiness. Every async path captures the account generation and
//! drops its result if the user logged out or switched account meanwhile.

use crate::api::Api;
use crate::auth;
use crate::library::Library;
use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};
use spotteck_core::library::{PlaylistEntry, TrackEntry};
use spotteck_core::readiness::{Backoff, Generation, Readiness};
use spotteck_core::state::{clamp_percent, Payload, PlayerState, Update};
use spotteck_core::uri::{playlist_id_of, playlist_uri, track_id_of, track_uri};
use spotteck_core::webapi::{pick_cover, pick_device, Devices, Failure, Me, Playback};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, Notify};

const NOTHING_PLAYING: &str = "Nessuna riproduzione attiva su Spotify: avvia una playlist.";
/// Polling while something plays; the UI interpolates the position in between.
const PLAYING_POLL: Duration = Duration::from_secs(1);
const IDLE_POLL: Duration = Duration::from_secs(4);
/// Spotify needs a moment before `GET /me/player` reflects a command.
const SETTLE: Duration = Duration::from_millis(700);

/// Where the saved login is kept (the system keychain in the app).
pub trait CredentialStore: Send + Sync {
    fn load(&self) -> Option<String>;
    fn save(&self, secret: &str) -> Result<(), String>;
    fn delete(&self);
}

pub struct EngineConfig {
    /// The name of this computer, used to prefer Spotify on this computer when no device
    /// is active.
    pub computer_name: String,
    /// The Client ID of the user's own Spotify developer app, if configured.
    pub client_id: Box<dyn Fn() -> Option<String> + Send + Sync>,
    pub credentials: Arc<dyn CredentialStore>,
    pub on_state: Box<dyn Fn(Payload) + Send + Sync>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Profile {
    pub name: String,
    pub product: String,
    pub avatar: String,
}

#[derive(Clone)]
pub struct Engine(Arc<Inner>);

struct Inner {
    config: EngineConfig,
    state: Mutex<PlayerState>,
    generation: Generation,
    api: Api,
    library: Library,
    wake: Notify,
    profile: Mutex<Option<Profile>>,
    logging_in: AtomicBool,
    cancel_login: Mutex<Option<oneshot::Sender<()>>>,
}

fn capitalize(product: &str) -> String {
    let mut chars = product.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

fn profile_of(me: &Me) -> Profile {
    Profile {
        name: me.display_name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| me.id.clone()),
        product: match me.product.as_deref() {
            None | Some("premium") => "Premium".into(),
            Some(other) => capitalize(other),
        },
        avatar: pick_cover(&me.images),
    }
}

impl Engine {
    pub fn new(config: EngineConfig) -> Engine {
        let api = Api::new(config.credentials.clone());
        Engine(Arc::new(Inner {
            config,
            state: Mutex::new(PlayerState::default()),
            generation: Generation::default(),
            api,
            library: Library::default(),
            wake: Notify::new(),
            profile: Mutex::new(None),
            logging_in: AtomicBool::new(false),
            cancel_login: Mutex::new(None),
        }))
    }

    pub fn payload(&self) -> Payload {
        self.0.state.lock().unwrap().payload(Instant::now())
    }

    pub fn readiness(&self) -> Readiness {
        self.0.state.lock().unwrap().readiness.clone()
    }

    fn notify(&self) {
        let payload = self.payload();
        (self.0.config.on_state)(payload);
    }

    /// Applies `f` if `epoch` is still current, and tells the UI when anything changed.
    fn update(&self, epoch: u64, f: impl FnOnce(&mut PlayerState)) {
        if !self.0.generation.is_current(epoch) {
            return;
        }
        let changed = {
            let mut state = self.0.state.lock().unwrap();
            let now = Instant::now();
            let before = state.payload(now);
            f(&mut state);
            state.payload(now) != before
        };
        if changed {
            self.notify();
        }
    }

    fn set_readiness(&self, epoch: u64, readiness: Readiness) {
        self.update(epoch, |s| s.readiness = readiness);
    }

    /// The readiness before any request: no Client ID, no saved login, or a login made with
    /// another Client ID.
    fn offline_readiness(&self) -> Readiness {
        let Some(client_id) = (self.0.config.client_id)() else {
            return Readiness::NeedsClientId;
        };
        match self.0.api.tokens() {
            Some(tokens) if tokens.client_id.eq_ignore_ascii_case(&client_id) => Readiness::Connecting,
            Some(_) => {
                self.0.api.clear();
                Readiness::SignedOut
            }
            None => Readiness::SignedOut,
        }
    }

    /// Restores the saved login and starts following playback. Called once at startup.
    pub fn start(&self) {
        let epoch = self.0.generation.current();
        let readiness = self.offline_readiness();
        self.set_readiness(epoch, readiness);
        let engine = self.clone();
        tokio::spawn(async move { engine.run().await });
    }

    /// The user saved another Client ID: the old login belongs to the old app.
    pub fn client_id_changed(&self) {
        self.logout();
    }

    fn cancel_login(&self) {
        if let Some(cancel) = self.0.cancel_login.lock().unwrap().take() {
            let _ = cancel.send(());
        }
    }

    fn forget_account(&self) {
        self.0.library.clear();
        *self.0.profile.lock().unwrap() = None;
    }

    /// Browser login. Returns once the account is checked, or with an Italian error.
    pub async fn login(&self) -> Result<(), String> {
        let Some(client_id) = (self.0.config.client_id)() else {
            return Err(Readiness::NeedsClientId.message().into());
        };
        let epoch = self.0.generation.bump();
        self.cancel_login();
        let (cancel, cancelled) = oneshot::channel();
        *self.0.cancel_login.lock().unwrap() = Some(cancel);
        self.0.logging_in.store(true, Ordering::Release);
        self.forget_account();
        self.0.state.lock().unwrap().reset(Readiness::Connecting);
        self.notify();

        let result = tokio::select! {
            result = auth::authorize(self.0.api.http(), &client_id) => result,
            _ = cancelled => Err("Accesso annullato.".to_owned()),
        };
        if !self.0.generation.is_current(epoch) {
            return Err("Accesso annullato.".into());
        }
        self.0.logging_in.store(false, Ordering::Release);
        *self.0.cancel_login.lock().unwrap() = None;
        match result {
            Ok(tokens) => {
                self.0.api.set_tokens(tokens);
                // Connected, or a definite answer (e.g. Free plan): either way the loop takes over.
                let connected = self.connect(epoch).await;
                self.0.wake.notify_one();
                match self.readiness() {
                    Readiness::Ready => Ok(()),
                    _ if connected.is_err() => Err(Failure::Transient.message()),
                    other => Err(other.message().into()),
                }
            }
            Err(error) => {
                // The previous login, if any, stays valid and reconnects.
                let readiness = self.offline_readiness();
                self.set_readiness(epoch, readiness);
                self.0.wake.notify_one();
                Err(error)
            }
        }
    }

    /// Forgets the saved login and the library cache. Playback on the user's devices goes on.
    pub fn logout(&self) {
        self.0.generation.bump();
        self.cancel_login();
        self.0.logging_in.store(false, Ordering::Release);
        self.0.api.clear();
        self.forget_account();
        let readiness = self.offline_readiness();
        self.0.state.lock().unwrap().reset(readiness);
        self.notify();
        self.0.wake.notify_one();
    }

    /// Called when the app quits: abandons a login waiting in the browser.
    pub fn disconnect(&self) {
        self.cancel_login();
    }

    async fn run(self) {
        let mut backoff = Backoff::default();
        loop {
            let epoch = self.0.generation.current();
            let delay = match self.readiness() {
                Readiness::Connecting if !self.0.logging_in.load(Ordering::Acquire) => {
                    match self.connect(epoch).await {
                        Ok(()) => {
                            backoff.reset();
                            Duration::ZERO
                        }
                        Err(()) => backoff.next_delay(),
                    }
                }
                Readiness::Ready => self.poll(epoch).await,
                _ => IDLE_POLL,
            };
            if delay > Duration::ZERO {
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = self.0.wake.notified() => {}
                }
            }
        }
    }

    /// Checks the account with `GET /me`. `Err` means "try again later".
    async fn connect(&self, epoch: u64) -> Result<(), ()> {
        match self.0.api.get::<Me>("/me", &[]).await {
            Ok(Some(me)) => {
                if self.0.generation.is_current(epoch) {
                    *self.0.profile.lock().unwrap() = Some(profile_of(&me));
                }
                self.set_readiness(epoch, Readiness::from_product(me.product.as_deref()));
                Ok(())
            }
            Err(Failure::SignedOut) => {
                self.set_readiness(epoch, Readiness::SignedOut);
                Ok(())
            }
            Err(Failure::PremiumRequired) => {
                self.set_readiness(epoch, Readiness::PlanUnsupported);
                Ok(())
            }
            Ok(None) | Err(_) => Err(()),
        }
    }

    /// One `GET /me/player`. Returns how long to wait before the next one.
    async fn poll(&self, epoch: u64) -> Duration {
        let query = [("additional_types", "episode".to_owned())];
        let updates = match self.0.api.get::<Playback>("/me/player", &query).await {
            Ok(Some(playback)) => playback.updates(),
            Ok(None) => vec![Update::Stopped],
            Err(Failure::RateLimited(wait)) => return wait,
            Err(failure) => {
                self.on_failure(epoch, &failure);
                return IDLE_POLL;
            }
        };
        let now = Instant::now();
        self.update(epoch, |s| {
            for update in updates {
                s.apply(update, now);
            }
        });
        if self.0.state.lock().unwrap().playing {
            PLAYING_POLL
        } else {
            IDLE_POLL
        }
    }

    /// Account-level consequences of a failed request; returns the text for the UI.
    fn on_failure(&self, epoch: u64, failure: &Failure) -> String {
        match failure {
            Failure::SignedOut => {
                self.0.api.clear();
                self.set_readiness(epoch, Readiness::SignedOut);
            }
            Failure::PremiumRequired => self.set_readiness(epoch, Readiness::PlanUnsupported),
            _ => {}
        }
        failure.message()
    }

    /// Polls again shortly, once Spotify has applied the command.
    fn settle(&self) {
        let engine = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(SETTLE).await;
            engine.0.wake.notify_one();
        });
    }

    fn gate(&self) -> Result<u64, String> {
        self.readiness().gate()?;
        Ok(self.0.generation.current())
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<(), Failure> {
        self.0.api.request(method, path, query, body.as_ref()).await.map(|_| ())
    }

    /// The device to wake up when none is active (Spotify on this computer first).
    async fn pick_device(&self, epoch: u64) -> Result<String, String> {
        let devices = match self.0.api.get::<Devices>("/me/player/devices", &[]).await {
            Ok(devices) => devices.unwrap_or_default(),
            Err(failure) => return Err(self.on_failure(epoch, &failure)),
        };
        pick_device(&devices.devices, &self.0.config.computer_name)
            .and_then(|d| d.id.clone())
            .ok_or_else(|| Failure::NoActiveDevice.message())
    }

    /// Plays or pauses. With no active device, playback resumes on Spotify on this
    /// computer (or the user's other Spotify app).
    pub async fn play_pause(&self) -> Result<(), String> {
        let epoch = self.gate()?;
        let playing = self.0.state.lock().unwrap().playing;
        let path = if playing { "/me/player/pause" } else { "/me/player/play" };
        match self.send(Method::PUT, path, &[], None).await {
            Ok(()) => {}
            Err(Failure::NoActiveDevice) if !playing => {
                let device = self.pick_device(epoch).await?;
                let body = json!({ "device_ids": [device], "play": true });
                self.send(Method::PUT, "/me/player", &[], Some(body)).await.map_err(|f| self.on_failure(epoch, &f))?;
            }
            Err(failure) => return Err(self.on_failure(epoch, &failure)),
        }
        let now = Instant::now();
        self.update(epoch, |s| {
            if s.active {
                let position_ms = s.position_ms(now);
                s.apply(if playing { Update::Paused { position_ms } } else { Update::Playing { position_ms } }, now);
            }
        });
        self.settle();
        Ok(())
    }

    async fn transport(&self, method: Method, path: &str, query: &[(&str, String)]) -> Result<u64, String> {
        let epoch = self.gate()?;
        match self.send(method, path, query, None).await {
            Ok(()) => {
                self.settle();
                Ok(epoch)
            }
            Err(Failure::NoActiveDevice) => Err(NOTHING_PLAYING.into()),
            Err(failure) => Err(self.on_failure(epoch, &failure)),
        }
    }

    pub async fn next(&self) -> Result<(), String> {
        self.transport(Method::POST, "/me/player/next", &[]).await.map(|_| ())
    }

    pub async fn prev(&self) -> Result<(), String> {
        self.transport(Method::POST, "/me/player/previous", &[]).await.map(|_| ())
    }

    pub async fn seek(&self, seconds: f64) -> Result<(), String> {
        let ms = if seconds.is_finite() { (seconds.max(0.0) * 1000.0).min(f64::from(u32::MAX)) as u32 } else { 0 };
        let epoch = self.transport(Method::PUT, "/me/player/seek", &[("position_ms", ms.to_string())]).await?;
        self.update(epoch, |s| s.apply(Update::Position { position_ms: ms }, Instant::now()));
        Ok(())
    }

    /// 0–100, on the device that is playing.
    pub async fn set_volume(&self, percent: f64) -> Result<(), String> {
        let epoch = self.gate()?;
        let volume = clamp_percent(percent);
        if self.0.state.lock().unwrap().active {
            match self.send(Method::PUT, "/me/player/volume", &[("volume_percent", volume.to_string())], None).await {
                Ok(()) | Err(Failure::NoActiveDevice) => {}
                Err(failure) => return Err(self.on_failure(epoch, &failure)),
            }
        }
        self.update(epoch, |s| s.apply(Update::Volume(volume), Instant::now()));
        self.settle();
        Ok(())
    }

    /// Takes effect on the playing device, or when the next playlist starts.
    pub async fn set_shuffle(&self, shuffle: bool) -> Result<(), String> {
        let epoch = self.gate()?;
        if self.0.state.lock().unwrap().active {
            match self.send(Method::PUT, "/me/player/shuffle", &[("state", shuffle.to_string())], None).await {
                Ok(()) | Err(Failure::NoActiveDevice) => {}
                Err(failure) => return Err(self.on_failure(epoch, &failure)),
            }
        }
        self.update(epoch, |s| s.apply(Update::Shuffle(shuffle), Instant::now()));
        self.settle();
        Ok(())
    }

    /// Starts a playlist, from `track` if given, on the active device (or wakes one up).
    pub async fn play(&self, context: &str, track: Option<&str>) -> Result<(), String> {
        let epoch = self.gate()?;
        let context = playlist_id_of(context).map(|id| playlist_uri(&id)).ok_or("Playlist non valida.")?;
        let mut body = json!({ "context_uri": context });
        if let Some(t) = track {
            body["offset"] = json!({ "uri": track_uri(&track_id_of(t).ok_or("Brano non valido.")?) });
        }
        let mut query = Vec::new();
        match self.send(Method::PUT, "/me/player/play", &query, Some(body.clone())).await {
            Ok(()) => {}
            Err(Failure::NoActiveDevice) => {
                query.push(("device_id", self.pick_device(epoch).await?));
                self.send(Method::PUT, "/me/player/play", &query, Some(body))
                    .await
                    .map_err(|f| self.on_failure(epoch, &f))?;
            }
            Err(failure) => return Err(self.on_failure(epoch, &failure)),
        }
        // Spotteck's shuffle switch applies to the playlist it starts.
        let shuffle = self.0.state.lock().unwrap().shuffling;
        query.push(("state", shuffle.to_string()));
        if let Err(failure) = self.send(Method::PUT, "/me/player/shuffle", &query, None).await {
            log::info!("Shuffle not applied: {failure:?}");
        }
        self.update(epoch, |s| s.apply(Update::Context(context), Instant::now()));
        self.settle();
        Ok(())
    }

    pub async fn profile(&self) -> Option<Profile> {
        if let Some(profile) = self.0.profile.lock().unwrap().clone() {
            return Some(profile);
        }
        let epoch = self.0.generation.current();
        if matches!(self.readiness(), Readiness::SignedOut | Readiness::NeedsClientId) {
            return None;
        }
        let me = self.0.api.get::<Me>("/me", &[]).await.ok().flatten()?;
        let profile = profile_of(&me);
        if !self.0.generation.is_current(epoch) {
            return None;
        }
        *self.0.profile.lock().unwrap() = Some(profile.clone());
        Some(profile)
    }

    fn checked<T>(&self, epoch: u64, value: Result<T, String>) -> Result<T, String> {
        if !self.0.generation.is_current(epoch) {
            return Err("Account cambiato.".into());
        }
        value
    }

    pub async fn playlists(&self) -> Result<Vec<PlaylistEntry>, String> {
        let epoch = self.gate()?;
        let list = self.0.library.playlists(&self.0.api).await;
        self.checked(epoch, list)
    }

    pub async fn playlist(&self, id: &str) -> Result<PlaylistEntry, String> {
        let epoch = self.gate()?;
        let entry = self.0.library.summary(&self.0.api, id).await;
        self.checked(epoch, entry)
    }

    pub async fn tracks(&self, id: &str) -> Result<Vec<TrackEntry>, String> {
        let epoch = self.gate()?;
        let tracks = self.0.library.tracks(&self.0.api, id).await;
        self.checked(epoch, tracks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_fall_back_to_the_user_id_and_name_the_plan() {
        let me: Me = serde_json::from_str(
            r#"{"id": "anna", "display_name": "", "product": "free",
                "images": [{"url": "https://i.scdn.co/image/a", "width": 300}]}"#,
        )
        .unwrap();
        let profile = profile_of(&me);
        assert_eq!(profile.name, "anna");
        assert_eq!(profile.product, "Free");
        assert_eq!(profile.avatar, "https://i.scdn.co/image/a");
        let me: Me = serde_json::from_str(r#"{"id": "x", "display_name": "Anna"}"#).unwrap();
        assert_eq!(profile_of(&me).product, "Premium");
        assert_eq!(profile_of(&me).name, "Anna");
    }
}
