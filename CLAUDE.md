# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Spotteck is a Tauri app for macOS (primary target: Apple Silicon, macOS ≥ 14.2), Linux and Windows: a compact Braun-style Spotify player for **Premium accounts only**, with analog visualizers (oscilloscope, cassette, VU meter, vinyl, WebGL "Aether"). It plays the audio itself through librespot as a Spotify Connect device named "Spotteck · <computer name>" (`scutil` ComputerName on macOS, `COMPUTERNAME` on Windows, the hostname on Linux). User-facing strings, README and SETUP_GUIDE are in **Italian**; keep new UI text and error messages in Italian.

## Commands

```
npm ci
npm start                     # tauri dev
npm test                      # cargo test --workspace && node --test tests/*.test.js
cargo test -p spotteck-core   # pure logic, any OS
cargo test -p spotteck-core state::tests::position   # single test (name filter)
cargo clippy --workspace --all-targets && cargo fmt --all --check
npm run check:ui              # headless Chromium (Playwright) check of ui/ with a stubbed Tauri IPC
node tools/generate_screenshots.js   # regenerates docs/screenshots with mock data
npm run pack                  # release binary only, any OS
npm run dist                  # bundles for the host OS: .app + .dmg | .deb + .AppImage | NSIS .exe
npm run pack:mac / dist:mac   # the same for aarch64-apple-darwin
```

Linux needs `libwebkit2gtk-4.1-dev libasound2-dev libssl-dev libdbus-1-dev librsvg2-dev file`; Windows needs the MSVC Build Tools and WebView2. Per-OS bundle targets live in `src-tauri/tauri.{linux,windows}.conf.json`, merged by Tauri over `tauri.conf.json` (whose `app`/`dmg` targets and macOS window keys apply on macOS). `.github/workflows/ci.yml` runs only on pushes to `main`, `v*` tags, pull requests into `main` and manual dispatch: fmt + clippy (`-D warnings`), `npm test` on ubuntu/macos/windows, and `check:ui` (installs Playwright with `--no-save`, so don't add it to package.json); the release `bundle` matrix runs on all of those except pull requests.

## Architecture

**Workspace.**
- `crates/spotteck-core` — no system dependencies, so it is unit-tested anywhere: `readiness` (`signed-out | connecting | plan-unsupported | ready | engine-error` with Italian messages, `Generation` epoch, `Backoff`), `state` (`PlayerState` + `Update` → the `spotify:state` `Payload`), `pinned` (playlists pinned by link), `library` (grid/drawer entry types, `merge`), `analysis` (PCM → visualizer frame), `uri` (link/URI/ID parsing).
- `crates/spotteck-spotify` — everything that talks to Spotify, via librespot 0.8: `Engine` (OAuth login with librespot's client ID, reusable credentials, `Spirc` Connect device, player events → `Update`), `library` (rootlist, playlist and track metadata), `tap` (`TeeSink` copies PCM sent to the audio output (CoreAudio / ALSA / WASAPI via rodio) into `AudioTap`; an analyzer thread drains it at playback rate).
- `src-tauri` — `main.rs` wires the engine, events and plugins; `commands.rs` holds the IPC commands; `credentials.rs` stores the login in the system keychain (`keyring`: apple-native, windows-native, sync-secret-service on Linux); `now_playing.rs` uses `souvlaki` for media keys and Now Playing / MPRIS / SMTC (Windows needs the main window's HWND).
- `ui/` — plain scripts, no modules or bundler: `bridge.js` defines `window.spotteck` (and the legacy alias `window.spotdeck`) on `window.__TAURI__`, then `visualizers.js` (defines `window.Instruments`), then `app.js` (all UI logic). A feature that crosses the boundary means touching `commands.rs` (+ `generate_handler!` in `main.rs`), `bridge.js` and `app.js` together.

**IPC contract.** Command results keep the shapes app.js already reads: controls return `{ ok }` or `{ error }` (shown as a stage toast), playlist calls return `{ success, … }`. Events: `spotify:state` (on every change, plus 1 s while playing), `audio:frame` (~30 Hz, `{ frequency[256], time[512], levels: { rms[2], peak[2] } }`), `audio:status`, `playlists:changed` (when readiness enters or leaves `ready`).

**Readiness gates everything.** Every playback command calls `Readiness::gate()` and returns the Italian message when not `ready`. Free accounts fail at login ("Premium account required") or via the `type` user attribute → `plan-unsupported`. Transient connection errors keep retrying with `Backoff`; bad stored credentials are deleted.

**Generation epoch.** `Engine` bumps `generation` on login/logout. Async work (connect, events, library calls, profile) captures the epoch and drops its result if it changed. Preserve this in any new async path.

**Spirc.** Commands are ignored by librespot while Spotteck isn't the active Connect device: `play` sends `activate()` then `load()`, `play_pause` transfers playback here when inactive, and `next`/`prev`/`seek` refuse with "Avvia una playlist su Spotteck.". `active` comes from player events (`PlayerState::active`).

**Visualizer audio.** No Core Audio tap and no system-audio permission: `TeeSink` wraps the rodio sink. Samples are divided by the soft volume so the instruments don't shrink with the slider, and released at 44.1 kHz so frames follow what the speakers play. The UI must never request the microphone (`tools/check-ui.js` asserts this).

## Conventions and constraints

- **Secrets:** never log OAuth tokens or the credentials blob. They live only in the keychain entry `com.braun.spotteck` / `spotify-session`.
- **Dependencies** are pinned exactly where the API surface matters (librespot `=0.8.0`, tauri `=2.12.5`, souvlaki, keyring). `vergen` is held at 9.0.x in `Cargo.lock` because librespot-core 0.8.0's build script fails with vergen 9.1.
- **Tests:** Rust unit tests live next to the code (`#[cfg(test)]`); keep Spotify- and OS-independent logic in `spotteck-core` so it stays testable. `tests/visualizers.test.js` loads `ui/visualizers.js` with `vm.runInNewContext`.
- Pinned playlists are written atomically (temp file + rename, mode 0600); a corrupt file is reported, never overwritten. Spotteck 1.x archives are imported once from `~/Library/Application Support/Spotteck/user-data/playlists.json`.
- Commit messages use Conventional Commits with a scope, e.g. `fix(engine): …`, `perf(visualizers): …`.
- `.impeccable/config.json` records accepted exceptions for a UI linting tool on `ui/index.html`.
