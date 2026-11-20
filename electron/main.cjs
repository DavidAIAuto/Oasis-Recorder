// Recoder — macOS desktop shell (Electron main process).
// The UI is the same React app, served from a privileged `app://` origin so OPFS,
// workers and the File System Access API behave exactly like in Chrome.
const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  shell,
  systemPreferences,
} = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist-electron');
const DEV_URL = process.env.RECODER_DEV_URL; // e.g. http://localhost:5199 for live-reload dev
const APP_ORIGIN = 'app://recoder';

// macOS: let Chromium capture system audio through ScreenCaptureKit (macOS 13+).
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

/** @type {BrowserWindow | null} */
let mainWindow = null;
let sharePreference = { surface: 'monitor', audio: true };

/** Last picked source, so a failed audio request can be retried without re-prompting. */
let lastChoice = null;
let reuseNext = false;
ipcMain.on('recoder:reuse-last-without-audio', () => {
  reuseNext = true;
});

ipcMain.on('recoder:share-preference', (_e, pref) => {
  if (pref && typeof pref === 'object') sharePreference = { surface: String(pref.surface), audio: !!pref.audio };
});

/* ------------------------------------------------------------------ */
/* Screen / window picker                                              */
/* ------------------------------------------------------------------ */

/** @type {Map<string, Electron.DesktopCapturerSource>} */
let lastSources = new Map();
/** @type {((r: {id: string, audio: boolean} | null) => void) | null} */
let pickerResolve = null;
/** @type {BrowserWindow | null} */
let pickerWindow = null;

ipcMain.handle('picker:init', async () => {
  const screenAccess = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
  let sources = [];
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 400, height: 250 },
      fetchWindowIcons: true,
    });
  } catch (err) {
    console.error('getSources failed', err);
  }
  // Hide our own windows from the list.
  const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
  sources = sources.filter((s) => !own.has(s.id));
  lastSources = new Map(sources.map((s) => [s.id, s]));
  return {
    screenAccess,
    preference: sharePreference,
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    })),
  };
});

ipcMain.on('picker:choose', (_e, result) => {
  const resolve = pickerResolve;
  pickerResolve = null;
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
  resolve?.(result && typeof result.id === 'string' ? result : null);
});

ipcMain.on('picker:open-privacy-settings', () => {
  void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
});

function showPicker() {
  return new Promise((resolve) => {
    pickerResolve = resolve;
    pickerWindow = new BrowserWindow({
      parent: mainWindow ?? undefined,
      modal: true,
      width: 860,
      height: 620,
      minWidth: 600,
      minHeight: 420,
      show: false,
      backgroundColor: '#09090b',
      title: 'Choose what to record',
      webPreferences: {
        preload: path.join(__dirname, 'picker-preload.cjs'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    pickerWindow.setMenuBarVisibility(false);
    pickerWindow.once('ready-to-show', () => pickerWindow?.show());
    pickerWindow.on('closed', () => {
      pickerWindow = null;
      if (pickerResolve) {
        const r = pickerResolve;
        pickerResolve = null;
        r(null);
      }
    });
    void pickerWindow.loadFile(path.join(__dirname, 'picker.html'));
  });
}

/* ------------------------------------------------------------------ */
/* App window                                                          */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 900,
    minWidth: 720,
    minHeight: 600,
    backgroundColor: '#09090b',
    title: 'Recoder',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // keep timers/meters alive while recording in the background
    },
  });

  // External links open in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank') return { action: 'allow' }; // Document Picture-in-Picture
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The page blocks unload while recording; ask the user instead of silently refusing to close.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Keep Recording', 'Quit Anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'A recording is in progress.',
      detail: 'If you quit now, the recording stops. You can recover it the next time you open Recoder.',
    });
    if (choice === 1) event.preventDefault();
  });

  void mainWindow.loadURL(DEV_URL || `${APP_ORIGIN}/index.html`);
  mainWindow.on('closed', () => (mainWindow = null));
}

function buildMenu() {
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // Serve the built renderer from app://recoder/…
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const filePath = path.normalize(path.join(DIST, rel));
    if (!filePath.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(filePath).toString());
  });

  const ses = session.defaultSession;
  const allowed = new Set(['media', 'display-capture', 'fileSystem', 'clipboard-sanitized-write', 'window-management']);
  const trusted = (origin) => origin.startsWith(APP_ORIGIN) || (DEV_URL && origin.startsWith(new URL(DEV_URL).origin));
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(allowed.has(permission) && trusted(details.requestingUrl || wc.getURL()));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && trusted(origin));

  // getDisplayMedia() → our own picker of screens and windows.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    let choice;
    if (reuseNext && lastChoice) {
      choice = { id: lastChoice.id, audio: false };
    } else {
      choice = await showPicker();
    }
    reuseNext = false;
    lastChoice = choice;
    const source = choice ? lastSources.get(choice.id) : null;
    if (!source) {
      callback({}); // rejects getDisplayMedia with NotAllowedError → friendly message in the UI
      return;
    }
    /** @type {Electron.Streams} */
    const streams = { video: source };
    // 'loopback' = system audio (Windows, and macOS 13+ via ScreenCaptureKit).
    if (request.audioRequested && choice.audio) streams.audio = 'loopback';
    callback(streams);
  });

  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
    systemPreferences.askForMediaAccess('microphone').catch(() => {});
  }

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
