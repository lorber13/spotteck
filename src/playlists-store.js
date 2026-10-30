const fs = require('fs');
const path = require('path');
const https = require('https');
const { app } = require('electron');

const userDataPath = (app && typeof app.getPath === 'function')
  ? app.getPath('userData')
  : path.join(require('os').homedir(), 'Library/Application Support/Spotteck');
const userConfigDir = path.join(userDataPath, 'user-data');
const playlistsFile = path.join(userConfigDir, 'playlists.json');

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 24 });
const playlistCache = new Map(); // playlistId -> { at, tracks }
const CACHE_MS = 15 * 60 * 1000;
function playlistIdOf(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/playlist[/:]([A-Za-z0-9]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{22}$/.test(s)) return s;
  return null;
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        agent: keepAliveAgent,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', ...headers }
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('error', reject);
        res.on('data', (c) => {
          data += c;
          if (data.length > 8 * 1024 * 1024) request.destroy(new Error('Risposta troppo grande'));
        });
        res.on('end', () => resolve(data));
      }
    ).on('error', reject);
    request.setTimeout(10000, () => request.destroy(new Error('Tempo di risposta scaduto')));
    const deadline = setTimeout(() => request.destroy(new Error('Tempo di risposta scaduto')), 15000);
    request.on('close', () => clearTimeout(deadline));
  });
}

// Title + cover via public oEmbed (no API keys needed).
async function fetchPlaylistMetadata(input) {
  const id = playlistIdOf(input);
  if (!id) return null;
  const url = `https://open.spotify.com/playlist/${id}`;
  try {
    const json = JSON.parse(await get(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`));
    return { id: url, name: json.title || 'Playlist', image: json.thumbnail_url || '' };
  } catch {
    return null;
  }
}

// Full track list from Spotify official public embed page
async function fetchPlaylistTracks(input) {
  const id = playlistIdOf(input);
  if (!id) return { success: false, error: 'Playlist non valida' };

  const cached = playlistCache.get(id);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return { success: true, tracks: cached.tracks };
  }

  try {
    const html = await get(`https://open.spotify.com/embed/playlist/${id}`);
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('Formato pagina inatteso');

    const state = JSON.parse(m[1])?.props?.pageProps?.state;
    const entity = state?.data?.entity;

    const tracks = [];
    for (const t of (entity?.trackList || [])) {
      if (t.uri && t.uri.startsWith('spotify:track:')) {
        const item = {
          uri: t.uri,
          title: t.title || 'Brano',
          artist: t.subtitle || '',
          duration: Math.round((t.duration || 0) / 1000),
          playable: t.isPlayable !== false
        };
        tracks.push(item);
      }
    }

    playlistCache.set(id, { at: Date.now(), tracks });
    return { success: true, tracks };
  } catch (e) {
    return { success: false, error: 'Impossibile caricare i brani: ' + e.message };
  }
}

function getPlaylists() {
  if (!fs.existsSync(playlistsFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(playlistsFile, 'utf8'));
    if (!Array.isArray(data)) throw new Error('Formato non valido');
    return data;
  } catch (_) {
    throw new Error('Archivio playlist danneggiato: il file è stato conservato. Ripristina una copia prima di modificarlo.');
  }
}

function savePlaylists(playlists) {
  fs.mkdirSync(userConfigDir, { recursive: true });
  const temporary = playlistsFile + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(playlists, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, playlistsFile);
  } catch (_) {
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
    throw new Error('Impossibile salvare le playlist. Il file precedente è stato conservato.');
  }
}

async function addPlaylistByUrl(url) {
  const meta = await fetchPlaylistMetadata(url);
  if (!meta) return { success: false, error: 'Link playlist Spotify non valido o non raggiungibile' };
  try {
  const current = getPlaylists();
  const i = current.findIndex((p) => playlistIdOf(p.id) === playlistIdOf(meta.id));
  if (i >= 0) current[i] = { ...current[i], ...meta };
  else current.push(meta);
  savePlaylists(current);
  return { success: true, playlist: meta, all: current };
  } catch (error) { return { success: false, error: error.message }; }
}

function removePlaylist(id) {
  const current = getPlaylists().filter((p) => p.id !== id);
  savePlaylists(current);
  return current;
}

function cachedPlaylistTracks(input) {
  const cached = playlistCache.get(playlistIdOf(input));
  return { tracks: cached && Date.now() - cached.at < CACHE_MS ? cached.tracks : [] };
}

module.exports = { cachedPlaylistTracks, getPlaylists, savePlaylists, addPlaylistByUrl, removePlaylist, fetchPlaylistTracks };
