const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const { EventEmitter } = require('events');
test('Bonjour uses the active interface and cannot restart after cancellation', () => {
  let route, launched, stopped = false;
  const context = { module: { exports: {} }, require(name) {
    if (name === 'os') return { networkInterfaces: () => ({ en1: [{ family: 'IPv4', internal: false, address: '192.0.2.3' }] }) };
    if (name === 'child_process') return { execFile: (_file, _args, _opts, callback) => { route = callback; },
      spawn: (file, args) => { launched = { file, args }; const child = new EventEmitter(); child.kill = () => { stopped = true; }; return child; } };
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/soloist-discovery'), 'utf8'), context);
  const discovery = new context.module.exports.SoloistDiscovery('Spotteck test');
  discovery.start(54321); route(null, 'interface: en1');
  assert.equal(launched.file, '/usr/bin/dns-sd');
  assert.ok(launched.args.includes('192.0.2.3'));
  assert.ok(launched.args.includes('CPath=/zc'));
  discovery.stop(); assert.equal(stopped, true);
  launched = null;
  discovery.start(54322); discovery.stop(); route(null, 'interface: en1');
  assert.equal(launched, null);
});
