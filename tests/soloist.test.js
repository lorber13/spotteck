const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { SoloistPlayer } = require('../src/soloist-player');

test('Soloist pairs by its unique name and sends controls to its actual device id', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soloist-test-'));
  const child = new EventEmitter();
  child.kill = () => {};
  let launched;
  const calls = [];
  const player = new SoloistPlayer({ binary: process.execPath, cacheDir, installationId: 'test', readKey: () => 'personal-secret',
    spawnProcess: (...args) => { launched = args; return child; }, sleep: async () => {},
    request: async (...args) => {
      calls.push(args);
      return { ok: true, data: { devices: [{ name: player.name, id: 'soloist-device', is_active: true }] } };
    } });
  try {
    await player.start();
    assert.equal(player.deviceId, 'soloist-device');
    assert.ok(launched[1].includes('--api-key'));
    assert.equal(launched[1][launched[1].indexOf('--initial-volume') + 1], '100');
    assert.ok(!launched[1].includes('--ws'), 'do not expose a local control port');
    assert.ok(!launched[1].includes('--pipewire-device'), 'follow the system default output');
    assert.ok(!launched[1].includes('--device'), 'never pin playback to headphones or speakers');
    assert.deepEqual(launched[2].stdio, ['ignore', 'pipe', 'pipe'], 'diagnostics are parsed privately, never inherited');
    await player.command('PUT', '/me/player/play');
    assert.equal(calls.at(-1)[3].device_id, 'soloist-device');
    child.emit('exit', 10);
    assert.match(player.error, /scaduto/);
    assert.ok(!player.error.includes('personal-secret'));
    assert.equal(player.child, null);
  } finally { player.stop(); fs.rmSync(cacheDir, { recursive: true, force: true }); }
});

test('Soloist missing key cannot launch a process', async () => {
  let launched = false;
  const player = new SoloistPlayer({ binary: process.execPath, installationId: 'test', readKey: () => null,
    spawnProcess: () => { launched = true; } });
  await assert.rejects(player.start(), /chiave personale/);
  assert.equal(launched, false);
});

test('unpaired Soloist stays running and discovers the device after pairing', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soloist-pair-test-'));
  const child = new EventEmitter();
  let stopped = false;
  let paired = false;
  child.kill = () => { stopped = true; };
  const player = new SoloistPlayer({ binary: process.execPath, cacheDir, installationId: 'test', readKey: () => 'personal-secret',
    spawnProcess: () => child, sleep: async () => {},
    request: async () => ({ ok: true, data: { devices: paired ? [{ name: player.name, id: 'paired-device' }] : [] } }) });
  try {
    await player.start();
    assert.equal(player.child, child);
    assert.equal(player.deviceId, null);
    assert.equal(stopped, false);
    await assert.rejects(player.command('PUT', '/me/player/play'), /primo collegamento/);
    assert.equal(stopped, false);
    paired = true;
    assert.equal(await player.refreshDevice(), true);
    assert.equal(player.deviceId, 'paired-device');
    assert.equal(player.eligibility, 'supported');
  } finally { player.stop(); fs.rmSync(cacheDir, { recursive: true, force: true }); }
});

test('personal key is encrypted at rest, never read before ready, and removable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soloist-key-test-'));
  let ready = false;
  let decrypted = 0;
  const context = { require(name) {
    if (name === 'electron') return { app: { getPath: () => directory, isReady: () => ready },
      safeStorage: { isEncryptionAvailable: () => true,
        encryptString: text => Buffer.from(text).map(x => x ^ 42),
        decryptString: bytes => { decrypted++; return bytes.map(x => x ^ 42).toString(); } } };
    return require(name);
  }, Buffer, module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/soloist-settings.js'), 'utf8'), context);
  const settings = context.module.exports;
  try {
    assert.equal(settings.key(), null);
    assert.equal(decrypted, 0);
    ready = true;
    assert.throws(() => settings.save('secret\ninvalid-key'), /non valida/);
    settings.save('personal-secret-value');
    const file = path.join(directory, 'soloist-key.json');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('personal-secret-value'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(settings.key(), 'personal-secret-value');
    settings.clear();
    assert.equal(settings.configured(), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('pairing publishes only the public port and restarts the stored session after success', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soloist-pair-flow-'));
  const children = [];
  const ports = [];
  const launches = [];
  const player = new SoloistPlayer({ binary: process.execPath, cacheDir, installationId: 'test', readKey: () => 'personal-secret',
    discovery: { start: port => ports.push(port), stop() {} },
    spawnProcess: (_binary, args) => {
      launches.push(args);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => {}; children.push(child); return child;
    }, request: async () => ({ ok: true, data: { devices: [] } }) });
  try {
    await player.startPairing();
    assert.ok(launches[0].includes('--pair'));
    children[0].stderr.emit('data', Buffer.from('private-secret diagnostic\nStarted ZeroConf service on po'));
    children[0].stderr.emit('data', Buffer.from('rt 54321 path /zc\n'));
    assert.deepEqual(ports, [54321]);
    children[0].emit('exit', 0);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(launches.length, 2);
    assert.ok(!launches[1].includes('--pair'));
    assert.equal(player.error, '');
  } finally { player.stop(); fs.rmSync(cacheDir, { recursive: true, force: true }); }
});

test('a Soloist crash message does not outlive stop()', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soloist-error-test-'));
  const child = new EventEmitter();
  child.kill = () => {};
  const player = new SoloistPlayer({ binary: process.execPath, cacheDir, installationId: 'test', readKey: () => 'personal-secret',
    spawnProcess: () => child, sleep: async () => {},
    request: async () => ({ ok: true, data: { devices: [{ name: player.name, id: 'soloist-device', is_active: true }] } }) });
  try {
    await player.start();
    child.emit('exit', 1);
    assert.match(player.error, /arrestato/);
    player.stop();
    assert.equal(player.error, '', 'logout or a switch to desktop mode must not keep showing the crash');
  } finally { player.stop(); fs.rmSync(cacheDir, { recursive: true, force: true }); }
});

test('logout deletes Soloist credentials only after the process has exited', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soloist-clear-test-'));
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  // Like the real engine, a graceful shutdown flushes its session to --data-dir before exiting.
  child.kill = (signal) => {
    if (signal !== 'SIGTERM') return;
    setImmediate(() => {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'credentials.json'), '{"private":"session"}');
      child.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
    });
  };
  const player = new SoloistPlayer({ binary: process.execPath, cacheDir, installationId: 'test', readKey: () => 'personal-secret',
    spawnProcess: () => child, sleep: async () => {},
    request: async () => ({ ok: true, data: { devices: [{ name: player.name, id: 'soloist-device', is_active: true }] } }) });
  try {
    await player.start();
    await player.clearCredentials();
    await new Promise(setImmediate); // let any pending shutdown write land
    assert.equal(player.child, null);
    assert.equal(fs.existsSync(cacheDir), false, 'credentials written during shutdown must not survive logout');
  } finally { player.stop(); fs.rmSync(cacheDir, { recursive: true, force: true }); }
});
