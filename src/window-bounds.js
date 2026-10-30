// A saved window position is only reused when the strip the user drags the
// window by is on a connected display; otherwise Electron centres the window.
const GRIP_WIDTH = 100;
const GRIP_HEIGHT = 40;

function overlap(start, end, areaStart, areaEnd) {
  return Math.min(end, areaEnd) - Math.max(start, areaStart);
}

function visibleBounds(saved, workAreas) {
  const { x, y, ...size } = saved;
  if (typeof x !== 'number' || typeof y !== 'number') return size;
  const reachable = workAreas.some((area) =>
    overlap(x, x + saved.width, area.x, area.x + area.width) >= GRIP_WIDTH &&
    overlap(y, y + GRIP_HEIGHT, area.y, area.y + area.height) >= GRIP_HEIGHT);
  return reachable ? saved : size;
}

module.exports = { visibleBounds };
