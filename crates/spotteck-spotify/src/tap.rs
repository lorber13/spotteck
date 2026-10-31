//! Copies the PCM librespot sends to the audio output so the visualizers analyze exactly what
//! is playing. Nothing is recorded and no input device is opened.

use librespot_playback::audio_backend::{Sink, SinkResult};
use librespot_playback::convert::Converter;
use librespot_playback::decoder::AudioPacket;
use librespot_playback::mixer::VolumeGetter;
use librespot_playback::SAMPLE_RATE;
use spotteck_core::analysis::{Analyzer, Frame};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// At most this much audio waits in the tap; more means nobody is draining it.
const MAX_BUFFERED_FRAMES: usize = SAMPLE_RATE as usize * 3;
const FRAME_INTERVAL: Duration = Duration::from_millis(33);
/// Keep sending frames this long after the last sample so the instruments settle at rest.
const TAIL: Duration = Duration::from_millis(300);

#[derive(Default)]
pub struct AudioTap {
    fifo: Mutex<VecDeque<f32>>,
}

impl AudioTap {
    /// `gain` is the soft volume applied to these samples; it is divided out so the
    /// instruments don't shrink with the volume slider.
    fn push(&self, samples: &[f64], gain: f64) {
        let scale = if gain > 0.001 { 1.0 / gain } else { 0.0 };
        let mut fifo = self.fifo.lock().unwrap();
        fifo.extend(samples.iter().map(|s| (s * scale) as f32));
        let excess = fifo.len().saturating_sub(MAX_BUFFERED_FRAMES * 2);
        fifo.drain(..excess);
    }

    fn clear(&self) {
        self.fifo.lock().unwrap().clear();
    }

    /// Moves up to `frames` stereo frames into `out`.
    fn drain(&self, frames: usize, out: &mut Vec<f32>) {
        let mut fifo = self.fifo.lock().unwrap();
        let n = (frames * 2).min(fifo.len() & !1);
        out.extend(fifo.drain(..n));
    }

    /// Releases buffered samples at the playback rate, so the analysis follows what the
    /// speakers play rather than what was just decoded, and hands a frame to `on_frame`
    /// about 30 times per second while there is audio.
    pub fn spawn_analyzer(self: Arc<Self>, mut on_frame: impl FnMut(Frame) + Send + 'static) {
        std::thread::Builder::new()
            .name("spotteck-analyzer".into())
            .spawn(move || {
                let mut analyzer = Analyzer::new();
                let mut chunk = Vec::new();
                let mut last = Instant::now();
                let mut last_audio: Option<Instant> = None;
                loop {
                    std::thread::sleep(FRAME_INTERVAL);
                    let now = Instant::now();
                    let frames = (now.duration_since(last).as_secs_f64() * f64::from(SAMPLE_RATE)).round() as usize;
                    last = now;
                    chunk.clear();
                    self.drain(frames, &mut chunk);
                    if chunk.is_empty() {
                        match last_audio {
                            Some(at) if now.duration_since(at) < TAIL => {
                                analyzer.push_interleaved(&vec![0.0; frames.min(1024) * 2])
                            }
                            Some(_) => {
                                last_audio = None;
                                analyzer.clear();
                                continue;
                            }
                            None => continue,
                        }
                    } else {
                        last_audio = Some(now);
                        analyzer.push_interleaved(&chunk);
                    }
                    on_frame(analyzer.frame());
                }
            })
            .expect("analyzer thread");
    }
}

/// The rodio sink with a copy of every packet going to the [`AudioTap`].
pub(crate) struct TeeSink {
    inner: Box<dyn Sink>,
    tap: Arc<AudioTap>,
    volume: Box<dyn VolumeGetter + Send>,
}

impl TeeSink {
    pub(crate) fn new(inner: Box<dyn Sink>, tap: Arc<AudioTap>, volume: Box<dyn VolumeGetter + Send>) -> Self {
        TeeSink { inner, tap, volume }
    }
}

impl Sink for TeeSink {
    fn start(&mut self) -> SinkResult<()> {
        self.inner.start()
    }

    fn stop(&mut self) -> SinkResult<()> {
        self.tap.clear();
        self.inner.stop()
    }

    fn write(&mut self, packet: AudioPacket, converter: &mut Converter) -> SinkResult<()> {
        if let AudioPacket::Samples(samples) = &packet {
            self.tap.push(samples, self.volume.attenuation_factor());
        }
        self.inner.write(packet, converter)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_undoes_the_volume_and_drain_keeps_frames_whole() {
        let tap = AudioTap::default();
        tap.push(&[0.25, -0.25, 0.1], 0.5);
        let mut out = Vec::new();
        tap.drain(10, &mut out);
        assert_eq!(out, [0.5, -0.5]);
        tap.clear();
        tap.drain(10, &mut out);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn muted_audio_reads_as_silence_and_the_buffer_is_bounded() {
        let tap = AudioTap::default();
        tap.push(&vec![0.5; MAX_BUFFERED_FRAMES * 4], 0.0);
        let mut out = Vec::new();
        tap.drain(usize::MAX / 4, &mut out);
        assert_eq!(out.len(), MAX_BUFFERED_FRAMES * 2);
        assert!(out.iter().all(|&s| s == 0.0));
    }
}
