const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
function store(directory, failWrite = false) {
  const context = { module: { exports: {} }, console, setTimeout, clearTimeout,
    require(name) {
      if (name === 'electron') return { app: { getPath: () => directory } };
      if (name === 'fs' && failWrite) return { ...fs, renameSync() { throw new Error('Disk full'); } };
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/playlists-store'), 'utf8'), context);
  return context.module.exports;
}
test('playlist writes are atomic and failures preserve the previous file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spotteck-playlists-'));
  try {
    const good = store(directory);
    good.savePlaylists([{ id: 'keep', name: 'Keep' }]);
    assert.throws(() => store(directory, true).removePlaylist('keep'), /salvare/);
    assert.equal(good.getPlaylists()[0].id, 'keep');
    const file = path.join(directory, 'user-data/playlists.json');
    fs.writeFileSync(file, '{broken');
    assert.throws(() => good.removePlaylist('keep'), /danneggiato/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    assert.equal(fs.existsSync(file + '.tmp'), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('playlist network requests have idle and total deadlines', async () => {
  const { EventEmitter } = require('events');
  let idle, total;
  const request = new EventEmitter();
  request.setTimeout = (milliseconds, callback) => { assert.equal(milliseconds, 10000); idle = callback; };
  request.destroy = error => { request.emit('error', error); request.emit('close'); };
  const context = { module: { exports: {} }, console,
    setTimeout: (callback, milliseconds) => { assert.equal(milliseconds, 15000); total = callback; return 1; }, clearTimeout() {},
    require(name) {
      if (name === 'electron') return { app: { getPath: () => '/tmp/spotteck-timeout-test' } };
      if (name === 'https') return { Agent: class {}, get: () => request };
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/playlists-store'), 'utf8'), context);
  const result = context.module.exports.fetchPlaylistTracks('spotify:playlist:abcdefgh');
  assert.equal(typeof idle, 'function'); assert.equal(typeof total, 'function');
  total();
  assert.equal((await result).success, false);
});
