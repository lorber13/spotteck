//! The visualizer audio. Spotteck plays nothing itself, so it listens to what the official
//! Spotify app plays on this computer through each OS's per-process loopback:
//!
//! - macOS 14.2+: a Core Audio process tap (asks once for "system audio recording only");
//! - Windows 10 2004+: WASAPI process loopback;
//! - Linux: a PipeWire capture stream linked to Spotify's playback stream.
//!
//! No microphone is opened, nothing is recorded, and the audio output is not changed.
//! When Spotify plays on another device (a phone, a speaker), the visualizers rest.

mod tap;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

pub use tap::AudioTap;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::sync::Arc;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::time::{Duration, Instant};

/// What the capture is doing, for the "Visualizzatori" line in Settings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    /// Spotify isn't playing on this computer.
    Waiting,
    Listening,
    PermissionDenied,
    Unsupported(&'static str),
    Failed(i64),
}

impl Status {
    pub fn message(&self) -> String {
        match self {
            Status::Waiting => "Visualizzatori: avvia la musica con Spotify su questo computer.".into(),
            Status::Listening => "Visualizzatori: collegati a Spotify su questo computer.".into(),
            Status::PermissionDenied => "Visualizzatori: consenti a Spotteck la registrazione dell’audio di sistema \
                 (Impostazioni di Sistema › Privacy e sicurezza)."
                .into(),
            Status::Unsupported(reason) => format!("Visualizzatori non disponibili: {reason}"),
            Status::Failed(code) => format!("Analisi audio non disponibile (codice {code})."),
        }
    }
}

/// Starts following Spotify on this computer. `on_status` is called when the status changes.
pub fn start(tap: std::sync::Arc<AudioTap>, on_status: impl Fn(Status) + Send + 'static) {
    let reporter = Reporter::new(on_status);
    let spawned = std::thread::Builder::new().name("spotteck-capture".into()).spawn(move || {
        #[cfg(target_os = "macos")]
        supervise::<macos::Platform>(tap, reporter);
        #[cfg(target_os = "windows")]
        supervise::<windows::Platform>(tap, reporter);
        #[cfg(target_os = "linux")]
        linux::run(tap, reporter);
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            drop(tap);
            reporter.report(Status::Unsupported("sistema operativo non supportato."));
        }
    });
    if let Err(e) = spawned {
        log::warn!("Could not start the audio capture: {e}");
    }
}

/// Reports a status only when it changes.
pub(crate) struct Reporter {
    last: Option<Status>,
    callback: Box<dyn Fn(Status) + Send>,
}

impl Reporter {
    fn new(callback: impl Fn(Status) + Send + 'static) -> Reporter {
        Reporter { last: None, callback: Box::new(callback) }
    }

    pub(crate) fn report(&mut self, status: Status) {
        if self.last.as_ref() != Some(&status) {
            self.last = Some(status.clone());
            (self.callback)(status);
        }
    }
}

/// One OS backend that captures a set of processes.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) trait Capture: Sized {
    /// The Spotify processes to capture right now (empty when Spotify isn't running).
    fn targets() -> Vec<u32>;
    fn open(targets: &[u32], tap: &Arc<AudioTap>) -> Result<Self, Status>;
    fn alive(&self) -> bool;
}

/// Opens a capture when Spotify appears, reopens it when its processes change, and drops
/// it (which stops it) when Spotify quits.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn supervise<C: Capture>(tap: Arc<AudioTap>, mut reporter: Reporter) {
    let mut current: Option<(Vec<u32>, C)> = None;
    let mut retry_at = Instant::now();
    loop {
        let targets = C::targets();
        if targets.is_empty() {
            if current.take().is_some() {
                tap.clear();
            }
            reporter.report(Status::Waiting);
        } else {
            let stale = current.as_ref().is_none_or(|(open, capture)| *open != targets || !capture.alive());
            if stale && Instant::now() >= retry_at {
                current = None;
                match C::open(&targets, &tap) {
                    Ok(capture) => {
                        current = Some((targets, capture));
                        reporter.report(Status::Listening);
                    }
                    Err(status) => {
                        log::info!("Audio capture not started: {status:?}");
                        retry_at = Instant::now() + Duration::from_secs(10);
                        reporter.report(status);
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn statuses_are_reported_once_per_change() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let mut reporter = Reporter::new(move |s| sink.lock().unwrap().push(s));
        for status in [Status::Waiting, Status::Waiting, Status::Listening, Status::Listening, Status::Waiting] {
            reporter.report(status);
        }
        assert_eq!(*seen.lock().unwrap(), [Status::Waiting, Status::Listening, Status::Waiting]);
    }

    #[test]
    fn messages_are_italian_and_never_mention_the_microphone() {
        for status in [
            Status::Waiting,
            Status::Listening,
            Status::PermissionDenied,
            Status::Unsupported("serve PipeWire."),
            Status::Failed(-50),
        ] {
            let text = status.message();
            assert!(text.starts_with("Visualizzatori") || text.starts_with("Analisi audio"), "{text}");
            assert!(!text.to_lowercase().contains("microfono"));
        }
    }
}
