const fs = require('fs');
const path = require('path');
const https = require('https');
const { app } = require('electron');

const userDataPath = (app && typeof app.getPath === 'function')
  ? app.getPath('userData')
  : path.join(require('os').homedir(), 'Library/Application Support/Spotteck');
const userConfigDir = path.join(userDataPath, 'user-data');
const playlistsFile = path.join(userConfigDir, 'playlists.json');
const metaCacheFile = path.join(userConfigDir, 'tracks-meta-cache.json');

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 24 });
const playlistCache = new Map(); // playlistId -> { at, tracks }
const CACHE_MS = 15 * 60 * 1000;
const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Persistent disk cache of track URI -> { title, artist, duration }
let diskTrackMeta = {};
try {
  if (fs.existsSync(metaCacheFile)) {
    diskTrackMeta = JSON.parse(fs.readFileSync(metaCacheFile, 'utf8')) || {};
  }
} catch (_e) {
  diskTrackMeta = {};
}

function saveDiskTrackMeta() {
  try {
    fs.mkdirSync(userConfigDir, { recursive: true });
    fs.writeFileSync(metaCacheFile, JSON.stringify(diskTrackMeta), 'utf8');
  } catch (_e) {}
}

function playlistIdOf(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/playlist[/:]([A-Za-z0-9]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{22}$/.test(s)) return s;
  return null;
}

// Converts a spotify:track:<base62> URI into a 32-char hex GID for spclient metadata v4.
function trackUriToGid(uri) {
  const id = String(uri || '').split(':').pop();
  if (!id) return null;
  let n = 0n;
  for (const ch of id) {
    const idx = BASE62.indexOf(ch);
    if (idx < 0) return null;
    n = n * 62n + BigInt(idx);
  }
  return n.toString(16).padStart(32, '0');
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(
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
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(data));
      }
    ).on('error', reject);
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
  try {
    if (fs.existsSync(playlistsFile)) {
      const data = JSON.parse(fs.readFileSync(playlistsFile, 'utf8'));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error('Error reading playlists:', e);
  }
  return [];
}

function savePlaylists(playlists) {
  try {
    fs.mkdirSync(userConfigDir, { recursive: true });
    fs.writeFileSync(playlistsFile, JSON.stringify(playlists, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Error saving playlists:', e);
    return false;
  }
}

async function addPlaylistByUrl(url) {
  const meta = await fetchPlaylistMetadata(url);
  if (!meta) return { success: false, error: 'Link playlist Spotify non valido o non raggiungibile' };
  const current = getPlaylists();
  const i = current.findIndex((p) => playlistIdOf(p.id) === playlistIdOf(meta.id));
  if (i >= 0) current[i] = { ...current[i], ...meta };
  else current.push(meta);
  savePlaylists(current);
  return { success: true, playlist: meta, all: current };
}

function removePlaylist(id) {
  const current = getPlaylists().filter((p) => p.id !== id);
  savePlaylists(current);
  return current;
}

module.exports = { getPlaylists, savePlaylists, addPlaylistByUrl, removePlaylist, fetchPlaylistTracks };
