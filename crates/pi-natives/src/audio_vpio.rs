//! macOS hardware AEC voice session via AVAudioEngine voice processing.
//!
//! One `AVAudioEngine` owns both directions: the input node runs with
//! `voiceProcessingEnabled` (Apple's system AEC + AGC + noise suppression —
//! the same path FaceTime/Zoom use), and the assistant's playback is
//! scheduled through the SAME engine's player node, which is exactly the
//! reference the voice processing cancels from the mic. Raw miniaudio
//! capture/playback cannot do this: the AEC only sees audio played through
//! its own engine.
//!
//! The legacy CoreAudio C API (VoiceProcessingIO AudioUnit) was attempted
//! first and rejected on macOS 14.1 (`kAudioOutputUnitProperty_SetInputCallback`
//! fails with -10879 on every scope/element combination) — AVAudioEngine is
//! the supported modern route.
//!
//! Non-macOS platforms expose a stub whose constructor always fails; callers
//! fall back to the miniaudio path.

#[cfg(not(target_os = "macos"))]
mod stub {
	use napi::bindgen_prelude::Result;
	use napi_derive::napi;

	/// Stub on non-macOS platforms — construction always fails so callers fall
	/// back to the raw miniaudio capture/playback path.
	#[napi]
	pub struct AudioVoiceSession {}

	#[napi]
	impl AudioVoiceSession {
		#[napi(constructor)]
		pub fn new(_sample_rate: u32) -> Result<Self> {
			Err(napi::Error::from_reason(
				"VoiceProcessingIO AEC is only available on macOS",
			))
		}
	}
}

#[cfg(not(target_os = "macos"))]
pub use stub::AudioVoiceSession;

#[cfg(target_os = "macos")]
mod macos {
	use std::{
		ffi::{CStr, c_char},
		sync::{
			Arc,
			atomic::{AtomicBool, AtomicU32, Ordering},
		},
	};

	use block2::RcBlock;
	use napi::{
		bindgen_prelude::{Float32Array, Result},
		threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
	};
	use napi_derive::napi;
	use objc2::{class, msg_send, runtime::AnyObject};
	use parking_lot::Mutex;
	use tokio::sync::Notify;

	type CaptureCallback = ThreadsafeFunction<Float32Array, UnknownReturnValue>;

	/// ObjC object handle. AVAudioEngine objects are internally thread-safe;
	/// every use here is additionally guarded by our own lock/stop discipline.
	#[derive(Clone, Copy)]
	struct ObjPtr(*mut AnyObject);
	unsafe impl Send for ObjPtr {}
	unsafe impl Sync for ObjPtr {}

	impl ObjPtr {
		fn get(self) -> *mut AnyObject {
			self.0
		}
	}

	/// Take ownership of an autoreleased object (+1 retain).
	unsafe fn retain_obj(ptr: *mut AnyObject) -> ObjPtr {
		if !ptr.is_null() {
			let _: () = msg_send![ptr, retain];
		}
		ObjPtr(ptr)
	}

	unsafe fn release_obj(ptr: ObjPtr) {
		if !ptr.0.is_null() {
			let _: () = msg_send![ptr.0, release];
		}
	}

	unsafe fn nsstring_to_string(obj: *mut AnyObject) -> String {
		unsafe {
			if obj.is_null() {
				return String::new();
			}
			let utf8: *const c_char = msg_send![obj, UTF8String];
			if utf8.is_null() {
				return String::new();
			}
			CStr::from_ptr(utf8).to_string_lossy().into_owned()
		}
	}

	unsafe fn error_detail(error: *mut AnyObject) -> String {
		unsafe {
			if error.is_null() {
				return String::from("unknown error");
			}
			let description: *mut AnyObject = msg_send![error, localizedDescription];
			nsstring_to_string(description)
		}
	}

	/// Linear-interpolation resampler (voice-grade, any rate → target rate).
	struct Resampler {
		ratio: f64,
		pos: f64,
	}

