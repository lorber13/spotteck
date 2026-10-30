const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function instruments(devicePixelRatio) {
  const context = { window: { devicePixelRatio }, document: { createElement: () => fakeCanvas(0, 0) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/visualizers.js'), 'utf8'), context);
  return context;
}

// Like a real <canvas>: the backing store size is an integer, and every assignment reallocates and clears it.
function fakeCanvas(width, height) {
  const canvas = { resizes: 0, size: { width: 300, height: 150 },
    getBoundingClientRect: () => ({ width, height }),
    getContext: () => ({ setTransform() {} }) };
  for (const side of ['width', 'height']) {
    Object.defineProperty(canvas, side, { get: () => canvas.size[side], set: (value) => { canvas.resizes++; canvas.size[side] = Math.trunc(value); } });
  }
  return canvas;
}

for (const dpr of [1, 1.25, 1.1, 2]) {
  test(`canvases are sized once, not every frame, at devicePixelRatio ${dpr}`, () => {
    const { fitCanvas } = instruments(dpr);
    const canvas = fakeCanvas(329.4, 101);
    for (let frame = 0; frame < 3; frame++) fitCanvas(canvas);
    assert.equal(canvas.resizes, 2, 'one width and one height assignment');
    assert.equal(canvas.width, Math.round(329 * dpr));
    assert.equal(canvas.height, Math.round(101 * dpr));
  });
}
