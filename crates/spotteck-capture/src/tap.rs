//! The samples captured from Spotify, released at the capture rate to the analyzer that
//! turns them into visualizer frames. Nothing is recorded or written anywhere.

use spotteck_core::analysis::{Analyzer, Frame};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// At most this many seconds of audio wait in the tap; more means nobody is draining it.
const MAX_BUFFERED_SECONDS: usize = 3;
const FRAME_INTERVAL: Duration = Duration::from_millis(33);
/// Keep sending frames this long after the last sample so the instruments settle at rest.
const TAIL: Duration = Duration::from_millis(300);

pub struct AudioTap {
    fifo: Mutex<VecDeque<f32>>,
    rate: AtomicU32,
}

impl Default for AudioTap {
    fn default() -> Self {
        AudioTap { fifo: Mutex::new(VecDeque::new()), rate: AtomicU32::new(48_000) }
    }
}

impl AudioTap {
    /// The sample rate of what is being pushed.
    pub fn set_rate(&self, rate: u32) {
        if rate > 0 {
            self.rate.store(rate, Ordering::Relaxed);
        }
    }

    fn rate(&self) -> u32 {
        self.rate.load(Ordering::Relaxed)
    }

    /// Appends interleaved samples with `channels` channels, keeping the first two (a mono
    /// stream is duplicated to both sides).
    pub fn push(&self, samples: &[f32], channels: usize) {
        let channels = channels.max(1);
        let mut fifo = self.fifo.lock().unwrap();
        for frame in samples.chunks_exact(channels) {
            let left = frame[0];
            let right = if channels > 1 { frame[1] } else { left };
            fifo.push_back(left);
            fifo.push_back(right);
        }
        let limit = self.rate() as usize * MAX_BUFFERED_SECONDS * 2;
        let excess = fifo.len().saturating_sub(limit);
        fifo.drain(..excess);
    }

    pub fn clear(&self) {
        self.fifo.lock().unwrap().clear();
    }

    /// Moves up to `frames` stereo frames into `out`.
    fn drain(&self, frames: usize, out: &mut Vec<f32>) {
        let mut fifo = self.fifo.lock().unwrap();
        let n = frames.saturating_mul(2).min(fifo.len() & !1);
        out.extend(fifo.drain(..n));
    }

    /// Releases buffered samples at the capture rate and hands a frame to `on_frame` about
    /// 30 times per second while there is audio.
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
                    let frames = (now.duration_since(last).as_secs_f64() * f64::from(self.rate())).round() as usize;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_keeps_two_channels_and_drain_keeps_frames_whole() {
        let tap = AudioTap::default();
        tap.push(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6], 3);
        let mut out = Vec::new();
        tap.drain(10, &mut out);
        assert_eq!(out, [0.1, 0.2, 0.4, 0.5]);
        tap.push(&[0.7], 1);
        out.clear();
        tap.drain(10, &mut out);
        assert_eq!(out, [0.7, 0.7]);
        tap.push(&[0.1, 0.2], 2);
        tap.clear();
        out.clear();
        tap.drain(10, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn the_buffer_is_bounded_by_the_rate() {
        let tap = AudioTap::default();
        tap.set_rate(1000);
        tap.push(&vec![0.5; 20_000], 2);
        let mut out = Vec::new();
        tap.drain(usize::MAX / 4, &mut out);
        assert_eq!(out.len(), 1000 * MAX_BUFFERED_SECONDS * 2);
    }
}
