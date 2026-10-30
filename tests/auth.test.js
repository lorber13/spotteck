const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

test('PKCE login validates state, encrypts tokens, refreshes once and persists logout', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spotteck-auth-'));
  let callback;
  let authorization;
  let closed = 0;
  let appReady = true;
  const exchanges = [];
  const load = () => {
    const context = {
      require(name) {
        if (name === 'electron') return {
          app: { getPath: () => directory, isReady: () => appReady }, shell: { openExternal: async (url) => { authorization = new URL(url); } },
          safeStorage: { isEncryptionAvailable: () => true,
            encryptString: (text) => Buffer.from(text).map((byte) => byte ^ 42),
            decryptString: (bytes) => bytes.map((byte) => byte ^ 42).toString() }
        };
        if (name === 'http') return { createServer: (handler) => {
          callback = handler;
          const server = new EventEmitter();
          server.listen = (port, host, ready) => { assert.equal(host, '127.0.0.1'); queueMicrotask(ready); };
          server.close = () => { closed++; };
          return server;
        } };
        if (name === './spotify-config.json') return { clientId: 'a'.repeat(32) };
        return require(name);
      },
      module: { exports: {} }, process: { env: {} }, URL, URLSearchParams, Buffer, AbortSignal, setTimeout, clearTimeout,
      fetch: async (_url, opts) => {
        const params = Object.fromEntries(opts.body);
        exchanges.push(params);
        return { ok: true, json: async () => ({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600 }) };
      }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/spotify-auth.js'), 'utf8'), context);
    return context.module.exports;
  };
  try {
    const auth = load();
    const pending = auth.login();
    await new Promise(setImmediate);
    assert.equal(authorization.origin, 'https://accounts.spotify.com');
    assert.equal(authorization.searchParams.get('redirect_uri'), 'http://127.0.0.1:43821/callback');
    assert.ok(authorization.searchParams.get('scope').includes('user-read-private'));
    const response = { code: 0, writeHead(code) { this.code = code; return this; }, end() {} };
    callback({ url: '/callback?state=wrong&code=bad' }, response);
    assert.equal(response.code, 400);
    assert.equal(exchanges.length, 0);
    callback({ url: '/callback?state=' + authorization.searchParams.get('state') + '&code=valid' }, response);
    await pending;
    assert.equal(closed, 1);
    assert.equal(crypto.createHash('sha256').update(exchanges[0].code_verifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
    const saved = fs.readFileSync(path.join(directory, 'spotify-session.json'), 'utf8');
    assert.ok(!saved.includes('private-access'));
    assert.ok(!saved.includes('private-refresh'));
    appReady = false;
    const coldStart = load();
    assert.equal(coldStart.hasSession(), false, 'defer Keychain access until Electron is ready');
    appReady = true;
    assert.equal(coldStart.hasSession(), true, 'early access must not cache a failed session');
    assert.equal(await auth.token(), 'private-access');
    await Promise.all([auth.token(true), auth.token(true)]);
    assert.equal(exchanges.length, 2);
    auth.logout();
    assert.equal(await auth.token(), null);
    const restarted = load();
    assert.equal(restarted.hasSession(), false);
    assert.equal(restarted.loggedOut(), true);
    assert.equal(restarted.clientId(), 'a'.repeat(32));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a rejected refresh token ends the session instead of retrying on every poll', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spotteck-auth-'));
  const xor = (bytes) => Buffer.from(bytes).map((byte) => byte ^ 42);
  const id = 'b'.repeat(32);
  fs.writeFileSync(path.join(directory, 'spotify-session.json'), JSON.stringify({ encrypted: xor(Buffer.from(JSON.stringify({
    clientId: id, accessToken: 'expired', refreshToken: 'revoked', expiresAt: 0 }))).toString('base64') }));
  let reply;
  const exchanges = [];
  const load = () => {
    const context = {
      require(name) {
        if (name === 'electron') return { app: { getPath: () => directory, isReady: () => true }, shell: {},
          safeStorage: { isEncryptionAvailable: () => true, encryptString: xor, decryptString: (bytes) => xor(bytes).toString() } };
        if (name === './spotify-config.json') return { clientId: 'a'.repeat(32) };
        return require(name);
      },
      module: { exports: {} }, process: { env: {} }, URL, URLSearchParams, Buffer, AbortSignal, setTimeout, clearTimeout,
      fetch: async (_url, opts) => { exchanges.push(Object.fromEntries(opts.body)); return reply(); }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/spotify-auth.js'), 'utf8'), context);
    return context.module.exports;
  };
  try {
    const auth = load();
    reply = () => { throw new Error('offline'); };
    await assert.rejects(auth.token());
    assert.equal(auth.hasSession(), true, 'a network error keeps the session');
    reply = () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
    await assert.rejects(auth.token());
    assert.equal(auth.hasSession(), false);
    assert.equal(await auth.token(), null);
    assert.equal(exchanges.length, 2, 'no further refresh attempts');
    const restarted = load();
    assert.equal(restarted.hasSession(), false);
    assert.equal(restarted.clientId(), id, 'the client id survives');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
