// The dashboard's one npm dependency, playwright-core (form tests and Log in),
// installed by the dashboard itself when it is missing - a fresh checkout then
// works with just `npm start` or `node server.js`, no separate `npm install`.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WIN = process.platform === 'win32';
let installing = null;

export function depsMissing() {
  return !fs.existsSync(path.join(ROOT, 'node_modules', 'playwright-core', 'package.json'));
}

function npm(args) {
  return new Promise((resolve, reject) => {
    // npm is a .cmd file on Windows (needs a shell); launchd starts us with a bare PATH, so look next to node.
    const p = WIN
      ? spawn(['npm', ...args].join(' '), { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('npm', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin'].join(':') } });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `npm exited with ${code}`))));
  });
}

/** Installs the dependencies once if they are missing; later callers wait for the same install. */
export function ensureDeps() {
  if (!depsMissing()) return Promise.resolve();
  if (!installing) {
    console.log('Installing the dashboard\'s dependencies (playwright-core) - first start only…');
    const quiet = ['--omit=dev', '--no-audit', '--no-fund', '--silent'];
    // The lockfile pins the version; if it does not match package.json, install without rewriting it.
    installing = npm(['ci', ...quiet])
      .catch(() => npm(['install', '--no-package-lock', ...quiet]))
      .then(() => {
        if (depsMissing()) throw new Error('npm finished but playwright-core is still missing');
        console.log('Dependencies installed.');
      })
      .catch(e => { installing = null; throw e; }); // let the next use try again
  }
  return installing;
}

/** playwright-core for `feature`, installing it first when needed. */
export async function importPlaywright(feature) {
  try { return await import('playwright-core'); } catch {}
  try { await ensureDeps(); }
  catch (e) { throw new Error(`${feature} needs playwright-core, and installing it failed (${e.message}). In the dashboard folder run: npm install`); }
  return import('playwright-core');
}
