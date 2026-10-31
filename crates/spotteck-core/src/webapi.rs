//! The parts of Spotify's official Web API (`https://api.spotify.com/v1`) that Spotteck reads,
//! and pure mappings from those responses to player updates, grid tiles and drawer rows.
//! Everything here is plain data, so it is unit-tested with recorded responses.

use crate::library::{PlaylistEntry, TrackEntry};
use crate::state::Update;
use crate::uri::{playlist_id_of, playlist_uri};
use serde::Deserialize;
use std::time::Duration;

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Image {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub width: Option<u32>,
}

/// The image closest to 300 px wide, which fits a tile and the artwork backdrop.
pub fn pick_cover(images: &[Image]) -> String {
    images
        .iter()
        .filter(|i| i.url.starts_with("https://"))
        .min_by_key(|i| (i64::from(i.width.unwrap_or(300)) - 300).abs())
        .map(|i| i.url.clone())
        .unwrap_or_default()
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Named {
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Album {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub images: Vec<Image>,
}

/// A track or a podcast episode.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Item {
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub uri: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub artists: Vec<Named>,
    #[serde(default)]
    pub album: Option<Album>,
    #[serde(default)]
    pub show: Option<Named>,
    #[serde(default)]
    pub images: Vec<Image>,
    #[serde(default)]
    pub is_playable: Option<bool>,
    #[serde(default)]
    pub is_local: bool,
}

impl Item {
    fn artist(&self) -> String {
        if self.kind == "episode" {
            return self.show.as_ref().map(|s| s.name.clone()).unwrap_or_default();
        }
        self.artists.iter().map(|a| a.name.as_str()).filter(|n| !n.is_empty()).collect::<Vec<_>>().join(", ")
    }

    fn artwork(&self) -> String {
        match &self.album {
            Some(album) if !album.images.is_empty() => pick_cover(&album.images),
            _ => pick_cover(&self.images),
        }
    }

    fn duration_ms(&self) -> u32 {
        u32::try_from(self.duration_ms).unwrap_or(u32::MAX)
    }
}

/// A Spotify Connect device from `GET /me/player/devices` or `GET /me/player`.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Device {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub is_active: bool,
    #[serde(default)]
    pub is_restricted: bool,
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub volume_percent: Option<u8>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Devices {
    #[serde(default)]
    pub devices: Vec<Device>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Context {
    #[serde(default)]
    pub uri: String,
}

/// `GET /me/player`.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Playback {
    #[serde(default)]
    pub device: Option<Device>,
    #[serde(default)]
    pub shuffle_state: bool,
    #[serde(default)]
    pub is_playing: bool,
    #[serde(default)]
    pub progress_ms: Option<u64>,
    #[serde(default)]
    pub item: Option<Item>,
    #[serde(default)]
    pub context: Option<Context>,
}

impl Playback {
    /// The updates that bring [`crate::state::PlayerState`] in line with this snapshot, in
    /// the order they must be applied (the track first, since it resets the position).
    pub fn updates(&self) -> Vec<Update> {
        let Some(item) = self.item.as_ref().filter(|i| !i.uri.is_empty()) else {
            return vec![Update::Stopped];
        };
        let position_ms = u32::try_from(self.progress_ms.unwrap_or(0)).unwrap_or(u32::MAX);
        let mut updates = vec![Update::Track {
            uri: item.uri.clone(),
            name: item.name.clone(),
            artist: item.artist(),
            album: item.album.as_ref().map(|a| a.name.clone()).unwrap_or_default(),
            artwork: item.artwork(),
            duration_ms: item.duration_ms(),
        }];
        if let Some(device) = &self.device {
            updates.push(Update::Device(device.name.clone()));
            if let Some(volume) = device.volume_percent {
                updates.push(Update::Volume(volume.min(100)));
            }
        }
        updates.push(Update::Shuffle(self.shuffle_state));
        updates.push(Update::Context(self.context.as_ref().map(|c| c.uri.clone()).unwrap_or_default()));
        updates.push(if self.is_playing { Update::Playing { position_ms } } else { Update::Paused { position_ms } });
        updates
    }
}

/// Where a command goes when no device is active: Spotify on this computer if it is open,
/// otherwise any other available device. Restricted devices refuse Web API commands.
pub fn pick_device<'a>(devices: &'a [Device], computer_name: &str) -> Option<&'a Device> {
    let usable: Vec<&Device> = devices.iter().filter(|d| d.id.is_some() && !d.is_restricted).collect();
    let computer = computer_name.trim();
    usable
        .iter()
        .find(|d| d.is_active)
        .or_else(|| {
            usable.iter().find(|d| {
                d.kind.eq_ignore_ascii_case("computer") && !computer.is_empty() && d.name.eq_ignore_ascii_case(computer)
            })
        })
        .or_else(|| usable.iter().find(|d| d.kind.eq_ignore_ascii_case("computer")))
        .or_else(|| usable.first())
        .copied()
}

