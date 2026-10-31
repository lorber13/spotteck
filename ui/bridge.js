// window.spotteck on top of the Tauri IPC, with the same methods and return shapes the
// Electron preload had. Load before visualizers.js and app.js.
(() => {
  const tauri = window.__TAURI__;
  if (!tauri) return;
  const call = (command, args) => tauri.core.invoke(command, args).catch((error) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
  const on = (event) => (callback) => { tauri.event.listen(event, (e) => callback(e.payload)); };

  const api = {
    getState: () => call('get_state'),
    getPlayerState: () => call('get_state'),
    playPause: () => call('play_pause'),
    next: () => call('next'),
    nextTrack: () => call('next'),
    prev: () => call('prev'),
    prevTrack: () => call('prev'),
    setShuffle: (value) => call('set_shuffle', { value: !!value }),
    seek: (seconds) => call('seek', { seconds: Number(seconds) || 0 }),
    setVolume: (volume) => call('set_volume', { volume: Number(volume) }),
    playUri: (uri) => call('play_uri', { uri: String(uri) }),
    playTrackInContext: (track, context) => call('play_track_in_context', { track: String(track), context: String(context) }),
    getPlaylists: () => call('playlists_get'),
    getPlaylistTracks: (id) => call('playlists_tracks', { id: String(id) }),
    addPlaylistByUrl: (url) => call('playlists_add_url', { url: String(url) }),
    removePlaylist: (id) => call('playlists_remove', { id: String(id) }),
    getProfile: () => call('get_profile'),
    login: () => call('login'),
    logout: () => call('logout'),
    getClientId: () => call('get_client_id'),
    setClientId: (clientId) => call('set_client_id', { clientId: String(clientId) }),
    openDeveloperDashboard: () => call('open_developer_dashboard'),
    onState: on('spotify:state'),
    onPlaylistsChanged: on('playlists:changed'),
    onAudioStatus: on('audio:status'),
    onAudioFrame: on('audio:frame')
  };

  window.spotteck = api;
  window.spotdeck = api;
})();
