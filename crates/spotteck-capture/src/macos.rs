//! macOS 14.2+: a private Core Audio process tap on Spotify's processes, read through a
//! private aggregate device. macOS asks once for "system audio recording only" (the
//! `NSAudioCaptureUsageDescription` text); no microphone or screen recording is involved.

use crate::{AudioTap, Capture, Status};
use objc2::rc::Retained;
use objc2::AllocAnyThread;
use objc2_core_audio::{
    kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceNameKey, kAudioAggregateDeviceTapAutoStartKey,
    kAudioAggregateDeviceTapListKey, kAudioAggregateDeviceUIDKey, kAudioDevicePropertyDeviceIsAlive,
    kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal,
    kAudioObjectSystemObject, kAudioProcessPropertyBundleID, kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey,
    kAudioTapPropertyFormat, AudioDeviceCreateIOProcID, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID,
    AudioDeviceStart, AudioDeviceStop, AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap,
    AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap, AudioObjectGetPropertyData,
    AudioObjectGetPropertyDataSize, AudioObjectID, AudioObjectPropertyAddress, CATapDescription, CATapMuteBehavior,
};
use objc2_core_audio_types::{
    kAudioFormatFlagIsFloat, kAudioFormatLinearPCM, AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp,
};
use objc2_core_foundation::{CFDictionary, CFRetained, CFString};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSObject, NSString};
use std::ffi::{c_void, CStr};
use std::mem::size_of;
use std::ptr::{self, NonNull};
use std::sync::Arc;
use std::time::Duration;

/// Spotify.app and its helper processes (`com.spotify.client.helper…`).
const SPOTIFY_BUNDLE: &str = "com.spotify.client";

pub(crate) struct Platform {
    tap: AudioObjectID,
    aggregate: AudioObjectID,
    io_proc: AudioDeviceIOProcID,
    /// The `Arc<AudioTap>` lent to the IO callback; reclaimed in `drop`.
    client: *const AudioTap,
}

// The IDs are plain integers and `client` is only touched by Core Audio's IO thread
// between start and stop.
unsafe impl Send for Platform {}

fn address(selector: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    }
}

fn check(status: i32) -> Result<(), Status> {
    match status {
        0 => Ok(()),
        // kAudioHardwareIllegalOperationError: what the HAL answers when the system audio
        // recording permission was refused.
        s if s == i32::from_be_bytes(*b"nope") => Err(Status::PermissionDenied),
        s => Err(Status::Failed(i64::from(s))),
    }
}

/// Reads a fixed-size property.
unsafe fn get<T>(object: AudioObjectID, selector: u32, value: &mut T) -> Result<(), Status> {
    let mut address = address(selector);
    let mut size = size_of::<T>() as u32;
    check(AudioObjectGetPropertyData(
        object,
        NonNull::from(&mut address),
        0,
        ptr::null(),
        NonNull::from(&mut size),
        NonNull::from(value).cast(),
    ))
}

fn process_objects() -> Vec<AudioObjectID> {
    let system = kAudioObjectSystemObject as AudioObjectID;
    let mut address = address(kAudioHardwarePropertyProcessObjectList);
    let mut size = 0u32;
    unsafe {
        if AudioObjectGetPropertyDataSize(system, NonNull::from(&mut address), 0, ptr::null(), NonNull::from(&mut size))
            != 0
        {
            return Vec::new();
        }
        let mut objects = vec![0 as AudioObjectID; size as usize / size_of::<AudioObjectID>()];
        let Some(data) = NonNull::new(objects.as_mut_ptr()) else { return Vec::new() };
        if objects.is_empty()
            || AudioObjectGetPropertyData(
                system,
                NonNull::from(&mut address),
                0,
                ptr::null(),
                NonNull::from(&mut size),
                data.cast(),
            ) != 0
        {
            return Vec::new();
        }
        objects.truncate(size as usize / size_of::<AudioObjectID>());
        objects
    }
}

fn bundle_id(process: AudioObjectID) -> Option<String> {
    let mut value: *mut CFString = ptr::null_mut();
    unsafe {
        get(process, kAudioProcessPropertyBundleID, &mut value).ok()?;
        // The HAL hands over a +1 reference.
        let string = CFRetained::from_raw(NonNull::new(value)?);
        Some(string.to_string())
    }
}

fn key(name: &CStr) -> Retained<NSString> {
    NSString::from_str(name.to_str().unwrap_or_default())
}

fn object(value: Retained<NSString>) -> Retained<NSObject> {
    value.into_super()
}

fn number(value: Retained<NSNumber>) -> Retained<NSObject> {
    value.into_super().into_super()
}

/// Core Audio's IO thread: the tap's samples, normally one interleaved stereo buffer.
unsafe extern "C-unwind" fn io_proc(
    _device: AudioObjectID,
    _now: NonNull<AudioTimeStamp>,
    input: NonNull<AudioBufferList>,
    _input_time: NonNull<AudioTimeStamp>,
    _output: NonNull<AudioBufferList>,
    _output_time: NonNull<AudioTimeStamp>,
    client: *mut c_void,
) -> i32 {
    let Some(tap) = (client as *const AudioTap).as_ref() else { return 0 };
    let list = input.as_ref();
    let buffers = std::slice::from_raw_parts(list.mBuffers.as_ptr(), list.mNumberBuffers as usize);
    let samples = |b: &objc2_core_audio_types::AudioBuffer| -> &[f32] {
        if b.mData.is_null() {
            &[]
        } else {
            std::slice::from_raw_parts(b.mData as *const f32, b.mDataByteSize as usize / size_of::<f32>())
        }
    };
    match buffers {
        [] => {}
        [only] => tap.push(samples(only), only.mNumberChannels as usize),
        [left, right, ..] => {
            // Non-interleaved: one buffer per channel.
            let (l, r) = (samples(left), samples(right));
            let interleaved: Vec<f32> = l.iter().zip(r).flat_map(|(a, b)| [*a, *b]).collect();
            tap.push(&interleaved, 2);
        }
    }
    0
}

