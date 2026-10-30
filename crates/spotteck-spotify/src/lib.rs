//! Spotteck's single connection to Spotify, through librespot.

mod engine;
mod library;
mod tap;

pub use engine::{CredentialStore, Engine, EngineConfig, Profile};
pub use tap::AudioTap;
