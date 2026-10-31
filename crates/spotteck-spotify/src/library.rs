//! The user's playlists and their tracks, read through the official Web API.

use crate::api::Api;
use spotteck_core::library::{PlaylistEntry, TrackEntry};
use spotteck_core::pkce::encode;
use spotteck_core::uri::{playlist_id_of, playlist_uri};
use spotteck_core::webapi::{Failure, Oembed, Page, Playlist, PlaylistItem};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const LIST_TTL: Duration = Duration::from_secs(5 * 60);
const TRACKS_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_PLAYLISTS: usize = 500;
const MAX_TRACKS: usize = 500;
/// In Development Mode, Spotify lists the items of the user's own and collaborative
/// playlists only. Any playlist can still be played.
const NOT_LISTABLE: &str = "Spotify mostra solo i brani delle tue playlist: premi play per avviarla.";

#[derive(Default)]
pub(crate) struct Library {
    cache: Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    list: Option<(Instant, Vec<PlaylistEntry>)>,
    summaries: HashMap<String, (Instant, PlaylistEntry)>,
    tracks: HashMap<String, (Instant, Vec<TrackEntry>)>,
}

fn fresh<T: Clone>(entry: Option<&(Instant, T)>, ttl: Duration) -> Option<T> {
    entry.filter(|(at, _)| at.elapsed() < ttl).map(|(_, value)| value.clone())
}

impl Library {
    pub(crate) fn clear(&self) {
        *self.cache.lock().unwrap() = Cache::default();
    }

    /// The playlists in the user's library (their own and the ones they follow), in Spotify's order.
    pub(crate) async fn playlists(&self, api: &Api) -> Result<Vec<PlaylistEntry>, String> {
        if let Some(list) = fresh(self.cache.lock().unwrap().list.as_ref(), LIST_TTL) {
            return Ok(list);
        }
        let mut list = Vec::new();
        let mut next = Some("/me/playlists?limit=50".to_owned());
        while let Some(url) = next.take() {
            let page: Page<Playlist> = api
                .get(&url, &[])
                .await
                .map_err(|_| "Impossibile caricare la libreria Spotify.".to_owned())?
                .ok_or("Risposta inattesa dalla libreria Spotify.")?;
            list.extend(page.items.iter().filter_map(Playlist::entry));
            if list.len() < MAX_PLAYLISTS {
                next = page.next;
            }
        }
        list.truncate(MAX_PLAYLISTS);
        self.cache.lock().unwrap().list = Some((Instant::now(), list.clone()));
        Ok(list)
    }

    /// Name and cover of one playlist, also for playlists of other users. When the Web API
    /// refuses, Spotify's public oEmbed metadata is used instead.
    pub(crate) async fn summary(&self, api: &Api, id: &str) -> Result<PlaylistEntry, String> {
        let key = playlist_id_of(id).ok_or("Playlist non valida.")?;
        if let Some(entry) = fresh(self.cache.lock().unwrap().summaries.get(&key), LIST_TTL) {
            return Ok(entry);
        }
        let query = [("fields", "id,name,images".to_owned())];
        let entry = match api.get::<Playlist>(&format!("/playlists/{key}"), &query).await {
            Ok(Some(playlist)) => playlist.entry(),
            Err(Failure::SignedOut) => return Err(Failure::SignedOut.message()),
            _ => None,
        };
        let entry = match entry {
            Some(entry) => entry,
            None => {
                let link = format!("https://open.spotify.com/playlist/{key}");
                let oembed: Oembed = api
                    .public_get(&format!("https://open.spotify.com/oembed?url={}", encode(&link)))
                    .await
                    .ok_or("Playlist Spotify non trovata o non accessibile.")?;
                PlaylistEntry {
                    id: playlist_uri(&key),
                    name: if oembed.title.is_empty() { "Playlist".into() } else { oembed.title },
                    image: oembed.thumbnail_url,
                    pinned: false,
                }
            }
        };
        self.cache.lock().unwrap().summaries.insert(key, (Instant::now(), entry.clone()));
        Ok(entry)
    }

    /// The first [`MAX_TRACKS`] tracks of a playlist, in order. Podcast episodes and local
    /// files are left out.
    pub(crate) async fn tracks(&self, api: &Api, id: &str) -> Result<Vec<TrackEntry>, String> {
        let key = playlist_id_of(id).ok_or("Playlist non valida.")?;
        if let Some(tracks) = fresh(self.cache.lock().unwrap().tracks.get(&key), TRACKS_TTL) {
            return Ok(tracks);
        }
        let mut tracks = Vec::new();
        let mut next = Some(format!("/playlists/{key}/items?limit=100&additional_types=track"));
        while let Some(url) = next.take() {
            let page: Page<PlaylistItem> = match api.get(&url, &[]).await {
                Ok(Some(page)) => page,
                Ok(None) => break,
                Err(Failure::Forbidden(_)) | Err(Failure::NotFound) => return Err(NOT_LISTABLE.into()),
                Err(_) => return Err("Impossibile caricare i brani della playlist.".into()),
            };
            tracks.extend(page.items.iter().filter_map(PlaylistItem::entry));
            if tracks.len() < MAX_TRACKS {
                next = page.next;
            }
        }
        tracks.truncate(MAX_TRACKS);
        self.cache.lock().unwrap().tracks.insert(key, (Instant::now(), tracks.clone()));
        Ok(tracks)
    }
}
