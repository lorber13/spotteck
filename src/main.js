const { app, BrowserWindow, ipcMain, globalShortcut, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const SpotifyController = require('./spotify-controller');
const PlaylistsStore = require('./playlists-store');
const { AudioMeter } = require('./audio-meter');
const { visibleBounds } = require('./window-bounds');
let audioMeter;

// Allow WebAudio AudioContext, <audio>.play(), and macOS Hardware Media Keys (F7/F8/F9 & Now Playing)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService');

let mainWindow = null;
let saveBoundsTimer = null;
const boundsFile = path.join(app.getPath('userData'), 'user-data', 'window-bounds.json');

function loadBounds() {
  try {
    if (fs.existsSync(boundsFile)) {
      const b = JSON.parse(fs.readFileSync(boundsFile, 'utf8'));
      if (b && typeof b.width === 'number' && typeof b.height === 'number') return b;
    }
  } catch (_e) {}
  return { width: 329, height: 628 };
}

function scheduleSaveBounds() {
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      fs.mkdirSync(path.dirname(boundsFile), { recursive: true });
      fs.writeFileSync(boundsFile, JSON.stringify(mainWindow.getBounds(), null, 2), 'utf8');
    } catch (_e) {}
  }, 350);
}

function createWindow() {
  // Drop a position on a display that is no longer connected, or the window opens off-screen.
  const initial = visibleBounds(loadBounds(), screen.getAllDisplays().map((display) => display.workArea));

  const opts = {
    width: Math.max(329, initial.width || 980),
    height: Math.max(440, initial.height || 480),
    minWidth: 329,
    minHeight: 440,
    resizable: true,
    // Only the native macOS traffic lights, drawn by the system over our faceplate.
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: '#141413',
    fullscreenable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  };
  if (typeof initial.x === 'number' && typeof initial.y === 'number') {
    opts.x = initial.x;
    opts.y = initial.y;
  }

  mainWindow = new BrowserWindow(opts);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('resize', scheduleSaveBounds);
  mainWindow.on('move', scheduleSaveBounds);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  audioMeter = new AudioMeter(app, mainWindow, () => SpotifyController.audioProcessId());
  SpotifyController.init(mainWindow).catch((err) => console.error('Spotify standalone init failed:', err));

  // Register global hardware media keys (F7 / F8 / F9 on Mac keyboards)
  try {
    globalShortcut.register('MediaNextTrack', () => {
      SpotifyController.nextTrack().catch(() => {});
    });
    globalShortcut.register('MediaPreviousTrack', () => {
      SpotifyController.prevTrack().catch(() => {});
    });
    globalShortcut.register('MediaPlayPause', () => {
      SpotifyController.playPause().catch(() => {});
    });
  } catch (_e) {}

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  audioMeter?.stop();
  try { globalShortcut.unregisterAll(); } catch (_e) {}
  SpotifyController.restoreWindowOnExit().catch(() => {});
});
app.on('window-all-closed', () => app.quit());

ipcMain.handle('spotify:get-state', () => SpotifyController.getPlayerState());
ipcMain.handle('spotify:play-pause', () => SpotifyController.playPause());
ipcMain.handle('spotify:next', () => SpotifyController.nextTrack());
ipcMain.handle('spotify:prev', () => SpotifyController.prevTrack());
ipcMain.handle('spotify:set-shuffle', (_e, val) => SpotifyController.setShuffle(!!val));
ipcMain.handle('spotify:seek', (_e, sec) => SpotifyController.seek(sec));
ipcMain.handle('spotify:set-volume', (_e, vol) => SpotifyController.setVolume(vol));
ipcMain.handle('spotify:play-uri', (_e, uri) => SpotifyController.playUri(uri));
ipcMain.handle('spotify:play-track-in-context', (_e, track, ctx) => SpotifyController.playTrackInContext(track, ctx));
ipcMain.handle('spotify:get-profile', () => SpotifyController.getProfile());
ipcMain.handle('spotify:login', (_e, clientId) => SpotifyController.login(clientId));
ipcMain.handle('spotify:logout', () => SpotifyController.logout());
ipcMain.handle('soloist:configure', (_e, key) => SpotifyController.configureSoloist(key));
ipcMain.handle('soloist:connect', () => SpotifyController.connectSoloist());
ipcMain.handle('soloist:open-key-page', () => shell.openExternal('https://developer.spotify.com/dashboard/soloist'));

ipcMain.handle('playlists:get', () => PlaylistsStore.getPlaylists());
ipcMain.handle('playlists:tracks', (_e, id) => PlaylistsStore.fetchPlaylistTracks(id));
ipcMain.handle('playlists:add-url', (_e, url) => PlaylistsStore.addPlaylistByUrl(url));
ipcMain.handle('playlists:remove', (_e, id) => PlaylistsStore.removePlaylist(id));
