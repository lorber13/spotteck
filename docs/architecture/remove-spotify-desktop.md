# Removing the Spotify Desktop dependency

Status: **proposal**, not implemented. Line references are to commit `61a89b6`.

## 1. Summary and decision

Spotteck currently has two playback paths: `desktop`, where Spotify.app plays the audio and is driven by the Web API with an AppleScript fallback, and `premium`, where the official Spotify Soloist CLI runs as our own Spotify Connect receiver. This proposal removes the `desktop` path.

After the change Spotteck is a front end for **Spotify Premium + Spotify Soloist only**. It never launches, scripts, hides or taps Spotify.app. Free accounts, and Premium accounts without Soloist set up, see a clear setup state that explains what is missing. Spotteck does not fall back to another player.

This is a breaking change for Free users. They can no longer use Spotteck, because the Web API player endpoints and Soloist both require Premium.

## 2. Where Spotteck depends on Spotify.app today

### `src/spotify-controller.js`

| What | Where | Role |
| --- | --- | --- |
| `selectPlaybackMode()` | 31–52 | Defaults to `'desktop'` unless the plan is Premium *and* Soloist is configured and installed. |
| `getOrActivateDevice()` | 252–262 | On a 404 from `PUT /me/player/play`, picks the active device, else any `Computer` device (in practice Spotify.app). |
| `runOsa()` | 267–274 | `osascript` wrapper. |
| `isSpotifyProcessRunning()` | 276–287 | Uses System Events to look for `com.spotify.client`. |
| `hideSpotify()`, `refocusApp()` | 289–312 | Exits Spotify.app full screen, hides it, and refocuses our window. |
| `ensureSpotifyRunning()` | 314–329 | `open -g -j -a /Applications/Spotify.app`, then hides it after 1.2 s. |
| `GET_STATE_SCRIPT` | 331–360 | AppleScript state read. |
| `pollSpotifyState()` | 433–440, 476–521 | A 204 from `/me/player` falls back to the process check. A failed Web API call falls back to AppleScript and re-derives the playlist context. |
| Desktop controls | 551–782 | `playPause`, `nextTrack`, `prevTrack`, `setShuffle`, `seek`, `setVolume`, `playUri`, `playTrackInContext` each run `ensureSpotifyRunning()`, try the Web API, then fall back to AppleScript. `setVolume` also sets Spotify.app's `sound volume`. |
| `init()` / `login()` | 536, 815 | Hide or launch Spotify.app depending on the mode. |
| `getProfile()` | 786–790 | Process check and the labels `… · Spotify Desktop`. |
| `premiumCommands` wrapper loop | 873–918 | Exists only to choose between the desktop implementation and `premium.command()` on every call. |
| `audioProcessId()` | 529 | Returns `'com.spotify.client'` in desktop mode. |

### Elsewhere

- **`native/audio-meter.swift` 55–82:** a bundle-id code path resolves `com.spotify.client` to a Core Audio process object. Only desktop mode uses it.
- **`src/app.js` 518:** hides the Soloist setup panel for `free`/`open` plans.
- **`src/app.js` 520–522, 606–608:** the pairing copy assumes the user is in Spotify.app ("Poi potrai chiudere Spotify").
- **`SETUP_GUIDE.md`:** the requirements line, step 2 ("Gli account Free continuano a usare Spotify Desktop"), steps 5–6, and the visualizer section ("Soloist o Spotify Desktop").
- **`tests/playback.test.js`:** desktop-path cases at 98–106, 134–143, 145–153, 166–193, 195–207, 209–219 and 334+. The fake `execFile` records `osascript` calls in `calls.desktop`.

### Not dependencies (unchanged)

- **Auth (`spotify-auth.js`):** PKCE in the browser.
- **Playlists (`playlists-store.js`):** oEmbed and `open.spotify.com/embed` scraping.
- **Bonjour discovery (`soloist-discovery.js`):** advertises Soloist, not Spotify.app.
- **Ulanzi credential import:** a separate auth path. Removing it is a sensible follow-up, but it is out of scope here.

