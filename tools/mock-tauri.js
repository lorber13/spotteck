// Stand-in for window.__TAURI__ so ui/ runs in a plain browser (Playwright) with the real
// bridge.js. Injected before the page loads; reads fixtures from window.__SPOTTECK_MOCK__.
(() => {
  const mock = window.__SPOTTECK_MOCK__ || {};
  const listeners = {};
  const calls = [];
  const state = Object.assign({
    isRunning: false, isPlaying: false, track: 'Spotteck', artist: 'Pronto', album: '', duration: 0, position: 0,
    shuffling: false, artwork: '', trackUri: '', contextUri: '', volume: 100, authenticated: true,
    readiness: 'ready', playbackError: null
  }, mock.state || {});
  const playlists = mock.playlists || [];
  const tracks = mock.tracks || [];
  const control = () => (mock.controlError ? { error: mock.controlError } : { ok: true });

  const handlers = {
    get_state: () => state,
    play_pause: control,
    next: control,
    prev: control,
    set_shuffle: control,
    seek: control,
    set_volume: control,
    play_uri: control,
    play_track_in_context: control,
    get_profile: () => mock.profile || { authenticated: false, readiness: 'signed-out', message: 'Accedi con il tuo account Spotify Premium.', profile: null },
    login: () => ({ ok: true }),
    logout: () => ({ ok: true }),
    playlists_get: () => playlists,
    playlists_tracks: () => ({ success: true, tracks }),
    playlists_add_url: () => ({ success: false, error: 'Link playlist Spotify non valido.' }),
    playlists_remove: () => playlists
  };

  window.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        calls.push({ command, args });
        const handler = handlers[command];
        return handler ? Promise.resolve(handler(args)) : Promise.reject(new Error(`unknown command ${command}`));
      }
    },
    event: {
      listen: (event, callback) => {
        (listeners[event] = listeners[event] || []).push(callback);
        return Promise.resolve(() => {});
      }
    }
  };
  window.__mockEmit = (event, payload) => (listeners[event] || []).forEach((cb) => cb({ event, payload }));
  window.__mockCalls = calls;
})();
