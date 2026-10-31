# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Spotteck is a Tauri app for macOS (primary target: Apple Silicon, macOS ≥ 14.2), Linux and Windows: a compact Braun-style **remote control** for Spotify **Premium** accounts, with analog visualizers (oscilloscope, cassette, VU meter, vinyl, WebGL "Aether"). It relies **only on official Spotify APIs**: the Web API (`api.spotify.com/v1`) for state, commands and library, Authorization Code + PKCE on `accounts.spotify.com` with **the user's own Client ID** (entered in Settings, stored in `settings.json`), and oEmbed for pinned playlists the Web API won't describe. It plays no audio: commands go to the active Spotify Connect device (Spotify Desktop, phone, speaker); with none active, it wakes Spotify on this computer (matched by `scutil` ComputerName on macOS, `COMPUTERNAME` on Windows, the hostname on Linux). User-facing strings, README and SETUP_GUIDE are in **Italian**; keep new UI text and error messages in Italian.

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

Linux needs `libwebkit2gtk-4.1-dev libpipewire-0.3-dev libclang-dev libssl-dev libdbus-1-dev librsvg2-dev file`; Windows needs the MSVC Build Tools and WebView2. Per-OS bundle targets live in `src-tauri/tauri.{linux,windows}.conf.json`, merged by Tauri over `tauri.conf.json` (whose `app`/`dmg` targets and macOS window keys apply on macOS). `.github/workflows/ci.yml` runs only on pushes to `main`, `v*` tags, pull requests into `main` and manual dispatch: fmt + clippy (`-D warnings`), `npm test` on ubuntu/macos/windows, and `check:ui` (installs Playwright with `--no-save`, so don't add it to package.json); the release `bundle` matrix runs on all of those except pull requests.

## Architecture

**Workspace.**
- `crates/spotteck-core` — no system dependencies, so it is unit-tested anywhere: `readiness` (`needs-client-id | signed-out | connecting | plan-unsupported | ready | engine-error` with Italian messages, `Generation` epoch, `Backoff`), `state` (`PlayerState` + `Update` → the `spotify:state` `Payload`), `webapi` (serde types for the Web API responses, `Playback::updates`, `pick_device`, `Failure` classification of error responses), `pkce` (verifier/challenge, authorize URL, loopback callback parsing, `REDIRECT_URI` = `http://127.0.0.1:43821/callback`), `settings` (the Client ID), `pinned` (playlists pinned by link), `library` (grid/drawer entry types, `merge`), `analysis` (PCM → visualizer frame), `uri` (link/URI/ID parsing).
- `crates/spotteck-spotify` — everything that talks to Spotify, Web API only (reqwest + rustls): `auth` (browser PKCE login on the loopback redirect, token refresh), `api` (bearer token, single-flight refresh, one retry on 401, only `api.spotify.com/v1` URLs), `engine` (`Engine`: run loop that checks `/me` then polls `/me/player` every 1 s while playing / 4 s idle, commands, readiness), `library` (`/me/playlists`, `/playlists/{id}`, `/playlists/{id}/items`, oEmbed fallback).
- `crates/spotteck-capture` — the visualizer audio, captured from Spotify's process on this computer: `macos` (Core Audio process tap + private aggregate device, needs `NSAudioCaptureUsageDescription` in `src-tauri/Info.plist`), `windows` (WASAPI process loopback on the root Spotify.exe, via `wasapi`), `linux` (PipeWire capture stream with `target.object` = Spotify's playback stream and `node.dont-fallback`, so it never opens a microphone). `AudioTap` buffers samples and its analyzer thread emits frames; `Status` gives the Italian status line.
- `src-tauri` — `main.rs` wires the engine, capture, events and plugins; `commands.rs` holds the IPC commands (including `get_client_id`/`set_client_id`/`open_developer_dashboard`); `credentials.rs` stores the tokens in the system keychain (`keyring`: apple-native, windows-native, sync-secret-service on Linux). There is no Now Playing / media-key integration: the official Spotify app owns those.
- `ui/` — plain scripts, no modules or bundler: `bridge.js` defines `window.spotteck` (and the legacy alias `window.spotdeck`) on `window.__TAURI__`, then `visualizers.js` (defines `window.Instruments`), then `app.js` (all UI logic). A feature that crosses the boundary means touching `commands.rs` (+ `generate_handler!` in `main.rs`), `bridge.js` and `app.js` together.

**IPC contract.** Command results keep the shapes app.js already reads: controls return `{ ok }` or `{ error }` (shown as a stage toast), playlist calls return `{ success, … }`. Controls are async (each is a Web API request). Events: `spotify:state` (on every change, plus 1 s while playing; includes `device`, the name of the playing Connect device), `audio:frame` (~30 Hz, `{ frequency[256], time[512], levels: { rms[2], peak[2] } }`), `audio:status`, `playlists:changed` (when readiness enters or leaves `ready`).

**Readiness gates everything.** Every playback command calls `Readiness::gate()` and returns the Italian message when not `ready`. No Client ID → `needs-client-id`; tokens saved for another Client ID are dropped. Free accounts become `plan-unsupported` from `/me`'s `product` or from a 403 `PREMIUM_REQUIRED` on any player call. Transient errors keep retrying with `Backoff`; a refused refresh token deletes the saved login (→ `signed-out`).

**Generation epoch.** `Engine` bumps `generation` on login/logout. Async work (connect, events, library calls, profile) captures the epoch and drops its result if it changed. Preserve this in any new async path.

**Devices.** On `NO_ACTIVE_DEVICE`, `play` retries with `device_id` from `pick_device` and `play_pause` transfers playback (`PUT /me/player`); `next`/`prev`/`seek` refuse with an Italian message. Volume/shuffle with nothing active only change local state. After a command the loop polls again after ~700 ms (`SETTLE`).

**Visualizer audio.** Only Spotify on this computer is captured; playback on a phone or speaker leaves the instruments at rest. The UI must never request the microphone (`tools/check-ui.js` asserts this), and the Linux stream must keep `node.dont-fallback`/`node.dont-reconnect`.

## Conventions and constraints

- **Official APIs only.** Never add librespot or any other reverse-engineered Spotify client, borrow another app's Client ID, or call private Spotify hosts (spclient, apresolve, dealer, login5…). `tests/official-only.test.js` enforces this; extend its host allowlist only for documented official endpoints.
- **Secrets:** never log OAuth tokens. They live only in the keychain entry `com.braun.spotteck` / `spotify-session` as JSON (`client_id`, `access_token`, `refresh_token`, `expires_at`). The Client ID is not a secret.
- **Web API limits:** Development Mode apps list `/playlists/{id}/items` only for the user's own or collaborative playlists, and Spotify renamed `track` to `item` in those rows (both are parsed). Respect `Retry-After` on 429.
- **Dependencies** are pinned exactly where the API surface matters (tauri `=2.12.5`, keyring).
- **Tests:** Rust unit tests live next to the code (`#[cfg(test)]`); keep Spotify- and OS-independent logic in `spotteck-core` so it stays testable. `tests/visualizers.test.js` loads `ui/visualizers.js` with `vm.runInNewContext`.
- Pinned playlists are written atomically (temp file + rename, mode 0600); a corrupt file is reported, never overwritten. Spotteck 1.x archives are imported once from `~/Library/Application Support/Spotteck/user-data/playlists.json`.
- Commit messages use Conventional Commits with a scope, e.g. `fix(engine): …`, `perf(visualizers): …`.
- `.impeccable/config.json` records accepted exceptions for a UI linting tool on `ui/index.html`.