/// `GET /me`.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Me {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub images: Vec<Image>,
    #[serde(default)]
    pub product: Option<String>,
}

/// One page of a paged Web API list.
#[derive(Clone, Debug, Deserialize)]
pub struct Page<T> {
    #[serde(default = "Vec::new")]
    pub items: Vec<T>,
    #[serde(default)]
    pub next: Option<String>,
}

/// A playlist in `GET /me/playlists` or `GET /playlists/{id}`.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Playlist {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub images: Option<Vec<Image>>,
}

impl Playlist {
    pub fn entry(&self) -> Option<PlaylistEntry> {
        let id = playlist_id_of(&self.id)?;
        Some(PlaylistEntry {
            id: playlist_uri(&id),
            name: if self.name.is_empty() { "Playlist".into() } else { self.name.clone() },
            image: self.images.as_deref().map(pick_cover).unwrap_or_default(),
            pinned: false,
        })
    }
}

/// A row of `GET /playlists/{id}/items`. Since February 2026 the object is under `item`;
/// older responses call it `track`.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct PlaylistItem {
    #[serde(default)]
    pub item: Option<Item>,
    #[serde(default)]
    pub track: Option<Item>,
}

impl PlaylistItem {
    /// Tracks only: podcast episodes and local files are left out, as in the drawer before.
    pub fn entry(&self) -> Option<TrackEntry> {
        let item = self.item.as_ref().or(self.track.as_ref())?;
        if item.kind != "track" || item.is_local || !item.uri.starts_with("spotify:track:") {
            return None;
        }
        Some(TrackEntry {
            uri: item.uri.clone(),
            title: if item.name.is_empty() { "Brano".into() } else { item.name.clone() },
            artist: item.artist(),
            duration: item.duration_ms() / 1000,
            playable: item.is_playable.unwrap_or(true),
        })
    }
}

/// `https://open.spotify.com/oembed`, Spotify's public embed metadata (no login needed).
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Oembed {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub thumbnail_url: String,
}

/// Why a Web API request failed, reduced to what Spotteck does about it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure {
    /// The token was refused even after a refresh: sign in again.
    SignedOut,
    /// Free account: the player endpoints need Premium.
    PremiumRequired,
    /// No Spotify app is active, so there is nowhere to send the command.
    NoActiveDevice,
    /// Too many requests; wait this long.
    RateLimited(Duration),
    /// Spotify refused this action (e.g. volume on a phone, or another user's playlist).
    Forbidden(String),
    NotFound,
    /// Network error or 5xx: try again later.
    Transient,
}

#[derive(Debug, Default, Deserialize)]
struct ErrorBody {
    #[serde(default)]
    error: ErrorDetail,
}

#[derive(Debug, Default, Deserialize)]
struct ErrorDetail {
    #[serde(default)]
    message: String,
    #[serde(default)]
    reason: String,
}

impl Failure {
    /// Classifies a non-2xx response. `retry_after` is the `Retry-After` header, if any.
    pub fn from_response(status: u16, body: &[u8], retry_after: Option<u64>) -> Failure {
        let detail = serde_json::from_slice::<ErrorBody>(body).map(|b| b.error).unwrap_or_default();
        let message = detail.message.to_ascii_lowercase();
        match status {
            401 => Failure::SignedOut,
            403 if detail.reason == "PREMIUM_REQUIRED" || message.contains("premium") => Failure::PremiumRequired,
            403 => Failure::Forbidden(detail.reason),
            404 if detail.reason == "NO_ACTIVE_DEVICE" || message.contains("no active device") => {
                Failure::NoActiveDevice
            }
            404 => Failure::NotFound,
            429 => Failure::RateLimited(Duration::from_secs(retry_after.unwrap_or(5).clamp(1, 120))),
            _ => Failure::Transient,
        }
    }

