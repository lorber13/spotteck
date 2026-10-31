// No console window on release builds for Windows; harmless elsewhere.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod credentials;

use commands::App;
use spotteck_capture::{AudioTap, Status};
use spotteck_core::pinned::PinnedStore;
use spotteck_core::readiness::Readiness;
use spotteck_core::settings::SettingsStore;
use spotteck_core::state::Payload;
use spotteck_spotify::{Engine, EngineConfig};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

/// The name the user gave this computer (System Settings → General → About on macOS). Spotify
/// on this computer usually appears under this name in the Connect device list.
#[cfg(target_os = "macos")]
fn computer_name() -> Option<String> {
    let output = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output().ok()?;
    String::from_utf8(output.stdout).ok()
}

#[cfg(target_os = "windows")]
fn computer_name() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn computer_name() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/hostname").or_else(|_| std::fs::read_to_string("/etc/hostname")).ok()
}

fn this_computer() -> String {
    computer_name().map(|n| n.trim().to_owned()).unwrap_or_default()
}

fn on_state(app: AppHandle) -> impl Fn(Payload) + Send + Sync {
    let last_readiness = Mutex::new(Readiness::SignedOut);
    move |payload: Payload| {
        let _ = app.emit("spotify:state", &payload);
        let mut last = last_readiness.lock().unwrap();
        if *last != payload.readiness {
            // Signing in or out changes which playlists the grid shows.
            if payload.readiness == Readiness::Ready || *last == Readiness::Ready {
                let _ = app.emit("playlists:changed", ());
            }
            *last = payload.readiness.clone();
        }
    }
}

/// The visualizers listen to Spotify on this computer through the OS's per-process loopback.
fn start_visualizer_audio(app: AppHandle, tap: Arc<AudioTap>) {
    let status_app = app.clone();
    spotteck_capture::start(tap.clone(), move |status: Status| {
        let _ = status_app.emit("audio:status", status.message());
    });
    let mut status_at: Option<Instant> = None;
    tap.spawn_analyzer(move |frame| {
        let _ = app.emit("audio:frame", &frame);
        if status_at.is_none_or(|at| at.elapsed() > Duration::from_secs(1)) {
            status_at = Some(Instant::now());
            let status = if frame.has_signal() {
                "Visualizzatori: audio reale collegato."
            } else {
                "Visualizzatori: audio collegato, silenzio."
            };
            let _ = app.emit("audio:status", status);
        }
    });
}

/// The renderer interpolates the position itself; a 1 s heartbeat keeps it honest.
fn start_heartbeat(app: AppHandle, engine: Engine) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tick.tick().await;
            let payload = engine.payload();
            if payload.is_playing {
                let _ = app.emit("spotify:state", &payload);
            }
        }
    });
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app.path().app_data_dir()?;
            let pinned = PinnedStore::new(data_dir.join("playlists.json"));
            if let Ok(support) = app.path().data_dir() {
                // Playlists pinned in Spotteck 1.x (Electron).
                pinned.import_legacy(&support.join("Spotteck/user-data/playlists.json"));
            }

            let settings = Arc::new(SettingsStore::new(data_dir.join("settings.json")));
            let client_id = settings.clone();
            let engine = Engine::new(EngineConfig {
                computer_name: this_computer(),
                client_id: Box::new(move || client_id.client_id()),
                credentials: Arc::new(credentials::Keychain),
                on_state: Box::new(on_state(handle.clone())),
            });

            start_visualizer_audio(handle.clone(), Arc::new(AudioTap::default()));
            start_heartbeat(handle.clone(), engine.clone());
            let starting = engine.clone();
            tauri::async_runtime::spawn(async move { starting.start() });

            app.manage(App { engine, pinned, settings });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::play_pause,
            commands::next,
            commands::prev,
            commands::set_shuffle,
            commands::seek,
            commands::set_volume,
            commands::play_uri,
            commands::play_track_in_context,
            commands::get_profile,
            commands::login,
            commands::logout,
            commands::get_client_id,
            commands::set_client_id,
            commands::open_developer_dashboard,
            commands::playlists_get,
            commands::playlists_tracks,
            commands::playlists_add_url,
            commands::playlists_remove,
        ])
        .build(tauri::generate_context!())
        .expect("Spotteck failed to start");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<App>() {
                state.engine.disconnect();
            }
        }
    });
}
