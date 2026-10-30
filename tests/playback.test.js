const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const { PremiumPlayer } = require('../src/premium-player');

function controller(product, options = {}) {
  const calls = { desktop: [], premium: [], api: [], stops: 0 };
  const auth = { hasSession: () => true, loggedOut: () => false, token: async () => 'test-token',
    clientId: () => 'a'.repeat(32), login: async () => {}, logout() {}, cancel() {} };
  const app = { getPath: () => '/tmp/spotteck-test', isPackaged: false };
  const context = {
    require(name) {
      if (name === 'electron') return { app };
      if (name === './spotify-auth') return auth;
      if (name === './playlists-store') return { getPlaylists: () => [] };
      if (name === './soloist-settings') return { binary: () => options.installed === false ? '/missing/soloist' : process.execPath,
        configured: () => options.configured !== false, key: () => 'test-key', save() {}, clear() {} };
      if (name === './soloist-player') return { SoloistPlayer: class {
        eligibility = options.paired ? 'supported' : 'unknown';
        child = null;
        deviceId = 'our-device';
        stop() { this.child = null; calls.stops++; }
        clearCredentials() { this.stop(); }
        async start() {
          if (options.probeFree) { this.eligibility = 'free'; throw new Error('Free'); }
          if (options.probeFails) throw new Error('Probe failed');
          this.child = {};
        }
        async command(...args) {
          calls.premium.push(args);
          if (options.engineFails) throw new Error('Engine unavailable');
          this.child = {};
          return { ok: true };
        }
      } };
      if (name === 'child_process') return { execFile: (file, args, opts, cb) => {
        calls.desktop.push({ file, args });
        if (options.deferState && args[1]?.includes('set pState')) { options.deferState(cb || opts); return; }
        (cb || opts)(null, options.rawState && args[1]?.includes('set pState') ? options.rawState : 'true');
      } };
      return require(name);
    },
    module: { exports: {} }, console, Buffer, URL, URLSearchParams, AbortSignal,
    Date: options.clock ? class extends Date { static now() { return options.clock.now; } } : Date,
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1,
    fetch: async (url, opts) => {
      const endpoint = new URL(url).pathname;
      calls.api.push({ endpoint, opts });
      const meStatus = endpoint === '/v1/me' && options.meStatus?.();
      if (meStatus === 0) throw new Error('offline');
      if (meStatus) return { status: meStatus, ok: false, text: async () => '{}' };
      if (endpoint === '/v1/me/player' && options.playerFails) return { status: 500, ok: false, text: async () => '{}' };
      if (options.commandsFail && endpoint.startsWith('/v1/me/player/') && opts.method !== 'GET') {
        return { status: 403, ok: false, text: async () => '{"error":{"reason":"PREMIUM_REQUIRED"}}' };
      }
      let data = endpoint === '/v1/me' ? { product, display_name: 'Test' } :
        (options.playerData?.() || { device: { id: 'our-device' }, is_playing: false });
      return { status: 200, ok: true, text: async () => JSON.stringify(data) };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/spotify-controller.js'), 'utf8') + '\nmodule.exports.snapshot = getPlayerStateSync;', context);
  return { api: context.module.exports, calls };
}

test('Premium routes every control to the integrated engine without opening Spotify', async () => {
  const { api, calls } = controller('premium');
  await api.init(null);
  for (const [method, args] of [
    ['playPause', []], ['nextTrack', []], ['prevTrack', []], ['setShuffle', [true]],
    ['seek', [15]], ['setVolume', [0]], ['playUri', ['spotify:track:abc']],
    ['playTrackInContext', ['spotify:track:abc', 'spotify:playlist:def']]
  ]) assert.equal((await api[method](...args)).ok, true, method);
  assert.equal(calls.desktop.length, 0);
  assert.equal(calls.premium.length, 8);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.premium[6][2])), { uris: ['spotify:track:abc'] });
  assert.equal((await api.getProfile()).profile.product, 'Premium · Spotify Soloist');
  await api.restoreWindowOnExit();
  assert.ok(calls.stops > 0);
});

