import Foundation
import CoreAudio
import Accelerate

func check(_ status: OSStatus) throws {
    if status != noErr { throw NSError(domain: "CoreAudio", code: Int(status)) }
}
func property(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ value: inout AudioStreamBasicDescription) throws {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    try check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value))
}

func channelSample(_ buffers: UnsafeMutableAudioBufferListPointer, _ index: Int, _ frame: Int) -> Float {
    guard let first = buffers.first else { return 0 }
    let channels = max(1, Int(first.mNumberChannels))
    let buffer = channels > 1 ? first : buffers[min(index, buffers.count - 1)]
    guard let raw = buffer.mData else { return 0 }
    let offset = channels > 1 ? frame * channels + min(index, channels - 1) : frame
    guard (offset + 1) * 4 <= Int(buffer.mDataByteSize) else { return 0 }
    let value = raw.assumingMemoryBound(to: Float.self)[offset]
    return value.isFinite ? value : 0
}
func levels(_ values: [Float]) -> (Float, Float) {
    let rms = sqrt(values.reduce(0) { $0 + $1 * $1 } / Float(values.count))
    let peak = values.reduce(Float(0)) { max($0, abs($1)) }
    return (rms, peak)
}
if CommandLine.arguments.dropFirst().first == "--self-test" {
    let storage = UnsafeMutableRawPointer.allocate(byteCount: MemoryLayout<AudioBufferList>.size + MemoryLayout<AudioBuffer>.size, alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { storage.deallocate() }
    let pointer = storage.bindMemory(to: AudioBufferList.self, capacity: 1)
    pointer.pointee.mNumberBuffers = 2
    let buffers = UnsafeMutableAudioBufferListPointer(pointer)
    var left: [Float] = [0, 0]
    var right: [Float] = [0.75, -0.75]
    left.withUnsafeMutableBytes { l in right.withUnsafeMutableBytes { r in
        buffers[0] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(l.count), mData: l.baseAddress)
        buffers[1] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(r.count), mData: r.baseAddress)
        precondition(channelSample(buffers, 0, 0) == 0)
        precondition(channelSample(buffers, 1, 1) == -0.75)
    } }
    var interleaved: [Float] = [0, 0.75, 0, -0.75]
    interleaved.withUnsafeMutableBytes { data in
        buffers[0] = AudioBuffer(mNumberChannels: 2, mDataByteSize: UInt32(data.count), mData: data.baseAddress)
        precondition(channelSample(buffers, 0, 1) == 0)
        precondition(channelSample(buffers, 1, 1) == -0.75)
    }
    precondition(levels(left).0 == 0 && levels(right).0 == 0.75)
    print("Stereo analysis self-test passed: planar, interleaved, RMS and peaks")
    exit(0)
}

