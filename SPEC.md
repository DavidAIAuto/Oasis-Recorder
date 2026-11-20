# Technical Specification: Free & Unlimited Screen Recorder (`SPEC.md`)

## 1. Project Overview
Build a **100% free, local-first, zero-backend screen recorder web application** capable of recording **unlimited-length** screen recordings and live screen-sharing sessions with **full microphone and system audio support**.

### Non-Negotiable Principles
1. **Unlimited Duration:** No artificial timers or recording caps. A user must be able to record for 10 seconds or 10+ hours without the browser tab crashing or running out of RAM.
2. **Completely Free & Private:** 100% client-side execution. Zero backend servers, zero authentication/login walls, zero watermarks, zero telemetry.
3. **Microphone First-Class Support:** Users can pick any connected microphone, see a live input volume meter before and during recording, and mute/unmute mid-recording without breaking the stream.
4. **Crash Resilient:** Recordings must be streamed incrementally to disk so an accidental tab close or browser crash does not destroy hours of footage.

---

## 2. Tech Stack
* **Framework:** React 18+ with TypeScript and Vite
* **Styling:** Tailwind CSS
* **Icons:** `lucide-react`
* **Storage & Streaming:** Origin Private File System (**OPFS**) + File System Access API (`showSaveFilePicker` where supported, with disk-backed `File` download fallback)
* **Media Capture & Mixing:** Browser native `navigator.mediaDevices.getDisplayMedia`, `navigator.mediaDevices.getUserMedia`, **Web Audio API** (`AudioContext`, `MediaStreamAudioDestinationNode`, `GainNode`, `AnalyserNode`), and `MediaRecorder` API
* **PWA Support (Optional/Lightweight):** Manifest + basic offline caching so users can install it as a standalone desktop-like app via Chrome/Edge.

> **Important Architectural Constraint:** Do **NOT** store recorded `Blob` chunks in React state or an in-memory JS array (`const chunks = []`). Do **NOT** use `ffmpeg.wasm` for automatic post-processing on long recordings, as WASM linear memory limits (~2GB–4GB) will crash multi-hour exports. Keep recording and export 100% stream-based.

---

## 3. Core Architecture & Technical Design

### 3.1. Directory Structure
```text
src/
├── main.tsx
├── App.tsx
├── types/
│   └── recording.ts          # Types for settings, tracks, metadata, recovery state
├── services/
│   ├── opfsStorage.ts        # OPFS chunk writer, metadata persistence, quota check, recovery
│   ├── audioMixer.ts         # Web Audio API mixer (mic + system audio, gain mute, VU analyser)
│   ├── mediaCapture.ts       # getDisplayMedia, getUserMedia, codec negotiation, device enumeration
│   └── recorderEngine.ts     # Orchestrates MediaRecorder -> OPFS streaming, pause/resume, stop
├── hooks/
│   ├── useMediaDevices.ts    # Mic list, permission state, hot-plug devicechange listener
│   ├── useAudioMeter.ts      # requestAnimationFrame loop reading AnalyserNode for live VU meter
│   └── useRecorder.ts        # Clean React interface over recorderEngine
└── components/
    ├── SetupPanel.tsx        # Capture mode, quality/FPS presets, audio/mic selection & meter
    ├── RecordingBar.tsx      # Active controls: HH:MM:SS timer, Pause/Resume, Stop, Mute, size est.
    ├── RecoveryBanner.tsx    # Prompts user to save/discard incomplete OPFS sessions after crash
    ├── RecordingsList.tsx    # Local OPFS recordings library with preview modal, Save As, Delete
    └── MiniPiPControls.tsx   # Optional Document Picture-in-Picture floating controls (Chrome/Edge)
```

---

### 3.2. Media Capture & Audio Mixing Pipeline (`audioMixer.ts` & `mediaCapture.ts`)

