//! The player state pushed to the UI on `spotify:state`, built from engine updates.

use crate::readiness::Readiness;
use serde::Serialize;
use std::time::Instant;

/// One change read from the Web API's playback state (or applied after a command).
#[derive(Clone, Debug, PartialEq)]
pub enum Update {
    Track {
        uri: String,
        name: String,
        artist: String,
        album: String,
        artwork: String,
        duration_ms: u32,
    },
    Playing {
        position_ms: u32,
    },
    Paused {
        position_ms: u32,
    },
    Position {
        position_ms: u32,
    },
    Stopped,
    Shuffle(bool),
    /// Volume of the playing device, 0–100.
    Volume(u8),
    Context(String),
    /// Name of the Spotify Connect device that is playing (Spotify on this computer, a
    /// phone, a speaker…).
    Device(String),
    Error(String),
}

#[derive(Clone, Debug)]
pub struct PlayerState {
    pub readiness: Readiness,
    pub active: bool,
    pub playing: bool,
    pub track: String,
    pub artist: String,
    pub album: String,
    pub artwork: String,
    pub track_uri: String,
    pub context_uri: String,
    pub duration_ms: u32,
    position_ms: u32,
    position_at: Option<Instant>,
    pub shuffling: bool,
    pub volume: u8,
    pub device: String,
    pub playback_error: Option<String>,
}

impl Default for PlayerState {
    fn default() -> Self {
        PlayerState {
            readiness: Readiness::SignedOut,
            active: false,
            playing: false,
            track: String::new(),
            artist: String::new(),
            album: String::new(),
            artwork: String::new(),
            track_uri: String::new(),
            context_uri: String::new(),
            duration_ms: 0,
            position_ms: 0,
            position_at: None,
            shuffling: false,
            volume: 100,
            device: String::new(),
            playback_error: None,
        }
    }
}

/// The JSON shape app.js reads. Times are whole seconds, volume is 0–100.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    pub is_running: bool,
    pub is_playing: bool,
    pub track: String,
    pub artist: String,
    pub album: String,
    pub duration: u32,
    pub position: u32,
    pub shuffling: bool,
    pub artwork: String,
    pub track_uri: String,
    pub context_uri: String,
    pub volume: u8,
    pub device: String,
    pub authenticated: bool,
    pub readiness: Readiness,
    pub playback_error: Option<String>,
}

/// A slider value as the Web API's `volume_percent`.
pub fn clamp_percent(percent: f64) -> u8 {
    if percent.is_finite() {
        percent.clamp(0.0, 100.0).round() as u8
    } else {
        100
    }
}

impl PlayerState {
    pub fn apply(&mut self, update: Update, now: Instant) {
        match update {
            Update::Track { uri, name, artist, album, artwork, duration_ms } => {
                self.active = true;
                self.track_uri = uri;
                self.track = name;
                self.artist = artist;
                self.album = album;
                self.artwork = artwork;
                self.duration_ms = duration_ms;
                self.set_position(0, now);
            }
            Update::Playing { position_ms } => {
                self.active = true;
                self.playing = true;
                self.playback_error = None;
                self.set_position(position_ms, now);
            }
            Update::Paused { position_ms } => {
                self.active = true;
                self.playing = false;
                self.set_position(position_ms, now);
            }
            Update::Position { position_ms } => self.set_position(position_ms, now),
            Update::Stopped => {
                let readiness = self.readiness.clone();
                let (shuffling, volume, context_uri) =
                    (self.shuffling, self.volume, std::mem::take(&mut self.context_uri));
                *self = PlayerState { readiness, shuffling, volume, context_uri, ..PlayerState::default() };
            }
            Update::Shuffle(shuffling) => self.shuffling = shuffling,
            Update::Volume(volume) => self.volume = volume,
            Update::Context(uri) => self.context_uri = uri,
            Update::Device(name) => self.device = name,
            Update::Error(message) => {
                self.playing = false;
                self.playback_error = Some(message);
            }
        }
    }

    /// Back to the signed-out state, keeping nothing from the previous account.
    pub fn reset(&mut self, readiness: Readiness) {
        *self = PlayerState { readiness, ..PlayerState::default() };
    }

    fn set_position(&mut self, position_ms: u32, now: Instant) {
        self.position_ms = position_ms;
        self.position_at = Some(now);
    }

    /// Position at `now`, advancing with the clock while playing.
    pub fn position_ms(&self, now: Instant) -> u32 {
        let elapsed = match (self.playing, self.position_at) {
            (true, Some(at)) => now.saturating_duration_since(at).as_millis().min(u128::from(u32::MAX)) as u32,
            _ => 0,
        };
        let position = self.position_ms.saturating_add(elapsed);
        if self.duration_ms > 0 {
            position.min(self.duration_ms)
        } else {
            position
        }
    }

