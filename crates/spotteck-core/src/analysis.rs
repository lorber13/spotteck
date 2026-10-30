//! Turns the PCM the player is sending to the speakers into the frames the visualizers
//! draw: a 256-bin spectrum, a 512-sample waveform and stereo RMS/peak levels. The
//! scaling matches the Core Audio helper of Spotteck 1.x, so the instruments look the same.

use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use serde::Serialize;
use std::sync::Arc;

pub const WINDOW: usize = 512;
pub const BINS: usize = WINDOW / 2;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Levels {
    pub rms: [f32; 2],
    pub peak: [f32; 2],
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Frame {
    pub frequency: Vec<u8>,
    pub time: Vec<u8>,
    pub levels: Levels,
}

impl Frame {
    /// Whether the waveform deviates from silence, as the 1.x status line measured it.
    pub fn has_signal(&self) -> bool {
        self.time.iter().any(|&v| (i16::from(v) - 128).abs() > 1)
    }
}

pub struct Analyzer {
    left: [f32; WINDOW],
    right: [f32; WINDOW],
    cursor: usize,
    hann: [f32; WINDOW],
    fft: Arc<dyn Fft<f32>>,
    scratch: Vec<Complex32>,
}

impl Default for Analyzer {
    fn default() -> Self {
        Analyzer::new()
    }
}

impl Analyzer {
    pub fn new() -> Self {
        let mut hann = [0.0; WINDOW];
        for (n, w) in hann.iter_mut().enumerate() {
            // vDSP_HANN_NORM: a Hann window scaled to unit RMS gain.
            *w = 0.816_496_6 * (1.0 - (2.0 * std::f32::consts::PI * n as f32 / WINDOW as f32).cos());
        }
        let fft = FftPlanner::new().plan_fft_forward(WINDOW);
        let scratch = vec![Complex32::default(); fft.get_inplace_scratch_len()];
        Analyzer { left: [0.0; WINDOW], right: [0.0; WINDOW], cursor: 0, hann, fft, scratch }
    }

    /// Appends interleaved stereo samples in -1.0..=1.0.
    pub fn push_interleaved(&mut self, samples: &[f32]) {
        for frame in samples.chunks_exact(2) {
            self.left[self.cursor] = sanitize(frame[0]);
            self.right[self.cursor] = sanitize(frame[1]);
            self.cursor = (self.cursor + 1) % WINDOW;
        }
    }

    pub fn clear(&mut self) {
        self.left = [0.0; WINDOW];
        self.right = [0.0; WINDOW];
    }

    pub fn frame(&mut self) -> Frame {
        let mono: Vec<f32> = (0..WINDOW)
            .map(|i| {
                let j = (self.cursor + i) % WINDOW;
                (self.left[j] + self.right[j]) * 0.5
            })
            .collect();
        let time = mono.iter().map(|s| (128.0 + s * 127.0).clamp(0.0, 255.0) as u8).collect();

        let mut buffer: Vec<Complex32> = mono.iter().zip(&self.hann).map(|(s, w)| Complex32::new(s * w, 0.0)).collect();
        self.fft.process_with_scratch(&mut buffer, &mut self.scratch);
        let frequency = buffer[..BINS]
            .iter()
            .enumerate()
            .map(|(k, c)| {
                // vDSP's packed real FFT returns twice the DFT and folds Nyquist into bin 0's
                // imaginary part, which the 1.x helper zeroed; reproduce both.
                let c = if k == 0 { Complex32::new(c.re, 0.0) } else { *c };
                let power = 4.0 * c.norm_sqr() / (WINDOW * WINDOW) as f32;
                let db = 10.0 * power.max(1e-12).log10() + 100.0;
                (db / 70.0 * 255.0).clamp(0.0, 255.0) as u8
            })
            .collect();

        let (lr, lp) = levels(&self.left);
        let (rr, rp) = levels(&self.right);
        Frame { frequency, time, levels: Levels { rms: [lr, rr], peak: [lp, rp] } }
    }
}

fn sanitize(sample: f32) -> f32 {
    if sample.is_finite() {
        sample.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

fn levels(values: &[f32]) -> (f32, f32) {
    let rms = (values.iter().map(|v| v * v).sum::<f32>() / values.len() as f32).sqrt();
    let peak = values.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    (rms, peak)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(frequency_bin: usize, amplitude: f32, right_scale: f32) -> Vec<f32> {
        (0..WINDOW * 2)
            .flat_map(|n| {
                let s =
                    amplitude * (2.0 * std::f32::consts::PI * frequency_bin as f32 * n as f32 / WINDOW as f32).sin();
                [s, s * right_scale]
            })
            .collect()
    }

    #[test]
    fn silence_is_flat() {
        let mut analyzer = Analyzer::new();
        analyzer.push_interleaved(&vec![0.0; WINDOW * 2]);
        let frame = analyzer.frame();
        assert_eq!(frame.frequency.len(), BINS);
        assert_eq!(frame.time.len(), WINDOW);
        assert!(frame.time.iter().all(|&v| v == 128));
        assert!(frame.frequency.iter().all(|&v| v == 0));
        assert!(!frame.has_signal());
        assert_eq!(frame.levels, Levels { rms: [0.0, 0.0], peak: [0.0, 0.0] });
    }

    #[test]
    fn a_tone_peaks_at_its_bin() {
        let mut analyzer = Analyzer::new();
        // Quiet enough that neighbouring bins don't all clip at 255.
        analyzer.push_interleaved(&tone(32, 0.01, 1.0));
        let frame = analyzer.frame();
        let loudest = frame.frequency.iter().enumerate().max_by_key(|(_, v)| **v).unwrap().0;
        assert_eq!(loudest, 32, "{:?}", &frame.frequency[28..37]);
        assert!(frame.frequency[32] > 150, "{}", frame.frequency[32]);
        assert!(frame.frequency[100] < frame.frequency[32] / 2);
        assert!(frame.has_signal());
    }

    #[test]
    fn levels_are_per_channel() {
        let mut analyzer = Analyzer::new();
        analyzer.push_interleaved(&tone(8, 0.8, 0.25));
        let Levels { rms, peak } = analyzer.frame().levels;
        assert!((rms[0] - 0.8 / 2f32.sqrt()).abs() < 0.01, "{rms:?}");
        assert!((rms[1] - 0.2 / 2f32.sqrt()).abs() < 0.01, "{rms:?}");
        assert!((peak[0] - 0.8).abs() < 0.01 && (peak[1] - 0.2).abs() < 0.01, "{peak:?}");
    }

    #[test]
    fn invalid_samples_are_ignored() {
        let mut analyzer = Analyzer::new();
        analyzer.push_interleaved(&[f32::NAN, f32::INFINITY, 3.0, -3.0]);
        let frame = analyzer.frame();
        assert!(frame.levels.peak[0] <= 1.0 && frame.levels.peak[1] <= 1.0);
        assert!(frame.levels.rms.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn serializes_like_the_1x_helper() {
        let json = serde_json::to_value(Analyzer::new().frame()).unwrap();
        assert_eq!(json["frequency"].as_array().unwrap().len(), 256);
        assert_eq!(json["time"].as_array().unwrap().len(), 512);
        assert_eq!(json["levels"]["rms"].as_array().unwrap().len(), 2);
        assert_eq!(json["levels"]["peak"].as_array().unwrap().len(), 2);
    }
}
