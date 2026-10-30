const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');

// Shared Connect controls and process lifecycle; Soloist provides startup.
class PremiumPlayer {
  constructor({ binary, installationId, cacheDir, request, token, spawnProcess = spawn, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.binary = binary;
    this.request = request;
    this.token = token;
    this.cacheDir = cacheDir;
    this.spawnProcess = spawnProcess;
    this.sleep = sleep;
    this.name = `Spotteck ${crypto.createHash('sha256').update(installationId).digest('hex').slice(0, 8)}`;
    this.deviceId = crypto.createHash('sha1').update(this.name).digest('hex');
    this.child = null;
    this.starting = null;
    this.generation = 0;
    this.error = '';
    this.eligibility = 'unknown';
  }

  async start() {
    if (this.starting) return this.starting;
    if (this.child) return;
    const epoch = this.generation;
    this.starting = this.launch(epoch).finally(() => { this.starting = null; });
    return this.starting;
  }

  async command(method, endpoint, body, query) {
    await this.start();
    if (!this.child) throw new Error('Riproduzione annullata.');
    if (this.error) throw new Error(this.error);
    const epoch = this.generation;
    // Activate only our receiver, never whichever device happens to be active.
    const devices = await this.request('GET', '/me/player/devices');
    if (epoch !== this.generation) throw new Error('Riproduzione annullata.');
    if (!devices?.ok) throw new Error('Impossibile verificare il lettore di Spotteck.');
    if (!devices.data?.devices?.some((d) => d.id === this.deviceId && d.is_active)) {
      const transfer = await this.request('PUT', '/me/player', { device_ids: [this.deviceId], play: false });
      if (!transfer?.ok) throw new Error('Impossibile attivare il lettore di Spotteck.');
    }
    if (epoch !== this.generation || !this.child) throw new Error('Riproduzione annullata.');
    const result = await this.request(method, endpoint, body, { ...query, device_id: this.deviceId });
    if (!result?.ok) throw new Error('Comando Spotify non riuscito. Controlla la connessione e riprova.');
    if (this.error) throw new Error(this.error);
    return { ok: true };
  }

  stop() {
    this.generation++;
    const child = this.child;
    this.child = null;
    if (child) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1500);
      timer.unref();
    }
  }

  clearCredentials() {
    this.stop();
    if (this.cacheDir) fs.rmSync(this.cacheDir, { recursive: true, force: true });
  }
}

module.exports = { PremiumPlayer };
