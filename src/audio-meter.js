const { spawn } = require('child_process');
const path = require('path');

// Capture only the playback process. No microphone, recording file, or audio output.
class AudioMeter {
  constructor(app, window, processId) {
    this.child = null;
    this.pid = null;
    this.retryAfter = 0;
    this.timer = setInterval(() => {
      const pid = processId();
      if (this.child && pid !== this.pid) this.stopChild();
      if (!pid || this.child || Date.now() < this.retryAfter) return;
      this.pid = pid;
      const binary = app.isPackaged ? path.join(process.resourcesPath, 'audio-meter') : path.join(__dirname, '../build/native/audio-meter');
      const child = spawn(binary, [String(pid)], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let buffer = '';
      let retryDelay = 30000;
      child.stderr.on('data', chunk => {
        const code = chunk.toString().match(/Audio analysis unavailable \((-?\d+)\)/)?.[1];
        if (code === '-2') retryDelay = 2000;
        if (code && !window.isDestroyed()) window.webContents.send('audio:status', 'Analisi audio non disponibile (codice ' + code + ').');
      });
      child.stdout.on('data', chunk => {
        if (this.child !== child) return;
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const frame = JSON.parse(line);
            if (frame.frequency?.length === 256 && frame.time?.length === 512 && !window.isDestroyed()) {
              window.webContents.send('audio:frame', frame);
              if (!this.statusAt || Date.now() - this.statusAt > 1000) {
                this.statusAt = Date.now();
                const signal = frame.time.some(value => Math.abs(value - 128) > 1);
                window.webContents.send('audio:status', signal ? 'Visualizzatori: audio reale collegato.' : 'Visualizzatori: audio collegato, silenzio.');
              }
            }
          } catch (_) {}
        }
        // Only an unterminated line is bounded; complete frames above were already delivered.
        if (buffer.length > 32768) buffer = '';
      });
      const ended = () => {
        if (this.child !== child) return;
        this.child = null;
        this.retryAfter = Date.now() + retryDelay;
      };
      child.once('error', () => {
        if (!window.isDestroyed()) window.webContents.send('audio:status', 'Analizzatore audio non disponibile: ricostruisci o reinstalla Spotteck.');
        ended();
      });
      child.once('exit', ended);
    }, 1000);
  }
  stopChild() {
    const child = this.child;
    this.child = null;
    child?.kill('SIGTERM');
  }
  stop() { clearInterval(this.timer); this.stopChild(); }
}
module.exports = { AudioMeter };