### Pairing

First-time Soloist pairing (`--pair`, ZeroConf) needs a Spotify client on the same network that can open the Connect menu and pick "Spotteck … Soloist". This does **not** have to be Spotify.app. The iOS or Android app works as well. Only the UI copy and `SETUP_GUIDE.md` tie pairing to the desktop app.

## 3. Target architecture

### 3.1 One backend

Every control is a Web API request sent to our receiver through `SoloistPlayer.command()`. Today's `premiumCommands` table (873–898) becomes the implementation itself:

```js
const commands = {
  playPause: () => ['PUT', state.isPlaying ? '/me/player/pause' : '/me/player/play'],
  nextTrack: () => ['POST', '/me/player/next'],
  // … unchanged entries …
};
for (const [name, build] of Object.entries(commands)) {
  SpotifyController[name] = (...args) => runCommand(build, args);  // readiness gate + premium.command + poll
}
```

Adding a control becomes a single table entry. Today it needs both a desktop method and a table entry. The desktop methods, the wrapper that overwrites them, and `getOrActivateDevice()` are all deleted. Because `PremiumPlayer` would have only one subclass left, it can be merged into `SoloistPlayer`. This is optional, and the tests in `tests/soloist.test.js` work with either layout.

### 3.2 Readiness instead of `playbackMode`

`playbackMode` (`'desktop' | 'premium'`) is replaced by a single `readiness` value that says why playback is or is not possible:

```
signed-out ─▶ checking ─▶ plan-unsupported            (product free/open)
                       └▶ engine-missing              (binary absent / not executable)
                       └▶ key-missing                 (SoloistSettings.configured() false)
                       └▶ pairing-required            (engine running, device not in /me/player/devices)
                       └▶ ready
                 any ─▶ engine-error                  (SoloistPlayer.error: crash, expired build)
```

- The derivation reuses what `selectPlaybackMode()` and `getProfile()` already compute: `account.product`, `SoloistSettings.configured()`, `fs.existsSync(SoloistSettings.binary())`, `premium.eligibility` and `premium.error`.
- The existing transient-failure rule stays as it is. When `/me` fails with status 0, 429 or 5xx, the current state is kept and the check is retried after 30 s. The `accountGeneration` epoch checks also stay.
- If the response has no `product`, the existing rule still applies: the account counts as ready only when a paired receiver is present (`premium.eligibility === 'supported'`). Otherwise the state is `checking` or `pairing-required`.
- `readiness` replaces `playbackMode` in the `spotify:state` payload (`getPlayerStateSync`) and in `getProfile()`. When the app is not `ready`, a control returns `{ error }` with an Italian message for that state, for example *"Spotteck richiede Spotify Premium."* or *"Installa il motore Spotify Soloist nelle Impostazioni."*. It never falls back to another player. Media keys go through the same gate.

### 3.3 Module split

`spotify-controller.js` (920 lines) loses about 300 lines of desktop code. The remainder is split along the seams that already exist. Each module stays loadable with `vm.runInNewContext` (CommonJS, stubbable relative `require`s, nothing at top level that needs a real Electron):

| Module | Contents (moved from) |
| --- | --- |
| `spotify-api.js` | `getAccessToken`, `spotifyWebApiRequest`, 401 retry (174–250); owns `accountGeneration`. |
| `account.js` | `/me` check, plan, readiness derivation (31–52, parts of `getProfile`). |
| `player-state.js` | `state`, `getPlayerStateSync`, `savedPlaylistContext`, `pollSpotifyState` (Web API branch only). |
| `spotify-controller.js` | Thin façade: `init`, command table, `login`/`logout`, Soloist setup, `audioProcessId`. The IPC surface in `main.js`/`preload.js` is unchanged. |

`pollSpotifyState()` keeps only its Web API branch. Playback counts as "ours" only when `/me/player` reports `device.id === premium.deviceId`, which is today's premium rule at 427. A 204 response or another active device shows as not playing, with no process probing.