	impl Resampler {
		fn new(source_rate: f64, target_rate: f64) -> Self {
			Self {
				ratio: source_rate / target_rate,
				pos: 0.0,
			}
		}

		fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
			let mut i = self.pos;
			let len = input.len() as f64;
			while i < len {
				let idx = i as usize;
				let frac = (i - idx as f64) as f32;
				let a = input[idx];
				let b = if idx + 1 < input.len() { input[idx + 1] } else { a };
				out.push(a + (b - a) * frac);
				i += self.ratio;
			}
			self.pos = i - len;
		}
	}

	struct SessionState {
		capture_cb: Mutex<Option<CaptureCallback>>,
		/// Created on the first tap callback, when the hardware rate is known.
		resampler: Mutex<Option<Resampler>>,
		target_rate: f64,
		/// Highest generation fully played — `end_playback(gen)` waits on it.
		consumed_gen: AtomicU32,
		/// Highest generation ever queued — `clear_playback` advances
		/// consumed_gen here so discarded generations still resolve.
		queued_gen: AtomicU32,
		notify: Notify,
		stopped: AtomicBool,
	}

	/// Mono mixdown + resample one tap buffer, then hand it to JS.
	unsafe fn deliver_capture(state: &Arc<SessionState>, buffer: *mut AnyObject) {
		unsafe {
			if buffer.is_null() || state.stopped.load(Ordering::Acquire) {
				return;
			}
			let frame_length: u32 = msg_send![buffer, frameLength];
			if frame_length == 0 {
				return;
			}
			let format: *mut AnyObject = msg_send![buffer, format];
			let channels: u32 = msg_send![format, channelCount];
			let sample_rate: f64 = msg_send![format, sampleRate];
			let data: *mut *mut f32 = msg_send![buffer, floatChannelData];
			if data.is_null() || channels == 0 || sample_rate <= 0.0 {
				return;
			}
			let channels = channels as usize;
			let n = frame_length as usize;
	
			let mut mono = vec![0.0f32; n];
			let scale = 1.0 / channels as f32;
			for c in 0..channels {
				let channel = *data.add(c);
				if channel.is_null() {
					continue;
				}
				for i in 0..n {
					mono[i] += *channel.add(i) * scale;
				}
			}
	
			let mut out = Vec::new();
			{
				let mut resampler_guard = state.resampler.lock();
				let resampler = resampler_guard
					.get_or_insert_with(|| Resampler::new(sample_rate, state.target_rate));
				out.reserve((n as f64 / resampler.ratio) as usize + 2);
				resampler.process(&mono, &mut out);
			}
			if out.is_empty() {
				return;
			}
			if let Some(cb) = state.capture_cb.lock().as_ref() {
				// Blocking (matches the raw capture path): every chunk is real
				// audio; late is better than lost.
				cb.call(Ok(Float32Array::new(out)), ThreadsafeFunctionCallMode::Blocking);
			}
		}
	}

	/// Duplex voice session over one AVAudioEngine with voice processing:
	/// echo-cancelled mic capture in, assistant playback out (and used as the
	/// AEC reference).
	#[napi]
	pub struct AudioVoiceSession {
		engine: ObjPtr,
		input: ObjPtr,
		player: ObjPtr,
		/// Mono f32 at the target rate — the playback (and AEC reference) format.
		format: ObjPtr,
		state: Arc<SessionState>,
	}

	#[napi]
	impl AudioVoiceSession {
		/// Build the engine: voice-processed input node + player node feeding
		/// the main mixer. Fails when voice processing is unavailable —
		/// callers fall back to raw capture.
		#[napi(constructor)]
		pub fn new(sample_rate: u32) -> Result<Self> {
			unsafe {
				let engine: *mut AnyObject = msg_send![class!(AVAudioEngine), new];

				let format_alloc: *mut AnyObject = msg_send![class!(AVAudioFormat), alloc];
				let format: *mut AnyObject = msg_send![
					format_alloc,
					initStandardFormatWithSampleRate: f64::from(sample_rate),
					channels: 1u32,
				];

				// Playback graph FIRST: enabling voice processing reconfigures the
				// engine's IO, and connecting the player afterwards fails the
				// start with InvalidScope (-10875).
				let player: *mut AnyObject = msg_send![class!(AVAudioPlayerNode), new];
				let _: () = msg_send![engine, attachNode: player];
				let mixer: *mut AnyObject = msg_send![engine, mainMixerNode];
				let _: () = msg_send![engine, connect: player, to: mixer, format: format];

				let input_raw: *mut AnyObject = msg_send![engine, inputNode];
				let input = retain_obj(input_raw);
				let mut vp_error: *mut AnyObject = std::ptr::null_mut();
				let vp_ok: bool = msg_send![input.get(), setVoiceProcessingEnabled: true, error: &mut vp_error];
				if !vp_ok {
					let detail = error_detail(vp_error);
					release_obj(input);
					release_obj(ObjPtr(engine));
					return Err(napi::Error::from_reason(format!(
						"enable voice processing failed: {detail}"
					)));
				}
				Ok(Self {
					engine: ObjPtr(engine),
					input,
					player: ObjPtr(player),
					format: ObjPtr(format),
					state: Arc::new(SessionState {
						capture_cb: Mutex::new(None),
						resampler: Mutex::new(None),
						target_rate: f64::from(sample_rate),
						consumed_gen: AtomicU32::new(0),
						queued_gen: AtomicU32::new(0),
						notify: Notify::new(),
						stopped: AtomicBool::new(false),
					}),
				})
			}
		}

		/// Start the engine and deliver AEC'd mono mic chunks (resampled to
		/// the session rate) to the callback.
		#[napi]
		pub fn start_capture(
			&self,
			#[napi(ts_arg_type = "(error: Error | null, samples: Float32Array) => void")]
			on_audio: CaptureCallback,
		) -> Result<()> {
			unsafe {
				*self.state.capture_cb.lock() = Some(on_audio);

				let state = Arc::clone(&self.state);
				let tap_block = RcBlock::new(move |buffer: *mut AnyObject, _when: *mut AnyObject| {
					deliver_capture(&state, buffer);
				});
				let _: () = msg_send![
					self.input.get(),
					installTapOnBus: 0u32,
					bufferSize: 1024u32,
					format: std::ptr::null_mut::<AnyObject>(),
					block: &*tap_block
				];

				let _: () = msg_send![self.engine.get(), prepare];
				let mut start_error: *mut AnyObject = std::ptr::null_mut();
				let started: bool = msg_send![self.engine.get(), startAndReturnError: &mut start_error];
				if !started {
					let detail = error_detail(start_error);
					let _: () = msg_send![self.input.get(), removeTapOnBus: 0u32];
					return Err(napi::Error::from_reason(format!(
						"start audio engine failed: {detail}"
					)));
				}
				let _: () = msg_send![self.player.get(), play];
				Ok(())
			}
		}

		/// Queue mono f32 playback tagged with a generation (one per response
		/// sink) so `end_playback` can wait per-response.
		#[napi]
		pub fn write_playback(&self, samples: Float32Array, generation: u32) -> Result<()> {
			if samples.is_empty() {
				return Ok(());
			}
			if self.state.stopped.load(Ordering::Acquire) {
				return Err(napi::Error::from_reason("Voice session is closed"));
			}
			unsafe {
				let buffer_alloc: *mut AnyObject = msg_send![class!(AVAudioPCMBuffer), alloc];
				let buffer: *mut AnyObject = msg_send![
					buffer_alloc,
					initWithPCMFormat: self.format.get(),
					frameCapacity: samples.len() as u32
				];
				let data: *mut *mut f32 = msg_send![buffer, floatChannelData];
				if data.is_null() {
					let _: () = msg_send![buffer, release];
					return Err(napi::Error::from_reason("AVAudioPCMBuffer has no float channel data"));
				}
				std::ptr::copy_nonoverlapping(samples.as_ptr(), *data, samples.len());
				let _: () = msg_send![buffer, setFrameLength: samples.len() as u32];

				self.state.queued_gen.fetch_max(generation, Ordering::AcqRel);
				let state = Arc::clone(&self.state);
				let completion = RcBlock::new(move |_reason: isize| {
					// Fires on playback completion AND on interruption
					// (clear_playback stops the player) — either way this
					// generation's buffers are done.
					state.consumed_gen.fetch_max(generation, Ordering::AcqRel);
					state.notify.notify_waiters();
				});
				let _: () = msg_send![
					self.player.get(),
					scheduleBuffer: buffer,
					completionHandler: &*completion
				];
				// The player retained the buffer; drop our init-time reference.
				let _: () = msg_send![buffer, release];
				Ok(())
			}
		}

		/// Discard all queued and in-flight playback (barge-in / new response).
		#[napi]
		pub fn clear_playback(&self) {
			unsafe {
				let _: () = msg_send![self.player.get(), stop];
				// Discarded generations must still resolve their end_playback.
				let queued = self.state.queued_gen.load(Ordering::Acquire);
				self.state.consumed_gen.fetch_max(queued, Ordering::AcqRel);
				self.state.notify.notify_waiters();
				let _: () = msg_send![self.player.get(), play];
			}
		}

		/// Resolve once every chunk up to `generation` has reached the speaker
		/// (or was discarded by `clear_playback`).
		#[napi]
		pub async fn end_playback(&self, generation: u32) {
			loop {
				if self.state.stopped.load(Ordering::Acquire) {
					return;
				}
				if self.state.consumed_gen.load(Ordering::Acquire) >= generation {
					return;
				}
				let notified = self.state.notify.notified();
				if self.state.consumed_gen.load(Ordering::Acquire) >= generation {
					return;
				}
				notified.await;
			}
		}

		/// Stop the engine. Idempotent.
		#[napi]
		pub fn stop(&self) -> Result<()> {
			self.state.stopped.store(true, Ordering::Release);
			unsafe {
				let _: () = msg_send![self.input.get(), removeTapOnBus: 0u32];
				let _: () = msg_send![self.player.get(), stop];
				let _: () = msg_send![self.engine.get(), stop];
			}
			Ok(())
		}
	}

	impl Drop for AudioVoiceSession {
		fn drop(&mut self) {
			let _ = self.stop();
			unsafe {
				release_obj(self.input);
				release_obj(self.player);
				release_obj(self.format);
				release_obj(self.engine);
			}
		}
	}
}

#[cfg(target_os = "macos")]
pub use macos::AudioVoiceSession;

#[cfg(all(test, target_os = "macos"))]
mod tests {
	use std::{env, time::Duration};

	use super::macos::AudioVoiceSession;

	/// Opt-in hardware test: OMP_NATIVE_VPIO_TEST=1 cargo test.
	/// Capture delivery needs a JS threadsafe function, so it is exercised by
	/// the live voice session instead; here we verify the session lifecycle
	/// and the playback queue.
	#[test]
	fn voice_session_lifecycle() {
		if env::var_os("OMP_NATIVE_VPIO_TEST").is_none() {
			return;
		}
		let session = AudioVoiceSession::new(24_000).expect("voice session initializes");
		let silence = vec![0.0f32; 240];
		session
			.write_playback(napi::bindgen_prelude::Float32Array::new(silence), 1)
			.expect("playback queues");
		session.clear_playback();
		std::thread::sleep(Duration::from_millis(100));
		session.stop().expect("session stops");
		session.stop().expect("stop is idempotent");
	}
}
