# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Spotteck is a macOS (Apple Silicon, macOS ≥ 14.2) Electron app: a compact Braun-style remote control for Spotify with analog visualizers (oscilloscope, cassette, VU meter, vinyl, WebGL "Aether"). It never decodes audio itself — an official Spotify client always produces the sound. User-facing strings, README and SETUP_GUIDE are in **Italian**; keep new UI text and error messages in Italian.

## Commands

```
npm ci
npm start                     # compiles native audio helper (xcrun swiftc), then electron .
npm test                      # node --test tests/*.test.js
node --test tests/playback.test.js                 # single file
node --test --test-name-pattern="<regex>" tests/playback.test.js   # single test
npm run build:audio           # build/native/audio-meter (needs Xcode/CLT with Core Audio Process Taps)
build/native/audio-meter --self-test
npm run pack                  # electron-builder --dir
npm run dist                  # DMG + ZIP
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron tools/check-premium-ui.js   # isolated renderer UI check with stubbed IPC
```

There is no linter or bundler. Unit tests run on any platform (plain Node); `start`, `build:audio`, `pack`, `dist` and the UI check require macOS.

## Architecture

**Process split.** `src/main.js` (main process) creates the window, registers media keys and maps `ipcMain.handle` channels (`spotify:*`, `soloist:*`, `playlists:*`) onto `SpotifyController` and `PlaylistsStore`. `src/preload.js` exposes the same API via `contextBridge` as both `window.spotteck` and the legacy alias `window.spotdeck`. The renderer is plain scripts with no modules: `index.html` loads `visualizers.js` (defines `window.Instruments`) then `app.js` (all UI logic). Adding a feature that crosses the boundary means touching main.js, preload.js and app.js together.

**Playback routing — two modes** (`src/spotify-controller.js`, the core file):
- `desktop`: Spotify.app produces audio. Controls try the Spotify Web API first and fall back to AppleScript via `osascript`; Spotify.app is launched/kept hidden (`ensureSpotifyRunning`, `hideSpotify`).
- `premium`: the official **Spotify Soloist** CLI (user-installed binary at `userData/engines/soloist/soloist`, user's personal key) runs as a child process and acts as a Spotify Connect device. `SoloistPlayer` (`soloist-player.js`) extends `PremiumPlayer` (`premium-player.js`, generic Connect lifecycle: transfer to our device, then send Web API commands with `device_id`). `soloist-discovery.js` advertises its ZeroConf port over Bonjour for first-time pairing (`--pair`).
- `selectPlaybackMode()` picks the mode from `GET /me` `product` plus whether Soloist is configured/installed; it is rechecked every 5 min. Transient errors (network/429/5xx) keep the current mode.
- At the bottom of the file, every public control (`playPause`, `nextTrack`, `seek`, `setVolume`, `playUri`, `playTrackInContext`, …) is **wrapped** by a loop over `premiumCommands`: the wrapper waits for init, routes to `premium.command(...)` in premium mode or the original desktop implementation otherwise. A new control needs both a desktop method on `SpotifyController` and an entry in `premiumCommands`.

**State.** A single module-level `state` object is refreshed by `pollSpotifyState()` every 850 ms (Web API `GET /me/player`, AppleScript when needed) and pushed to the renderer on `spotify:state`. `accountGeneration` is an epoch counter: async work captures it and bails if it changed (login/logout/account switch). Preserve this pattern in any new async path. `PremiumPlayer` uses the same idea with `generation`.

**Auth** (`spotify-auth.js`): OAuth Authorization Code + PKCE (no client secret), loopback redirect `http://127.0.0.1:43821/callback`, client ID in `spotify-config.json`, tokens encrypted with Electron `safeStorage`. `spotify-controller.js` also has a legacy path that imports tokens from the Ulanzi Spotify plugin (`loadUlanziCredentials`), gated by `allowLegacyCredentials`.

**Playlists** (`playlists-store.js`): user playlists are saved locally in userData (atomic temp-file + rename; corrupt files are reported, never overwritten). Metadata comes from the public oEmbed endpoint and track lists are scraped from `open.spotify.com/embed/playlist/{id}` (`__NEXT_DATA__` JSON) — not the Web API — and cached in memory.

**Visualizer audio.** `native/audio-meter.swift` uses Core Audio Process Taps to capture only the player process (Soloist PID or bundle id `com.spotify.client`, from `SpotifyController.audioProcessId()`) and prints one JSON line per frame (`frequency`[256], `time`[512], stereo RMS/peaks). `src/audio-meter.js` spawns it, parses lines and forwards `audio:frame` / `audio:status` IPC. It must never open the microphone (the UI check asserts this). Packaged builds load the helper from `process.resourcesPath`; dev builds from `build/native/`.

## Conventions and constraints

- **Secrets:** never log Soloist process arguments, stderr or stdout. The CLI receives the personal key on its command line; Soloist output is only scanned for the ZeroConf port and otherwise discarded. The Soloist binary and keys are never committed or bundled.
- **Tests** load source files with `vm.runInNewContext(fs.readFileSync(...))` and a fake `require` that stubs `electron` and sibling modules (see `tests/playback.test.js`). Each source file needs to stay loadable that way: CommonJS `require` of the relative names that tests stub, and nothing at top level that needs a real Electron. Tests may append code to reach internals (e.g. `module.exports.snapshot = getPlayerStateSync`).
- The packaged bundle includes only `src/**`, `package.json` and the compiled helper; Electron and electron-builder versions are pinned.
- Commit messages use Conventional Commits with a scope, e.g. `fix(soloist): …`, `perf(visualizers): …`.
- `.impeccable/config.json` records accepted exceptions for a UI linting tool on `src/index.html`.
