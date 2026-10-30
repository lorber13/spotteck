const test = require('node:test');
const assert = require('node:assert/strict');
const { visibleBounds } = require('../src/window-bounds');

const laptop = { x: 0, y: 25, width: 1512, height: 920 };
const external = { x: 1512, y: -200, width: 2560, height: 1415 };

test('a saved position on a connected display is kept', () => {
  const saved = { x: 2000, y: 100, width: 329, height: 628 };
  assert.deepEqual(visibleBounds(saved, [laptop, external]), saved);
  assert.deepEqual(visibleBounds({ x: 40, y: 60, width: 329, height: 628 }, [laptop]), { x: 40, y: 60, width: 329, height: 628 });
});

test('a position on a disconnected monitor is dropped so the window is centred', () => {
  assert.deepEqual(visibleBounds({ x: 2000, y: 100, width: 329, height: 628 }, [laptop]), { width: 329, height: 628 });
});

test('the title strip must be reachable, not just any corner of the window', () => {
  // Only 20 px of the window overlaps the screen horizontally.
  assert.deepEqual(visibleBounds({ x: 1492, y: 100, width: 329, height: 628 }, [laptop]), { width: 329, height: 628 });
  // The top is above the menu bar / work area, so the window cannot be dragged.
  assert.deepEqual(visibleBounds({ x: 100, y: -300, width: 329, height: 628 }, [laptop]), { width: 329, height: 628 });
  // Mostly off the right edge, but 120 px of the title strip is visible.
  assert.deepEqual(visibleBounds({ x: 1392, y: 100, width: 329, height: 628 }, [laptop]), { x: 1392, y: 100, width: 329, height: 628 });
});

test('bounds without a position, or no displays, need no position', () => {
  assert.deepEqual(visibleBounds({ width: 329, height: 628 }, [laptop]), { width: 329, height: 628 });
  assert.deepEqual(visibleBounds({ x: 0, y: 25, width: 329, height: 628 }, []), { width: 329, height: 628 });
});
