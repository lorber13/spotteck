const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getState: () => ipcRenderer.invoke('spotify:get-state'),
  getPlayerState: () => ipcRenderer.invoke('spotify:get-state'),
  playPause: () => ipcRenderer.invoke('spotify:play-pause'),
  next: () => ipcRenderer.invoke('spotify:next'),
  nextTrack: () => ipcRenderer.invoke('spotify:next'),
  prev: () => ipcRenderer.invoke('spotify:prev'),
  prevTrack: () => ipcRenderer.invoke('spotify:prev'),
  setShuffle: (val) => ipcRenderer.invoke('spotify:set-shuffle', val),
  seek: (sec) => ipcRenderer.invoke('spotify:seek', sec),
  setVolume: (vol) => ipcRenderer.invoke('spotify:set-volume', vol),
  playUri: (uri) => ipcRenderer.invoke('spotify:play-uri', uri),
  playTrackInContext: (track, ctx) => ipcRenderer.invoke('spotify:play-track-in-context', track, ctx),
  getPlaylists: () => ipcRenderer.invoke('playlists:get'),
  getPlaylistTracks: (id) => ipcRenderer.invoke('playlists:tracks', id),
  addPlaylistByUrl: (url) => ipcRenderer.invoke('playlists:add-url', url),
  removePlaylist: (id) => ipcRenderer.invoke('playlists:remove', id),
  getProfile: () => ipcRenderer.invoke('spotify:get-profile'),
  login: () => ipcRenderer.invoke('spotify:login'),
  logout: () => ipcRenderer.invoke('spotify:logout'),
  reportProgress: (data) => ipcRenderer.send('spotify:report-progress', data),
  onState: (cb) => {
    ipcRenderer.on('spotify:state', (_e, st) => cb(st));
  },
  onPlayStream: (cb) => {
    ipcRenderer.on('spotify:play-stream', (_e, payload) => cb(payload));
  },
  onTogglePause: (cb) => {
    ipcRenderer.on('spotify:toggle-pause', (_e, payload) => cb(payload));
  },
  onSeekTo: (cb) => {
    ipcRenderer.on('spotify:seek-to', (_e, payload) => cb(payload));
  }
};

contextBridge.exposeInMainWorld('spotteck', api);
contextBridge.exposeInMainWorld('spotdeck', api);
