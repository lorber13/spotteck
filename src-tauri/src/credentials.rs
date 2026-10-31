//! The reusable Spotify login, kept in the system keychain (macOS Keychain, Windows
//! Credential Manager, Secret Service on Linux). It is never logged.

use spotteck_spotify::CredentialStore;

const SERVICE: &str = "com.braun.spotteck";
const ACCOUNT: &str = "spotify-session";

pub struct Keychain;

impl Keychain {
    fn entry() -> Option<keyring::Entry> {
        keyring::Entry::new(SERVICE, ACCOUNT).ok()
    }
}

impl CredentialStore for Keychain {
    fn load(&self) -> Option<String> {
        Self::entry()?.get_password().ok()
    }

    fn save(&self, secret: &str) -> Result<(), String> {
        Self::entry()
            .ok_or_else(|| "Portachiavi non disponibile".to_owned())?
            .set_password(secret)
            .map_err(|_| "Portachiavi non disponibile".to_owned())
    }

    fn delete(&self) {
        if let Some(entry) = Self::entry() {
            let _ = entry.delete_credential();
        }
    }
}
