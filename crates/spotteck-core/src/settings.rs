//! App settings kept in the app data directory: the Client ID of the user's own Spotify
//! developer app. A Client ID identifies an app, it is not a secret.

use crate::pkce::is_client_id;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub client_id: Option<String>,
}

pub struct SettingsStore {
    path: PathBuf,
    cached: Mutex<Option<Settings>>,
}

impl SettingsStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        SettingsStore { path: path.into(), cached: Mutex::new(None) }
    }

    pub fn load(&self) -> Settings {
        let mut cached = self.cached.lock().unwrap();
        if cached.is_none() {
            let settings = fs::read(&self.path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
                .unwrap_or_default();
            *cached = Some(settings);
        }
        cached.clone().unwrap_or_default()
    }

    /// The configured Client ID, lower-cased, if it is well formed.
    pub fn client_id(&self) -> Option<String> {
        self.load().client_id.filter(|id| is_client_id(id)).map(|id| id.to_ascii_lowercase())
    }

    /// Saves a Client ID (or clears it with an empty string). Returns whether it changed.
    pub fn set_client_id(&self, value: &str) -> Result<bool, &'static str> {
        let value = value.trim();
        let next = if value.is_empty() {
            None
        } else if is_client_id(value) {
            Some(value.to_ascii_lowercase())
        } else {
            return Err("Client ID non valido: copia i 32 caratteri dalla dashboard Spotify for Developers.");
        };
        if self.client_id() == next {
            return Ok(false);
        }
        let settings = Settings { client_id: next };
        self.save(&settings).map_err(|_| "Impossibile salvare le impostazioni.")?;
        *self.cached.lock().unwrap() = Some(settings);
        Ok(true)
    }

    /// Writes to a temporary file and renames it over the settings.
    fn save(&self, settings: &Settings) -> std::io::Result<()> {
        let dir = self.path.parent().ok_or(std::io::ErrorKind::NotFound)?;
        fs::create_dir_all(dir)?;
        let temporary = self.path.with_extension("json.tmp");
        let result = (|| -> std::io::Result<()> {
            let mut options = fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            let mut file = options.open(&temporary)?;
            file.write_all(serde_json::to_string_pretty(settings)?.as_bytes())?;
            file.sync_all()?;
            fs::rename(&temporary, &self.path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_ids_are_validated_normalized_and_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/settings.json");
        let store = SettingsStore::new(&path);
        assert_eq!(store.client_id(), None);
        assert!(store.set_client_id("not an id").is_err());
        assert_eq!(store.set_client_id(" 0123456789ABCDEF0123456789abcdef "), Ok(true));
        assert_eq!(store.set_client_id("0123456789abcdef0123456789abcdef"), Ok(false));
        assert_eq!(SettingsStore::new(&path).client_id().as_deref(), Some("0123456789abcdef0123456789abcdef"));
        assert!(std::fs::read_to_string(&path).unwrap().contains("\"clientId\""));
        assert_eq!(store.set_client_id(""), Ok(true));
        assert_eq!(SettingsStore::new(&path).client_id(), None);
    }

    #[test]
    fn a_damaged_file_reads_as_unset() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"{oops").unwrap();
        assert_eq!(SettingsStore::new(&path).client_id(), None);
    }
}
