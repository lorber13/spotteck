const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const PlaylistsStore = require('./playlists-store');

let mainWindowRef = null;
let pollTimer = null;
let isPolling = false;

const state = {
  isRunning: false,
  isPlaying: false,
  track: 'Spotify Companion',
  artist: 'Pronto',
  album: '',
  duration: 0,
  position: 0,
  shuffling: false,
  artwork: '',
  trackUri: '',
  contextUri: '',
  volume: 100,
  authenticated: true
};

const URI_RE = /^spotify:(track|playlist|album|artist):[A-Za-z0-9]+$/;
let lastTrackForContextCheck = null;

function toUri(input, defaultType = 'playlist') {
  if (!input) return null;
  const s = String(input).trim();
  if (URI_RE.test(s)) return s;
  const m = s.match(/open\.spotify\.com\/(track|playlist|album|artist)\/([A-Za-z0-9]+)/);
  if (m) return `spotify:${m[1]}:${m[2]}`;
  if (/^[A-Za-z0-9]{22}$/.test(s)) return `spotify:${defaultType}:${s}`;
  return null;
}

// ---------------------------------------------------------------------------
// Ulanzi Spotify Plugin Credentials Decryption & Spotify Connect Token
// ---------------------------------------------------------------------------
const ULANZI_DATA_PATH = path.join(
  os.homedir(),
  'Library/Application Support/Ulanzi/UlanziDeck/Plugins/com.buzs.spotify.ulanziPlugin/.data/index.json'
);
const PLUGIN_UUID = 'com.buzs.ulanzideck.spotify';
const SALT = 'ulanzi-spotify-v2';

let cachedAccessToken = null;
let tokenExpiresAt = 0;
let cachedRefreshToken = null;
let cachedClientId = null;
let cachedClientSecret = null;
let cachedDisplayName = '';

function decryptUlanziSecret(obj) {
  if (!obj || typeof obj === 'string') return null;
  try {
    const key = crypto.pbkdf2Sync(`${os.hostname()}${PLUGIN_UUID}`, SALT, 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(obj.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(obj.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(obj.data, 'base64')), decipher.final()]).toString('utf8');
  } catch (_e) {
    return null;
  }
}

async function loadUlanziCredentials() {
  try {
    if (!fs.existsSync(ULANZI_DATA_PATH)) return false;
    const raw = JSON.parse(fs.readFileSync(ULANZI_DATA_PATH, 'utf8'));
    const accounts = Object.values(raw.accounts || {});
    if (!accounts.length) return false;
    const acct = accounts[0];

    const at = decryptUlanziSecret(acct.accessToken);
    const rt = decryptUlanziSecret(acct.refreshToken);
    const cs = decryptUlanziSecret(acct.clientSecret);
    const ci = acct.clientId;
    if (acct.displayName) cachedDisplayName = acct.displayName;

    if (rt) cachedRefreshToken = rt;
    if (ci) cachedClientId = ci;
    if (cs) cachedClientSecret = cs;

    if (at && typeof acct.expiresAt === 'number' && Date.now() < acct.expiresAt - 60000) {
      cachedAccessToken = at;
      tokenExpiresAt = acct.expiresAt;
      return true;
    }

    if (rt && ci && cs) {
      return await refreshSpotifyAccessToken();
    }
  } catch (_e) {}
  return false;
}

async function refreshSpotifyAccessToken() {
  if (!cachedRefreshToken || !cachedClientId || !cachedClientSecret) return false;
  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', cachedRefreshToken);

    const authHeader = Buffer.from(`${cachedClientId}:${cachedClientSecret}`).toString('base64');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (data.access_token) {
      cachedAccessToken = data.access_token;
      tokenExpiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
      return true;
    }
  } catch (_e) {}
  return false;
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedAccessToken;
  }
  const loaded = await loadUlanziCredentials();
  if (loaded && cachedAccessToken) return cachedAccessToken;
  return null;
}

