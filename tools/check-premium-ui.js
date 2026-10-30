const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
app.setPath('userData', path.join(require('os').tmpdir(), 'spotteck-ui-check'));
let profile = { authenticated: true, needsClientId: false,
  profile: { name: 'Account di prova', product: 'Premium · Lettore integrato' } };
ipcMain.handle('spotify:get-profile', () => profile);
ipcMain.handle('spotify:get-state', () => ({ isRunning: false, isPlaying: false }));
ipcMain.handle('playlists:get', () => []);
ipcMain.handle('spotify:login', () => ({ error: 'Accesso Spotify annullato.' }));
ipcMain.handle('soloist:configure', () => ({ error: 'Chiave di prova non valida.' }));
ipcMain.handle('soloist:connect', () => ({ ok: true }));
const volumeCalls = [];
const volumeReplies = [];
ipcMain.handle('spotify:set-volume', (_event, value) => {
  volumeCalls.push(value);
  return new Promise(resolve => volumeReplies.push(resolve));
});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 329, height: 628, show: false,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, '../src/index.html'));
  await win.webContents.executeJavaScript(`
    window.audioCheck = { microphoneCalls: 0, mediaSources: 0 };
    navigator.mediaDevices.getUserMedia = () => {
      audioCheck.microphoneCalls++;
      return Promise.reject(new Error('Microphone must not be opened for playback'));
    };
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  `);
  const audio = await win.webContents.executeJavaScript('audioCheck');
  assert.equal(audio.microphoneCalls, 0, 'Playback must not activate a Bluetooth microphone');
  const setSlider = (values) => win.webContents.executeJavaScript(`
    { const slider = document.getElementById('volumeSlider');
      for (const value of ${JSON.stringify(values)}) { slider.value = value; slider.dispatchEvent(new Event('input')); }
      slider.dispatchEvent(new Event('change')); }
  `);
  const sliderValue = () => win.webContents.executeJavaScript("Number(document.getElementById('volumeSlider').value)");
  await setSlider([95, 80, 0]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(volumeCalls, [0], 'coalesce dragging and preserve mute');
  await setSlider([25, 35]);
  win.webContents.send('spotify:state', { isRunning: true, volume: 80 });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(volumeCalls, [0], 'only one request may be in flight');
  assert.equal(await sliderValue(), 35, 'stale polling must not move the slider');
  volumeReplies.shift()({ ok: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(volumeCalls, [0, 35], 'send only the newest queued volume');
  volumeReplies.shift()({ ok: true });
  await new Promise(resolve => setTimeout(resolve, 1600));
  for (const value of [42, 0, 100]) {
    win.webContents.send('spotify:state', { isRunning: true, volume: value });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await sliderValue(), value, 'sync remote changes at every volume');
  }
  await win.webContents.executeJavaScript("document.getElementById('settingsBtn').click()");
  await new Promise((resolve) => setTimeout(resolve, 200));
  let result = await win.webContents.executeJavaScript(`({
    plan: document.getElementById('profileSub').textContent,
    setupHidden: document.getElementById('spotifySetup').hidden,
    overflow: document.documentElement.scrollWidth > innerWidth
  })`);
  assert.match(result.plan, /Premium/);
  assert.ok(result.setupHidden);
  assert.equal(result.overflow, false);
  await win.webContents.executeJavaScript("document.getElementById('profileLoginBtn').click()");
  await new Promise((resolve) => setTimeout(resolve, 200));
  result = await win.webContents.executeJavaScript(`({ message: document.getElementById('spotifyStatus').textContent,
    disabled: document.getElementById('profileLoginBtn').disabled })`);
  assert.equal(result.message, 'Accesso Spotify annullato.');
  assert.equal(result.disabled, false);
  await win.webContents.executeJavaScript("document.getElementById('soloistKey').value = 'test-key'; document.getElementById('soloistSave').click()");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const secretField = await win.webContents.executeJavaScript(`({
    type: document.getElementById('soloistKey').type,
    cleared: document.getElementById('soloistKey').value === '',
    message: document.getElementById('soloistStatus').textContent,
    enabled: !document.getElementById('soloistSave').disabled
  })`);
  assert.equal(secretField.type, 'password');
  assert.ok(secretField.cleared);
  assert.equal(secretField.message, 'Chiave di prova non valida.');
  assert.ok(secretField.enabled);
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync('/tmp/spotteck-premium-settings.png', (await win.webContents.capturePage()).toPNG());
  profile = { authenticated: false, needsClientId: true };
  await win.webContents.executeJavaScript("document.getElementById('settingsBtn').click()");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('spotifySetup').hidden"), false);
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync('/tmp/spotteck-premium-setup.png', (await win.webContents.capturePage()).toPNG());
  console.log('UI checks passed: no microphone capture, coalesced volume requests, remote volume sync, Premium label, setup visibility, login errors, button recovery, 329px layout.');
  app.quit();
}).catch((err) => { console.error(err); app.exit(1); });
