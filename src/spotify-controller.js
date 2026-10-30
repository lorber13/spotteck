const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const PlaylistsStore = require('./playlists-store');
const { app } = require('electron');
const Auth = require('./spotify-auth');
const { SoloistPlayer } = require('./soloist-player');
const SoloistSettings = require('./soloist-settings');

let mainWindowRef = null;
let pollTimer = null;
let isPolling = false;
let account = null;
let accountCheckedAt = 0;
let playbackMode = 'desktop';
let playbackError = '';
let accountGeneration = 0;
let switchingAccount = false;
let soloistDeviceCheckedAt = 0;
let initialized = Promise.resolve();
let allowLegacyCredentials = !Auth.loggedOut();
const premium = new SoloistPlayer({ binary: SoloistSettings.binary(), installationId: app.getPath('userData'),
  cacheDir: path.join(app.getPath('userData'), 'soloist-player'), readKey: SoloistSettings.key,
  request: spotifyWebApiRequest, token: getAccessToken });

const ACCOUNT_RECHECK_MS = 5 * 60 * 1000;
const ACCOUNT_RETRY_MS = 30 * 1000;

async function selectPlaybackMode() {
  const epoch = accountGeneration;
  const res = await spotifyWebApiRequest('GET', '/me');
  if (epoch !== accountGeneration) return;
  // A network error, rate limit or server error says nothing about the plan:
  // keep the current mode and retry soon. No token or a 401 means signed out.
  if (res && !res.ok && (res.status === 0 || res.status === 429 || res.status >= 500)) {
    accountCheckedAt = Date.now() - ACCOUNT_RECHECK_MS + ACCOUNT_RETRY_MS;
    return;
  }
  account = res?.ok ? res.data : null;
  accountCheckedAt = Date.now();
  playbackError = '';
  // Premium playback needs Soloist set up; until then Spotify Desktop keeps working.
  const soloistReady = SoloistSettings.configured() && fs.existsSync(SoloistSettings.binary());
  let mode = soloistReady && account?.product === 'premium' ? 'premium' : 'desktop';
  // Some API responses omit product: only trust a paired receiver for that case.
  if (soloistReady && account && !account.product && premium.eligibility === 'supported') mode = 'premium';
  if (epoch !== accountGeneration) return;
  if (mode === 'desktop') premium.stop();
  playbackMode = mode;
}


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
  if (!allowLegacyCredentials || Auth.hasSession()) return false;
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
  if (Auth.hasSession()) {
    try { return !!(await Auth.token(true)); } catch (_) { return false; }
  }
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
      body: params, signal: AbortSignal.timeout(15000)
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
  if (Auth.hasSession()) {
    try { return await Auth.token(); } catch (_) {
      // Spotify rejected the session: show it as signed out and re-pick the mode on the next control.
      if (!Auth.hasSession()) { account = null; accountCheckedAt = 0; }
      return null;
    }
  }
  if (!allowLegacyCredentials) return null;
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedAccessToken;
  }
  const loaded = await loadUlanziCredentials();
  if (loaded && cachedAccessToken) return cachedAccessToken;
  return null;
}

async function spotifyWebApiRequest(method, endpoint, body = null, queryParams = null) {
  const epoch = accountGeneration;
  let token = await getAccessToken();
  if (!token || epoch !== accountGeneration) return null;

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
    signal: AbortSignal.timeout(10000),
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
    if (epoch !== accountGeneration) return null;

    // If 401 Unauthorized, token expired: refresh once and retry
    if (res.status === 401) {
      cachedAccessToken = null;
      tokenExpiresAt = 0;
      const refreshed = await refreshSpotifyAccessToken();
      token = refreshed ? await getAccessToken() : null;
      if (epoch !== accountGeneration) return null;
      if (token) {
        options.headers.Authorization = `Bearer ${token}`;
        res = await fetch(url, options);
      }
    }

    if (res.status === 204) {
      return { ok: true, status: 204, data: null };
    }

    const text = await res.text();
    if (epoch !== accountGeneration) return null;
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
    authenticated: !!account || state.isRunning,
    playbackMode,
    playbackError: playbackError || premium.error
  };
}