async function spotifyWebApiRequest(method, endpoint, body = null, queryParams = null) {
  let token = await getAccessToken();
  if (!token) return null;

  const url = new URL(`https://api.spotify.com/v1${endpoint}`);
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`
    }
  };
  if (body !== null && body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  try {
    let res = await fetch(url, options);

    // If 401 Unauthorized, token expired: refresh once and retry
    if (res.status === 401) {
      cachedAccessToken = null;
      tokenExpiresAt = 0;
      const refreshed = await refreshSpotifyAccessToken();
      if (refreshed && cachedAccessToken) {
        options.headers.Authorization = `Bearer ${cachedAccessToken}`;
        res = await fetch(url, options);
      }
    }

    if (res.status === 204) {
      return { ok: true, status: 204, data: null };
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_e) {}

    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

async function getOrActivateDevice() {
  try {
    const devRes = await spotifyWebApiRequest('GET', '/me/player/devices');
    if (devRes && devRes.ok && devRes.data && Array.isArray(devRes.data.devices)) {
      const list = devRes.data.devices;
      const dev = list.find((d) => d.is_active) || list.find((d) => d.type === 'Computer') || list[0];
      if (dev) return dev.id;
    }
  } catch (_e) {}
  return null;
}

// ---------------------------------------------------------------------------
// Native macOS AppleScript Fallback Bridge & Process Background Control
// ---------------------------------------------------------------------------
function runOsa(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 4000 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve((stdout || '').trim());
    });
  });
}

async function isSpotifyProcessRunning() {
  try {
    const res = await runOsa(`
      tell application "System Events"
        return (count (every process whose bundle identifier is "com.spotify.client")) > 0
      end tell
    `);
    return res === 'true';
  } catch (_e) {
    return false;
  }
}

async function hideSpotify() {
  try {
    await runOsa(`
      tell application "System Events"
        if (count (every process whose bundle identifier is "com.spotify.client")) > 0 then
          tell process "Spotify"
            try
              set value of attribute "AXFullScreen" of window 1 to false
            end try
          end tell
          set visible of (every process whose bundle identifier is "com.spotify.client") to false
        end if
      end tell
    `);
  } catch (_e) {}
}

function refocusApp() {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    try {
      mainWindowRef.focus();
    } catch (_e) {}
  }
}

async function ensureSpotifyRunning() {
  const running = await isSpotifyProcessRunning();
  if (!running) {
    await new Promise((resolve) => {
      execFile('open', ['-g', '-j', '-a', '/Applications/Spotify.app'], () => {
        setTimeout(async () => {
          await hideSpotify();
          refocusApp();
          resolve();
        }, 1200);
      });
    });
  } else {
    hideSpotify().catch(() => {});
  }
}

const GET_STATE_SCRIPT = `
tell application "System Events"
  set isRunning to (count (every process whose bundle identifier is "com.spotify.client")) > 0
end tell
if not isRunning then
  return "not_running"
end if
tell application "Spotify"
  set d to character id 0
  set pState to player state as string
  set pPos to player position as integer
  set pVol to sound volume
  set pShuff to shuffling as string
  set curTrack to ""
  set curArtist to ""
  set curAlbum to ""
  set curDuration to 0
  set curArt to ""
  set curId to ""
  try
    set curTrack to name of current track
    set curArtist to artist of current track
    set curAlbum to album of current track
    set curDuration to duration of current track
    set curArt to artwork url of current track
    set curId to id of current track
  end try
  return pState & d & pPos & d & pVol & d & pShuff & d & curTrack & d & curArtist & d & curAlbum & d & curDuration & d & curArt & d & curId
end tell
`;

function getPlayerStateSync() {
  return {
    isRunning: state.isRunning,
    isPlaying: state.isPlaying,
    track: state.track || 'Spotify Companion',
    artist: state.artist || (state.isRunning ? 'In pausa' : 'Pronto'),
    album: state.album || '',
    duration: state.duration || 0,
    position: state.position || 0,
    shuffling: !!state.shuffling,
    artwork: state.artwork || '',
    trackUri: state.trackUri || '',
    contextUri: state.contextUri || '',
    volume: typeof state.volume === 'number' ? state.volume : 100,
    authenticated: true
  };
}

function pushStateToRenderer() {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('spotify:state', getPlayerStateSync());
  }
}

async function pollSpotifyState() {
  if (isPolling) return;
  isPolling = true;
  try {
    // 1. Prefer Spotify Web API Connect (fast, non-intrusive, exact status)
    const webRes = await spotifyWebApiRequest('GET', '/me/player');
    if (webRes && webRes.ok) {
      if (webRes.status === 204 || !webRes.data) {
        const running = await isSpotifyProcessRunning();
        state.isRunning = running;
        state.isPlaying = false;
        pushStateToRenderer();
        return;
      }

      const d = webRes.data;
      state.isRunning = true;
      state.isPlaying = !!d.is_playing;
      state.position = Math.round((d.progress_ms || 0) / 1000);
      if (d.item) {
        state.track = d.item.name || 'Spotify';
        state.artist = (d.item.artists && d.item.artists.length)
          ? d.item.artists.map((a) => a.name).join(', ')
          : '';
        state.album = (d.item.album && d.item.album.name) || '';
        state.duration = Math.round((d.item.duration_ms || 0) / 1000);
        if (d.item.uri) state.trackUri = d.item.uri;
        if (d.item.album && d.item.album.images && d.item.album.images[0]) {
          state.artwork = d.item.album.images[0].url;
        }
      }
      if (d.device && typeof d.device.volume_percent === 'number') {
        state.volume = d.device.volume_percent;
      }
      if (typeof d.shuffle_state === 'boolean') {
        state.shuffling = d.shuffle_state;
      }
      if (d.context && d.context.uri) {
        state.contextUri = d.context.uri;
        lastTrackForContextCheck = state.trackUri;
      }

      // If contextUri is missing, match against saved playlists (only once per track change)
      if (!state.contextUri && state.trackUri && state.trackUri !== lastTrackForContextCheck) {
        lastTrackForContextCheck = state.trackUri;
        try {
          const saved = PlaylistsStore.getPlaylists();
          for (const pl of saved) {
            const tracksRes = await PlaylistsStore.fetchPlaylistTracks(pl.id);
            if (tracksRes && Array.isArray(tracksRes.tracks)) {
              if (tracksRes.tracks.some((t) => t.uri === state.trackUri)) {
                state.contextUri = toUri(pl.id, 'playlist') || pl.id;
                break;
              }
            }
          }
        } catch (_e) {}
      }

      pushStateToRenderer();
      return;
    }

    // 2. Fallback to AppleScript
    const raw = await runOsa(GET_STATE_SCRIPT);
    if (!raw || raw === 'not_running') {
      state.isRunning = false;
      state.isPlaying = false;
      pushStateToRenderer();
      return;
    }

    const parts = raw.split('\0');
    if (parts.length >= 10) {
      const pState = parts[0];
      const pPos = parseInt(parts[1], 10) || 0;
      const pVol = parseInt(parts[2], 10) || 100;
      const pShuff = parts[3] === 'true';
      const cTrack = parts[4] || '';
      const cArtist = parts[5] || '';
      const cAlbum = parts[6] || '';
      const cDurMs = parseInt(parts[7], 10) || 0;
      const cArt = parts[8] || '';
      const cId = parts[9] || '';

      state.isRunning = true;
      state.isPlaying = pState === 'playing';
      state.position = pPos;
      state.volume = pVol;
      state.shuffling = pShuff;
      state.track = cTrack || 'Spotify';
      state.artist = cArtist;
      state.album = cAlbum;
      state.duration = Math.round(cDurMs / 1000);
      if (cArt) state.artwork = cArt;
      if (cId) state.trackUri = cId;

      if (!state.contextUri && state.trackUri && state.trackUri !== lastTrackForContextCheck) {
        lastTrackForContextCheck = state.trackUri;
        try {
          const saved = PlaylistsStore.getPlaylists();
          for (const pl of saved) {
            const tracksRes = await PlaylistsStore.fetchPlaylistTracks(pl.id);
            if (tracksRes && Array.isArray(tracksRes.tracks)) {
              if (tracksRes.tracks.some((t) => t.uri === state.trackUri)) {
                state.contextUri = toUri(pl.id, 'playlist') || pl.id;
                break;
              }
            }
          }
        } catch (_e) {}
      }

      pushStateToRenderer();
    }
  } catch (_e) {
  } finally {
    isPolling = false;
  }
}

const SpotifyController = {
  async init(mainWindow) {
    mainWindowRef = mainWindow;
    await loadUlanziCredentials();
    hideSpotify().catch(() => {});

    // Start background state poll (every 850ms)
    clearInterval(pollTimer);
    pollTimer = setInterval(pollSpotifyState, 850);
    pollSpotifyState().catch(() => {});
  },

  async getPlayerState() {
    await pollSpotifyState();
    return getPlayerStateSync();
  },

  async playPause() {
    await ensureSpotifyRunning();

    // 1. Try Spotify Web API first (silent in background)
    try {
      if (state.isPlaying) {
        const res = await spotifyWebApiRequest('PUT', '/me/player/pause');
        if (res && (res.ok || res.status === 204)) {
          state.isPlaying = false;
          pushStateToRenderer();
          setTimeout(pollSpotifyState, 140);
          return { ok: true };
        }
      } else {
        let res = await spotifyWebApiRequest('PUT', '/me/player/play');
        if (res && res.status === 404) {
          const devId = await getOrActivateDevice();
          if (devId) {
            res = await spotifyWebApiRequest('PUT', '/me/player/play', undefined, { device_id: devId });
          }
        }
        if (res && (res.ok || res.status === 204)) {
          state.isPlaying = true;
          pushStateToRenderer();
          setTimeout(pollSpotifyState, 140);
          return { ok: true };
        }
      }
    } catch (_e) {}

    // 2. Fallback to AppleScript
    try {
      await runOsa(`
        tell application "Spotify" to playpause
        tell application "System Events"
          try
            tell process "Spotify"
              set value of attribute "AXFullScreen" of window 1 to false
            end try
            set visible of (every process whose bundle identifier is "com.spotify.client") to false
          end try
        end tell
      `);
      refocusApp();
    } catch (_e) {}
    setTimeout(pollSpotifyState, 140);
    return { ok: true };
  },

  async nextTrack() {
    await ensureSpotifyRunning();

    // 1. Try Spotify Web API first
    try {
      const res = await spotifyWebApiRequest('POST', '/me/player/next');
      if (res && (res.ok || res.status === 204)) {
        hideSpotify().catch(() => {});
        refocusApp();
        setTimeout(pollSpotifyState, 140);
        return { ok: true };
      }
    } catch (_e) {}

    // 2. Fallback to AppleScript
    try {
      await runOsa(`
        tell application "Spotify" to next track
        tell application "System Events"
          try
            tell process "Spotify"
              set value of attribute "AXFullScreen" of window 1 to false
            end try
            set visible of (every process whose bundle identifier is "com.spotify.client") to false
          end try
        end tell
      `);
      refocusApp();
    } catch (_e) {}
    setTimeout(pollSpotifyState, 140);
    return { ok: true };
  },

  async prevTrack() {
    await ensureSpotifyRunning();

    // 1. Try Spotify Web API first
    try {
      const res = await spotifyWebApiRequest('POST', '/me/player/previous');
      if (res && (res.ok || res.status === 204)) {
        hideSpotify().catch(() => {});
        refocusApp();
        setTimeout(pollSpotifyState, 140);
        return { ok: true };
      }
    } catch (_e) {}

    // 2. Fallback to AppleScript
    try {
      await runOsa(`
        tell application "Spotify" to previous track
        tell application "System Events"
          try
            tell process "Spotify"
              set value of attribute "AXFullScreen" of window 1 to false
            end try
            set visible of (every process whose bundle identifier is "com.spotify.client") to false
          end try
        end tell
      `);
      refocusApp();
    } catch (_e) {}
    setTimeout(pollSpotifyState, 140);
    return { ok: true };
  },

  async setShuffle(val) {
    await ensureSpotifyRunning();

    // 1. Try Spotify Web API
    try {
      const res = await spotifyWebApiRequest('PUT', '/me/player/shuffle', undefined, { state: !!val });
      if (res && (res.ok || res.status === 204)) {
        state.shuffling = !!val;
        pushStateToRenderer();
        return { ok: true };
      }
    } catch (_e) {}

    // 2. Fallback to AppleScript
    try {
      await runOsa(`tell application "Spotify" to set shuffling to ${val ? 'true' : 'false'}`);
      state.shuffling = !!val;
      pushStateToRenderer();
    } catch (_e) {}
    return { ok: true };
  },

  async seek(seconds) {
    await ensureSpotifyRunning();
    const s = Math.max(0, Math.floor(seconds));

    // 1. Try Spotify Web API
    try {
      const res = await spotifyWebApiRequest('PUT', '/me/player/seek', undefined, { position_ms: s * 1000 });
      if (res && (res.ok || res.status === 204)) {
        state.position = s;
        pushStateToRenderer();
        return { ok: true };
      }
    } catch (_e) {}

    // 2. Fallback to AppleScript
    try {
      await runOsa(`tell application "Spotify" to set player position to ${s}`);
      state.position = s;
      pushStateToRenderer();
    } catch (_e) {}
    return { ok: true };
  },

  async setVolume(vol) {
    const v = Math.min(100, Math.max(0, Math.round(vol)));
    state.volume = v;

    // Try Spotify Web API first
    try {
      await spotifyWebApiRequest('PUT', '/me/player/volume', undefined, { volume_percent: v });
    } catch (_e) {}

    // Also keep Spotify Desktop local volume in sync
    try {
      await runOsa(`tell application "Spotify" to set sound volume to ${v}`);
    } catch (_e) {}
    return { ok: true };
  },

  async playUri(input) {
    await ensureSpotifyRunning();
    const uri = toUri(input);
    if (!uri) return { error: 'URI non valido' };
    state.contextUri = uri;

    // 1. Try Spotify Web API Connect (Silent background playback, zero window popups or space switches)
    try {
      let res = await spotifyWebApiRequest('PUT', '/me/player/play', { context_uri: uri });
      if (res && res.status === 404) {
        const devId = await getOrActivateDevice();
        if (devId) {
          res = await spotifyWebApiRequest('PUT', '/me/player/play', { context_uri: uri }, { device_id: devId });
        }
      }
      if (res && (res.ok || res.status === 204)) {
        hideSpotify().catch(() => {});
        refocusApp();
        setTimeout(pollSpotifyState, 180);
        return { ok: true };
      }
    } catch (_e) {}

    // 2. Fallback to AppleScript
    try {
      await runOsa(`
        tell application "Spotify"
          play track "${uri}"
        end tell
        tell application "System Events"
          try
            tell process "Spotify"
              set value of attribute "AXFullScreen" of window 1 to false
            end tell
            set visible of (every process whose bundle identifier is "com.spotify.client") to false
          end try
        end tell
      `);
      refocusApp();
      setTimeout(pollSpotifyState, 200);
      return { ok: true };
    } catch (err) {
      return { error: String(err) };
    }
  },

  async playTrackInContext(trackInput, contextInput) {
    await ensureSpotifyRunning();
    const trackUri = toUri(trackInput);
    const contextUri = toUri(contextInput);
    if (contextUri) state.contextUri = contextUri;
    if (trackUri) state.trackUri = trackUri;

    // 1. Try Spotify Web API Connect
    try {
      let playBody = null;
      if (contextUri && trackUri) {
        playBody = { context_uri: contextUri, offset: { uri: trackUri } };
      } else if (trackUri) {
        playBody = { uris: [trackUri] };
      }

      if (playBody) {
        let res = await spotifyWebApiRequest('PUT', '/me/player/play', playBody);
        if (res && res.status === 404) {
          const devId = await getOrActivateDevice();
          if (devId) {
            res = await spotifyWebApiRequest('PUT', '/me/player/play', playBody, { device_id: devId });
          }
        }
        if (res && (res.ok || res.status === 204)) {
          hideSpotify().catch(() => {});
          refocusApp();
          setTimeout(pollSpotifyState, 180);
          return { ok: true };
        }
      }
    } catch (_e) {}

    // 2. Fallback to AppleScript
    try {
      if (contextUri && trackUri) {
        await runOsa(`
          tell application "Spotify"
            play track "${trackUri}" in context "${contextUri}"
          end tell
          tell application "System Events"
            try
              tell process "Spotify"
                set value of attribute "AXFullScreen" of window 1 to false
              end tell
              set visible of (every process whose bundle identifier is "com.spotify.client") to false
            end try
          end tell
        `);
      } else if (trackUri) {
        await runOsa(`
          tell application "Spotify"
            play track "${trackUri}"
          end tell
          tell application "System Events"
            try
              tell process "Spotify"
                set value of attribute "AXFullScreen" of window 1 to false
              end tell
              set visible of (every process whose bundle identifier is "com.spotify.client") to false
            end try
          end tell
        `);
      }
      refocusApp();
      setTimeout(pollSpotifyState, 200);
      return { ok: true };
    } catch (err) {
      return { error: String(err) };
    }
  },

  async getProfile() {
    const running = await isSpotifyProcessRunning();
    return {
      authenticated: true,
      profile: {
        name: cachedDisplayName || 'Spotify User',
        product: running ? 'Connesso (Background Connect)' : 'In attesa di Spotify',
        email: ''
      }
    };
  },

  async login() {
    await loadUlanziCredentials();
    await ensureSpotifyRunning();
    await pollSpotifyState();
    return { ok: true };
  },

  async logout() {
    return { ok: true };
  },

  updateFromRenderer(_data) {
    // Spotify desktop is the source of truth for playback
  },

  async restoreWindowOnExit() {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};

module.exports = SpotifyController;
