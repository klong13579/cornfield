//! In-process audio capture via cpal.
//!
//! Replaces external-process recording (`ffmpeg`/`sox`) with a cross-platform
//! native input stream. Zero external dependencies — cpal uses `CoreAudio`
//! (macOS), `ALSA` (Linux), or `WASAPI` (Windows) directly.
//!
//! # Safety
//! The cpal audio callback runs on a real-time audio thread. All shared state
//! is behind `Arc<Mutex<…>>` — the callback only pushes samples, never
//! allocates or blocks.

#![allow(clippy::arc_with_non_send_sync, reason = "callbacks are intentionally FnMut; Arc is the only safe share")]

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use napi::bindgen_prelude::*;
use napi_derive::napi;

// ---------------------------------------------------------------------------
// N-API class
// ---------------------------------------------------------------------------

/// In-process audio capture.
///
/// Usage (JS):
/// ```js
/// const cap = new AudioCapture();
/// cap.start(16000, 1);
/// // …later…
/// const wavBuffer = cap.stop();   // Uint8Array containing WAV bytes
/// Bun.write("/tmp/out.wav", wavBuffer);
/// ```
#[napi]
pub struct AudioCapture {
	state: Arc<Mutex<CaptureState>>,
}

impl Default for AudioCapture {
	fn default() -> Self {
		Self::new()
	}
}

struct CaptureState {
	stream: Option<cpal::Stream>,
	samples: Option<Arc<Mutex<Vec<i16>>>>,
	running: Option<Arc<AtomicBool>>,
	sample_rate: u32,
	// Live audio level metrics, atomically written from the real-time audio
	// thread and polled from the JS main thread (cheap, lock-free).
	level_rms: Arc<AtomicI32>,
	peak_rms: Arc<AtomicI32>,
}

impl CaptureState {
	fn idle() -> Self {
		Self {
			stream: None,
			samples: None,
			running: None,
			sample_rate: 0,
			level_rms: Arc::new(AtomicI32::new(0)),
			peak_rms: Arc::new(AtomicI32::new(0)),
		}
	}
}

#[napi]
impl AudioCapture {
	#[napi(constructor)]
	pub fn new() -> Self {
		Self { state: Arc::new(Mutex::new(CaptureState::idle())) }
	}

