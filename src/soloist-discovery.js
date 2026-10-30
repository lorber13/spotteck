const { spawn, execFile } = require('child_process');
const os = require('os');
const crypto = require('crypto');

// Publish the official ZeroConf endpoint through macOS Bonjour, which owns UDP 5353.
class SoloistDiscovery {
  constructor(name) { this.name = name; this.generation = 0; this.child = null; }
  start(port) {
    this.stop();
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    const epoch = this.generation;
    execFile('/sbin/route', ['-n', 'get', 'default'], { timeout: 2000 }, (error, output) => {
      if (epoch !== this.generation) return;
      const network = !error && output.match(/interface:\s*(\S+)/)?.[1];
      const address = network && os.networkInterfaces()[network]?.find(x => x.family === 'IPv4' && !x.internal)?.address;
      const host = 'spotteck-' + crypto.createHash('sha256').update(this.name).digest('hex').slice(0, 12) + '.local';
      const args = address ? ['-P', this.name, '_spotify-connect._tcp', 'local.', String(port), host, address] :
        ['-R', this.name, '_spotify-connect._tcp', 'local.', String(port)];
      this.child = spawn('/usr/bin/dns-sd', [...args, 'CPath=/zc', 'VERSION=1.0', 'Stack=SP'], { stdio: 'ignore' });
      this.child.once('error', () => {});
    });
  }
  stop() {
    this.generation++;
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}
module.exports = { SoloistDiscovery };