    pub fn payload(&self, now: Instant) -> Payload {
        let running = self.active && !self.track_uri.is_empty();
        Payload {
            is_running: running,
            is_playing: running && self.playing,
            track: if self.track.is_empty() { "Spotteck".into() } else { self.track.clone() },
            artist: if !self.artist.is_empty() {
                self.artist.clone()
            } else if self.readiness == Readiness::Ready {
                if running {
                    "In pausa".into()
                } else {
                    "Pronto".into()
                }
            } else {
                self.readiness.message().into()
            },
            album: self.album.clone(),
            duration: self.duration_ms / 1000,
            position: self.position_ms(now) / 1000,
            shuffling: self.shuffling,
            artwork: self.artwork.clone(),
            track_uri: self.track_uri.clone(),
            context_uri: self.context_uri.clone(),
            volume: self.volume,
            device: if running { self.device.clone() } else { String::new() },
            authenticated: !matches!(self.readiness, Readiness::SignedOut | Readiness::NeedsClientId),
            readiness: self.readiness.clone(),
            playback_error: self.playback_error.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn track() -> Update {
        Update::Track {
            uri: "spotify:track:a".into(),
            name: "Song".into(),
            artist: "Artist".into(),
            album: "Album".into(),
            artwork: "https://i.scdn.co/image/x".into(),
            duration_ms: 200_000,
        }
    }

    #[test]
    fn payload_uses_the_ui_keys_and_units() {
        let now = Instant::now();
        let mut state = PlayerState { readiness: Readiness::Ready, ..Default::default() };
        state.apply(track(), now);
        state.apply(Update::Playing { position_ms: 61_500 }, now);
        state.apply(Update::Volume(50), now);
        state.apply(Update::Device("Telefono".into()), now);
        let json = serde_json::to_value(state.payload(now)).unwrap();
        for key in [
            "isRunning",
            "isPlaying",
            "track",
            "artist",
            "album",
            "duration",
            "position",
            "shuffling",
            "artwork",
            "trackUri",
            "contextUri",
            "volume",
            "device",
            "authenticated",
            "readiness",
            "playbackError",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        assert_eq!(json["duration"], 200);
        assert_eq!(json["position"], 61);
        assert_eq!(json["volume"], 50);
        assert_eq!(json["device"], "Telefono");
        assert_eq!(json["isPlaying"], true);
        assert_eq!(json["readiness"], "ready");
    }

    #[test]
    fn position_advances_only_while_playing_and_stops_at_the_end() {
        let start = Instant::now();
        let mut state = PlayerState::default();
        state.apply(track(), start);
        state.apply(Update::Playing { position_ms: 10_000 }, start);
        assert_eq!(state.position_ms(start + Duration::from_secs(5)), 15_000);
        assert_eq!(state.position_ms(start + Duration::from_secs(500)), 200_000);
        state.apply(Update::Paused { position_ms: 12_000 }, start);
        assert_eq!(state.position_ms(start + Duration::from_secs(5)), 12_000);
    }

    #[test]
    fn idle_states_explain_themselves() {
        let now = Instant::now();
        let state = PlayerState { readiness: Readiness::PlanUnsupported, ..Default::default() };
        let payload = state.payload(now);
        assert!(!payload.is_running);
        assert_eq!(payload.artist, "Spotteck richiede Spotify Premium.");
        let ready = PlayerState { readiness: Readiness::Ready, ..Default::default() };
        assert_eq!(ready.payload(now).artist, "Pronto");
        assert!(!PlayerState::default().payload(now).authenticated);
    }

    #[test]
    fn stopped_clears_the_track_but_keeps_settings() {
        let now = Instant::now();
        let mut state = PlayerState { readiness: Readiness::Ready, ..Default::default() };
        state.apply(track(), now);
        state.apply(Update::Shuffle(true), now);
        state.apply(Update::Volume(30), now);
        state.apply(Update::Context("spotify:playlist:p".into()), now);
        state.apply(Update::Stopped, now);
        assert!(state.track_uri.is_empty() && !state.active);
        assert!(state.shuffling);
        assert_eq!(state.volume, 30);
        assert_eq!(state.context_uri, "spotify:playlist:p");
        assert_eq!(state.readiness, Readiness::Ready);
    }

    #[test]
    fn errors_stop_playback_until_it_plays_again() {
        let now = Instant::now();
        let mut state = PlayerState::default();
        state.apply(track(), now);
        state.apply(Update::Playing { position_ms: 0 }, now);
        state.apply(Update::Error("Brano non disponibile.".into()), now);
        assert!(!state.playing);
        assert_eq!(state.payload(now).playback_error.as_deref(), Some("Brano non disponibile."));
        state.apply(Update::Playing { position_ms: 0 }, now);
        assert_eq!(state.payload(now).playback_error, None);
    }

    #[test]
    fn slider_values_become_percent() {
        assert_eq!(clamp_percent(0.0), 0);
        assert_eq!(clamp_percent(49.6), 50);
        assert_eq!(clamp_percent(250.0), 100);
        assert_eq!(clamp_percent(-3.0), 0);
        assert_eq!(clamp_percent(f64::NAN), 100);
    }
}
