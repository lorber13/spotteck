//! Linux: a PipeWire capture stream linked to Spotify's own playback stream (what
//! `pw-record --target <spotify>` does). The stream never falls back to another source, so
//! no microphone is ever opened. Systems without PipeWire get no visualizers.

use crate::{AudioTap, Reporter, Status};
use pipewire as pw;
use pw::properties::properties;
use pw::spa;
use pw::spa::param::format::{MediaSubtype, MediaType};
use pw::spa::param::format_utils;
use pw::spa::pod::Pod;
use pw::types::ObjectType;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

/// Whether a playback stream belongs to Spotify (native, Flatpak or Snap builds).
pub(crate) fn is_spotify(binary: Option<&str>, application: Option<&str>) -> bool {
    let matches = |value: Option<&str>| value.is_some_and(|v| v.to_ascii_lowercase().contains("spotify"));
    matches(binary) || matches(application)
}

struct Open {
    target: u32,
    _stream: pw::stream::Stream,
    _listener: pw::stream::StreamListener<Format>,
}

#[derive(Default)]
struct Format {
    info: spa::param::audio::AudioInfoRaw,
}

#[derive(Default)]
struct State {
    /// Spotify's playback streams: global id → object serial.
    spotify: BTreeMap<u32, String>,
    open: Option<Open>,
}

fn format_params() -> Vec<u8> {
    let mut info = spa::param::audio::AudioInfoRaw::new();
    info.set_format(spa::param::audio::AudioFormat::F32LE);
    let object = spa::pod::Object {
        type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
        id: spa::param::ParamType::EnumFormat.as_raw(),
        properties: info.into(),
    };
    spa::pod::serialize::PodSerializer::serialize(std::io::Cursor::new(Vec::new()), &spa::pod::Value::Object(object))
        .map(|(cursor, _)| cursor.into_inner())
        .unwrap_or_default()
}

fn open(core: &pw::core::Core, target: u32, serial: &str, tap: &Arc<AudioTap>) -> Result<Open, pw::Error> {
    let props = properties! {
        *pw::keys::MEDIA_TYPE => "Audio",
        *pw::keys::MEDIA_CATEGORY => "Capture",
        *pw::keys::MEDIA_ROLE => "Music",
        *pw::keys::NODE_NAME => "spotteck-visualizer",
        "target.object" => serial,
        // Never move to another node (e.g. the default microphone) if Spotify's stream goes away.
        "node.dont-reconnect" => "true",
        "node.dont-fallback" => "true",
        "node.passive" => "true",
    };
    let stream = pw::stream::Stream::new(core, "Spotteck visualizer", props)?;
    let process_tap = tap.clone();
    let format_tap = tap.clone();
    let listener = stream
        .add_local_listener_with_user_data(Format::default())
        .param_changed(move |_, format, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            match format_utils::parse_format(param) {
                Ok((MediaType::Audio, MediaSubtype::Raw)) => {}
                _ => return,
            }
            if format.info.parse(param).is_ok() {
                format_tap.set_rate(format.info.rate());
            }
        })
        .process(move |stream, format| {
            let Some(mut buffer) = stream.dequeue_buffer() else { return };
            let datas = buffer.datas_mut();
            let Some(data) = datas.first_mut() else { return };
            let size = data.chunk().size() as usize;
            let offset = data.chunk().offset() as usize;
            let Some(bytes) = data.data() else { return };
            let end = offset.saturating_add(size).min(bytes.len());
            let Some(bytes) = bytes.get(offset..end) else { return };
            let samples: Vec<f32> =
                bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
            process_tap.push(&samples, format.info.channels().max(1) as usize);
        })
        .register()?;
    let params = format_params();
    let mut params = [Pod::from_bytes(&params).ok_or(pw::Error::CreationFailed)?];
    stream.connect(
        spa::utils::Direction::Input,
        None,
        // Processed on this loop's thread, not the realtime one: the analysis is not latency-critical.
        pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
        &mut params,
    )?;
    Ok(Open { target, _stream: stream, _listener: listener })
}

/// One connection to PipeWire; returns when it fails or is lost.
fn session(tap: &Arc<AudioTap>, reporter: &Rc<RefCell<Reporter>>) -> Result<(), pw::Error> {
    let main_loop = pw::main_loop::MainLoop::new(None)?;
    let context = pw::context::Context::new(&main_loop)?;
    let core = Rc::new(context.connect(None)?);
    let registry = core.get_registry()?;
    let state = Rc::new(RefCell::new(State::default()));

    let weak_loop = main_loop.downgrade();
    let _core_listener = core
        .add_listener_local()
        .error(move |id, _seq, _res, message| {
            if id == pw::core::PW_ID_CORE {
                log::warn!("PipeWire connection lost: {message}");
                if let Some(main_loop) = weak_loop.upgrade() {
                    main_loop.quit();
                }
            }
        })
        .register();

    let added = state.clone();
    let removed = state.clone();
    let _registry_listener = registry
        .add_listener_local()
        .global(move |global| {
            if global.type_ != ObjectType::Node {
                return;
            }
            let Some(props) = global.props else { return };
            if props.get("media.class") != Some("Stream/Output/Audio")
                || !is_spotify(props.get("application.process.binary"), props.get("application.name"))
            {
                return;
            }
            if let Some(serial) = props.get("object.serial") {
                added.borrow_mut().spotify.insert(global.id, serial.to_owned());
            }
        })
        .global_remove(move |id| {
            removed.borrow_mut().spotify.remove(&id);
        })
        .register();

    let (timer_state, timer_core, timer_tap, timer_reporter) =
        (state.clone(), core.clone(), tap.clone(), reporter.clone());
    let timer = main_loop.loop_().add_timer(move |_| {
        let mut state = timer_state.borrow_mut();
        let target = state.spotify.iter().next_back().map(|(id, serial)| (*id, serial.clone()));
        if state.open.as_ref().is_some_and(|o| Some(o.target) != target.as_ref().map(|t| t.0)) {
            state.open = None;
            timer_tap.clear();
        }
        match target {
            None => timer_reporter.borrow_mut().report(Status::Waiting),
            Some(_) if state.open.is_some() => {}
            Some((id, serial)) => match open(&timer_core, id, &serial, &timer_tap) {
                Ok(stream) => {
                    state.open = Some(stream);
                    timer_reporter.borrow_mut().report(Status::Listening);
                }
                Err(e) => {
                    log::info!("PipeWire capture not started: {e}");
                    timer_reporter.borrow_mut().report(Status::Failed(-1));
                }
            },
        }
    });
    timer.update_timer(Some(Duration::from_millis(500)), Some(Duration::from_secs(1))).into_result()?;

    main_loop.run();
    state.borrow_mut().open = None;
    Ok(())
}

pub(crate) fn run(tap: Arc<AudioTap>, reporter: Reporter) {
    pw::init();
    let reporter = Rc::new(RefCell::new(reporter));
    loop {
        if let Err(e) = session(&tap, &reporter) {
            log::info!("PipeWire unavailable: {e}");
            reporter.borrow_mut().report(Status::Unsupported("su Linux serve PipeWire."));
        }
        tap.clear();
        std::thread::sleep(Duration::from_secs(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spotify_streams_are_recognized() {
        assert!(is_spotify(Some("spotify"), None));
        assert!(is_spotify(None, Some("Spotify")));
        assert!(is_spotify(Some("/app/extra/share/spotify/spotify"), Some("spotify")));
        assert!(!is_spotify(Some("firefox"), Some("Firefox")));
        assert!(!is_spotify(None, None));
    }
}
