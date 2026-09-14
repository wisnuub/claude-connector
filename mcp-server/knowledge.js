import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const REPO           = 'wisnuub/claude-connector';
const KNOWLEDGE_PATH = 'KNOWLEDGE.md';
const RAW_URL        = `https://raw.githubusercontent.com/${REPO}/main/${KNOWLEDGE_PATH}`;
const BUFFER_FILE    = path.join(__dirname, 'knowledge-buffer.json');

// Category slugs (used in tool args / dedup / buffering) don't all match their
// markdown heading text 1:1 (e.g. "hosting-waf" -> "Hosting & WAF"), so both
// directions go through this table rather than deriving one from the other.
const CATEGORY_HEADINGS = {
  'elementor':        'Elementor',
  'divi':             'Divi',
  'acf':              'ACF',
  'hosting-waf':      'Hosting & WAF',
  'wp-cli-database':  'WP-CLI & Database',
  'general':          'General',
};
const CATEGORIES = Object.keys(CATEGORY_HEADINGS);
const HEADING_TO_CATEGORY = Object.fromEntries(
  Object.entries(CATEGORY_HEADINGS).map(([slug, heading]) => [heading.toLowerCase(), slug])
);

// ── gh CLI helpers ───────────────────────────────────────────────────────────

async function gh(args) {
  try {
    const { stdout } = await execFileAsync('gh', args, { timeout: 15_000 });
    return { ok: true, stdout: stdout.trim() };
  } catch (err) {
    return { ok: false, notInstalled: err.code === 'ENOENT', error: err.message };
  }
}

async function ghStatus() {
  const authed = await gh(['auth', 'status']);
  if (!authed.ok) {
    return { installed: !authed.notInstalled, authenticated: false, canPush: false };
  }
  const perm = await gh(['api', `repos/${REPO}`, '--jq', '.permissions.push']);
  return { installed: true, authenticated: true, canPush: perm.ok && perm.stdout === 'true' };
}

// ── Reading (public repo, no auth needed) ────────────────────────────────────

async function readKnowledgeText() {
  const res = await fetch(RAW_URL);
  return res.ok ? await res.text() : '';
}

