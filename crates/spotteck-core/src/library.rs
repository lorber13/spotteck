//! The playlist grid: the user's Spotify library followed by playlists pinned by link.

use crate::pinned::PinnedPlaylist;
use crate::uri::{playlist_id_of, playlist_uri};
use serde::Serialize;

/// A tile in the grid. `id` is a `spotify:playlist:` URI.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PlaylistEntry {
    pub id: String,
    pub name: String,
    pub image: String,
    /// Pinned by link in Spotteck, so it can be removed from Spotteck.
    pub pinned: bool,
}

/// A row in the playlist drawer. `duration` is in whole seconds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TrackEntry {
    pub uri: String,
    pub title: String,
    pub artist: String,
    pub duration: u32,
    pub playable: bool,
}

impl From<&PinnedPlaylist> for PlaylistEntry {
    fn from(p: &PinnedPlaylist) -> Self {
        PlaylistEntry {
            id: playlist_uri(&p.id),
            name: if p.name.is_empty() { "Playlist".into() } else { p.name.clone() },
            image: p.image.clone(),
            pinned: true,
        }
    }
}

/// Library playlists in Spotify's order, then pinned ones that aren't in the library.
/// A pinned playlist that is also in the library stays where the library has it.
pub fn merge(library: Vec<PlaylistEntry>, pinned: &[PinnedPlaylist]) -> Vec<PlaylistEntry> {
    let mut out = library;
    for entry in out.iter_mut() {
        let id = playlist_id_of(&entry.id);
        entry.pinned = pinned.iter().any(|p| Some(&p.id) == id.as_ref());
    }
    for p in pinned {
        if !out.iter().any(|e| playlist_id_of(&e.id).as_deref() == Some(p.id.as_str())) {
            out.push(PlaylistEntry::from(p));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "37i9dQZF1DXcBWIGoYBM5M";
    const B: &str = "4uLU6hMCjMI75M1A2tKUQC";
    const C: &str = "1h0CEZCm6IbFTbxThn6Xcs";

    fn library(id: &str, name: &str) -> PlaylistEntry {
        PlaylistEntry { id: playlist_uri(id), name: name.into(), image: String::new(), pinned: false }
    }

    #[test]
    fn appends_pinned_after_library_without_duplicates() {
        let pinned = [
            PinnedPlaylist { id: B.into(), name: "Pinned B".into(), image: String::new() },
            PinnedPlaylist { id: C.into(), name: String::new(), image: "img".into() },
        ];
        let merged = merge(vec![library(A, "Mine"), library(B, "Followed B")], &pinned);
        let names: Vec<_> = merged.iter().map(|e| (e.name.as_str(), e.pinned)).collect();
        assert_eq!(names, [("Mine", false), ("Followed B", true), ("Playlist", true)]);
        assert_eq!(merged[2].id, playlist_uri(C));
        assert_eq!(merged[2].image, "img");
    }

    #[test]
    fn serializes_the_fields_app_js_reads() {
        let json = serde_json::to_value(library(A, "Mine")).unwrap();
        assert_eq!(json["id"], format!("spotify:playlist:{A}"));
        assert_eq!(json["name"], "Mine");
        assert!(json.get("image").is_some() && json.get("pinned").is_some());
        let track = TrackEntry {
            uri: "spotify:track:x".into(),
            title: "T".into(),
            artist: "A".into(),
            duration: 61,
            playable: true,
        };
        let json = serde_json::to_value(track).unwrap();
        for key in ["uri", "title", "artist", "duration", "playable"] {
            assert!(json.get(key).is_some(), "{key}");
        }
    }
}