1. **Screen Capture (`getDisplayMedia`):**
   * Request video with user-selected constraints:
     * Resolution presets: `Native`, `1080p` (`1920x1080`), `720p` (`1280x720`)
     * Frame rate presets: `30 fps`, `60 fps`
   * Request `audio: true` (system/tab audio) when "Capture System Audio" is enabled.
   * Handle `videoTrack.onended` (triggered if the user clicks the browser's built-in "Stop sharing" button) to gracefully stop and finalize the recording instead of losing data.

2. **Microphone Capture (`getUserMedia`):**
   * Enumerate audio input devices (`enumerateDevices`) and listen to `navigator.mediaDevices.ondevicechange` for hot-plugged mics/headsets.
   * Allow toggling `echoCancellation`, `noiseSuppression`, and `autoGainControl` (default: enabled for clean speech during screen shares).
   * Handle `micTrack.onended` (e.g., Bluetooth headset disconnects mid-session): show a non-blocking warning toast and continue recording the video/system audio without crashing.

3. **Web Audio API Mixing (`audioMixer.ts`):**
   * Create an `AudioContext`.
   * Connect Microphone stream -> `micGainNode` -> `MediaStreamAudioDestinationNode` (`dest`).
   * Also connect `micGainNode` -> `AnalyserNode` to power the live VU volume meter.
   * **Muting Implementation:** To mute/unmute the mic mid-recording without interrupting the `MediaRecorder` stream or causing audio/video drift, set `micGainNode.gain.setValueAtTime(0 or volume, audioContext.currentTime)`. Never call `track.stop()` on mute.
   * If System Audio track exists on the `displayStream`, connect it -> `systemGainNode` -> `dest`.
   * Combine `displayStream.getVideoTracks()` + `dest.stream.getAudioTracks()` into the final `MediaStream` passed to `MediaRecorder`.
   * Edge case: If both Mic and System Audio are disabled, pass only video tracks to `MediaRecorder`.

---

### 3.3. Unlimited-Length Disk Streaming (`opfsStorage.ts` & `recorderEngine.ts`)

1. **Codec Selection:**
   * Probe `MediaRecorder.isTypeSupported(...)` in priority order:
     1. `video/webm;codecs=vp9,opus`
     2. `video/webm;codecs=vp8,opus`
     3. `video/webm`
     4. `video/mp4` (Safari fallback)
   * Configure sensible `videoBitsPerSecond` based on resolution preset (e.g., 2.5 Mbps for 720p, 5 Mbps for 1080p, 8 Mbps for Native/60fps) so 5-hour recordings stay manageable in size while staying sharp.

2. **Chunked Streaming to OPFS (Zero RAM Bloat):**
   * Start `MediaRecorder` with `recorder.start(1000)` (emits a chunk every 1 second).
   * Maintain a **serial write queue** (promise chain or Web Worker) so chunks are written strictly in order to an OPFS file (`recordings/<id>.webm`) using `FileSystemFileHandle.createWritable({ keepExistingData: true })` (or `createSyncAccessHandle()` inside a dedicated Storage Worker for maximum speed and broad compatibility, including Safari).
   * Track `bytesWritten`, `startTime`, `pausedDuration`, and `status: "recording" | "paused" | "completed"` in a companion metadata JSON file in OPFS (`recordings/<id>.json`), updated every ~5 seconds.
   * **Important:** Close the writable stream cleanly on `recorder.onstop` after all queued chunk writes have flushed.

3. **Disk Quota Safeguard:**
   * Before starting and every 30 seconds during recording, call `navigator.storage.estimate()`.
   * Display estimated remaining space / current file size in the UI.
   * If remaining available quota drops below `250 MB`, display an urgent warning and gracefully auto-stop + finalize the recording before hitting `0` bytes.

4. **Crash Recovery:**
   * On app mount, scan OPFS metadata files. Any session still marked `"recording"` or `"paused"` (not actively running in this tab) is flagged as an interrupted recording.
   * Show `RecoveryBanner.tsx` allowing the user to **Finalize & Save** the partial recording (which is already safely stored on disk up to the last 1-second chunk) or **Discard** it to free disk space.

5. **Zero-RAM Export / Download:**
   * **Option A (Preferred in Chrome/Edge):** If `window.showSaveFilePicker` is available, allow the user to stream the finalized OPFS `File` directly to any folder on their OS disk via `opfsFile.stream().pipeTo(targetWritable)`.
   * **Option B (Universal Fallback):** Obtain the disk-backed `File` handle via `fileHandle.getFile()`, create an object URL (`URL.createObjectURL(file)`), and trigger `<a download="recording-YYYY-MM-DD.webm">`. Revoke the URL after download.

---

## 4. UI / UX Requirements

### 4.1. Layout & Aesthetic
* Clean, modern, dark-mode-first studio interface (inspired by OBS Simple Mode + Loom, without any login/account chrome).
* Responsive single-page workspace with two main sections:
  1. **Studio Setup / Active Recorder Card** (Top/Center)
  2. **Local Recordings Library** (Bottom, persisted in OPFS until the user deletes them)

### 4.2. Screen-by-Screen / Component Details
1. **Setup Panel (Idle State):**
   * **Screen/Share Mode Note:** Clear helper text explaining users can pick *Entire Screen*, *Application Window* (e.g., Zoom/Meet/Teams/IDE), or *Browser Tab* in the browser prompt.
   * **Quality & FPS Selectors:** Resolution (`720p`, `1080p`, `Native`) + FPS (`30`, `60`) + Estimated MB/hour readout.
   * **Microphone Controls:**
     * Dropdown of detected microphones + Refresh button.
     * Toggle: Enable/Disable Mic.
     * **Live VU Meter:** Real-time animated audio bar showing mic input level *before* recording starts so the user can test their mic.
     * Mic Gain slider (0%–150%) + Noise Suppression toggle.
   * **System Audio Toggle:** Checkbox/switch to include system/tab audio.
   * **Optional 3-Second Countdown** toggle before capture begins.
   * Primary CTA: **"Start Recording"** button.

2. **Active Recording Bar (Recording / Paused State):**
   * Large tabular `HH:MM:SS` elapsed timer (strictly counting active recording time, frozen while paused).
   * Live file size counter (`e.g., 142.8 MB saved to disk`).
   * **Live Mic VU Meter** + quick **Mute/Unmute Mic** button (with clear red/muted indicator).
   * **Pause / Resume** button (calls `recorder.pause()` / `recorder.resume()` and suspends timer).
   * **Stop & Save** button.
   * **Pop-out Mini Controls (Progressive Enhancement):** If `window.documentPictureInPicture` is supported, offer a "Float Mini Bar" button that opens a tiny always-on-top control window (Timer, Mute, Pause, Stop) so the user can control the recording while presenting in other apps.

3. **Recordings Library:**
   * Lists all completed recordings stored in OPFS: filename/timestamp, duration, file size, format.
   * **Preview Player:** Plays directly from the disk-backed OPFS `File` URL (`<video controls>`).
   * **Save to Computer:** Exports file via `showSaveFilePicker` or download link.
   * **Delete:** Removes both video and metadata files from OPFS to free space.

---

## 5. Edge Cases & Acceptance Criteria
* [ ] **Long-duration stability test:** Recording continuously for extended periods must not grow JS heap memory linearly; chunks flush to OPFS every 1 second and are garbage-collected.
* [ ] **Native "Stop Sharing" button:** Clicking the browser's native "Stop sharing" overlay cleanly finalizes the OPFS file and moves the recording into the Recordings Library.
* [ ] **Pause/Resume timer accuracy:** Pausing for 60 seconds and resuming must not add 60 seconds to the displayed recording duration.
* [ ] **Live Mute:** Muting/unmuting the microphone mid-recording silences/restores the mic track cleanly while keeping system audio active and A/V in sync.
* [ ] **Permission Denial:** Denying screen or microphone permission shows a clear, friendly error banner with instructions to re-enable permissions, without leaving orphaned files in OPFS.
* [ ] **Safari / Firefox Compatibility:** Gracefully handle missing `showSaveFilePicker` or `documentPictureInPicture` using feature detection (never throw `ReferenceError` or unhandled rejections).
* [ ] **Crash Recovery:** Refreshing or killing the tab mid-recording leaves the partial `.webm` file recoverable via the Crash Recovery Banner upon reopening the app.

---

## 6. Build Instructions for Implementation
1. Scaffold a clean Vite + React + TypeScript + Tailwind CSS project.
2. Implement `opfsStorage.ts` (including a dedicated Web Worker if using `FileSystemSyncAccessHandle` for cross-browser OPFS support, or async `createWritable` with fallback) and test chunked read/write + recovery metadata.
3. Implement `audioMixer.ts` and `mediaCapture.ts` with proper cleanup of all `MediaStreamTrack`s and `AudioContext` on stop/error.
4. Build `recorderEngine.ts` and `useRecorder.ts` to bind capture, mixing, OPFS streaming, and quota monitoring together.
5. Build the UI components (`SetupPanel`, `RecordingBar`, `RecoveryBanner`, `RecordingsList`, `MiniPiPControls`).
6. Verify TypeScript compilation (`tsc --noEmit`) and production build (`npm run build`) pass with zero errors.
