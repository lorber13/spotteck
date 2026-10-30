//! Playlists the user pinned with "+" by pasting a link. Stored as JSON in the app data
//! directory; a damaged file is reported and never overwritten.

use crate::uri::playlist_id_of;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PinnedPlaylist {
    /// Base62 playlist ID. Files written by Spotteck 1.x hold a share link here instead.
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub image: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum StoreError {
    #[error("Archivio playlist danneggiato: il file è stato conservato. Ripristina una copia prima di modificarlo.")]
    Corrupt,
    #[error("Impossibile salvare le playlist. Il file precedente è stato conservato.")]
    Write,
}

pub struct PinnedStore {
    path: PathBuf,
}

impl PinnedStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        PinnedStore { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Copies a Spotteck 1.x archive into place when there is none yet.
    pub fn import_legacy(&self, legacy: &Path) {
        if self.path.exists() || !legacy.is_file() {
            return;
        }
        if let Ok(list) = PinnedStore::new(legacy).load() {
            let _ = self.save(&list);
        }
    }

    pub fn load(&self) -> Result<Vec<PinnedPlaylist>, StoreError> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err(StoreError::Corrupt),
        };
        let list: Vec<PinnedPlaylist> = serde_json::from_str(&text).map_err(|_| StoreError::Corrupt)?;
        let mut out: Vec<PinnedPlaylist> = Vec::with_capacity(list.len());
        for mut entry in list {
            let Some(id) = playlist_id_of(&entry.id) else { continue };
            entry.id = id;
            if !out.iter().any(|p| p.id == entry.id) {
                out.push(entry);
            }
        }
        Ok(out)
    }

    /// Writes to a temporary file and renames it over the archive.
    pub fn save(&self, list: &[PinnedPlaylist]) -> Result<(), StoreError> {
        let dir = self.path.parent().ok_or(StoreError::Write)?;
        fs::create_dir_all(dir).map_err(|_| StoreError::Write)?;
        let temporary = self.path.with_extension("json.tmp");
        let result = (|| -> std::io::Result<()> {
            let mut options = fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            let mut file = options.open(&temporary)?;
            file.write_all(serde_json::to_string_pretty(list)?.as_bytes())?;
            file.sync_all()?;
            fs::rename(&temporary, &self.path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(StoreError::Write);
        }
        Ok(())
    }

    /// Adds or refreshes one entry and returns the new list.
    pub fn upsert(&self, playlist: PinnedPlaylist) -> Result<Vec<PinnedPlaylist>, StoreError> {
        let mut list = self.load()?;
        match list.iter_mut().find(|p| p.id == playlist.id) {
            Some(existing) => *existing = playlist,
            None => list.push(playlist),
        }
        self.save(&list)?;
        Ok(list)
    }

    pub fn remove(&self, id: &str) -> Result<Vec<PinnedPlaylist>, StoreError> {
        let id = playlist_id_of(id).unwrap_or_else(|| id.to_owned());
        let mut list = self.load()?;
        list.retain(|p| p.id != id);
        self.save(&list)?;
        Ok(list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "37i9dQZF1DXcBWIGoYBM5M";
    const B: &str = "4uLU6hMCjMI75M1A2tKUQC";

    fn entry(id: &str, name: &str) -> PinnedPlaylist {
        PinnedPlaylist { id: id.into(), name: name.into(), image: String::new() }
    }

    #[test]
    fn missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(PinnedStore::new(dir.path().join("p.json")).load().unwrap(), vec![]);
    }

    #[test]
    fn upsert_and_remove_persist() {
        let dir = tempfile::tempdir().unwrap();
        let store = PinnedStore::new(dir.path().join("nested/p.json"));
        store.upsert(entry(A, "One")).unwrap();
        store.upsert(entry(B, "Two")).unwrap();
        let list = store.upsert(entry(A, "Uno")).unwrap();
        assert_eq!(list, vec![entry(A, "Uno"), entry(B, "Two")]);
        assert_eq!(store.load().unwrap(), list);
        assert_eq!(store.remove(&format!("spotify:playlist:{A}")).unwrap(), vec![entry(B, "Two")]);
        assert!(!dir.path().join("nested/p.json.tmp").exists());
    }

    #[test]
    fn corrupt_file_is_reported_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.json");
        fs::write(&path, "{ not json").unwrap();
        let store = PinnedStore::new(&path);
        assert_eq!(store.load().unwrap_err(), StoreError::Corrupt);
        assert_eq!(store.upsert(entry(A, "One")).unwrap_err(), StoreError::Corrupt);
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
    }

    #[test]
    fn reads_and_imports_version_1_files() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("old.json");
        fs::write(
            &legacy,
            format!(
                r#"[{{"id":"https://open.spotify.com/playlist/{A}","name":"Old","image":"https://i.scdn.co/x"}},
                   {{"id":"https://open.spotify.com/playlist/{A}?si=1","name":"Dup"}},
                   {{"id":"not a playlist","name":"Junk"}}]"#
            ),
        )
        .unwrap();
        let store = PinnedStore::new(dir.path().join("new/p.json"));
        store.import_legacy(&legacy);
        let list = store.load().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, A);
        assert_eq!(list[0].image, "https://i.scdn.co/x");
        // An existing archive is never replaced by the legacy one.
        store.remove(A).unwrap();
        store.import_legacy(&legacy);
        assert_eq!(store.load().unwrap(), vec![]);
    }
}
