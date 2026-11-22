# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Recoder is a local-first screen recorder with no length limit (React 18 + TS + Vite + Tailwind v4). The same `src/` app ships as three targets: a hosted web app/PWA, a Chrome MV3 extension, and a macOS Electron app. `SPEC.md` is the original product spec, including the acceptance criteria.

## Commands

```bash
npm run dev               # Vite dev server (web target)
npm run typecheck         # tsc --noEmit (strict; noUnusedLocals/Parameters are on)
npm run build             # web/PWA → dist/
npm run build:extension   # → dist-extension/ + recoder-extension.zip (load unpacked in chrome://extensions)
npm run app               # build renderer + launch Electron locally
npm run dist:mac          # electron-builder → release/*.dmg + .zip (unsigned, arm64)
```

`RECODER_DEV_URL=http://localhost:<port> npx electron .` runs Electron against a live Vite server.

There is no test suite or linter. Verification has been done by driving headless Chrome/Electron with `playwright-core` (channel `chrome`; extensions need channel `chromium`). Useful flags: `--auto-select-tab-capture-source-by-title=<title>` (auto-accepts getDisplayMedia) and stubbing `window.showSaveFilePicker` to return an OPFS handle. `getUserMedia` hangs in headless Chrome on macOS, so mic paths can't be tested headless.

## Build targets

`vite.config.ts` switches on `--mode`:
- `production`: `dist/`, base `/`, `public/` (PWA manifest + `sw.js`)
- `extension`: `dist-extension/`, base `./`, publicDir `platforms/extension`
- `electron`: `dist-electron/`, base `./`, publicDir `platforms/electron-public`, injects a CSP meta tag

The packaged modes strip the PWA manifest link. The service worker only registers when `MODE === 'production'` and the page is served over http(s). All npm packages are devDependencies because Vite bundles everything, so the Electron app ships no node_modules. Keep it that way.

## Architecture (big picture)

**Recording pipeline** (`src/services/recorderEngine.ts` orchestrates):
1. `mediaCapture.getDisplayStream()` → screen video (+ optional system audio). The mic stream is owned by `useMicPreview` (in `hooks/useMediaDevices.ts`) and handed to the engine; the engine never stops it.
2. `AudioMixer` (Web Audio): mic → gain → destination + analyser; system audio → gain → destination. Mute only ramps the gain node to 0. Never stop tracks to mute (keeps A/V in sync).
3. `MediaRecorder.start(1000)` → each chunk goes through `opfsStorage.storageWorker` → `workers/storage.worker.ts`.
4. The worker writes with `FileSystemSyncAccessHandle` + `flush()` per chunk. **Do not switch to `createWritable()` for recording.** It writes to a swap file that is only committed on close, so a crash would lose the whole recording. Messages are serialized through a promise chain.
5. Metadata JSON (`recordings/<id>.json`) is rewritten every 5s through the same serialized chain. `finalize()` clears the timers first so a late metadata write can't overwrite `status: 'completed'`.

**Invariants:**
- Never buffer recording chunks or whole files in JS memory. No `chunks[]` and no ffmpeg.wasm. Preview and export use disk-backed `File`/`Blob.slice()`.
- OPFS files are created only after capture permissions succeed, so a denied permission leaves no orphans.
- The timer is derived (`activeElapsedMs`: now − startTime − pausedDuration − current pause span), not counted.
- MP4 (H.264/AAC) is the preferred recording format, with WebM as a fallback (Firefox). `videoKeyFrameIntervalDuration: 1000` is required: Chrome's MP4 muxer only emits a fragment at each keyframe, so without it data piles up in memory.

**Camera bubble** has two modes (`settings.cameraMode`). The camera stream is owned by `useCameraPreview` (`hooks/useMediaDevices.ts`). Like the mic, the engine and the bubble only borrow it and never stop it.
- `floating`: an on-screen bubble that is captured as part of the screen, with no pipeline change. In the browser it is the Document PiP window (`usePipWindow` kind `'bubble'` → `components/CameraBubble.tsx`, which has hover controls). A page gets only one PiP window, so it replaces the Mini Bar. The PiP must be opened from a click. In Electron it is a frameless, transparent, always-on-top window (`electron/bubble.html`, driven via `native.showBubble/hideBubble`) that opens the camera itself, so the main window skips its own camera in this mode. Its `file://` origin is granted only `media`. Its lifecycle lives in `main.cjs` as desired state (`bubbleWanted`): a hide that lands during the camera-permission await must win, and handlers must reference their own `win`, never the global. It must keep `skipTransformProcessType: true`, or macOS turns Recoder into a Dock-less background app that can't be quit. The bubble is destroyed on reload, renderer crash and main-window close, and closing the main window quits the app. The bubble's × sends `recoder:bubble-closed`, which switches the camera setting off. `cameraEnabled` is never restored at launch.
- `composite` ("In video"): `services/cameraCompositor.ts` feeds the screen track and a clone of the camera track through `MediaStreamTrackProcessor` into `workers/compositor.worker.ts`. The worker draws onto an OffscreenCanvas fixed at the first frame's size and writes to a `MediaStreamTrackGenerator`, which is what gets recorded. It keeps only the latest frame per source and closes superseded frames immediately, or capture stalls. It needs Chrome/Edge/Electron. The `ended` listener for "Stop sharing" stays on the raw screen track.

**Crash recovery:** while recording, the tab holds a Web Lock `recoder-rec-<id>`. On load, `findInterrupted()` flags non-completed sessions whose lock is free. `finalizeInterrupted()` estimates duration from the last WebM cluster (`webmDuration.probeWebmDurationMs`) or extrapolates from the bitrate.

**Seekable WebM without remuxing:** `webmDuration.ts` parses only the EBML header and injects `Info/Duration`. The playable Blob is `[patchedPrefix, file.slice(resumeAt)]`.

**Export** (`services/exporter.ts`): always produces `.mp4`. The flow:
1. Call `showSaveFilePicker` *before* any async work, to keep the click's user activation.
2. MP4 recordings are piped straight into the chosen file. WebM recordings go through `mp4Converter.ts` (mediabunny, lazy-imported, `fastStart: false`, streaming into a wrapped writable that is aborted on cancel/error).
3. Without the picker (Firefox/Safari), the file is converted into OPFS `exports/` and then downloaded. That directory is cleaned up on the next launch.

**Platforms:**
- `src/lib/platform.ts`: `window.recoderNative` (Electron preload bridge), `isElectron`, `isExtension`.
- `electron/main.cjs`: serves `dist-electron` over a privileged `app://recoder` scheme (needed for OPFS and workers). It replaces getDisplayMedia's picker with `picker.html` via `setDisplayMediaRequestHandler`, and turns on Chromium's macOS ScreenCaptureKit loopback-audio feature flags. If system-audio capture fails, the renderer calls `reuseLastChoiceWithoutAudio()` and retries video-only without showing the picker again. The page's `beforeunload` guard is turned into a native dialog via `will-prevent-unload`.
- `platforms/extension/`: MV3 manifest (`unlimitedStorage`), and `background.js`, which opens or focuses `index.html` in a tab.
- The share-surface setting (`monitor|window|browser`) is passed as the `displaySurface` hint in browsers and through the preload bridge in Electron (the Browser Tab card is hidden there).

**UI state:** `RecorderEngine` is a singleton store consumed via `useSyncExternalStore` (`hooks/useRecorder.ts`). It also emits `toast`/`finished` events. Settings persist to `localStorage` (`recoder.settings.v1`). Each target and origin has its own OPFS library.