for (const product of ['free', 'open', undefined]) {
  test(`${product || 'unknown'} preserves desktop playback`, async () => {
    const { api, calls } = controller(product, { probeFails: product === undefined });
    await api.init(null);
    await api.playPause();
    assert.equal(calls.premium.length, 0);
    assert.ok(calls.desktop.some((call) => call.file === 'osascript'));
  });
}

test('engine failure is visible and never launches the desktop fallback for Premium', async () => {
  const { api, calls } = controller('premium', { engineFails: true });
  await api.init(null);
  assert.equal((await api.playPause()).error, 'Engine unavailable');
  assert.equal(calls.desktop.length, 0);
  assert.equal((await api.getProfile()).error, 'Engine unavailable');
});

test('invalid controls do not reach either player', async () => {
  const { api, calls } = controller('premium');
  await api.init(null);
  for (const [method, args] of [['seek', [NaN]], ['setVolume', [Infinity]], ['playUri', ['invalid']],
    ['playTrackInContext', ['spotify:playlist:abc', '']]]) assert.ok((await api[method](...args)).error);
  assert.equal(calls.premium.length, 0);
  assert.equal(calls.desktop.length, 0);
});

 test('missing product in new API uses verified engine capability', async () => {
  const { api, calls } = controller(undefined, { paired: true });
  await api.init(null);
  await api.playPause();
  assert.equal(calls.premium.length, 1);
  assert.equal(calls.desktop.length, 0);
  assert.equal((await api.getProfile()).profile.product, 'Lettore integrato · Accesso verificato');
});

test('missing plan remains unclassified and keeps desktop until Soloist is paired', async () => {
  const { api, calls } = controller(undefined, { probeFree: true });
  await api.init(null);
  await api.playPause();
  assert.equal(calls.premium.length, 0);
  assert.ok(calls.desktop.length > 0);
  assert.equal((await api.getProfile()).profile.product, 'Piano non verificato · Spotify Desktop');
});



test('desktop mute stays zero and audio analysis targets Spotify', async () => {
  const rawState = ['playing', '10', '0', 'false', 'Track', 'Artist', 'Album', '100000', '', 'spotify:track:abc'].join('\0');
  const { api } = controller('free', { playerFails: true, rawState });
  await api.init(null);
  await new Promise(setImmediate);
  const state = await api.getPlayerState();
  assert.equal(state.volume, 0);
  assert.equal(api.audioProcessId(), 'com.spotify.client');
});

test('standalone tracks clear the previous playlist context', async () => {
  let playlist = true;
  const { api } = controller('free', { playerData: () => ({ is_playing: true,
    item: { uri: 'spotify:track:abc' }, context: playlist ? { uri: 'spotify:playlist:old' } : null }) });
  await api.init(null);
  await new Promise(setImmediate);
  assert.equal((await api.getPlayerState()).contextUri, 'spotify:playlist:old');
  playlist = false;
  assert.equal((await api.getPlayerState()).contextUri, '');
});

test('logout discards an outstanding desktop state reply', async () => {
  let reply;
  const { api } = controller('free', { playerFails: true, deferState: callback => { reply = callback; } });
  await api.init(null);
  await new Promise(setImmediate);
  for (let i = 0; !reply && i < 20; i++) await Promise.resolve();
  assert.ok(reply);
  await api.logout();
  reply(null, ['playing', '10', '50', 'false', 'Old private track', 'Old account', '', '100000', '', 'spotify:track:old'].join('\0'));
  await Promise.resolve(); await Promise.resolve();
  // getPlayerState sees the existing poll finishing; it must retain the logout reset.
  const state = api.snapshot();
  assert.equal(state.track, 'Spotteck');
  assert.equal(state.isPlaying, false);
});

