//! Windows 10 2004+ / 11: WASAPI process loopback on Spotify.exe and its child processes.
//! Windows asks for no permission; no microphone or recording device is opened.

use crate::{AudioTap, Capture, Status};
use std::collections::{HashSet, VecDeque};
use std::ffi::OsStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::Duration;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use wasapi::{AudioClient, Direction, SampleType, StreamMode, WaveFormat};

const RATE: usize = 48_000;
const CHANNELS: usize = 2;

pub(crate) struct Platform {
    stop: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

fn is_spotify(name: &OsStr) -> bool {
    name.to_string_lossy().eq_ignore_ascii_case("spotify.exe")
}

/// The root Spotify.exe: the one whose parent isn't Spotify too. Its process tree holds the
/// renderer that actually plays.
fn spotify_root() -> Option<u32> {
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let spotify: HashSet<u32> =
        system.processes().iter().filter(|(_, p)| is_spotify(p.name())).map(|(pid, _)| pid.as_u32()).collect();
    system
        .processes()
        .iter()
        .filter(|(pid, p)| {
            spotify.contains(&pid.as_u32()) && !p.parent().is_some_and(|parent| spotify.contains(&parent.as_u32()))
        })
        .map(|(pid, _)| pid.as_u32())
        .min()
}

/// Runs on the capture thread, which owns the COM objects.
fn capture(pid: u32, tap: Arc<AudioTap>, ready: mpsc::Sender<Result<(), Status>>, stop: Arc<AtomicBool>) {
    let fail = |code: i64| Status::Failed(code);
    let setup = || -> Result<_, Status> {
        if wasapi::initialize_mta().is_err() {
            return Err(fail(-1));
        }
        // Windows older than 10 2004 has no process loopback.
        let mut client = AudioClient::new_application_loopback_client(pid, true)
            .map_err(|_| Status::Unsupported("serve Windows 10 versione 2004 o successiva."))?;
        let format = WaveFormat::new(32, 32, &SampleType::Float, RATE, CHANNELS, None);
        let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 200_000 };
        client.initialize_client(&format, &Direction::Capture, &mode).map_err(|_| fail(-2))?;
        let event = client.set_get_eventhandle().map_err(|_| fail(-3))?;
        let reader = client.get_audiocaptureclient().map_err(|_| fail(-4))?;
        client.start_stream().map_err(|_| fail(-5))?;
        Ok((client, event, reader))
    };
    let (client, event, reader) = match setup() {
        Ok(parts) => {
            tap.set_rate(RATE as u32);
            let _ = ready.send(Ok(()));
            parts
        }
        Err(status) => {
            let _ = ready.send(Err(status));
            return;
        }
    };
    let mut bytes = VecDeque::new();
    let mut samples = Vec::new();
    while !stop.load(Ordering::Acquire) {
        // Silence produces no events; the timeout only lets us notice `stop`.
        if event.wait_for_event(500).is_err() {
            continue;
        }
        if reader.read_from_device_to_deque(&mut bytes).is_err() {
            break;
        }
        let whole = bytes.len() / 4 * 4;
        let raw: Vec<u8> = bytes.drain(..whole).collect();
        samples.clear();
        samples.extend(raw.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
        tap.push(&samples, CHANNELS);
    }
    let _ = client.stop_stream();
}

impl Capture for Platform {
    fn targets() -> Vec<u32> {
        spotify_root().into_iter().collect()
    }

    fn open(targets: &[u32], tap: &Arc<AudioTap>) -> Result<Self, Status> {
        let pid = *targets.first().ok_or(Status::Waiting)?;
        let stop = Arc::new(AtomicBool::new(false));
        let running = Arc::new(AtomicBool::new(true));
        let (ready, started) = mpsc::channel();
        let (tap, flag, alive) = (tap.clone(), stop.clone(), running.clone());
        let thread = std::thread::Builder::new()
            .name("spotteck-wasapi".into())
            .spawn(move || {
                capture(pid, tap, ready, flag);
                alive.store(false, Ordering::Release);
            })
            .map_err(|_| Status::Failed(-6))?;
        let capture = Platform { stop, running, thread: Some(thread) };
        match started.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(capture),
            Ok(Err(status)) => Err(status),
            Err(_) => Err(Status::Failed(-7)),
        }
    }

    fn alive(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }
}

impl Drop for Platform {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
