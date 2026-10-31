//! Spotteck's connection to Spotify, through the official Web API only. Spotteck plays no
//! audio itself: it controls the user's own Spotify apps (desktop, phone, speakers).

mod api;
mod auth;
mod engine;
mod library;

pub use engine::{CredentialStore, Engine, EngineConfig, Profile};
pub use spotteck_core::pkce::{is_client_id, REDIRECT_URI};