// osascript rejects a script whose blocks do not close in order; the fallbacks swallow that error.
function unbalancedAppleScript(script) {
  const open = [];
  for (const line of script.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const end = line.match(/^end (tell|try|if)\b/);
    if (end) { if (open.pop() !== end[1]) return line; }
    else if (/^tell\b/.test(line) && !/\bto\b/.test(line)) open.push('tell');
    else if (line === 'try') open.push('try');
    else if (/^if\b.*\bthen$/.test(line)) open.push('if');
  }
  return open.length ? `unclosed ${open.at(-1)}` : null;
}

test('desktop AppleScript fallbacks are well formed', async () => {
  const { api, calls } = controller('free', { commandsFail: true });
  await api.init(null);
  for (const [method, args] of [['playPause', []], ['nextTrack', []], ['prevTrack', []],
    ['playUri', ['spotify:playlist:abc']], ['playTrackInContext', ['spotify:track:abc', 'spotify:playlist:def']],
    ['playTrackInContext', ['spotify:track:abc', '']]]) {
    calls.desktop.length = 0;
    await api[method](...args);
    const scripts = calls.desktop.filter((call) => call.file === 'osascript').map((call) => call.args[1]);
    assert.ok(scripts.some((s) => /tell application "Spotify"/.test(s) && !/player state/.test(s)), `${method} reaches Spotify`);
    for (const script of scripts) assert.equal(unbalancedAppleScript(script), null, `${method}:\n${script}`);
  }
});

for (const [setup, options] of [['no key', { configured: false }], ['no engine', { installed: false }]]) {
  test(`Premium without Soloist (${setup}) keeps Spotify Desktop controls`, async () => {
    const { api, calls } = controller('premium', options);
    await api.init(null);
    assert.equal((await api.playPause()).ok, true);
    assert.equal(calls.premium.length, 0);
    assert.ok(calls.desktop.some((call) => call.file === 'osascript'));
    assert.equal(api.snapshot().playbackMode, 'desktop');
    assert.equal((await api.getProfile()).profile.product, 'Premium · Spotify Desktop');
  });
}

test('a transient account check failure keeps Premium playback and retries soon', async () => {
  const clock = { now: Date.now() };
  let meStatus = null;
  const { api, calls } = controller('premium', { clock, meStatus: () => meStatus });
  await api.init(null);
  const checks = () => calls.api.filter((call) => call.endpoint === '/v1/me').length;
  for (const status of [0, 503, 429]) {
    meStatus = status;
    clock.now += 6 * 60 * 1000;
    assert.equal((await api.playPause()).ok, true, `status ${status}`);
    assert.equal(api.snapshot().playbackMode, 'premium');
  }
  assert.equal(calls.stops, 0);
  assert.equal(calls.desktop.length, 0);
  const before = checks();
  meStatus = null;
  clock.now += 31 * 1000;
  await api.playPause();
  assert.equal(checks(), before + 1, 'retried after 30 s, not 5 min');
});

test('starting offline retries the plan check after 30 s', async () => {
  const clock = { now: Date.now() };
  let meStatus = 0;
  const { api, calls } = controller('premium', { clock, meStatus: () => meStatus });
  await api.init(null);
  assert.equal(api.snapshot().playbackMode, 'desktop');
  meStatus = null;
  clock.now += 31 * 1000;
  await api.playPause();
  assert.equal(api.snapshot().playbackMode, 'premium');
  assert.equal(calls.premium.length, 1);
});

test('a rejected account check signs out of Premium', async () => {
  const clock = { now: Date.now() };
  let meStatus = null;
  const { api, calls } = controller('premium', { clock, meStatus: () => meStatus });
  await api.init(null);
  meStatus = 401;
  clock.now += 6 * 60 * 1000;
  await api.playPause();
  assert.equal(api.snapshot().playbackMode, 'desktop');
  assert.ok(calls.stops > 0);
  assert.equal((await api.getProfile()).profile.product, 'Piano non verificato · Spotify Desktop');
});
