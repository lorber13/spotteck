const { app, shell, safeStorage } = require('electron');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./spotify-config.json');

const REDIRECT = 'http://127.0.0.1:43821/callback';
const SCOPES = 'user-read-private user-read-playback-state user-modify-playback-state streaming';
let session;
let refreshing;
let cancelLogin;
let generation = 0;
const file = () => path.join(app.getPath('userData'), 'spotify-session.json');

function load() {
  if (session !== undefined) return session;
  if (!app.isReady()) return null;
  session = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    session = saved.loggedOut ? { loggedOut: true, clientId: saved.clientId } :
      JSON.parse(safeStorage.decryptString(Buffer.from(saved.encrypted, 'base64')));
  } catch (_) {}
  return session;
}

function save(value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Portachiavi macOS non disponibile.');
  const encrypted = safeStorage.encryptString(JSON.stringify(value)).toString('base64');
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ encrypted }), { mode: 0o600 });
  session = value;
}

async function exchange(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params), signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw Object.assign(new Error('Accesso Spotify non riuscito. Ripeti il login.'), { status: res.status });
  const data = await res.json();
  if (!data.access_token) throw new Error('Spotify non ha restituito un accesso valido.');
  return data;
}

function clientId() {
  return process.env.SPOTTECK_SPOTIFY_CLIENT_ID || load()?.clientId || config.clientId || '';
}

async function token(force = false) {
  const current = load();
  if (!current?.accessToken) return null;
  if (!force && current.expiresAt > Date.now() + 60000) return current.accessToken;
  if (!refreshing) {
    const epoch = generation;
    refreshing = (async () => {
      let data;
      try {
        data = await exchange({ grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: current.clientId });
      } catch (error) {
        // Revoked or expired grant: forget the tokens so callers stop retrying and the user can log in again.
        if (generation === epoch && [400, 401].includes(error.status)) save({ clientId: current.clientId });
        throw error;
      }
      if (generation !== epoch) return null;
      save({ ...current, accessToken: data.access_token, refreshToken: data.refresh_token || current.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000 });
      return session.accessToken;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function login(input) {
  if (cancelLogin) throw new Error('Accesso già in corso nel browser.');
  const id = input || clientId();
  if (!/^[a-f0-9]{32}$/i.test(id)) throw new Error('Configura il Client ID Spotify di Spotteck.');
  const epoch = ++generation;
  const verifier = crypto.randomBytes(48).toString('base64url');
  const state = crypto.randomBytes(24).toString('hex');
  const url = new URL('https://accounts.spotify.com/authorize');
  url.search = new URLSearchParams({ client_id: id, response_type: 'code', redirect_uri: REDIRECT,
    scope: SCOPES, state, code_challenge_method: 'S256', show_dialog: 'true',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }).toString();
  const code = await new Promise((resolve, reject) => {
    let completed = false;
    const finish = (err, value) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      cancelLogin = null;
      server.close();
      if (err) reject(err); else resolve(value);
    };
    const server = http.createServer((req, res) => {
      const callback = new URL(req.url, REDIRECT);
      if (callback.pathname !== '/callback' || callback.searchParams.get('state') !== state) {
        res.writeHead(400).end('Richiesta non valida.');
        return;
      }
      const code = callback.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(code ? 'Puoi tornare a Spotteck.' : 'Accesso annullato. Puoi tornare a Spotteck.');
      finish(code ? null : new Error('Accesso Spotify annullato.'), code);
    });
    const timer = setTimeout(() => finish(new Error('Accesso scaduto. Riprova.')), 180000);
    cancelLogin = () => finish(new Error('Accesso annullato.'));
    server.on('error', () => finish(new Error('Porta del login 43821 non disponibile.')));
    server.listen(43821, '127.0.0.1', () => {
      shell.openExternal(url.href).catch(() => finish(new Error('Impossibile aprire il browser.')));
    });
  });
  const data = await exchange({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
    client_id: id, code_verifier: verifier });
  if (generation !== epoch) throw new Error('Accesso annullato.');
  save({ clientId: id, accessToken: data.access_token, refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 });
}

function logout() {
  const id = clientId();
  generation++;
  if (cancelLogin) cancelLogin();
  session = { loggedOut: true, clientId: id };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(session), { mode: 0o600 });
}

module.exports = { token, login, logout, clientId, hasSession: () => !!load()?.accessToken,
  loggedOut: () => !!load()?.loggedOut,
  cancel: () => { generation++; if (cancelLogin) cancelLogin(); } };