function pushStateToRenderer() {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('spotify:state', getPlayerStateSync());
  }
}

async function pollSpotifyState() {
  if (isPolling || switchingAccount) return;
  isPolling = true;
  const epoch = accountGeneration;
  try {
    // 1. Prefer Spotify Web API Connect (fast, non-intrusive, exact status)
    if (premium.child && !premium.deviceId && Date.now() - soloistDeviceCheckedAt > 5000) {
      soloistDeviceCheckedAt = Date.now();
      await premium.refreshDevice();
      if (epoch !== accountGeneration) return;
      if (premium.eligibility === 'supported' && account && !['free', 'open'].includes(account.product)) playbackMode = 'premium';
    }
    const webRes = await spotifyWebApiRequest('GET', '/me/player');
    if (epoch !== accountGeneration) return;
    if (playbackMode === 'premium' && (!premium.child || !webRes?.ok || webRes.data?.device?.id !== premium.deviceId)) {
      state.isRunning = !!premium.child;
      state.isPlaying = false;
      pushStateToRenderer();
      return;
    }
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
      state.isPlaying = !!d.is_playing && !(playbackMode === 'premium' && premium.error);
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
      state.contextUri = d.context?.uri || '';
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
            const tracksRes = await PlaylistsStore.cachedPlaylistTracks(pl.id);
            if (epoch !== accountGeneration) return;
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
    if (epoch !== accountGeneration) return;
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
      const parsedVolume = parseInt(parts[2], 10);
      const pVol = Number.isFinite(parsedVolume) ? parsedVolume : 100;
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
            const tracksRes = await PlaylistsStore.cachedPlaylistTracks(pl.id);
            if (epoch !== accountGeneration) return;
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
  audioProcessId: () => !state.isPlaying ? null : playbackMode === 'premium' ? premium.child?.pid : 'com.spotify.client',
  async init(mainWindow) {
    mainWindowRef = mainWindow;
    initialized = (async () => {
      allowLegacyCredentials = !Auth.loggedOut();
      await loadUlanziCredentials();
      await selectPlaybackMode();
      if (playbackMode === 'desktop') hideSpotify().catch(() => {});
    })();
    await initialized;

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
      await runOsa('tell application "Spotify" to playpause');
      await hideSpotify();
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
      await runOsa('tell application "Spotify" to next track');
      await hideSpotify();
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
      await runOsa('tell application "Spotify" to previous track');
      await hideSpotify();
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
      await runOsa(`tell application "Spotify" to play track "${uri}"`);
      await hideSpotify();
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
        await runOsa(`tell application "Spotify" to play track "${trackUri}" in context "${contextUri}"`);
      } else if (trackUri) {
        await runOsa(`tell application "Spotify" to play track "${trackUri}"`);
      }
      await hideSpotify();
      refocusApp();
      setTimeout(pollSpotifyState, 200);
      return { ok: true };
    } catch (err) {
      return { error: String(err) };
    }
  },

  async getProfile() {
    await initialized;
    const running = playbackMode === 'premium' ? !!premium.child : await isSpotifyProcessRunning();
    const plan = account?.product;
    const label = playbackMode === 'premium' ? (plan === 'premium' ? 'Premium · Spotify Soloist' : 'Lettore integrato · Accesso verificato') :
      plan === 'premium' ? 'Premium · Spotify Desktop' :
      ['free', 'open'].includes(plan) ? 'Free · Spotify Desktop' : 'Piano non verificato · Spotify Desktop';
    return {
      authenticated: !!account || running,
      needsClientId: !Auth.clientId(),
      soloist: { configured: SoloistSettings.configured(), installed: fs.existsSync(SoloistSettings.binary()), deviceName: premium.name, paired: premium.eligibility === 'supported', running: !!premium.child },
      error: playbackError || premium.error,
      profile: { name: account?.display_name || cachedDisplayName || 'Spotify User', product: label, email: '' }
    };
  },

  async login(clientId) {
    if (switchingAccount) return { error: 'Accesso già in corso.' };
    switchingAccount = true;
    accountGeneration++;
    premium.stop();
    try {
      await Auth.login(clientId);
      premium.clearCredentials();
      cachedAccessToken = null;
      cachedRefreshToken = null;
      cachedDisplayName = '';
      account = null;
      playbackMode = 'desktop';
      await selectPlaybackMode();
      if (playbackMode === 'premium') await premium.start();
      else await ensureSpotifyRunning();
      return { ok: true };
    } catch (err) {
      playbackError = err.message;
      return { error: playbackError };
    } finally {
      switchingAccount = false;
      pushStateToRenderer();
    }
  },

  async configureSoloist(key) {
    try {
      SoloistSettings.save(key);
      premium.stop();
      playbackError = '';
      accountCheckedAt = 0; // re-pick the playback mode on the next control
      return { ok: true };
    } catch (error) { return { error: error.message }; }
  },

  async connectSoloist() {
    await initialized;
    try {
      await premium.startPairing();
      const paired = await premium.refreshDevice();
      if (paired && account && !['free', 'open'].includes(account.product)) playbackMode = 'premium';
      await pollSpotifyState();
      return { ok: true, pendingPairing: !paired, deviceName: premium.name };
    } catch (error) { playbackError = error.message; return { error: playbackError }; }
  },

  async logout() {
    accountGeneration++;
    premium.clearCredentials();
    Auth.logout();
    SoloistSettings.clear();
    allowLegacyCredentials = false;
    cachedAccessToken = cachedRefreshToken = cachedClientSecret = cachedClientId = null;
    cachedDisplayName = '';
    account = null;
    playbackMode = 'desktop';
    playbackError = '';
    Object.assign(state, { isPlaying: false, isRunning: false, track: 'Spotteck', artist: 'Pronto',
      album: '', artwork: '', trackUri: '', contextUri: '', position: 0, duration: 0 });
    pushStateToRenderer();
    return { ok: true };
  },

  async restoreWindowOnExit() {
    accountGeneration++;
    Auth.cancel();
    premium.stop();
    clearInterval(pollTimer);
    pollTimer = null;
  }
};