impl Platform {
    fn start(&mut self, processes: &[u32], tap: &Arc<AudioTap>) -> Result<(), Status> {
        unsafe {
            let ids: Vec<Retained<NSNumber>> = processes.iter().map(|&id| NSNumber::new_u32(id)).collect();
            let description = CATapDescription::initStereoMixdownOfProcesses(
                CATapDescription::alloc(),
                &NSArray::from_retained_slice(&ids),
            );
            description.setName(&NSString::from_str("Spotteck visualizer"));
            description.setPrivate(true);
            description.setMuteBehavior(CATapMuteBehavior::Unmuted);
            check(AudioHardwareCreateProcessTap(Some(&description), &mut self.tap))?;

            let mut format: AudioStreamBasicDescription = std::mem::zeroed();
            get(self.tap, kAudioTapPropertyFormat, &mut format)?;
            if format.mFormatID != kAudioFormatLinearPCM
                || format.mBitsPerChannel != 32
                || format.mFormatFlags & kAudioFormatFlagIsFloat == 0
            {
                return Err(Status::Failed(-3));
            }
            tap.set_rate(format.mSampleRate.round() as u32);

            let sub_tap = NSDictionary::<NSString, NSObject>::from_retained_objects(
                &[&*key(kAudioSubTapUIDKey), &*key(kAudioSubTapDriftCompensationKey)],
                &[object(description.UUID().UUIDString()), number(NSNumber::new_bool(true))],
            );
            let uid = format!("com.braun.spotteck.analysis.{}", std::process::id());
            let config = NSDictionary::<NSString, NSObject>::from_retained_objects(
                &[
                    &*key(kAudioAggregateDeviceNameKey),
                    &*key(kAudioAggregateDeviceUIDKey),
                    &*key(kAudioAggregateDeviceIsPrivateKey),
                    &*key(kAudioAggregateDeviceTapAutoStartKey),
                    &*key(kAudioAggregateDeviceTapListKey),
                ],
                &[
                    object(NSString::from_str("Spotteck analysis")),
                    object(NSString::from_str(&uid)),
                    number(NSNumber::new_bool(true)),
                    number(NSNumber::new_bool(false)),
                    NSArray::from_retained_slice(&[sub_tap]).into_super(),
                ],
            );
            // NSDictionary and CFDictionary are toll-free bridged.
            let config = &*(Retained::as_ptr(&config) as *const CFDictionary);
            check(AudioHardwareCreateAggregateDevice(config, NonNull::from(&mut self.aggregate)))?;

            // The HAL creates aggregates asynchronously; starting too early yields only zeros.
            let mut alive = 0u32;
            for _ in 0..30 {
                if get(self.aggregate, kAudioDevicePropertyDeviceIsAlive, &mut alive).is_ok() && alive != 0 {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            if alive == 0 {
                return Err(Status::Failed(-4));
            }

            self.client = Arc::into_raw(tap.clone());
            check(AudioDeviceCreateIOProcID(
                self.aggregate,
                Some(io_proc),
                self.client as *mut c_void,
                NonNull::from(&mut self.io_proc),
            ))?;
            check(AudioDeviceStart(self.aggregate, self.io_proc))
        }
    }
}

impl Capture for Platform {
    fn targets() -> Vec<u32> {
        let mut ids: Vec<u32> = process_objects()
            .into_iter()
            .filter(|&p| {
                bundle_id(p).is_some_and(|b| b == SPOTIFY_BUNDLE || b.starts_with(&format!("{SPOTIFY_BUNDLE}.")))
            })
            .collect();
        ids.sort_unstable();
        ids
    }

    fn open(targets: &[u32], tap: &Arc<AudioTap>) -> Result<Self, Status> {
        let mut capture = Platform { tap: 0, aggregate: 0, io_proc: None, client: ptr::null() };
        // On failure, `drop` releases whatever was created.
        capture.start(targets, tap)?;
        Ok(capture)
    }

    fn alive(&self) -> bool {
        let mut alive = 0u32;
        unsafe { get(self.aggregate, kAudioDevicePropertyDeviceIsAlive, &mut alive).is_ok() && alive != 0 }
    }
}

impl Drop for Platform {
    fn drop(&mut self) {
        unsafe {
            if self.io_proc.is_some() {
                AudioDeviceStop(self.aggregate, self.io_proc);
                AudioDeviceDestroyIOProcID(self.aggregate, self.io_proc);
            }
            if self.aggregate != 0 {
                AudioHardwareDestroyAggregateDevice(self.aggregate);
            }
            if self.tap != 0 {
                AudioHardwareDestroyProcessTap(self.tap);
            }
            if !self.client.is_null() {
                // The IO proc is stopped and destroyed, so nothing else holds this pointer.
                drop(Arc::from_raw(self.client));
            }
        }
    }
}
