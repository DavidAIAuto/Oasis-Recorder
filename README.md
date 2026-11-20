# Recoder

A free, private screen recorder with no length limit. It records your screen, a window or a tab, with microphone and system audio, and saves recordings as **MP4** (H.264/AAC). Recordings stream to disk as they're made (OPFS), so multi-hour sessions don't fill up RAM, and a crash doesn't lose the recording. No account, no watermark, no servers.

See [SPEC.md](SPEC.md) for the full specification.

## Ways to run it

| Target | Build | Install |
|---|---|---|
| **macOS app** | `npm run dist:mac` | Open `release/Recoder-<version>-arm64.dmg` and drag Recoder to Applications. The app is unsigned, so the first time, right-click it → **Open**. |
| **Chrome / Edge extension** | `npm run build:extension` | Go to `chrome://extensions`, turn on Developer mode, then **Load unpacked** → `dist-extension/`. Or upload `recoder-extension.zip` to the Chrome Web Store. |
| **Web app / PWA** | `npm run build` (dev: `npm run dev`) | Host `dist/` anywhere static. In Chrome, use ⋮ → **Install Recoder**. |

To try the desktop app without packaging it: `npm run app`.

## Platform notes

- **macOS app:** the first recording asks for *Screen & System Audio Recording* permission (System Settings → Privacy & Security). Recoder shows its own picker of screens and windows. System audio uses ScreenCaptureKit (macOS 13+). If it isn't available, Recoder records video only.
- **Chrome / Edge (web and extension):** the browser's picker opens on the Screen, Window or Tab list you chose. On macOS the browser can only capture tab audio. The extension asks for `unlimitedStorage`, so long recordings aren't limited by the browser's storage quota.
- **Firefox / Safari:** can record the screen and microphone, but not system audio.

## Layout

```
src/                 React app (shared by every target)
  workers/           OPFS storage worker (writes each chunk in place and flushes it, so crashes don't lose data)
  services/          capture, Web Audio mixer, recorder engine, WebM duration patcher, exporter
electron/            macOS shell: main process, preloads, screen/window picker
platforms/extension/ MV3 manifest, background worker, icons
public/              PWA manifest + service worker
```

## MP4 output

Recordings are made directly in MP4 (H.264 + AAC) wherever the browser supports it: Chrome/Edge 126+, Safari and the desktop app. A keyframe every second keeps data flushing to disk. In Firefox, and for older WebM recordings, **Save as MP4** converts the file with WebCodecs (mediabunny). The conversion streams from disk to the destination file, so memory stays flat even for very long recordings.
