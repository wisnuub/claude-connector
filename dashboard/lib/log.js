// The maintenance log: what each run updated, what it did not do and why, and
// what failed. Kept in history.json (for the Log view) and as plain monthly
// text files in data/logs/ that can be read or sent on without the dashboard.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { DATA_DIR } from './store.js';

export const LOG_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

/**
 * Sorts one step into a log category.
 *  updated  - an update or install that went in
 *  notdone  - something there was to do that was not done (licence, PHP, major core, run stopped)
 *  failed   - an update that failed or was rolled back, a broken site, a failed form test
 *  notice   - worth a look but not a failure (site could not be checked from inside, captcha)
 *  info     - everything else (checks, up-to-date items, form sent)
 */
export function classify(step) {
  const m = step.meta || {};
  // Entries from before steps carried meta: an "x 1.0 → 2.0" line that went fine was an update.
  if (!step.meta && step.status === 'ok' && /\S \S+ → \S+$/.test(step.label)) return 'updated';
  if (!step.meta && step.status === 'warning' && /- skipped$|- skipped \(/.test(step.label)) return 'notdone';
  if (m.result === 'updated') return 'updated';
  if (m.result === 'skipped') return 'notdone';
  if (m.result === 'failed' || step.status === 'failed') return 'failed';
  if (step.status === 'warning') return 'notice';
  return 'info';
}

export function summarize(entry) {
  const out = { updated: [], notdone: [], failed: [], notice: [], info: [] };
  for (const s of entry.steps || []) out[classify(s)].push(s);
  return out;
}

const pad = n => String(n).padStart(2, '0');
function stamp(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One block per site per job, appended to data/logs/maintenance-YYYY-MM.log. */
export function appendTextLog(entry) {
  const sum = summarize(entry);
  const lines = [`${stamp(entry.at)}  ${entry.siteName}  -  ${entry.title}  -  ${String(entry.status).toUpperCase()}${entry.summary ? `  (${entry.summary})` : ''}`];
  const add = (tag, steps) => {
    for (const s of steps) {
      lines.push(`    ${tag.padEnd(9)}${s.label}`);
      if (s.detail && tag !== 'UPDATED') lines.push(`             ${String(s.detail).split('\n')[0].slice(0, 300)}`);
    }
  };
  add('UPDATED', sum.updated);
  add('NOT DONE', sum.notdone);
  add('FAILED', sum.failed);
  add('NOTICE', sum.notice);
  const d = new Date(entry.at);
  const file = path.join(LOG_DIR, `maintenance-${d.getFullYear()}-${pad(d.getMonth() + 1)}.log`);
  try { fs.appendFileSync(file, lines.join('\n') + '\n\n'); } catch {}
}

const asText = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** macOS banner notification; silently does nothing elsewhere. */
export function notify(title, message) {
  if (process.platform !== 'darwin') return;
  execFile('osascript', ['-e', `display notification ${asText(message.slice(0, 220))} with title ${asText(title)} sound name "Basso"`], () => {});
}
