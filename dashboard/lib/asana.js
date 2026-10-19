// Asana: your task list, which task belongs to which site, the WordPress logins
// written in Asana, and posting each run's results back as a comment.
//
// Auth is a Personal Access Token (Asana → Settings → Apps → Developer apps),
// kept in the macOS Keychain via secrets.js. Logins are read from Asana when
// asked for and never stored by the dashboard.
import { getSecret, setSecret, deleteSecret } from './secrets.js';
import { getSettings, saveSettings, listSites, siteState, patchSiteState, getMeta, patchMeta } from './store.js';
import { summarize } from './log.js';

const BASE = process.env.CC_ASANA_BASE || 'https://app.asana.com/api/1.0';
const TOKEN = 'asana-token';

export class AsanaError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, path, { params, body, token } = {}) {
  token ||= await getSecret(TOKEN);
  if (!token) throw new AsanaError(401, 'Asana is not connected - add a personal access token in Settings.');
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify({ data: body }) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.errors?.map(e => e.message).join('; ') || `HTTP ${res.status}`;
    throw new AsanaError(res.status, res.status === 401 ? `Asana rejected the token (${msg}) - add a new one in Settings.` : `Asana: ${msg}`);
  }
  return json;
}

/** Every page of a list endpoint. */
async function all(path, params) {
  const out = [];
  let offset;
  do {
    const r = await api('GET', path, { params: { ...params, limit: 100, offset } });
    out.push(...(r.data || []));
    offset = r.next_page?.offset;
  } while (offset && out.length < 2000);
  return out;
}

// ── Connection ───────────────────────────────────────────────────────────────