// All public controls share one routing gate, including hardware media keys.
const premiumCommands = {
  playPause: () => ['PUT', state.isPlaying ? '/me/player/pause' : '/me/player/play'],
  nextTrack: () => ['POST', '/me/player/next'],
  prevTrack: () => ['POST', '/me/player/previous'],
  setShuffle: (value) => ['PUT', '/me/player/shuffle', null, { state: !!value }],
  seek: (value) => {
    if (!Number.isFinite(value)) throw new Error('Posizione non valida.');
    return ['PUT', '/me/player/seek', null, { position_ms: Math.max(0, Math.floor(value * 1000)) }];
  },
  setVolume: (value) => {
    if (!Number.isFinite(value)) throw new Error('Volume non valido.');
    return ['PUT', '/me/player/volume', null, { volume_percent: Math.min(100, Math.max(0, Math.round(value))) }];
  },
  playUri: (input) => {
    const uri = toUri(input);
    if (!uri) throw new Error('URI non valido.');
    return ['PUT', '/me/player/play', uri.startsWith('spotify:track:') ? { uris: [uri] } : { context_uri: uri }];
  },
  playTrackInContext: (trackInput, contextInput) => {
    const track = toUri(trackInput);
    const context = toUri(contextInput);
    if (!track?.startsWith('spotify:track:') || (contextInput && !context)) throw new Error('URI non valido.');
    return ['PUT', '/me/player/play', context ? { context_uri: context, offset: { uri: track } } : { uris: [track] }];
  }
};
for (const [name, command] of Object.entries(premiumCommands)) {
  const desktopCommand = SpotifyController[name];
  SpotifyController[name] = async (...args) => {
    await initialized;
    if (switchingAccount) return { error: 'Completa il login nel browser.' };
    try {
      const request = command(...args);
      if (Date.now() - accountCheckedAt > ACCOUNT_RECHECK_MS) await selectPlaybackMode();
      if (playbackMode !== 'premium') return await desktopCommand(...args);
      const result = await premium.command(...request);
      playbackError = '';
      await pollSpotifyState();
      return result;
    } catch (err) {
      playbackError = err.message;
      pushStateToRenderer();
      return { error: playbackError };
    }
  };
}

module.exports = SpotifyController;
