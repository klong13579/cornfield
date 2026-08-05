//! macOS VoiceProcessingIO capture+playback session (hardware AEC).
//!
//! One CoreAudio VPIO unit owns both directions: the input bus delivers
//! echo-cancelled microphone audio — the unit cancels whatever its own output
//! bus plays — and the output bus renders the assistant's playback, which is
//! exactly the reference the AEC needs. Raw miniaudio capture/playback cannot
//! do this: VPIO only cancels audio played through the same unit.
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
		ffi::c_void,
		mem,
		sync::{
			Arc,
			atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering},
		},
	};

	use napi::{
		bindgen_prelude::{Float32Array, Result},
		threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
	};
	use napi_derive::napi;
	use parking_lot::Mutex;
	use tokio::sync::Notify;

	type OsStatus = i32;
	type Ostype = u32;
	type AudioUnit = *mut c_void;
	type AudioComponent = *mut c_void;

	const K_AUDIO_UNIT_TYPE_OUTPUT: Ostype = 0x61756F75; // 'auou'
	const K_AUDIO_UNIT_SUBTYPE_VOICE_PROCESSING_IO: Ostype = 0x7670696F; // 'vpio'
	const K_AUDIO_UNIT_MANUFACTURER_APPLE: Ostype = 0x6170706C; // 'appl'
	const K_AUDIO_FORMAT_LINEAR_PCM: Ostype = 0x6C70636D; // 'lpcm'
	const K_AUDIO_FORMAT_FLAGS_NATIVE_FLOAT_PACKED: u32 = 0x1 | 0x8; // float | packed

	const K_AUDIO_UNIT_PROPERTY_STREAM_FORMAT: u32 = 8;
	const K_AUDIO_UNIT_PROPERTY_SET_RENDER_CALLBACK: u32 = 23;
	const K_AUDIO_OUTPUT_UNIT_PROPERTY_ENABLE_IO: u32 = 2003;
	const K_AUDIO_OUTPUT_UNIT_PROPERTY_SET_INPUT_CALLBACK: u32 = 2004;

	const K_AUDIO_UNIT_SCOPE_GLOBAL: u32 = 0;
	/// Client side of the output bus (what our render callback feeds).
	const K_AUDIO_UNIT_SCOPE_INPUT: u32 = 1;
	/// Client side of the input bus (what the input callback receives).
	const K_AUDIO_UNIT_SCOPE_OUTPUT: u32 = 2;

	const OUTPUT_BUS: u32 = 0;
	const INPUT_BUS: u32 = 1;
	const MAX_INPUT_FRAMES: usize = 4096;

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct AudioComponentDescription {
		component_type: Ostype,
		component_sub_type: Ostype,
		component_manufacturer: Ostype,
		component_flags: u32,
		component_flags_mask: u32,
	}

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct AudioStreamBasicDescription {
		sample_rate: f64,
		format_id: Ostype,
		format_flags: u32,
		bytes_per_packet: u32,
		frames_per_packet: u32,
		bytes_per_frame: u32,
		channels_per_frame: u32,
		bits_per_channel: u32,
		reserved: u32,
	}

	#[repr(C)]
	struct AudioBuffer {
		number_channels: u32,
		data_byte_size: u32,
		data: *mut c_void,
	}

	#[repr(C)]
	struct AudioBufferList {
		number_buffers: u32,
		buffers: [AudioBuffer; 1],
	}

	/// Opaque — only passed through between CoreAudio and the callbacks.
	#[repr(C)]
	struct AudioTimeStamp {
		_private: [u8; 0],
	}

	type RenderCallback = unsafe extern "C" fn(
		in_ref_con: *mut c_void,
		io_action_flags: *mut u32,
		in_time_stamp: *const AudioTimeStamp,
		in_bus_number: u32,
		in_number_frames: u32,
		io_data: *mut AudioBufferList,
	) -> OsStatus;

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct AurRenderCallbackStruct {
		input_proc: RenderCallback,
		input_proc_ref_con: *mut c_void,
	}

	#[link(name = "AudioToolbox", kind = "framework")]
	#[link(name = "CoreAudio", kind = "framework")]
	unsafe extern "C" {
		fn AudioComponentFindNext(
			in_component: AudioComponent,
			in_desc: *const AudioComponentDescription,
		) -> AudioComponent;
		fn AudioComponentInstanceNew(in_component: AudioComponent, out_instance: *mut AudioUnit) -> OsStatus;
		fn AudioComponentInstanceDispose(in_component_instance: AudioUnit) -> OsStatus;
		fn AudioUnitInitialize(in_unit: AudioUnit) -> OsStatus;
		fn AudioUnitUninitialize(in_unit: AudioUnit) -> OsStatus;
		fn AudioUnitSetProperty(
			in_unit: AudioUnit,
			in_id: u32,
			in_scope: u32,
			in_element: u32,
			in_data: *const c_void,
			in_data_size: u32,
		) -> OsStatus;
		fn AudioUnitRender(
			in_unit: AudioUnit,
			io_action_flags: *mut u32,
			in_time_stamp: *const AudioTimeStamp,
			in_bus_number: u32,
			in_number_frames: u32,
			io_data: *mut AudioBufferList,
		) -> OsStatus;
		fn AudioOutputUnitStart(in_unit: AudioUnit) -> OsStatus;
		fn AudioOutputUnitStop(in_unit: AudioUnit) -> OsStatus;
	}

	type CaptureCallback = ThreadsafeFunction<Float32Array, UnknownReturnValue>;

	/// CoreAudio AudioUnit handles are internally synchronized; every use here
	/// is additionally guarded by our own lock/stop discipline.
	#[derive(Clone, Copy)]
	struct UnitPtr(*mut c_void);
	unsafe impl Send for UnitPtr {}
	unsafe impl Sync for UnitPtr {}

	struct CurrentChunk {
		samples: Vec<f32>,
		generation: u32,
		cursor: usize,
	}

	struct VpioState {
		unit: AtomicUsize,
		capture_cb: Mutex<Option<CaptureCallback>>,
		playback_rx: flume::Receiver<(Vec<f32>, u32)>,
		/// Render-callback-side playback position. parking_lot keeps the
		/// critical section short on the real-time thread.
		current: Mutex<CurrentChunk>,
		/// Highest generation fully rendered — `end_playback(gen)` waits on it.
		consumed_gen: AtomicU32,
		notify: Notify,
		stopped: AtomicBool,
	}

	unsafe fn check(status: OsStatus, what: &str) -> std::result::Result<(), String> {
		if status == 0 {
			return Ok(());
		}
		Err(format!("{what} failed (OSStatus {status})"))
	}

	/// Pulls AEC'd mic frames and forwards them to JS.
	unsafe extern "C" fn input_callback(
		in_ref_con: *mut c_void,
		io_action_flags: *mut u32,
		in_time_stamp: *const AudioTimeStamp,
		_in_bus_number: u32,
		in_number_frames: u32,
		_io_data: *mut AudioBufferList,
	) -> OsStatus {
		unsafe {
			let state = &*(in_ref_con as *const VpioState);
			let frames = in_number_frames as usize;
			if frames == 0 || frames > MAX_INPUT_FRAMES {
				return 0;
			}
			let mut samples = [0.0f32; MAX_INPUT_FRAMES];
			let mut list = AudioBufferList {
				number_buffers: 1,
				buffers: [AudioBuffer {
					number_channels: 1,
					data_byte_size: (frames * 4) as u32,
					data: samples.as_mut_ptr() as *mut c_void,
				}],
			};
			let status = AudioUnitRender(
				state.unit.load(Ordering::Acquire) as AudioUnit,
				io_action_flags,
				in_time_stamp,
				_in_bus_number,
				in_number_frames,
				&mut list,
			);
			if status != 0 {
				return status;
			}
			if let Some(cb) = state.capture_cb.lock().as_ref() {
				// Blocking (matches the raw capture path): every chunk is real
				// audio; late is better than lost.
				cb.call(
					Ok(Float32Array::new(samples[..frames].to_vec())),
					ThreadsafeFunctionCallMode::Blocking,
				);
			}
			0
		}
	}

	/// Feeds the assistant's playback to the speaker — VPIO's AEC reference.
	unsafe extern "C" fn render_callback(
		in_ref_con: *mut c_void,
		_io_action_flags: *mut u32,
		_in_time_stamp: *const AudioTimeStamp,
		_in_bus_number: u32,
		in_number_frames: u32,
		io_data: *mut AudioBufferList,
	) -> OsStatus {
		unsafe {
			let state = &*(in_ref_con as *const VpioState);
			if state.stopped.load(Ordering::Acquire) {
				return 0;
			}
			let list = &mut *io_data;
			let frames = in_number_frames as usize;
			for buffer in list.buffers.iter_mut().take(list.number_buffers as usize) {
				let capacity = (buffer.data_byte_size / 4) as usize;
				let out = std::slice::from_raw_parts_mut(buffer.data as *mut f32, capacity.min(frames));
				let mut current = state.current.lock();
				let mut offset = 0;
				while offset < out.len() {
					if current.cursor == current.samples.len() {
						match state.playback_rx.try_recv() {
							Ok((next, generation)) => {
								current.samples = next;
								current.generation = generation;
								current.cursor = 0;
							},
							Err(_) => break,
						}
					}
					let count = (current.samples.len() - current.cursor).min(out.len() - offset);
					out[offset..offset + count]
						.copy_from_slice(&current.samples[current.cursor..current.cursor + count]);
					current.cursor += count;
					offset += count;
				}
				out[offset..].fill(0.0);
				if !current.samples.is_empty() && current.cursor == current.samples.len() {
					state.consumed_gen.fetch_max(current.generation, Ordering::AcqRel);
					state.notify.notify_waiters();
				}
			}
			0
		}
	}

	/// Duplex voice session over one VoiceProcessingIO unit: echo-cancelled
	/// mic capture in, assistant playback out (and used as the AEC reference).
	#[napi]
	pub struct AudioVoiceSession {
		state: Arc<VpioState>,
		playback_tx: flume::Sender<(Vec<f32>, u32)>,
		unit: Mutex<Option<UnitPtr>>,
		ref_con: usize,
	}

	#[napi]
	impl AudioVoiceSession {
		/// Create and initialize the VPIO unit at the requested sample rate
		/// (mono f32 both directions). Fails when the unit is unavailable or
		/// the rate is rejected — callers fall back to raw capture.
		#[napi(constructor)]
		pub fn new(sample_rate: u32) -> Result<Self> {
			unsafe {
				let desc = AudioComponentDescription {
					component_type: K_AUDIO_UNIT_TYPE_OUTPUT,
					component_sub_type: K_AUDIO_UNIT_SUBTYPE_VOICE_PROCESSING_IO,
					component_manufacturer: K_AUDIO_UNIT_MANUFACTURER_APPLE,
					component_flags: 0,
					component_flags_mask: 0,
				};
				let component = AudioComponentFindNext(std::ptr::null_mut(), &desc);
				if component.is_null() {
					return Err(napi::Error::from_reason("VoiceProcessingIO audio unit not found"));
				}
				let mut unit: AudioUnit = std::ptr::null_mut();
				check(AudioComponentInstanceNew(component, &mut unit), "create VoiceProcessingIO unit")
					.map_err(napi::Error::from_reason)?;

				let set_property = |what: &str,
				                    id: u32,
				                    scope: u32,
				                    element: u32,
				                    data: *const c_void,
				                    size: u32| { check(AudioUnitSetProperty(unit, id, scope, element, data, size), what) };

				// Enable input IO. macOS versions disagree about the scope: try
				// Input, Global, Output in order and keep the statuses so a total
				// failure is diagnosable. Some versions have input enabled by
				// default and reject the property outright (-10866) — treat that
				// as success and let the callback setup verify input availability.
				let enable_input: u32 = 1;
				let mut enable_statuses: Vec<(u32, OsStatus)> = Vec::new();
				let mut enabled = false;
				for scope in [K_AUDIO_UNIT_SCOPE_INPUT, K_AUDIO_UNIT_SCOPE_GLOBAL, K_AUDIO_UNIT_SCOPE_OUTPUT] {
					let status = AudioUnitSetProperty(
						unit,
						K_AUDIO_OUTPUT_UNIT_PROPERTY_ENABLE_IO,
						scope,
						INPUT_BUS,
						&enable_input as *const u32 as *const c_void,
						mem::size_of::<u32>() as u32,
					);
					enable_statuses.push((scope, status));
					if status == 0 {
						enabled = true;
						break;
					}
				}
				if !enabled {
					let all_rejected = enable_statuses.iter().all(|(_, s)| *s != 0);
					let detail = enable_statuses
						.iter()
						.map(|(scope, s)| format!("scope {scope}: {s}"))
						.collect::<Vec<_>>()
						.join(", ");
					// -10866 on every scope = property not writable = input already on.
					if !all_rejected {
						AudioComponentInstanceDispose(unit);
						return Err(napi::Error::from_reason(format!("enable VPIO input failed ({detail})")));
					}
				}

				let format = AudioStreamBasicDescription {
					sample_rate: f64::from(sample_rate),
					format_id: K_AUDIO_FORMAT_LINEAR_PCM,
					format_flags: K_AUDIO_FORMAT_FLAGS_NATIVE_FLOAT_PACKED,
					bytes_per_packet: 4,
					frames_per_packet: 1,
					bytes_per_frame: 4,
					channels_per_frame: 1,
					bits_per_channel: 32,
					reserved: 0,
				};
				let setup_result = set_property(
					"set VPIO input format",
					K_AUDIO_UNIT_PROPERTY_STREAM_FORMAT,
					K_AUDIO_UNIT_SCOPE_OUTPUT,
					INPUT_BUS,
					&format as *const AudioStreamBasicDescription as *const c_void,
					mem::size_of::<AudioStreamBasicDescription>() as u32,
				)
				.and_then(|()| {
					set_property(
						"set VPIO output format",
						K_AUDIO_UNIT_PROPERTY_STREAM_FORMAT,
						K_AUDIO_UNIT_SCOPE_INPUT,
						OUTPUT_BUS,
						&format as *const AudioStreamBasicDescription as *const c_void,
						mem::size_of::<AudioStreamBasicDescription>() as u32,
					)
				});
				if let Err(message) = setup_result {
					AudioComponentInstanceDispose(unit);
					return Err(napi::Error::from_reason(message));
				}

				let (tx, rx) = flume::unbounded();
				let state = Arc::new(VpioState {
					unit: AtomicUsize::new(unit as usize),
					capture_cb: Mutex::new(None),
					playback_rx: rx,
					current: Mutex::new(CurrentChunk {
						samples: Vec::new(),
						generation: 0,
						cursor: 0,
					}),
					consumed_gen: AtomicU32::new(0),
					notify: Notify::new(),
					stopped: AtomicBool::new(false),
				});
				let ref_con = Arc::into_raw(Arc::clone(&state)) as *mut c_void;

				let input_cb_struct = AurRenderCallbackStruct {
					input_proc: input_callback,
					input_proc_ref_con: ref_con,
				};
				let render_cb_struct = AurRenderCallbackStruct {
					input_proc: render_callback,
					input_proc_ref_con: ref_con,
				};
				// The input-callback (scope, element) pair differs across macOS
				// versions; sweep the plausible combinations, then retry after
				// AudioUnitInitialize as a last resort. Every status is kept so a
				// total failure is diagnosable.
				let try_input_callback = |scope: u32, element: u32| -> OsStatus {
					AudioUnitSetProperty(
						unit,
						K_AUDIO_OUTPUT_UNIT_PROPERTY_SET_INPUT_CALLBACK,
						scope,
						element,
						&input_cb_struct as *const AurRenderCallbackStruct as *const c_void,
						mem::size_of::<AurRenderCallbackStruct>() as u32,
					)
				};
				const INPUT_CB_COMBOS: [(u32, u32); 5] = [
					(K_AUDIO_UNIT_SCOPE_GLOBAL, OUTPUT_BUS),
					(K_AUDIO_UNIT_SCOPE_GLOBAL, INPUT_BUS),
					(K_AUDIO_UNIT_SCOPE_INPUT, OUTPUT_BUS),
					(K_AUDIO_UNIT_SCOPE_INPUT, INPUT_BUS),
					(K_AUDIO_UNIT_SCOPE_OUTPUT, INPUT_BUS),
				];
				let mut input_cb_statuses: Vec<((u32, u32), OsStatus)> = Vec::new();
				let mut input_cb_set = false;
				for combo in INPUT_CB_COMBOS {
					let status = try_input_callback(combo.0, combo.1);
					input_cb_statuses.push((combo, status));
					if status == 0 {
						input_cb_set = true;
						break;
					}
				}

				let render_result = set_property(
					"set VPIO render callback",
					K_AUDIO_UNIT_PROPERTY_SET_RENDER_CALLBACK,
					K_AUDIO_UNIT_SCOPE_GLOBAL,
					OUTPUT_BUS,
					&render_cb_struct as *const AurRenderCallbackStruct as *const c_void,
					mem::size_of::<AurRenderCallbackStruct>() as u32,
				);

				let init_result = render_result
					.and_then(|()| check(AudioUnitInitialize(unit), "initialize VoiceProcessingIO unit"));

				// Last resort: some units accept the input callback only once initialized.
				let callback_result = if !input_cb_set && init_result.is_ok() {
					for combo in INPUT_CB_COMBOS {
						let status = try_input_callback(combo.0, combo.1);
						input_cb_statuses.push((combo, status));
						if status == 0 {
							input_cb_set = true;
							break;
						}
					}
					if input_cb_set { Ok(()) } else { init_result }
				} else {
					init_result
				};
				let callback_result = callback_result.and_then(|()| {
					if input_cb_set {
						Ok(())
					} else {
						let detail = input_cb_statuses
							.iter()
							.map(|((scope, element), s)| format!("(scope {scope}, element {element}): {s}"))
							.collect::<Vec<_>>()
							.join(", ");
						Err(format!("set VPIO input callback failed on all combinations ({detail})"))
					}
				});
				if let Err(message) = callback_result {
					drop(Arc::from_raw(ref_con as *const VpioState));
					AudioComponentInstanceDispose(unit);
					return Err(napi::Error::from_reason(message));
				}

				Ok(Self {
					state,
					playback_tx: tx,
					unit: Mutex::new(Some(UnitPtr(unit))),
					ref_con: ref_con as usize,
				})
			}
		}

		/// Start the unit and deliver AEC'd mono mic chunks to the callback.
		#[napi]
		pub fn start_capture(
			&self,
			#[napi(ts_arg_type = "(error: Error | null, samples: Float32Array) => void")]
			on_audio: CaptureCallback,
		) -> Result<()> {
			*self.state.capture_cb.lock() = Some(on_audio);
			let UnitPtr(unit) = self
				.unit
				.lock()
				.ok_or_else(|| napi::Error::from_reason("Voice session is closed"))?;
			unsafe { check(AudioOutputUnitStart(unit), "start VoiceProcessingIO unit") }
				.map_err(napi::Error::from_reason)
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
			self.playback_tx
				.send((samples.to_vec(), generation))
				.map_err(|_| napi::Error::from_reason("Voice session is closed"))
		}

		/// Discard all queued and in-flight playback (barge-in / new response).
		#[napi]
		pub fn clear_playback(&self) {
			while self.state.playback_rx.try_recv().is_ok() {}
			let mut current = self.state.current.lock();
			current.samples.clear();
			current.cursor = 0;
		}

		/// Resolve once every chunk up to `generation` has reached the speaker.
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

		/// Stop the unit and release it. Idempotent.
		#[napi]
		pub fn stop(&self) -> Result<()> {
			self.state.stopped.store(true, Ordering::Release);
			let Some(UnitPtr(unit)) = self.unit.lock().take() else {
				return Ok(());
			};
			unsafe {
				// AudioOutputUnitStop guarantees the callbacks have stopped
				// before returning — only then may the refcon Arc be reclaimed.
				AudioOutputUnitStop(unit);
				AudioUnitUninitialize(unit);
				AudioComponentInstanceDispose(unit);
				drop(Arc::from_raw(self.ref_con as *const VpioState));
			}
			Ok(())
		}
	}

	impl Drop for AudioVoiceSession {
		fn drop(&mut self) {
			let _ = self.stop();
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
	/// the live voice session instead; here we verify the unit lifecycle and
	/// the playback queue.
	#[test]
	fn vpio_session_lifecycle() {
		if env::var_os("OMP_NATIVE_VPIO_TEST").is_none() {
			return;
		}
		let session = AudioVoiceSession::new(24_000).expect("VPIO unit initializes");
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
