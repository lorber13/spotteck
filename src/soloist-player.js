const fs = require('fs');
const { PremiumPlayer } = require('./premium-player');
const { SoloistDiscovery } = require('./soloist-discovery');

class SoloistPlayer extends PremiumPlayer {
  constructor(options) {
    super(options);
    this.name += ' Soloist';
    this.readKey = options.readKey;
    this.discovery = options.discovery || new SoloistDiscovery(this.name);
    this.pairing = false;
  }

  async launch(epoch) {
    const key = this.readKey();
    if (!key) throw new Error('Inserisci la chiave personale Spotify Soloist nelle Impostazioni.');
    try { fs.accessSync(this.binary, fs.constants.X_OK); }
    catch (_) { throw new Error('Spotify Soloist non è installato. Scarica la versione Mac Apple Silicon dal sito ufficiale.'); }
    fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.cacheDir, 0o700);
    if (epoch !== this.generation) throw new Error('Avvio annullato.');
    // The official CLI requires the personal key at startup. Never log arguments or stderr.
    const pairMode = this.pairing;
    const child = this.spawnProcess(this.binary, ['--device-name', this.name, '--api-key', key,
      '--data-dir', this.cacheDir, '--cache-dir', this.cacheDir + '/cache', '--cache-size', '100', '--initial-volume', '100', '--verbose', ...(pairMode ? ['--pair'] : [])],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.error = '';
    // Discard all diagnostic text; only extract the public discovery port.
    let diagnostic = '';
    const inspect = chunk => {
      diagnostic = (diagnostic + chunk.toString()).slice(-1024);
      const port = diagnostic.match(/Started ZeroConf service on port (\d+) path \/zc/);
      if (port && this.child === child) { this.discovery.start(Number(port[1])); diagnostic = ''; }
    };
    child.stderr?.on('data', inspect);
    child.stdout?.on('data', inspect);
    const failed = (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.discovery.stop();
      if (pairMode && code === 0) {
        this.pairing = false;
        // Let the original start promise settle before restoring the saved session.
        setTimeout(() => { if (epoch === this.generation) this.start().catch(error => { this.error = error.message; }); }, 0);
        return;
      }
      this.error = code === 10 ? 'Spotify Soloist è scaduto: scarica una build aggiornata dal sito ufficiale.' :
        'Spotify Soloist si è arrestato. Verifica la chiave personale e riprova.';
    };
    child.once('error', failed);
    child.once('exit', failed);
    this.deviceId = null;
    this.eligibility = 'unknown';
    await this.refreshDevice();
    if (this.child !== child || epoch !== this.generation) throw new Error(this.error || 'Avvio annullato.');
  }

  async startPairing() {
    await this.stopAndWait();
    this.pairing = true;
    await this.start();
  }

  stop() {
    this.discovery.stop();
    this.pairing = false;
    super.stop();
  }

  async refreshDevice() {
    const child = this.child;
    const epoch = this.generation;
    if (!child) return false;
    const result = await this.request('GET', '/me/player/devices');
    if (this.child !== child || epoch !== this.generation) return false;
    if (result && [401, 403, 429].includes(result.status)) throw new Error('Spotify non consente il collegamento. Verifica il login o riprova più tardi.');
    const device = result?.ok && result.data?.devices?.find((d) => d.name === this.name && d.id);
    if (!device) return false;
    this.deviceId = device.id;
    this.eligibility = 'supported';
    return true;
  }

  async command(...args) {
    await this.start();
    let paired = await this.refreshDevice();
    const epoch = this.generation;
    for (let attempt = 0; !paired && attempt < 20 && this.child && epoch === this.generation; attempt++) {
      await this.sleep(250);
      paired = await this.refreshDevice();
    }
    if (epoch !== this.generation || !this.child) throw new Error('Avvio annullato.');
    if (!paired) throw new Error(`Apri Spotify e seleziona ${this.name} nel menu Dispositivi per il primo collegamento.`);
    return super.command(...args);
  }
}
module.exports = { SoloistPlayer };
