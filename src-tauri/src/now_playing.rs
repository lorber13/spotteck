//! macOS Now Playing and the hardware media keys (F7/F8/F9, headphones, Control Center).

use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig};
use spotteck_core::state::Payload;
use spotteck_spotify::Engine;
use std::cell::RefCell;
use std::time::Duration;
use tauri::{AppHandle, Runtime};

thread_local! {
    // MediaControls is bound to the main thread on macOS.
    static CONTROLS: RefCell<Option<MediaControls>> = const { RefCell::new(None) };
}

/// Call from the main thread during setup. Spotteck targets macOS; other platforms
/// (used only to build and test) skip it.
pub fn install(engine: Engine) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let config = PlatformConfig { display_name: "Spotteck", dbus_name: "spotteck", hwnd: None };
    let mut controls = match MediaControls::new(config) {
        Ok(controls) => controls,
        Err(e) => return log::warn!("Now Playing unavailable: {e:?}"),
    };
    let attached = controls.attach(move |event| {
        let result = match event {
            MediaControlEvent::Toggle => engine.play_pause(),
            MediaControlEvent::Play if !engine.payload().is_playing => engine.play_pause(),
            MediaControlEvent::Pause if engine.payload().is_playing => engine.play_pause(),
            MediaControlEvent::Next => engine.next(),
            MediaControlEvent::Previous => engine.prev(),
            MediaControlEvent::SetPosition(MediaPosition(at)) => engine.seek(at.as_secs_f64()),
            _ => Ok(()),
        };
        if let Err(e) = result {
            log::info!("Media key ignored: {e}");
        }
    });
    if let Err(e) = attached {
        return log::warn!("Media keys unavailable: {e:?}");
    }
    CONTROLS.with(|c| *c.borrow_mut() = Some(controls));
}

/// Mirrors the player state into Now Playing. Safe to call from any thread.
pub fn update<R: Runtime>(app: &AppHandle<R>, payload: &Payload) {
    let payload = payload.clone();
    let _ = app.run_on_main_thread(move || {
        CONTROLS.with(|c| {
            let mut c = c.borrow_mut();
            let Some(controls) = c.as_mut() else { return };
            if !payload.is_running {
                let _ = controls.set_playback(MediaPlayback::Stopped);
                return;
            }
            let _ = controls.set_metadata(MediaMetadata {
                title: Some(payload.track.as_str()),
                artist: Some(payload.artist.as_str()),
                album: (!payload.album.is_empty()).then_some(payload.album.as_str()),
                cover_url: (!payload.artwork.is_empty()).then_some(payload.artwork.as_str()),
                duration: Some(Duration::from_secs(u64::from(payload.duration))),
            });
            let progress = Some(MediaPosition(Duration::from_secs(u64::from(payload.position))));
            let _ = controls.set_playback(if payload.is_playing {
                MediaPlayback::Playing { progress }
            } else {
                MediaPlayback::Paused { progress }
            });
        });
    });
}
