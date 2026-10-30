// Regenerates docs/screenshots with mock data: ui/ in headless Chromium, stubbed Tauri IPC.
// Usage: node tools/generate_screenshots.js
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

// Load preset images as base64 data URLs
const presetsDir = path.join(__dirname, '../artwork_presets');
const files = [
  { file: '01_kronberg_bauhaus_circle.png', name: 'Kronberg 1960' },
  { file: '02_kling_klang_bars.png', name: 'Kling Klang' },
  { file: '03_tokyo_horizon_sun.png', name: 'Tokyo Horizon' },
  { file: '04_van_gelder_split.png', name: 'Van Gelder' },
  { file: '05_ambient_radar_arcs.png', name: 'Ambient Radar' },
  { file: '06_selected_checker_minimal.png', name: 'Selected Minimal' },
  { file: '07_oxford_diagonal_beam.png', name: 'Oxford Beam' },
  { file: '08_paris_concentric_rings.png', name: 'Paris Concentric' },
  { file: '09_ecm_vertical_stems.png', name: 'ECM Stems' }
];

const mockPlaylists = files.map((f, idx) => {
  const filePath = path.join(presetsDir, f.file);
  const b64 = fs.existsSync(filePath) ? fs.readFileSync(filePath).toString('base64') : '';
  return {
    id: `spotify:playlist:mock${idx + 1}`,
    name: f.name,
    image: b64 ? `data:image/png;base64,${b64}` : '',
    pinned: false
  };
});

const mockTracks = [
  { uri: 'spotify:track:mock1', title: 'Weniger, aber besser', artist: 'Dieter Rams', duration: 214, playable: true },
  { uri: 'spotify:track:mock2', title: 'Atelier 01 (Minimal Edition)', artist: 'Braun Sound Studio', duration: 185, playable: true },
  { uri: 'spotify:track:mock3', title: 'Form Follows Function', artist: 'Bauhaus Ensemble', duration: 242, playable: true },
  { uri: 'spotify:track:mock4', title: 'Anodized Aluminium', artist: 'Kling Klang System', duration: 198, playable: true },
  { uri: 'spotify:track:mock5', title: 'Ten Principles', artist: 'Kronberg Design', duration: 260, playable: true }
];

const mockState = {
  isRunning: true,
  isPlaying: true,
  track: 'Weniger, aber besser',
  artist: 'Dieter Rams · Braun Sound Studio',
  album: 'Atelier Minimal Edition',
  duration: 214,
  position: 78,
  shuffling: true,
  artwork: mockPlaylists[0].image,
  trackUri: 'spotify:track:mock1',
  contextUri: mockPlaylists[0].id,
  readiness: 'ready',
  volume: 100,
  authenticated: true
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 980, height: 620 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('Renderer console:', m.text()); });
  const fixtures = {
    state: mockState,
    playlists: mockPlaylists,
    tracks: mockTracks,
    profile: { authenticated: true, readiness: 'ready', message: '', profile: { name: 'Dieter Rams', product: 'Braun Edition', avatar: '' } }
  };
  await page.addInitScript(`window.__SPOTTECK_MOCK__ = ${JSON.stringify(fixtures)};`);
  await page.addInitScript({ path: path.join(__dirname, 'mock-tauri.js') });
  await page.goto('file://' + path.join(__dirname, '../ui/index.html'));

  const outDir = path.join(__dirname, '../docs/screenshots');
  fs.mkdirSync(outDir, { recursive: true });

  // Let initial state and visualizers settle
  await delay(1000);

  const modes = [
    { file: '01_oscilloscope.png' },
    { file: '02_cassette.png' },
    { file: '03_vu_meter.png' },
    { file: '04_vinyl.png' },
    { file: '05_aether_morph.png' }
  ];

  for (let i = 0; i < modes.length; i++) {
    if (i > 0) {
      // Click stage to cycle mode
      await page.evaluate(() => document.getElementById('stage')?.click());
      await delay(600);
    }
    await page.screenshot({ path: path.join(outDir, modes[i].file) });
    console.log(`Saved screenshot: ${modes[i].file}`);
  }

  // Also capture the drawer view (track list open with active track highlighted)
  await page.evaluate(() => {
    const drawer = document.getElementById('drawer');
    const drawerCover = document.getElementById('drawerCover');
    const drawerTitle = document.getElementById('drawerTitle');
    const drawerList = document.getElementById('drawerList');

    if (drawer && drawerCover && drawerTitle && drawerList) {
      const tile = document.querySelector('.tile');
      const img = tile ? tile.querySelector('img') : null;
      if (img) drawerCover.src = img.src;
      drawerCover.classList.add('active');
      drawerTitle.textContent = 'Kronberg 1960 · 5';
      drawerList.innerHTML = '';

      const sampleTracks = [
        { title: 'Weniger, aber besser', artist: 'Dieter Rams', time: '3:34', cur: true },
        { title: 'Atelier 01 (Minimal Edition)', artist: 'Braun Sound Studio', time: '3:05', cur: false },
        { title: 'Form Follows Function', artist: 'Bauhaus Ensemble', time: '4:02', cur: false },
        { title: 'Anodized Aluminium', artist: 'Kling Klang System', time: '3:18', cur: false },
        { title: 'Ten Principles', artist: 'Kronberg Design', time: '4:20', cur: false }
      ];

      sampleTracks.forEach((t) => {
        const row = document.createElement('button');
        row.className = 'track-row' + (t.cur ? ' current' : '');
        const titleEl = document.createElement('div');
        titleEl.className = 'tr-title';
        titleEl.textContent = t.title;
        const artistEl = document.createElement('div');
        artistEl.className = 'tr-artist';
        artistEl.textContent = t.artist;
        const timeEl = document.createElement('div');
        timeEl.className = 'tr-time';
        timeEl.textContent = t.time;
        row.appendChild(titleEl);
        row.appendChild(artistEl);
        row.appendChild(timeEl);
        drawerList.appendChild(row);
      });
      drawer.classList.add('open');
    }
  });

  await delay(500);
  await page.screenshot({ path: path.join(outDir, '06_playlist_drawer.png') });
  console.log('Saved screenshot: 06_playlist_drawer.png');

  await browser.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