	/// Start capturing audio from the default input device.
	///
	/// Uses the device's native input config (sample rate, channels) so the
	/// stream can always be built. The captured audio is recorded at that
	/// native rate. The transcriber handles resampling to 16 kHz.
	///
	/// `channels` — 1 (mono) is recommended for speech.
	#[napi]
	pub fn start(&self, channels: i32) -> Result<()> {
		let mut state = self.state.lock().map_err(|e| {
			Error::from_reason(format!("AudioCapture lock poisoned: {e}"))
		})?;

		if state.stream.is_some() {
			return Err(Error::from_reason("AudioCapture is already recording"));
		}

		// ---- discover host + device ----
		let host = cpal::default_host();
		let device = host
			.default_input_device()
			.ok_or_else(|| Error::from_reason("No audio input device found"))?;

		// ---- use device's native config ----
		let native_cfg = device.default_input_config().map_err(|e| {
			Error::from_reason(format!("No default input config: {e}"))
		})?;

		let stream_config: cpal::StreamConfig = cpal::StreamConfig {
			channels: channels as cpal::ChannelCount,
			sample_rate: native_cfg.sample_rate(),
			buffer_size: cpal::BufferSize::Default,
		};
		// Record the actual sample rate for WAV encoding.
		let sample_rate = native_cfg.sample_rate().0;

		let samples: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::new()));
		let running = Arc::new(AtomicBool::new(true));
		let samples_cb = Arc::clone(&samples);
		let running_cb = Arc::clone(&running);
		let level_cb = Arc::clone(&state.level_rms);
		let peak_cb = Arc::clone(&state.peak_rms);

		// Reset live levels for the new recording.
		level_cb.store(0, Ordering::Relaxed);
		peak_cb.store(0, Ordering::Relaxed);

		let err_fn = move |err| {
			eprintln!("cpal audio stream error: {err}");
		};

		let stream = device
			.build_input_stream(&stream_config, {
				move |data: &[f32], _: &cpal::InputCallbackInfo| {
					if !running_cb.load(Ordering::Relaxed) {
						return;
					}
					let Ok(mut buf) = samples_cb.lock() else { return };
					// Compute RMS and peak in f32, scale to i16 range to match
					// the SILENCE_RMS_THRESHOLD convention used by listen-controller
					// (Hermes-style: 0-32767 scale).
					let mut sum_sq: f64 = 0.0;
					let mut peak: f32 = 0.0;
					for &sample in data {
						let abs = sample.abs();
						if abs > peak {
							peak = abs;
						}
						sum_sq = f64::from(sample).mul_add(f64::from(sample), sum_sq);
						// Convert f32 [−1, 1] → i16 [−32768, 32767]
						let scaled = sample * 32767.0_f32;
						buf.push((scaled as i16).clamp(i16::MIN, i16::MAX));
					}
					if !data.is_empty() {
						let rms = (sum_sq / data.len() as f64).sqrt() * 32767.0;
						level_cb.store(rms as i32, Ordering::Relaxed);
						let peak_i = (peak * 32767.0) as i32;
						// peak only ratchets up; never decreases during a session
						let prev = peak_cb.load(Ordering::Relaxed);
						if peak_i > prev {
							peak_cb.store(peak_i, Ordering::Relaxed);
						}
					}
				}
			}, err_fn, None)
			.map_err(|e| Error::from_reason(format!("Failed to build audio stream: {e}")))?;

		stream
			.play()
			.map_err(|e| Error::from_reason(format!("Failed to start audio stream: {e}")))?;

		state.stream = Some(stream);
		state.samples = Some(samples);
		state.running = Some(running);
		state.sample_rate = sample_rate;

		Ok(())
	}

	/// Stop recording and return the captured audio as a WAV buffer.
	///
	/// Returns the WAV bytes as a `Buffer` (`Uint8Array`). Call
	/// `Bun.write(path, buffer)` in JS to persist to disk.
	///
	/// # Errors
	/// Returns an error if no recording is active.
	#[napi]
	pub fn stop(&self) -> Result<Buffer> {
		let mut state = self.state.lock().map_err(|e| {
			Error::from_reason(format!("AudioCapture lock poisoned: {e}"))
		})?;

		let sample_rate = state.sample_rate;

		// Read fields before dropping the stream.
		let stream = state.stream.take().ok_or_else(|| {
			Error::from_reason("AudioCapture is not recording")
		})?;
		let samples_arc = state.samples.take().unwrap();
		let running = state.running.take().unwrap();

		// Signal the callback to stop pushing.
		running.store(false, Ordering::Relaxed);

		// Drop the stream — this synchronises with the audio callback
		// thread so no more samples arrive after drop() returns.
		drop(stream);

		// Take accumulated samples.
		let samples = match Arc::into_inner(samples_arc) {
			Some(m) => m.into_inner().unwrap_or_default(),
			None => Vec::new(),
		};

		if samples.is_empty() {
			return Err(Error::from_reason(
				"No audio captured — check microphone permissions",
			));
		}

		// Encode as WAV at the device's native sample rate.
		// The transcriber handles resampling to 16 kHz.
		let bytes = encode_wav_i16_mono(&samples, sample_rate);
		log_audio_stats(bytes.len(), &samples, sample_rate);

		Ok(Buffer::from(bytes))
	}

	/// Current RMS audio level, in the i16 range [0, 32767].
	///
	/// Updated continuously by the audio thread. Returns 0 when not
	/// recording. Use this for live level meters and VAD (voice activity
	/// detection).
	#[napi]
	pub fn get_level(&self) -> i32 {
		let Ok(state) = self.state.lock() else { return 0 };
		state.level_rms.load(Ordering::Relaxed)
	}

	/// Peak RMS audio level seen since `start()`, in the i16 range [0, 32767].
	///
	/// Monotonically non-decreasing during a recording session. Use this
	/// to detect "did the user actually speak" after stop (analogous to
	/// Hermes' peak-RMS silence gate).
	#[napi]
	pub fn get_peak(&self) -> i32 {
		let Ok(state) = self.state.lock() else { return 0 };
		state.peak_rms.load(Ordering::Relaxed)
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn log_audio_stats(wav_len: usize, samples: &[i16], sample_rate: u32) {
	let len_s = samples.len() as f64 / sample_rate as f64;
	let max_amp = samples.iter().map(|s| s.abs()).max().unwrap_or(0);
	eprintln!(
		"[audio] captured {:.1}s ({len} i16) @ {rate}Hz, {wav_len}-byte WAV, peak={peak}",
		len_s,
		len = samples.len(),
		rate = sample_rate,
		peak = max_amp,
	);
}

// ---------------------------------------------------------------------------
// Manual WAV encoding (16-bit mono)
// ---------------------------------------------------------------------------

/// Encode 16-bit mono PCM samples into a RIFF/WAV byte buffer.
///
/// This is ~30 lines that replaces a `hound` dependency. The WAV format is
/// stable and the header is trivial — not worth pulling in a crate.
fn encode_wav_i16_mono(samples: &[i16], sample_rate: u32) -> Vec<u8> {
	let channels = 1u16;
	let bits_per_sample = 16u16;
	let block_align = channels * (bits_per_sample / 8);
	let byte_rate = sample_rate * block_align as u32;
	let data_size = samples.len() as u32 * 2;
	let riff_size = 36 + data_size;

	let mut buf = Vec::with_capacity(44 + samples.len() * 2);

	buf.extend_from_slice(b"RIFF");
	buf.extend_from_slice(&riff_size.to_le_bytes());
	buf.extend_from_slice(b"WAVE");

	buf.extend_from_slice(b"fmt ");
	buf.extend_from_slice(&16u32.to_le_bytes()); // sub-chunk size
	buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
	buf.extend_from_slice(&channels.to_le_bytes());
	buf.extend_from_slice(&sample_rate.to_le_bytes());
	buf.extend_from_slice(&byte_rate.to_le_bytes());
	buf.extend_from_slice(&block_align.to_le_bytes());
	buf.extend_from_slice(&bits_per_sample.to_le_bytes());

	buf.extend_from_slice(b"data");
	buf.extend_from_slice(&data_size.to_le_bytes());

	for &s in samples {
		buf.extend_from_slice(&s.to_le_bytes());
	}

	buf
}
