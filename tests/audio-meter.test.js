const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
test('audio meter captures only the player, bounds frames and stops on player change', () => {
  let tick, launch, child;
  const events = [];
  const context = { module: { exports: {} }, __dirname: __dirname + '/../src', process, Date,
    setInterval: fn => { tick = fn; return 1; }, clearInterval: () => {},
    require: name => name === 'child_process' ? { spawn: (...args) => {
      launch = args;
      child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => { child.killed = true; }; return child;
    } } : require(name) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/audio-meter'), 'utf8'), context);
  let pid = 123;
  const meter = new context.module.exports.AudioMeter({ isPackaged: false }, {
    isDestroyed: () => false, webContents: { send: (...args) => events.push(args) }
  }, () => pid);
  tick();
  assert.deepEqual(Array.from(launch[1]), ['123']);
  assert.equal(launch[2].stdio[2], 'pipe');
  const frame = { frequency: Array(256).fill(0), time: Array(512).fill(128) };
  child.stdout.emit('data', JSON.stringify(frame) + '\n');
  assert.equal(events[0][0], 'audio:frame');
  assert.match(events[1][1], /silenzio/);
  const before = events.length;
  child.stdout.emit('data', 'x'.repeat(40000));
  assert.equal(events.length, before);
  child.stdout.emit('data', '\n'); // end the oversized junk line
  // A busy main process receives many queued frames in one chunk; none may be dropped.
  const burst = (JSON.stringify(frame) + '\n').repeat(16);
  assert.ok(burst.length > 32768);
  child.stdout.emit('data', burst.slice(0, -100));
  child.stdout.emit('data', burst.slice(-100));
  assert.equal(events.filter(([channel]) => channel === 'audio:frame').length, 17);
  child.stderr.emit('data', 'Audio analysis unavailable (-1)\n');
  assert.match(events.at(-1)[1], /codice -1/);
  pid = null;
  tick();
  assert.equal(child.killed, true);
  meter.stop();
});
