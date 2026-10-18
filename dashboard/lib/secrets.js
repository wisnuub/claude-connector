// Small secrets store: the macOS Keychain where available (encrypted, locked
// with the login password), otherwise a 0600 file in data/. Used for the Asana
// access token - never written to settings.json or sent to the browser.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { DATA_DIR } from './store.js';

const SERVICE = 'Claude Connector Dashboard';
const FILE = path.join(DATA_DIR, 'secrets.json');
const mac = process.platform === 'darwin' && !process.env.CC_NO_KEYCHAIN;

const sec = args => new Promise(resolve => {
  execFile('security', args, { timeout: 10_000 }, (err, stdout) => resolve(err ? null : stdout));
});

function readFile() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }

export async function getSecret(name) {
  if (mac) {
    const out = await sec(['find-generic-password', '-a', name, '-s', SERVICE, '-w']);
    return out ? out.replace(/\n$/, '') : null;
  }
  return readFile()[name] ?? null;
}

export async function setSecret(name, value) {
  if (mac) {
    // -U updates an existing item instead of failing on a duplicate.
    const ok = await sec(['add-generic-password', '-a', name, '-s', SERVICE, '-w', value, '-U']);
    if (ok === null) throw new Error('Could not save to the macOS Keychain.');
    return;
  }
  const all = readFile();
  all[name] = value;
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

export async function deleteSecret(name) {
  if (mac) { await sec(['delete-generic-password', '-a', name, '-s', SERVICE]); return; }
  const all = readFile();
  delete all[name];
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}
