const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const file = () => path.join(app.getPath('userData'), 'soloist-key.json');
const binary = () => path.join(app.getPath('userData'), 'engines', 'soloist', 'soloist');
function key() {
  if (!app.isReady()) return null;
  try { return safeStorage.decryptString(Buffer.from(JSON.parse(fs.readFileSync(file(), 'utf8')).encrypted, 'base64')); }
  catch (_) { return null; }
}
function save(value) {
  if (typeof value !== 'string' || value.trim().length < 16 || value.length > 2048 || /[\r\n\0]/.test(value)) throw new Error('Chiave Soloist non valida.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Portachiavi non disponibile.');
  const encrypted = safeStorage.encryptString(value.trim()).toString('base64');
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ encrypted }), { mode: 0o600 });
}
module.exports = { key, save, binary, configured: () => !!key(), clear: () => fs.rmSync(file(), { force: true }) };