export async function status() {
  const token = await getSecret(TOKEN);
  if (!token) return { connected: false };
  try {
    const me = (await api('GET', '/users/me', { params: { opt_fields: 'name,email,workspaces.name' }, token })).data;
    const s = getSettings().asana;
    return { connected: true, user: { name: me.name, email: me.email }, workspaces: me.workspaces || [], workspace: s.workspace || me.workspaces?.[0]?.gid || null };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

export async function connect(token) {
  token = String(token || '').trim();
  if (!token) throw new AsanaError(400, 'Paste the personal access token.');
  const me = (await api('GET', '/users/me', { params: { opt_fields: 'name,workspaces.name' }, token })).data;
  await setSecret(TOKEN, token);
  const s = getSettings().asana;
  if (!s.workspace || !me.workspaces?.some(w => w.gid === s.workspace)) saveSettings({ asana: { ...s, workspace: me.workspaces?.[0]?.gid || null } });
  return status();
}

export async function disconnect() { await deleteSecret(TOKEN); }

// ── Tasks and sites ──────────────────────────────────────────────────────────

const norm = s => String(s || '').toLowerCase()
  .replace(/^https?:\/\//, '').replace(/^www\./, '')
  .replace(/\.(com|net|org|co|edu|gov|biz|info)(\.[a-z]{2})?(\/.*)?$|\.[a-z]{2}(\/.*)?$/, '')
  .replace(/[^a-z0-9]/g, '');

/** The dashboard site a project name refers to: "Eccentric Engineering" ↔ eccentricengineering.com.au. */
function matchSite(projectName, sites) {
  const p = norm(projectName);
  if (p.length < 3) return null;
  let best = null;
  for (const s of sites) {
    const keys = [norm(s.name), norm(new URL(s.url).hostname)];
    for (const k of keys) {
      if (!k) continue;
      const score = k === p ? 3 : (k.length >= 5 && p.length >= 5 && (k.startsWith(p) || p.startsWith(k))) ? 2 : 0;
      if (score > (best?.score || 0)) best = { site: s, score };
    }
  }
  return best?.site || null;
}

let cache = { at: null, tasks: [] };

/** Your incomplete tasks in the chosen workspace, each with the site it is for. */
export async function myTasks({ refresh = false } = {}) {
  if (!refresh && cache.at && Date.now() - cache.at < 5 * 60_000) return withSites(cache.tasks);
  const ws = getSettings().asana.workspace || (await status()).workspace;
  if (!ws) throw new AsanaError(400, 'Pick an Asana workspace in Settings.');
  const tasks = await all('/tasks', {
    assignee: 'me', workspace: ws, completed_since: 'now',
    opt_fields: 'name,permalink_url,due_on,num_subtasks,modified_at,actual_time_minutes,projects.name,num_likes',
  });
  cache = {
    at: Date.now(),
    tasks: tasks.map(t => ({
      gid: t.gid, name: t.name, url: t.permalink_url, due: t.due_on || null, modified: t.modified_at,
      minutes: t.actual_time_minutes ?? null,
      project: t.projects?.[0] ? { gid: t.projects[0].gid, name: t.projects[0].name } : null,
    })),
  };
  return withSites(cache.tasks);
}

/** Adds the matching site to each task, and links unlinked sites to their maintenance task. */
function withSites(tasks) {
  const sites = listSites();
  const out = tasks.map(t => {
    const linked = sites.find(s => siteState(s.id).asana?.taskGid === t.gid);
    const site = linked || (t.project ? matchSite(t.project.name, sites) : null);
    return { ...t, siteId: site?.id || null, siteName: site?.name || null, linked: !!linked };
  });
  for (const s of sites) {
    if (siteState(s.id).asana?.taskGid) continue;
    // Prefer the "wordpress update" task when a project has several.
    const mine = out.filter(t => t.siteId === s.id);
    const pick = mine.find(t => /wordpress|update/i.test(t.name)) || (mine.length === 1 ? mine[0] : null);
    if (pick) patchSiteState(s.id, { asana: { taskGid: pick.gid, taskName: pick.name, project: pick.project?.name || null, url: pick.url, auto: true } });
  }
  return { at: new Date(cache.at).toISOString(), tasks: out };
}

export function linkTask(siteId, task) {
  patchSiteState(siteId, { asana: task ? { taskGid: task.gid, taskName: task.name, project: task.project?.name || null, url: task.url, auto: false } : null });
}

// ── Logins written in Asana ──────────────────────────────────────────────────

// "U:" / "P:" only with a separator, so ordinary words starting with u/p are not read as labels.
const USER_RE = /^\s*(?:(?:wp[\s-]*)?(?:user(?:name)?|login|un|u\/n|admin(?:\s*user)?|e-?mail)\b\s*[:=\-–]?|u\s*[:=\-–])\s*(.+)$/i;
const PASS_RE = /^\s*(?:(?:wp[\s-]*)?(?:pass(?:word)?|pw|pwd|p\/w)\b\s*[:=\-–]?|p\s*[:=\-–])\s*(.+)$/i;
const URL_RE = /(https?:\/\/[^\s<>"')]+)/i;

/**
 * Pulls username / password pairs (and the login URL near them) out of free
 * text. Handles "User: x" lines, "x / y" on one line after a URL, and the
 * usual spellings; returns them in the order they appear.
 */
export function parseLogins(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.replace(/ /g, ' ').trim());
  const found = [];
  let cur = { url: null, user: null, pass: null };
  const flush = () => {
    if (cur.user && cur.pass) found.push({ ...cur });
    cur = { url: cur.url, user: null, pass: null }; // a URL often heads several logins
  };
  for (const line of lines) {
    if (!line) continue;
    const url = line.match(URL_RE)?.[1]?.replace(/[.,;]+$/, '');
    let u = line.match(USER_RE);
    const p = line.match(PASS_RE);
    // "Login URL: https://…" / "Admin: https://…" is an address, not a username.
    if (url && u && (u[1].includes(url) || /^\s*(?:login|admin|wp)?\s*(?:url|link|site|page|address)\b/i.test(line))) u = null;
    if (url && !u && !p) {
      if (cur.user || cur.pass) flush();
      if (/wp-admin|wp-login|login|admin/i.test(url) || !cur.url) cur.url = url;
      // "https://site/wp-admin  user / pass" on one line
      const rest = line.replace(url, '').trim();
      const pair = rest.match(/^[:\-–]?\s*(\S+)\s*(?:\/|\||,)\s*(\S+)$/);
      if (pair) { cur.user = pair[1]; cur.pass = pair[2]; flush(); }
      continue;
    }
    if (u && !/^(?:e-?mail)\b/i.test(line) || (u && !cur.user)) {
      if (cur.user && cur.pass) flush();
      cur.user = u[1].trim().replace(/^["'`]|["'`]$/g, '');
    }
    if (p) {
      cur.pass = p[1].trim().replace(/^["'`]|["'`]$/g, '');
      if (cur.user) flush();
    }
  }
  flush();
  // Same pair repeated (e.g. in several comments): keep the first.
  const seen = new Set();
  return found.filter(f => { const k = `${f.url}|${f.user}|${f.pass}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Each project keeps its WordPress login in a task called "Login", "Logins",
// "Login detail" or "Login details": username on one line, password on the next.
const LOGIN_TASK_RE = /^\s*log\s*-?\s*ins?(?:\s+details?)?\s*:?\s*$/i;
const LABEL_ONLY_RE = /^\s*(?:wp\s*)?(?:user(?:name)?|login|pass(?:word)?|pw|pwd|u|p)\s*:?\s*$/i;

/** A Login task's description: labelled lines if present, else line 1 / line 2. */
export function parseLoginTask(notes) {
  const labelled = parseLogins(notes);
  if (labelled.length) return labelled;
  let url = null;
  const rest = [];
  for (const raw of String(notes || '').replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\u00a0/g, ' ').trim();
    if (!line || LABEL_ONLY_RE.test(line)) continue;
    const m = line.match(URL_RE);
    if (m && line === m[1]) { url ||= m[1]; continue; } // an address on its own line
    rest.push(line);
  }
  return rest.length >= 2 ? [{ url, user: rest[0], pass: rest[1] }] : [];
}

/** A one-line comment that is a new password: one word, 6+ characters, with a digit or symbol. */
const looksLikePassword = s => !/\s/.test(s) && s.length >= 6 && /[\d\W_]/.test(s) && !URL_RE.test(s);

/**
 * What one description or comment in a Login task says: any of the address,
 * username and password. A single line is a new password for the same
 * username (when it looks like one).
 */
export function parseLoginUpdate(text) {
  const labelled = parseLogins(text);
  if (labelled.length) return labelled[labelled.length - 1];
  let url = null;
  const rest = [];
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\u00a0/g, ' ').trim();
    if (!line || LABEL_ONLY_RE.test(line)) continue;
    const m = line.match(URL_RE);
    if (m && line === m[1]) { url ||= m[1]; continue; }
    rest.push(line);
  }
  if (rest.length >= 2) return { url, user: rest[0], pass: rest[1] };
  if (rest.length === 1 && looksLikePassword(rest[0])) return { url, pass: rest[0], passwordOnly: true };
  return url ? { url } : null;
}

/**
 * A Login task as a history, oldest first: each entry updates the address,
 * username and/or password. Returns every complete login it went through,
 * newest first, each with the address last known.
 *
 * @param {Array<{ text, where }>} entries  description first, then comments oldest → newest
 */
export function loginHistory(entries) {
  const cur = { url: null, user: null, pass: null };
  const states = [];
  for (const e of entries) {
    const u = parseLoginUpdate(e.text);
    if (!u) continue;
    if (u.url) cur.url = u.url;
    if (u.user) cur.user = u.user;
    if (u.pass) cur.pass = u.pass;
    if ((u.user || u.pass) && cur.user && cur.pass) states.push({ ...cur, where: u.passwordOnly ? `${e.where} (new password)` : e.where });
  }
  const seen = new Set();
  return states.reverse()
    .map(st => ({ ...st, url: st.url || cur.url }))
    .filter(st => { const k = `${st.user}|${st.pass}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Looks for the login: first the project's Login task, then the task's own
 * description, the project's description and overview, and the task's
 * comments (newest first). Returns where each was found.
 */
export async function loginsFor(taskGid) {
  const task = (await api('GET', `/tasks/${taskGid}`, { params: { opt_fields: 'name,notes,permalink_url,projects.name,projects.notes,projects.project_brief' } })).data;
  const sources = [];
  for (const p of task.projects || []) {
    try {
      const inProject = await all(`/projects/${p.gid}/tasks`, { opt_fields: 'name,notes,permalink_url' });
      for (const lt of inProject.filter(t => LOGIN_TASK_RE.test(t.name || ''))) {
        const name = lt.name.trim();
        // The login is usually posted as comments - address, username and password,
        // or just a new password when it changes - so read the task as a history.
        const entries = [{ text: lt.notes, where: `“${name}” description` }];
        try {
          const comments = (await all(`/tasks/${lt.gid}/stories`, { opt_fields: 'text,type,created_at,created_by.name' })).filter(c => c.type === 'comment');
          for (const c of comments) {
            entries.push({ text: c.text, where: `“${name}” · ${c.created_by?.name || 'comment'}, ${new Date(c.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}` });
          }
        } catch {}
        const found = loginHistory(entries);
        sources.push({ where: name, logins: found, link: lt.permalink_url });
      }
    } catch {}
  }
  sources.push({ where: 'Task description', text: task.notes });
  for (const p of task.projects || []) {
    sources.push({ where: `Project “${p.name}” description`, text: p.notes });
    if (p.project_brief?.gid) {
      try {
        const brief = (await api('GET', `/project_briefs/${p.project_brief.gid}`, { params: { opt_fields: 'text' } })).data;
        sources.push({ where: `Project “${p.name}” overview`, text: brief.text });
      } catch {}
    }
  }
  try {
    const stories = await all(`/tasks/${taskGid}/stories`, { opt_fields: 'text,type,created_at,created_by.name' });
    for (const st of stories.filter(s => s.type === 'comment').reverse()) {
      sources.push({ where: `Comment by ${st.created_by?.name || 'someone'}, ${new Date(st.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}`, text: st.text });
    }
  } catch {}
  const logins = [];
  for (const src of sources) for (const l of src.logins || parseLogins(src.text)) logins.push({ where: src.where, ...l, ...(src.link ? { link: src.link } : {}) });
  // Dedupe across sources (the same pair often sits in several places).
  const seen = new Set();
  const unique = logins.filter(l => { const k = `${l.user}|${l.pass}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const project = task.projects?.[0] || null;
  return {
    task: { gid: task.gid, name: task.name, url: task.permalink_url, project: project?.name || null, projectGid: project?.gid || null },
    logins: unique,
    // The address typed in last time for this project, when the login itself has none.
    siteUrl: project ? (getMeta().asanaSiteUrls || {})[project.gid] || null : null,
  };
}

/** Remembers the site address for a project whose login has none. */
export function rememberSiteUrl(projectGid, url) {
  if (!projectGid) return;
  patchMeta({ asanaSiteUrls: { ...(getMeta().asanaSiteUrls || {}), [projectGid]: url } });
}

// ── Posting results back ─────────────────────────────────────────────────────

const x = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A run's log as an Asana comment (only the tags Asana allows in comments). */
export function commentHtml(record) {
  const sum = summarize(record);
  const when = new Date(record.at).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
  const list = (title, steps) => steps.length
    ? `<strong>${x(title)}</strong><ul>${steps.map(s => `<li>${x(s.label)}${s.detail && title !== 'Updated' ? ` - ${x(String(s.detail).split('\n')[0].slice(0, 300))}` : ''}</li>`).join('')}</ul>` : '';
  const form = (record.steps || []).find(s => s.meta?.kind === 'form');
  const health = [...(record.steps || [])].reverse().find(s => s.meta?.kind === 'health');
  return `<body><strong>${x(record.title)} - ${x(when)}</strong> (${x(String(record.status).toUpperCase())})\n`
    + list('Updated', sum.updated) + list('Not done', sum.notdone) + list('Failed', sum.failed) + list('Check', sum.notice)
    + (!sum.updated.length && !sum.notdone.length && !sum.failed.length ? 'Nothing to update.\n' : '')
    + (health ? `${x(health.label)}\n` : '') + (form ? `${x(form.label)}\n` : '')
    + '<em>Posted by the Claude Connector maintenance dashboard</em></body>';
}

/**
 * After a run on a site: comment on its linked task, and optionally add the
 * time to Actual time. Returns what happened, for the run's log.
 */
export async function postResults(siteId, record, durationMs) {
  const s = getSettings().asana;
  const link = siteState(siteId).asana;
  if (!s.postResults || !link?.taskGid || !(await getSecret(TOKEN))) return null;
  await api('POST', `/tasks/${link.taskGid}/stories`, { body: { html_text: commentHtml(record) } });
  let time = null;
  if (s.logTime && durationMs > 0) {
    try {
      await api('POST', `/tasks/${link.taskGid}/time_tracking_entries`, { body: { duration_minutes: Math.max(1, Math.round(durationMs / 60000)) } });
      time = Math.max(1, Math.round(durationMs / 60000));
    } catch (e) {
      time = e.status === 402 ? 'not available on this Asana plan' : e.message;
    }
  }
  return { task: link.taskName, project: link.project, url: link.url, time };
}