guard CommandLine.arguments.count == 2 else { exit(2) }
var pid = Int32(CommandLine.arguments[1]) ?? 0
let bundle = pid == 0 ? CommandLine.arguments[1] : nil
let parent = getppid()
var processID = AudioObjectID(0)
var translation = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
var size = UInt32(MemoryLayout<AudioObjectID>.size)
var tap = AudioObjectID(0)
var aggregate = AudioObjectID(0)
var callback: AudioDeviceIOProcID?
do {
    if let bundle {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var bytes: UInt32 = 0
        try check(AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &bytes))
        var objects = [AudioObjectID](repeating: 0, count: Int(bytes) / 4)
        try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &bytes, &objects))
        for object in objects {
            address.mSelector = kAudioProcessPropertyBundleID
            var identifier: Unmanaged<CFString>?
            bytes = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
            if AudioObjectGetPropertyData(object, &address, 0, nil, &bytes, &identifier) == noErr,
               identifier?.takeUnretainedValue() as String? == bundle {
                processID = object
                address.mSelector = kAudioProcessPropertyPID
                bytes = 4
                try check(AudioObjectGetPropertyData(object, &address, 0, nil, &bytes, &pid))
                break
            }
        }
    } else {
        try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &translation, UInt32(MemoryLayout<pid_t>.size), &pid, &size, &processID))
    }
    guard processID != 0 else { throw NSError(domain: "ProcessMissing", code: -2) }
    let description = CATapDescription(stereoMixdownOfProcesses: [processID])
    description.name = "Spotteck visualizer"
    description.isPrivate = true
    description.muteBehavior = .unmuted
    try check(AudioHardwareCreateProcessTap(description, &tap))
    var format = AudioStreamBasicDescription()
    try property(tap, kAudioTapPropertyFormat, &format)
    guard format.mFormatID == kAudioFormatLinearPCM, format.mBitsPerChannel == 32,
          format.mFormatFlags & kAudioFormatFlagIsFloat != 0 else { throw NSError(domain: "UnsupportedFormat", code: -3) }
    let config: [String: Any] = [
        kAudioAggregateDeviceNameKey: "Spotteck analysis",
        kAudioAggregateDeviceUIDKey: UUID().uuidString,
        kAudioAggregateDeviceIsPrivateKey: true,
        kAudioAggregateDeviceTapAutoStartKey: false,
        kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString,
                                          kAudioSubTapDriftCompensationKey: true]]
    ]
    try check(AudioHardwareCreateAggregateDevice(config as CFDictionary, &aggregate))
    // HAL creates aggregates asynchronously; starting before they are alive can yield only zeros.
    var alive: UInt32 = 0
    var aliveAddress = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsAlive, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    for _ in 0..<30 {
        var aliveSize = UInt32(MemoryLayout<UInt32>.size)
        AudioObjectGetPropertyData(aggregate, &aliveAddress, 0, nil, &aliveSize, &alive)
        if alive != 0 { break }
        Thread.sleep(forTimeInterval: 0.1)
    }
    guard alive != 0 else { throw NSError(domain: "AggregateNotReady", code: -4) }
    var rate = format.mSampleRate
    var rateAddress = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyNominalSampleRate, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    try check(AudioObjectSetPropertyData(aggregate, &rateAddress, 0, nil, UInt32(MemoryLayout<Double>.size), &rate))
    let queue = DispatchQueue(label: "spotteck.audio.analysis")
    var samples = [Float](repeating: 0, count: 512)
    var cursor = 0
    var leftSamples = samples
    var rightSamples = samples
    var lastSent = DispatchTime.now().uptimeNanoseconds
    var window = [Float](repeating: 0, count: 512)
    vDSP_hann_window(&window, 512, Int32(vDSP_HANN_NORM))
    guard let fft = vDSP_create_fftsetup(9, FFTRadix(kFFTRadix2)) else { exit(3) }
    try check(AudioDeviceCreateIOProcIDWithBlock(&callback, aggregate, queue) { _, input, _, _, _ in
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        guard let first = buffers.first, first.mData != nil else { return }
        let channels = max(1, Int(first.mNumberChannels))
        let count = Int(first.mDataByteSize) / MemoryLayout<Float>.size / channels
        for frame in 0..<count {
            let left = channelSample(buffers, 0, frame)
            let right = channelSample(buffers, 1, frame)
            leftSamples[cursor] = left
            rightSamples[cursor] = right
            samples[cursor] = (left + right) * 0.5
            cursor = (cursor + 1) % 512
        }
        let now = DispatchTime.now().uptimeNanoseconds
        guard now - lastSent >= 33_000_000 else { return }
        lastSent = now
        var real = [Float](repeating: 0, count: 256)
        var imag = real
        var ordered = (0..<512).map { samples[(cursor + $0) % 512] }
        let wave = ordered.map { Int(max(0, min(255, 128 + $0 * 127))) }
        vDSP_vmul(ordered, 1, window, 1, &ordered, 1, 512)
        var powers = [Float](repeating: 0, count: 256)
        real.withUnsafeMutableBufferPointer { r in
            imag.withUnsafeMutableBufferPointer { i in
                var split = DSPSplitComplex(realp: r.baseAddress!, imagp: i.baseAddress!)
                ordered.withUnsafeBufferPointer { data in
                    data.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: 256) {
                        vDSP_ctoz($0, 2, &split, 1, 256)
                    }
                }
                vDSP_fft_zrip(fft, &split, 1, 9, FFTDirection(kFFTDirection_Forward))
                split.imagp[0] = 0
                vDSP_zvmags(&split, 1, &powers, 1, 256)
            }
        }
        let frequencies = powers.map { Int(max(0, min(255, (10 * log10(max($0 / (512 * 512), 1e-12)) + 100) / 70 * 255))) }
        let left = levels(leftSamples)
        let right = levels(rightSamples)
        if let json = try? JSONSerialization.data(withJSONObject: ["frequency": frequencies, "time": wave,
            "levels": ["rms": [left.0, right.0], "peak": [left.1, right.1]]]) {
            FileHandle.standardOutput.write(json)
            FileHandle.standardOutput.write(Data([10]))
        }
    })
    try check(AudioDeviceStart(aggregate, callback))
    let timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
        if getppid() != parent || kill(pid, 0) != 0 { CFRunLoopStop(CFRunLoopGetMain()) }
    }
    RunLoop.main.run()
    timer.invalidate()
    AudioDeviceStop(aggregate, callback)
    if let callback { AudioDeviceDestroyIOProcID(aggregate, callback) }
    vDSP_destroy_fftsetup(fft)
} catch {
    // Only status codes, never captured audio or other process data, go to diagnostics.
    fputs("Audio analysis unavailable (\((error as NSError).code))\n", stderr)
}
if aggregate != 0 { AudioHardwareDestroyAggregateDevice(aggregate) }
if tap != 0 { AudioHardwareDestroyProcessTap(tap) }