function parseEntries(md) {
  let category = 'general';
  const entries = [];
  for (const line of md.split('\n')) {
    const heading = line.match(/^##\s+(.*)/);
    if (heading) {
      const title = heading[1].trim().toLowerCase();
      category = HEADING_TO_CATEGORY[title] || title;
      continue;
    }
    const m = line.match(/^- \*\*Symptom:\*\*\s*(.*?)\s*\*\*Fix:\*\*\s*(.*?)(?:\s*\*\*Why:\*\*\s*(.*))?$/);
    if (m) entries.push({ category, symptom: m[1], fix: m[2], why: m[3] || '' });
  }
  return entries;
}

export async function searchKnowledge(query, category) {
  const entries = parseEntries(await readKnowledgeText());
  const q = query.toLowerCase();
  return entries.filter(e =>
    (!category || e.category === category.toLowerCase()) &&
    (e.symptom.toLowerCase().includes(q) || e.fix.toLowerCase().includes(q) || e.why.toLowerCase().includes(q))
  );
}

function normalize(s) {
  // Underscores/hyphens become spaces before stripping other punctuation, so
  // WP-style identifiers (_elementor_data) line up with prose mentioning them
  // ("elementor data") instead of collapsing into one unmatched word.
  return s.toLowerCase().replace(/[_-]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function isDuplicate(entries, entry) {
  const ns = normalize(entry.symptom);
  return entries.some(e =>
    e.category === entry.category.toLowerCase() &&
    (normalize(e.symptom) === ns || normalize(e.symptom).includes(ns) || ns.includes(normalize(e.symptom)))
  );
}

// ── Direct-commit path (maintainer, has push access) ─────────────────────────

function formatEntryLine(entry) {
  const why = entry.why ? ` **Why:** ${entry.why}` : '';
  return `- **Symptom:** ${entry.symptom} **Fix:** ${entry.fix}${why}`;
}

function insertEntry(text, entry) {
  const headingTitle = CATEGORY_HEADINGS[entry.category] || entry.category;
  const heading = `## ${headingTitle}`;
  const lines = text.split('\n');
  const idx = lines.findIndex(l => l.trim().toLowerCase() === heading.toLowerCase());
  const line = formatEntryLine(entry);

  if (idx === -1) {
    return text.replace(/\n*$/, '') + `\n\n${heading}\n\n${line}\n`;
  }
  let insertAt = idx + 1;
  while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
  lines.splice(insertAt, 0, line);
  return lines.join('\n');
}

async function commitEntry(entry) {
  const getRes = await gh(['api', `repos/${REPO}/contents/${KNOWLEDGE_PATH}`]);
  if (!getRes.ok) return { ok: false, error: getRes.error };

  let meta;
  try { meta = JSON.parse(getRes.stdout); } catch { return { ok: false, error: 'Could not parse KNOWLEDGE.md metadata.' }; }

  const currentText = Buffer.from(meta.content, 'base64').toString('utf8');
  const updatedText = insertEntry(currentText, entry);
  const b64 = Buffer.from(updatedText, 'utf8').toString('base64');

  // Content is written to a temp file and read via -f content=@path rather than
  // passed inline, since a growing KNOWLEDGE.md will eventually exceed the OS
  // command-line length limit if base64-encoded straight into an argv entry.
  const tmpFile = path.join(os.tmpdir(), `claude-connector-knowledge-${Date.now()}.b64`);
  fs.writeFileSync(tmpFile, b64);
  try {
    const put = await gh(['api', `repos/${REPO}/contents/${KNOWLEDGE_PATH}`, '-X', 'PUT',
      '-f', `message=knowledge: ${entry.category} - ${entry.symptom.slice(0, 60)}`,
      '-f', `content=@${tmpFile}`,
      '-f', `sha=${meta.sha}`]);
    return put.ok ? { ok: true } : { ok: false, error: put.error };
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

// ── Buffered daily-issue path (non-maintainer contributors) ──────────────────

function loadBuffer() {
  try { return JSON.parse(fs.readFileSync(BUFFER_FILE, 'utf8')); }
  catch { return { lastFlush: null, pending: [] }; }
}

function saveBuffer(buf) {
  fs.writeFileSync(BUFFER_FILE, JSON.stringify(buf, null, 2));
}

async function bufferAndMaybeFlush(entry) {
  const buf = loadBuffer();
  buf.pending.push({ ...entry, addedAt: new Date().toISOString() });

  const today = new Date().toISOString().slice(0, 10);
  if (buf.lastFlush === today || buf.pending.length === 0) {
    saveBuffer(buf);
    return false;
  }

  const body = buf.pending.map(e =>
    `- **${e.category}** — Symptom: ${e.symptom} Fix: ${e.fix}${e.why ? ' Why: ' + e.why : ''}`
  ).join('\n');
  const title = `Findings from claude-connector — ${today} (${buf.pending.length})`;

  const res = await gh(['issue', 'create', '--repo', REPO, '--title', title, '--body', body]);
  if (res.ok) {
    buf.pending = [];
    buf.lastFlush = today;
  }
  saveBuffer(buf);
  return res.ok;
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function addKnowledge({ category, symptom, fix, why }) {
  if (!CATEGORIES.includes(category)) {
    return { status: 'invalid_category', message: `category must be one of: ${CATEGORIES.join(', ')}` };
  }
  const entry = { category, symptom, fix, why };
  const existing = parseEntries(await readKnowledgeText());
  if (isDuplicate(existing, entry)) {
    return { status: 'duplicate', message: 'A similar entry already exists in the knowledge base.' };
  }

  const status = await ghStatus();

  if (!status.installed) {
    loadBufferAndSave(entry);
    return { status: 'no_gh_cli', message: 'The GitHub CLI (gh) is not installed, so this could not be shared. Saved locally for now.' };
  }
  if (!status.authenticated) {
    loadBufferAndSave(entry);
    return {
      status: 'not_authenticated',
      message: "You're not logged into the GitHub CLI. Run `gh auth login` if you'd like fixes like this "
        + "shared with the claude-connector maintainer — this one is saved locally until then.",
    };
  }
  if (status.canPush) {
    const res = await commitEntry(entry);
    return res.ok
      ? { status: 'committed', message: 'Recorded directly to KNOWLEDGE.md.' }
      : { status: 'error', message: res.error };
  }

  const flushed = await bufferAndMaybeFlush(entry);
  return flushed
    ? { status: 'issue_opened', message: 'Opened a GitHub issue with today\'s findings, including this one.' }
    : { status: 'buffered', message: 'Saved locally — will be shared as a GitHub issue at most once per day.' };
}

function loadBufferAndSave(entry) {
  const buf = loadBuffer();
  buf.pending.push({ ...entry, addedAt: new Date().toISOString() });
  saveBuffer(buf);
}
