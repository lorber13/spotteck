// Isolated renderer check: loads ui/ in headless Chromium with a stubbed Tauri IPC and
// asserts the page wires up, never asks for the microphone, and explains refused controls.
// Usage: node tools/check-ui.js [screenshot.png]
const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');
const { chromium } = require('playwright');

const ui = path.join(__dirname, '../ui/index.html');
const mockScript = fs.readFileSync(path.join(__dirname, 'mock-tauri.js'), 'utf8');

const fixtures = {
  state: {
    isRunning: true, isPlaying: true, track: 'Weniger, aber besser', artist: 'Dieter Rams', album: 'Atelier',
    duration: 214, position: 78, trackUri: 'spotify:track:mock1', contextUri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'
  },
  playlists: [
    { id: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', name: 'Kronberg 1960', image: '', pinned: false },
    { id: 'spotify:playlist:4uLU6hMCjMI75M1A2tKUQC', name: 'Pinned', image: '', pinned: true }
  ],
  tracks: [{ uri: 'spotify:track:mock1', title: 'Weniger, aber besser', artist: 'Dieter Rams', duration: 214, playable: true }],
  profile: { authenticated: true, readiness: 'ready', message: 'Lettore Spotteck pronto.', profile: { name: 'Dieter Rams', product: 'Premium', avatar: '' } },
  controlError: 'Spotteck richiede Spotify Premium.'
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 980, height: 620 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(`window.__SPOTTECK_MOCK__ = ${JSON.stringify(fixtures)};
    window.__micRequests = 0;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => { window.__micRequests++; return Promise.reject(new Error('blocked')); };`);
  await page.addInitScript(mockScript);
  await page.goto('file://' + ui);
  await page.waitForTimeout(800);

  assert.equal(await page.locator('#trackName').textContent(), 'Weniger, aber besser');
  assert.equal(await page.locator('.playlist-grid .tile').count(), 2, 'library + pinned tiles');
  assert.equal(await page.locator('.playlist-grid .tile.active').count(), 1, 'playing playlist highlighted');

  // Library playlists can't be removed from Spotteck; pinned ones can.
  await page.locator('.playlist-grid .tile').nth(0).click({ button: 'right' });
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#drawerRemove').isHidden(), true);
  assert.equal(await page.locator('#drawerList .track-row').count(), 1);
  await page.locator('#drawerClose').click();
  await page.locator('.playlist-grid .tile').nth(1).click({ button: 'right' });
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#drawerRemove').isVisible(), true);
  await page.locator('#drawerClose').click();

  // A refused control shows its reason on the stage.
  await page.locator('#nextBtn').click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#presetToast').textContent(), fixtures.controlError);

  // Settings reflect the profile; no Soloist or Client ID fields remain.
  await page.locator('#settingsBtn').click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#profileName').textContent(), 'Dieter Rams');
  assert.equal(await page.locator('#profileSub').textContent(), 'Premium · Spotteck');
  assert.equal(await page.locator('#soloistSetup, #spotifyClientId').count(), 0);

  // Native audio frames reach the visualizers' status line.
  await page.evaluate(() => window.__mockEmit('audio:status', 'Visualizzatori: audio reale collegato.'));
  assert.equal(await page.locator('#audioAnalysisStatus').textContent(), 'Visualizzatori: audio reale collegato.');

  const calls = await page.evaluate(() => window.__mockCalls.map((c) => c.command));
  for (const command of ['playlists_get', 'get_state', 'next', 'get_profile']) assert.ok(calls.includes(command), command);
  assert.equal(await page.evaluate(() => window.__micRequests), 0, 'microphone must never be requested');
  assert.deepEqual(errors, []);

  if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
  await browser.close();
  console.log('UI check passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