    /// Italian text for a refused command.
    pub fn message(&self) -> String {
        match self {
            Failure::SignedOut => "Accesso a Spotify scaduto: accedi di nuovo.".into(),
            Failure::PremiumRequired => "Spotteck richiede Spotify Premium.".into(),
            Failure::NoActiveDevice => "Apri Spotify su questo computer o sul telefono, poi riprova.".into(),
            Failure::RateLimited(_) => "Troppe richieste a Spotify: riprova tra qualche secondo.".into(),
            Failure::Forbidden(reason) if reason == "VOLUME_CONTROL_DISALLOW" => {
                "Questo dispositivo Spotify non consente di cambiare il volume.".into()
            }
            Failure::Forbidden(_) => "Spotify non consente questa azione sul dispositivo attivo.".into(),
            Failure::NotFound => "Contenuto Spotify non trovato.".into(),
            Failure::Transient => "Spotify non risponde. Controlla la connessione e riprova.".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAYING: &str = r#"{
      "device": {"id": "d1", "is_active": true, "is_restricted": false, "name": "MacBook", "type": "Computer", "volume_percent": 64},
      "shuffle_state": true, "is_playing": true, "progress_ms": 61500,
      "context": {"uri": "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", "type": "playlist"},
      "item": {"type": "track", "uri": "spotify:track:4uLU6hMCjMI75M1A2tKUQC", "name": "Song", "duration_ms": 200000,
        "artists": [{"name": "A"}, {"name": "B"}],
        "album": {"name": "Album", "images": [{"url": "https://i.scdn.co/image/640", "width": 640}, {"url": "https://i.scdn.co/image/300", "width": 300}, {"url": "https://i.scdn.co/image/64", "width": 64}]}},
      "currently_playing_type": "track"
    }"#;

    #[test]
    fn playback_maps_to_ordered_updates() {
        let playback: Playback = serde_json::from_str(PLAYING).unwrap();
        let updates = playback.updates();
        assert_eq!(
            updates[0],
            Update::Track {
                uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC".into(),
                name: "Song".into(),
                artist: "A, B".into(),
                album: "Album".into(),
                artwork: "https://i.scdn.co/image/300".into(),
                duration_ms: 200_000,
            }
        );
        assert!(updates.contains(&Update::Device("MacBook".into())));
        assert!(updates.contains(&Update::Volume(64)));
        assert!(updates.contains(&Update::Shuffle(true)));
        assert!(updates.contains(&Update::Context("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M".into())));
        assert_eq!(updates.last(), Some(&Update::Playing { position_ms: 61_500 }));
    }

    #[test]
    fn episodes_use_the_show_and_their_own_images() {
        let json = r#"{"is_playing": false, "progress_ms": 1000, "item": {"type": "episode", "uri": "spotify:episode:x",
            "name": "Ep", "duration_ms": 5000, "show": {"name": "Show"}, "images": [{"url": "https://i.scdn.co/image/e", "width": 300}]}}"#;
        let updates = serde_json::from_str::<Playback>(json).unwrap().updates();
        match &updates[0] {
            Update::Track { artist, artwork, album, .. } => {
                assert_eq!(artist, "Show");
                assert_eq!(artwork, "https://i.scdn.co/image/e");
                assert!(album.is_empty());
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(updates.last(), Some(&Update::Paused { position_ms: 1000 }));
    }

    #[test]
    fn nothing_playing_is_stopped() {
        assert_eq!(Playback::default().updates(), [Update::Stopped]);
        let json = r#"{"device": {"id": "d", "name": "x"}, "is_playing": false, "item": null}"#;
        assert_eq!(serde_json::from_str::<Playback>(json).unwrap().updates(), [Update::Stopped]);
    }

    fn device(id: &str, name: &str, kind: &str, active: bool) -> Device {
        Device {
            id: Some(id.into()),
            is_active: active,
            is_restricted: false,
            name: name.into(),
            kind: kind.into(),
            volume_percent: None,
        }
    }

    #[test]
    fn device_choice_prefers_active_then_this_computer() {
        let devices = vec![
            device("phone", "iPhone", "Smartphone", false),
            device("other", "Ufficio", "Computer", false),
            device("here", "MacBook di Anna", "Computer", false),
        ];
        assert_eq!(pick_device(&devices, "MacBook di Anna").unwrap().id.as_deref(), Some("here"));
        assert_eq!(pick_device(&devices, "Altro").unwrap().id.as_deref(), Some("other"));
        let mut active = devices.clone();
        active[0].is_active = true;
        assert_eq!(pick_device(&active, "MacBook di Anna").unwrap().id.as_deref(), Some("phone"));
        let phone_only = vec![device("phone", "iPhone", "Smartphone", false)];
        assert_eq!(pick_device(&phone_only, "x").unwrap().id.as_deref(), Some("phone"));
        let mut restricted = phone_only.clone();
        restricted[0].is_restricted = true;
        assert!(pick_device(&restricted, "x").is_none());
        assert!(pick_device(&[], "x").is_none());
    }

    #[test]
    fn playlists_and_items_map_to_tiles_and_rows() {
        let page: Page<Playlist> = serde_json::from_str(
            r#"{"items": [{"id": "37i9dQZF1DXcBWIGoYBM5M", "name": "Mix", "images": null},
                          {"id": "bad id", "name": "x"}], "next": "https://api.spotify.com/v1/me/playlists?offset=50"}"#,
        )
        .unwrap();
        let entries: Vec<_> = page.items.iter().filter_map(Playlist::entry).collect();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M");
        assert_eq!(entries[0].image, "");
        assert!(page.next.is_some());

