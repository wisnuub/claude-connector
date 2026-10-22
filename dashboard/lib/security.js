// Security check results → SECURITY-REPORT.md in the site's Claude Code
// workspace, with instructions for Claude to investigate read-only first and
// change nothing until the user agrees to a plan.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ensureWorkspace, openInVSCode } from './connect.js';

const SEV = { high: 'HIGH', medium: 'MEDIUM', low: 'LOW', info: 'INFO' };

/**
 * A stable key for one warning item. It changes when the item does - a file's
 * date, a matched snippet, an account's details - so a checked item that
 * changes is flagged again.
 */
export const ackKey = (f, i) => crypto.createHash('sha1')
  .update(`${f.title}|${i.path}|${i.detail || ''}|${(i.hits || []).map(h => h.snippet).join('|')}`).digest('hex').slice(0, 16);

/**
 * The scan as you see it: every item carries its ackKey, items you marked
 * checked carry `checked`, a warning whose items are all checked is `checked`
 * and no longer counts, and the summary counts what is left (the scanner's own
 * numbers stay in rawSummary).
 */
export function effectiveScan(scan, acks = {}) {
  if (!scan?.findings) return scan;
  const findings = scan.findings.map(f => {
    const items = (f.items || []).map(i => {
      const key = ackKey(f, i);
      return acks?.[key] ? { ...i, ackKey: key, checked: acks[key] } : { ...i, ackKey: key };
    });
    const done = items.filter(i => i.checked).length;
    // A warning with more items than the scan listed is never fully checked.
    const checked = f.severity !== 'info' && items.length > 0 && done === items.length && (f.count || items.length) <= items.length;
    return { ...f, items, checkedCount: done, checked };
  });
  const summary = { ...(scan.summary || {}) };
  for (const sev of ['high', 'medium', 'low']) summary[sev] = findings.filter(f => f.severity === sev && !f.checked).length;
  return { ...scan, findings, summary, rawSummary: scan.summary };
}
const code = s => '`' + String(s ?? '').replace(/`/g, "'") + '`';

export function reportMarkdown(site, scan) {
  const when = new Date(scan.scanned_at || Date.now()).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
  const s = scan.summary || {};
  const lines = [
    `# Security check - ${site.name} - ${when}`,
    '',
    `Site: ${scan.site || site.url} · WordPress ${scan.wp_version || '?'} · ${s.high || 0} high, ${s.medium || 0} medium, ${s.low || 0} low`,
    '',
    '> **Claude - read this first.** This site may be compromised. The findings below come from the connector\'s read-only',
    '> security check (`wp_security_scan`); they are leads, not proof. This workspace is connected to the site through the',
    '> claude-connector MCP tools.',
    '>',
    '> 1. Run `wp_security_scan` again for current results, and `wp_status` / `wp_maintenance_overview` for versions.',
    '> 2. Open every flagged file with `wp_files_read` (and list folders with `wp_files_list`). Decide for each whether it',
    '>    is malicious, legitimate, or unclear, and say why. Premium plugins sometimes obfuscate code legitimately.',
    '>    Outside wp-content (site root, wp-admin, wp-includes), list folders and read files with `wp_site_files`: a file',
    '>    that is not part of WordPress comes back with its content and malware-pattern hits. For a core file,',
    '>    `wp_core_file_diff` shows exactly what differs from the official file. Modified or missing core files are',
    '>    restored with `wp_reinstall_core` (reinstalls the same WordPress version from wordpress.org - root, wp-admin and',
    '>    wp-includes; plugins, themes and uploads are not touched). It does',
    '>    not remove ADDED files - use `wp_quarantine_file` for those. If some core files cannot be written, its result',
    '>    lists them under `blocked_by` with the owner, permissions and reason - give that list to the user for the host.',
    '>    For an ADDED file that is not part of WordPress (a planted file in the root, wp-admin, wp-includes, or anywhere',
    '>    the file tools cannot reach), once you have examined it and the user agrees, remove it with `wp_quarantine_file`',
    '>    (several at once with `paths`; each is moved, not deleted, so it can be restored with `wp_quarantine_restore`).',
    '>    Files in wp-content can also be',
    '>    removed with the ordinary file tools.',
    '>    For the site-root .htaccess, `wp_htaccess_review` shows each part and flags injected lines; with the user\'s',
    '>    agreement `wp_htaccess_restore` regenerates WordPress\'s rules, drops the flagged parts and keeps a copy.',
    '> 3. Check the database findings with `wp_db_query` using `readonly: true`.',
    '> 4. Work out how the attacker got in where you can (an outdated plugin, a new admin account, an uploads backdoor).',
    '> 5. Write up what you found and a cleanup plan: what to delete or restore, in what order, and how to close the way',
    '>    in - update or reinstall affected plugins and themes, reinstall WordPress core, remove unknown administrators,',
    '>    reset passwords and rotate the salts in wp-config.php.',
    '>',
    '> **Do not change, delete or deactivate anything until the user has agreed to the plan, and confirm each destructive',
    '> step.** The connector backs up files it overwrites, but deleted files and database changes cannot be undone from here.',
    '> Recommend a full backup (from the host) before cleaning.',
    '',
  ];
  if (scan.stats?.stopped_early) lines.push('_The scan hit its time limit; some folders may not have been checked - run `wp_security_scan` again._', '');
  if (!scan.findings?.some(f => f.severity !== 'info')) lines.push('No warning signs were found. The info items below are for review.', '');
  const checked = (scan.findings || []).reduce((n, f) => n + (f.checkedCount || 0), 0);
  if (checked) lines.push(`_${checked} item${checked === 1 ? '' : 's'} the user already reviewed and marked checked ${checked === 1 ? 'is' : 'are'} left out below._`, '');
  for (const f of scan.findings || []) {
    if (f.checked) continue;
    lines.push(`## [${SEV[f.severity] || f.severity}] ${f.title} (${f.count - (f.checkedCount || 0)})`, '');
    if (f.note) lines.push(f.note, '');
    for (const it of f.items || []) {
      if (it.checked) continue;
      lines.push(`- ${code(it.path)}${it.detail ? ` - ${it.detail}` : ''}`);
      for (const h of it.hits || []) lines.push(`  - ${h.label}, line ${h.line}: ${code(h.snippet)}`);
    }
    if (f.count > (f.items || []).length) lines.push(`- … and ${f.count - f.items.length} more (run \`wp_security_scan\` for the full list)`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Writes the report into the site's workspace and opens it in VS Code. */
export async function openForClaude(site, scan) {
  const dir = await ensureWorkspace(site);
  const file = path.join(dir, 'SECURITY-REPORT.md');
  fs.writeFileSync(file, reportMarkdown(site, scan));
  const opened = await openInVSCode(dir, file);
  return { folder: dir, file, opened };
}
