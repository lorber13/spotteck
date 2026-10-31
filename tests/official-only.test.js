// Spotteck must rely only on official Spotify APIs: the Web API, the accounts service for
// the PKCE login, oEmbed and the image CDN the Web API links to. This guard fails the build if
// an unofficial client library, a borrowed Client ID or a private Spotify endpoint comes back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function files(dir, keep) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (['node_modules', 'target', 'gen', '.git'].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (keep(entry.name)) out.push(full);
    }
  };
  walk(path.join(root, dir));
  return out;
}

const manifests = [
  'Cargo.lock',
  'package.json',
  'package-lock.json',
  ...files('.', (name) => name === 'Cargo.toml').map((f) => path.relative(root, f))
];
const sources = ['crates', 'src-tauri', 'ui', 'tools']
  .flatMap((dir) => files(dir, (name) => /\.(rs|js|html|json|toml|plist)$/.test(name)));

// Reverse-engineered Spotify clients and libraries built on them.
const UNOFFICIAL = /\b(librespot[\w-]*|go-librespot|spotifyd|ncspot|spotify-player|spotify_player|spotify-qt)\b/i;
// The Client ID librespot ships with, which Spotteck 2 borrowed for its login.
const BORROWED_CLIENT_ID = '65b708073fc0480ea92a077233ca87bd';
// Official, documented hosts. Anything else on Spotify's domains (spclient, apresolve, dealer,
// login5, audio CDNs…) is private to Spotify's own apps.
const OFFICIAL_HOSTS = new Set(['api.spotify.com', 'accounts.spotify.com', 'open.spotify.com', 'developer.spotify.com', 'i.scdn.co']);
const SPOTIFY_HOST = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:spotify\.com|scdn\.co|spotifycdn\.com|spotify\.net))\b/gi;

test('no unofficial Spotify client in the dependencies', () => {
  for (const file of manifests) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const match = text.match(UNOFFICIAL);
    assert.equal(match, null, `${file} depends on ${match && match[0]}`);
  }
});

test('no unofficial client, borrowed Client ID or private endpoint in the sources', () => {
  assert.ok(sources.length > 10, 'sources found');
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    const name = path.relative(root, file);
    const match = text.match(UNOFFICIAL);
    assert.equal(match, null, `${name} mentions ${match && match[0]}`);
    assert.ok(!text.includes(BORROWED_CLIENT_ID), `${name} contains librespot's Client ID`);
    for (const [, host] of text.matchAll(SPOTIFY_HOST)) {
      assert.ok(OFFICIAL_HOSTS.has(host.toLowerCase()), `${name} uses the non-official host ${host}`);
    }
  }
});

test('the guard itself recognizes what it forbids', () => {
  assert.match('librespot-core = "=0.8.0"', UNOFFICIAL);
  assert.match('use librespot_connect::Spirc;', UNOFFICIAL);
  assert.doesNotMatch('rspotify = "0.15"', UNOFFICIAL);
  const hosts = [...'https://gew1-spclient.spotify.com/x https://api.spotify.com/v1'.matchAll(SPOTIFY_HOST)].map((m) => m[1]);
  assert.deepEqual(hosts, ['gew1-spclient.spotify.com', 'api.spotify.com']);
});