        let items: Page<PlaylistItem> = serde_json::from_str(
            r#"{"items": [
              {"item": {"type": "track", "uri": "spotify:track:a", "name": "New key", "duration_ms": 61000, "artists": [{"name": "X"}]}},
              {"track": {"type": "track", "uri": "spotify:track:b", "name": "Old key", "duration_ms": 1000, "is_playable": false}},
              {"item": {"type": "episode", "uri": "spotify:episode:c", "name": "Ep"}},
              {"item": {"type": "track", "uri": "spotify:local:x:y:z:1", "name": "Local", "is_local": true}},
              {"item": null}
            ], "next": null}"#,
        )
        .unwrap();
        let rows: Vec<_> = items.items.iter().filter_map(PlaylistItem::entry).collect();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].title.as_str(), rows[0].artist.as_str(), rows[0].duration), ("New key", "X", 61));
        assert!(rows[0].playable && !rows[1].playable);
    }

    #[test]
    fn failures_are_classified() {
        let premium = br#"{"error": {"status": 403, "message": "Player command failed: Premium required", "reason": "PREMIUM_REQUIRED"}}"#;
        assert_eq!(Failure::from_response(403, premium, None), Failure::PremiumRequired);
        let device = br#"{"error": {"status": 404, "message": "Player command failed: No active device found", "reason": "NO_ACTIVE_DEVICE"}}"#;
        assert_eq!(Failure::from_response(404, device, None), Failure::NoActiveDevice);
        assert_eq!(Failure::from_response(404, b"", None), Failure::NotFound);
        assert_eq!(Failure::from_response(401, b"{}", None), Failure::SignedOut);
        assert_eq!(Failure::from_response(429, b"", Some(7)), Failure::RateLimited(Duration::from_secs(7)));
        assert_eq!(Failure::from_response(429, b"", Some(9999)), Failure::RateLimited(Duration::from_secs(120)));
        assert_eq!(Failure::from_response(502, b"<html>", None), Failure::Transient);
        let volume = br#"{"error": {"status": 403, "message": "Cannot control device volume", "reason": "VOLUME_CONTROL_DISALLOW"}}"#;
        let failure = Failure::from_response(403, volume, None);
        assert_eq!(failure, Failure::Forbidden("VOLUME_CONTROL_DISALLOW".into()));
        assert!(failure.message().contains("volume"));
    }

    #[test]
    fn covers_prefer_300_px_https() {
        let images = vec![
            Image { url: "http://insecure/300".into(), width: Some(300) },
            Image { url: "https://a/640".into(), width: Some(640) },
            Image { url: "https://a/200".into(), width: Some(200) },
        ];
        assert_eq!(pick_cover(&images), "https://a/200");
        assert_eq!(pick_cover(&[Image { url: "https://a/x".into(), width: None }]), "https://a/x");
        assert_eq!(pick_cover(&[]), "");
    }
}
