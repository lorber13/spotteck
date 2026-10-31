//! The system media controls and the hardware media keys: Now Playing on macOS
//! (F7/F8/F9, headphones, Control Center), MPRIS on Linux, SMTC on Windows.

use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig};
use spotteck_core::state::Payload;
use spotteck_spotify::Engine;
use std::cell::RefCell;
use std::time::Duration;
use tauri::{App, AppHandle, Runtime};

thread_local! {
    // MediaControls is bound to the main thread on macOS.
    static CONTROLS: RefCell<Option<MediaControls>> = const { RefCell::new(None) };
}

/// Call from the main thread during setup.
pub fn install<R: Runtime>(app: &App<R>, engine: Engine) {
    let config = PlatformConfig { display_name: "Spotteck", dbus_name: "spotteck", hwnd: window_handle(app) };
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

/// Windows ties the media controls to a window.
#[cfg(target_os = "windows")]
fn window_handle<R: Runtime>(app: &App<R>) -> Option<*mut std::ffi::c_void> {
    use tauri::Manager;
    let hwnd = app.get_webview_window("main")?.hwnd().ok()?;
    Some(hwnd.0 as *mut std::ffi::c_void)
}

#[cfg(not(target_os = "windows"))]
fn window_handle<R: Runtime>(_app: &App<R>) -> Option<*mut std::ffi::c_void> {
    None
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