### 3.4 Visualizer

`audioProcessId()` returns only `premium.child?.pid` while playing. The bundle-id branch in `audio-meter.swift` becomes dead code and should be removed so that the helper accepts only a PID. In `audio-meter.js`, the 2 s retry on error `-2` (process missing) was meant for Spotify.app starting up. It can stay, because it does no harm.

### 3.5 Setup UX (renderer)

- The Soloist setup panel is always shown, and Free accounts see a `plan-unsupported` notice. This removes the plan check at `app.js` 518.
- The status lines are driven by `readiness`, not by the profile label. The pairing copy becomes device-neutral, for example: *"Apri l’app Spotify sul telefono o su un altro dispositivo e seleziona {deviceName} nel menu Dispositivi."*
- The profile labels drop `· Spotify Desktop`. The label becomes `Premium · Spotify Soloist`, or the readiness message.

## 4. Deletions

- **`spotify-controller.js`:** `runOsa`, `isSpotifyProcessRunning`, `hideSpotify`, `refocusApp`, `ensureSpotifyRunning`, `GET_STATE_SCRIPT`, the AppleScript branch of `pollSpotifyState`, the eight desktop control bodies, `getOrActivateDevice`, the wrapper loop, `playbackMode`, the desktop labels, and the `child_process` import.
- **`audio-meter.swift`:** bundle-id process lookup.
- **`app.js`:** Free-plan panel hiding and the desktop pairing copy.
- **Tests:** the desktop cases listed in §2, the `calls.desktop`/`osascript` fake, and the AppleScript well-formedness test.

## 5. Migration plan

Each step is one Conventional Commit, and `npm test` passes after each one.

1. **`refactor(controller): derive playback readiness`.** Compute `readiness` alongside `playbackMode`, expose it in state and profile, and have the renderer read it. No behavior change.
2. **`feat(playback)!: drop the Spotify Desktop player`.** Gate controls on `readiness`, delete the AppleScript and launch code, collapse the command wrapper, and point `audioProcessId` only at Soloist. Replace the desktop tests with readiness tests: each non-ready state returns its message, never calls `execFile`, and never calls `premium.command`.
3. **`refactor(controller): split API, account and state modules`.** Move the code as shown in §3.3. Update the test loaders to stub the new relative `require`s.
4. **`refactor(audio-meter): capture by PID only`.** Remove the bundle-id branch. `--self-test` still passes.
5. **`docs: require Premium and Soloist`.** Update the `SETUP_GUIDE.md` requirements and steps 2, 5, 6, the README requirements, and the CLAUDE.md architecture section. Bump to `2.0.0`.

## 6. Risks and open questions

- **Free users are cut off.** This is intentional, but it needs a release note and a major version bump. Existing Free users get the `plan-unsupported` screen, not a silent failure.
- **No safety net.** If the Soloist build expires (exit code 10), crashes, or the key is revoked, there is no playback at all. Today the desktop fallback hides some of these failures. `engine-error` must be prominent in the main UI, not only in Settings, and should link to the official download page.
- **Manual engine install.** Soloist cannot be bundled, so every user must download it and place it at `userData/engines/soloist/soloist`. This is now on the critical path for every user. A guided "choose file…" install step in Settings would help, but it is not part of this proposal.
- **Headless pairing (open).** Soloist's official documentation could not be reached while writing this proposal. If Soloist supports logging in with the user's OAuth session or a device-code flow, first pairing would no longer need any Spotify client. `soloist-discovery.js` and the Bonjour advertisement could then be removed as well. This needs to be verified against the Soloist reference before step 2.
- **Playback on other devices.** When the user plays on a phone, Spotteck shows "not playing" because only our device counts. One option is to show that playback read-only with a "transfer to Spotteck" action. Decide this before step 2, because it affects `player-state.js`.
- **Web API rate limits.** Every control and the 850 ms poll now go only through the Web API, with no local AppleScript reads. Request volume is unchanged for Premium users, who already work this way. Watch for 429 responses once all users are on this path.
