// Site Maintenance dashboard UI. Plain DOM, no build step.

const S = {
  version: '',
  editUrl: null,            // site id whose address is being edited inline
  urlDraft: '',
  sites: [],
  settings: null,
  jobs: new Map(),
  open: new Set(),          // expanded site ids
  tab: {},                  // site id -> tab
  selected: new Set(),      // selected site ids
  pluginSel: {},            // site id -> Set(plugin files)
  search: {},               // site id -> { q, results, busy }
  history: {},              // site id -> entries
  openJobs: new Set(),
  collapsed: new Set(),     // collapsed agency groups
  filter: 'all',
  agency: 'all',
  q: '',
  drawerMin: true,
  schedule: null,           // { next, sites, last }
  failures: [],             // sites whose last run failed, until dismissed
  newSites: new Set(),      // found in ~/claude-sites since the dashboard started
  view: 'sites',
  log: null,                // { days, entries }
  logDays: 30,
  logShow: 'problems',
  logDir: '',
  asana: null,              // { connected, user, workspaces, workspace }
  tasks: null,              // { at, tasks }
  tasksQ: '',
  tasksShow: 'all',
  showDone: false,          // Tasks: also show WordPress update tasks already done this month
  logins: {},               // task gid -> { busy, error, logins, task }
  drafts: {},               // site id -> { text, basedOn, pending } for the Asana comment
  taskStatus: {},           // site id -> { completed, completedAt, completedBy, lastComment, lastDoneComment }
  reveal: new Set(),        // "gid|i" of shown passwords
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const $ = (sel, el = document) => el.querySelector(sel);
const h = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CC-Dashboard': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
  return d;
}

let toastTimer;
function toast(msg) {
  let el = $('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.append(el); }
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 4000);
}

function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

// PHP end-of-life dates (php.net/supported-versions). Past = unsupported;
// within 6 months = plan the upgrade.
const PHP_EOL = { '7.0': '2019-01-10', '7.1': '2019-12-01', '7.2': '2020-11-30', '7.3': '2021-12-06', '7.4': '2022-11-28', '8.0': '2023-11-26', '8.1': '2025-12-31', '8.2': '2026-12-31', '8.3': '2027-12-31', '8.4': '2028-12-31', '8.5': '2029-12-31' };
function phpInfo(v) {
  if (!v) return null;
  const branch = v.split('.').slice(0, 2).join('.');
  const eol = PHP_EOL[branch];
  if (!eol) return { cls: parseFloat(branch) < 7 ? 'bad' : 'ok', text: branch, title: `PHP ${v}` };
  const left = (new Date(eol) - Date.now()) / 86400000;
  if (left < 0) return { cls: 'bad', text: branch, title: `PHP ${v} - no longer supported since ${eol}` };
  if (left < 183) return { cls: 'warn', text: branch, title: `PHP ${v} - security support ends ${eol}` };
  return { cls: 'ok', text: branch, title: `PHP ${v} - supported until ${eol}` };
}

const agencies = () => S.settings?.agencies || [];
const agencyOf = site => agencies().find(a => a.id === site.agencyId) || agencies().find(a => a.id === S.settings.defaultAgency) || agencies()[0];

const isHeld = (site, key) => (site.held || []).includes(key);

function counts(site) {
  const ov = site.overview;
  if (!ov) return { plugins: 0, themes: 0, core: 0, translations: 0, total: 0, held: 0 };
  const plugins = ov.plugins.filter(p => p.update && !isHeld(site, `plugin:${p.file}`)).length;
  const themes = ov.themes.filter(t => t.update && !isHeld(site, `theme:${t.stylesheet}`)).length;
  const core = (ov.core.minor || ov.core.major) && !isHeld(site, 'core') ? 1 : 0;
  const translations = ov.translations > 0 && !isHeld(site, 'translations') ? 1 : 0;
  return { plugins, themes, core, translations, total: plugins + themes + core + translations, held: (site.held || []).length };
}

// ── Review before "Update everything" ────────────────────────────────────────

let reviewIds = [];

/** Everything a run would update on a site, as review rows. */
function reviewItems(site) {
  const ov = site.overview;
  if (!ov) return null;
  const rows = [];
  const blockReason = u => (u.php_ok === false ? `needs PHP ${u.requires_php}` : u.package === false ? 'needs a licence key' : null);
  for (const p of ov.plugins.filter(p => p.update)) rows.push({ key: `plugin:${p.file}`, kind: 'Plugin', name: p.name, from: p.version, to: p.update.version, blocked: blockReason(p.update), self: p.self });
  for (const t of ov.themes.filter(t => t.update)) rows.push({ key: `theme:${t.stylesheet}`, kind: 'Theme', name: t.name, from: t.version, to: t.update.version, blocked: blockReason(t.update) });
  if (ov.core.minor || ov.core.major) rows.push({ key: 'core', kind: 'Core', name: 'WordPress', from: ov.core.version, to: ov.core.minor?.version || ov.core.major.version, major: !ov.core.minor, majorTo: ov.core.major?.version });
  if (ov.translations > 0) rows.push({ key: 'translations', kind: 'Translations', name: `${ov.translations} translation update${ov.translations === 1 ? '' : 's'}`, from: '', to: '' });
  return rows;
}

function renderReview({ fresh = false } = {}) {
  const f = $('#form-review');
  // Redraws (Hold, the major-updates box) must not undo the user's ticks.
  // Only ticks the user could change count - a just-released item comes back ticked.
  const keep = fresh ? new Map() : new Map([...document.querySelectorAll('#review-body input[data-rv]:not(:disabled)')].map(b => [`${b.dataset.rv}|${b.dataset.key}`, b.checked]));
  const keepInc = fresh ? new Map() : new Map([...document.querySelectorAll('#review-body input[data-rv-include]')].map(b => [b.dataset.rvInclude, b.checked]));
  const major = f.elements.allowMajorCore.checked;
  const sites = reviewIds.map(id => S.sites.find(s => s.id === id)).filter(Boolean);
  $('#review-body').innerHTML = sites.map(site => {
    const rows = reviewItems(site);
    // Handle with care: included only when ticked, unless it is the only site being updated.
    const include = site.careful ? keepInc.get(site.id) ?? sites.length === 1 : true;
    const careful = site.careful ? `<div class="notice warn" style="margin:4px 0 6px"><label class="check"><input type="checkbox" data-rv-include="${h(site.id)}" ${include ? 'checked' : ''}> <span><b>Handle with care</b>${site.careful.note ? ` - ${h(site.careful.note)}` : ''}${sites.length > 1 ? ' - tick to include this site' : ''}</span></label></div>` : '';
    const head = `<div class="rv-h"><b>${h(site.name)}</b>${rows?.length && include ? `<button type="button" class="btn sm ghost" data-action="rv-all" data-site="${h(site.id)}">All</button><button type="button" class="btn sm ghost" data-action="rv-none" data-site="${h(site.id)}">None</button>` : ''}</div>${careful}`;
    if (!include) return `<div class="rv">${head}<p class="hint">Left out of this run.</p></div>`;
    const woo = site.overview?.woocommerce;
    const wooRisk = r => woo?.overrides && (r.key === 'plugin:woocommerce/woocommerce.php' || (r.key.startsWith('theme:') && site.overview.themes.some(t => `theme:${t.stylesheet}` === r.key && (t.active || t.in_use))));
    if (!rows) return `<div class="rv">${head}<p class="hint">Not checked yet - everything found when the run starts will be updated.</p></div>`;
    if (!rows.length) return `<div class="rv">${head}<p class="hint">Up to date - the run will only check health${f.elements.formTest.value !== 'off' ? ' and the form' : ''}.</p></div>`;
    return `<div class="rv">${head}<ul class="rv-list">${rows.map(r => {
      const held = isHeld(site, r.key);
      const majorOnly = r.key === 'core' && r.major && !major;
      const disabled = !!r.blocked || held || majorOnly;
      const to = r.key === 'core' && major && r.majorTo ? r.majorTo : r.to;
      const note = (held ? '<span class="tag accent">held</span>' : r.blocked ? `<span class="tag warn">${h(r.blocked)}</span>` : majorOnly ? '<span class="tag">major - tick "Include major WordPress updates"</span>' : '')
        + (wooRisk(r) ? ` <span class="tag warn" title="The theme overrides WooCommerce templates. The shop, cart and checkout are loaded after this update and it is rolled back if they break.">theme overrides ${woo.overrides} Woo template${woo.overrides === 1 ? '' : 's'}${woo.outdated ? `, ${woo.outdated} outdated` : ''}</span>` : '');
      return `<li class="${disabled ? 'off' : ''}">
        <label class="check"><input type="checkbox" data-rv="${h(site.id)}" data-key="${h(r.key)}" ${disabled ? 'disabled' : keep.get(`${site.id}|${r.key}`) === false ? '' : 'checked'}>
          <span><span class="faint">${h(r.kind)}</span> ${h(r.name)}${r.from || to ? ` <span class="muted">${h(r.from)} → <b class="ver-arrow">${h(to)}</b></span>` : ''} ${note}${r.self ? ' <span class="faint">(runs last)</span>' : ''}</span></label>
        ${r.blocked ? '' : `<button type="button" class="btn sm ghost" data-action="rv-hold" data-site="${h(site.id)}" data-key="${h(r.key)}" title="${held ? 'Allow updates again' : 'Keep this version on this site - skipped on every run until released'}">${held ? 'Release' : 'Hold'}</button>`}
      </li>`;
    }).join('')}</ul></div>`;
  }).join('');
  updateReviewCount();
}

/** The review's sites minus "Handle with care" ones left unticked. */
function reviewSites() {
  const left = new Set([...document.querySelectorAll('#review-body input[data-rv-include]')].filter(b => !b.checked).map(b => b.dataset.rvInclude));
  return reviewIds.filter(id => !left.has(id));
}

function updateReviewCount() {
  const boxes = [...document.querySelectorAll('#review-body input[data-rv]')];
  const n = boxes.filter(b => b.checked).length;
  const ids = reviewSites();
  const unchecked = ids.filter(id => !S.sites.find(s => s.id === id)?.overview).length;
  const btn = $('#form-review [data-action=run-review]');
  btn.textContent = `Update ${n} item${n === 1 ? '' : 's'}${unchecked ? ` + ${unchecked} unchecked site${unchecked === 1 ? '' : 's'}` : ''} on ${ids.length} site${ids.length === 1 ? '' : 's'}`;
  btn.disabled = !ids.length;
}

function openReview(ids, title) {
  reviewIds = ids;
  const f = $('#form-review');
  f.elements.formTest.value = S.settings.formTestMode;
  f.elements.allowMajorCore.checked = !!S.settings.allowMajorCore;
  $('[data-title]', f).textContent = title || `Update everything on ${ids.length} site${ids.length === 1 ? '' : 's'}`;
  renderReview({ fresh: true });
  $('#dlg-review').showModal();
}

function issue(site) {
  if (site.overviewError) return 'bad';
  if (site.security?.summary?.high) return 'bad';
  if (site.health?.status === 'fatal' || site.lastRun?.status === 'failed' || ['failed', 'error', 'mail_failed'].includes(site.formTest?.status)) return 'bad';
  if (site.health?.status === 'warning' || site.lastRun?.status === 'warning' || site.overview?.stuck_maintenance) return 'warn';
  return null;
}

/** The step currently running on a site, if any job is working on it. */
function running(siteId) {
  for (const j of S.jobs.values()) {
    const e = j.sites?.[siteId];
    if (e && (e.status === 'running' || e.status === 'queued') && j.status === 'running') {
      const last = e.steps[e.steps.length - 1];
      return { job: j, entry: e, label: e.status === 'queued' ? `Queued: ${j.title}` : last?.label || j.title };
    }
  }
  return null;
}

function visibleSites() {
  const q = S.q.toLowerCase();
  return S.sites.filter(s => !s.hidden).filter(s => {
    if (q && !`${s.name} ${s.url}`.toLowerCase().includes(q)) return false;
    if (S.agency !== 'all' && agencyOf(s)?.id !== S.agency) return false;
    if (S.filter === 'updates' && !counts(s).total) return false;
    if (S.filter === 'issues' && !issue(s)) return false;
    if (S.filter === 'asana' && !asanaTodo().has(s.id)) return false;
    return true;
  });
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderStats() {
  const sites = S.sites.filter(s => !s.hidden);
  const upd = sites.reduce((n, s) => n + counts(s).total, 0);
  const withUpd = sites.filter(s => counts(s).total).length;
  const bad = sites.filter(s => issue(s) === 'bad').length;
  const warn = sites.filter(s => issue(s) === 'warn').length;
  const unchecked = sites.filter(s => !s.overview && !s.overviewError).length;
  $('#stats').innerHTML = `
    <span><b>${sites.length}</b> sites</span>
    <span class="${upd ? 'warn' : ''}"><b>${upd}</b> updates on ${withUpd} sites</span>
    <span class="${bad ? 'bad' : ''}"><b>${bad}</b> need attention</span>
    ${warn ? `<span class="warn"><b>${warn}</b> warnings</span>` : ''}
    ${unchecked ? `<span><b>${unchecked}</b> not checked yet</span>` : ''}`;
  $('#ver').textContent = S.version ? ` v${S.version}` : '';
}

function renderToolbar() {
  const vis = visibleSites();
  const n = [...S.selected].filter(id => S.sites.some(s => s.id === id && !s.hidden)).length;
  const allSel = vis.length && vis.every(s => S.selected.has(s.id));
  const dis = n ? '' : 'disabled';
  const focused = document.activeElement?.id === 'q';
  $('#toolbar').innerHTML = `
    <input type="checkbox" data-action="select-all" ${allSel ? 'checked' : ''} aria-label="Select all shown sites">
    <span class="count">${n ? `${n} selected` : `${vis.length} shown`}</span>
    <button class="btn sm" data-action="bulk-check" ${dis} title="Read-only: updates, health, security and Divi forms - changes nothing">${ICON.refresh}Check everything</button>
    <button class="btn primary sm" data-action="bulk-maintain" ${dis}>${ICON.download}Update everything</button>
    <span class="sep"></span>
    <button class="btn sm" data-action="bulk-form" ${dis}>Form test now</button>
    <button class="btn sm" data-action="bulk-queue" ${dis} title="Add to the morning form-test run">Queue form test</button>
    <button class="btn sm" data-action="bulk-plugin" ${dis}>Plugin…</button>
    <button class="btn sm" data-action="bulk-agency" ${dis}>Agency…</button>
    <button class="btn sm" data-action="bulk-security" ${dis}>Security check</button>
    <button class="btn sm" data-action="bulk-divi" ${dis}>Check Divi forms</button>
    <span class="grow"></span>
    ${scheduleChip()}
    ${agencies().length > 1 ? `<select data-action="agency-filter" aria-label="Agency">
      <option value="all">All agencies</option>
      ${agencies().map(a => `<option value="${h(a.id)}" ${S.agency === a.id ? 'selected' : ''}>${h(a.label)}</option>`).join('')}
    </select>` : ''}
    <div class="seg" role="group" aria-label="Filter">
      ${[['all', 'All'], ['updates', 'Updates'], ['issues', 'Issues'], ...(S.asana?.connected ? [['asana', `Asana to-do${S.tasks?.tasks ? ` (${asanaTodo().size})` : ''}`]] : [])].map(([k, l]) => `<button data-action="filter" data-v="${k}" class="${S.filter === k ? 'on' : ''}" ${k === 'asana' ? 'title="Sites whose “WordPress update” task is still open in Asana - each drops off once it is ticked complete there, or once you comment that the updates are done"' : ''}>${l}</button>`).join('')}
    </div>
    <input type="search" id="q" placeholder="Search sites" value="${h(S.q)}" data-action="search-sites">`;
  if (focused) { const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

function scheduleChip() {
  const sc = S.settings?.schedule;
  const info = S.schedule;
  if (!sc || !info) return '';
  const queued = S.sites.filter(s => !s.hidden && s.formTestQueued).length;
  const when = info.next ? new Date(info.next).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  const label = sc.enabled
    ? `Morning test: ${sc.what === 'all' ? 'all sites' : `${queued} queued`}${when ? ` · ${when}` : ''}`
    : `${queued} form test${queued === 1 ? '' : 's'} queued · schedule off`;
  if (!sc.enabled && !queued) return '';
  return `<button type="button" class="pill ${sc.enabled ? 'accent' : 'warn'} pill-btn" data-action="open-queue" title="See and manage the queue and the schedule">${h(label)} ›</button>`;
}

/** The form test queue: which sites wait for the morning run, with Run now / Remove, and the schedule. */
function renderQueue() {
  const sc = S.settings?.schedule || {};
  const info = S.schedule || {};
  const queued = S.sites.filter(s => !s.hidden && s.formTestQueued).sort((a, b) => a.formTestQueued.localeCompare(b.formTestQueued));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const when = info.next ? new Date(info.next).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  $('#queue-body').innerHTML = `
    <div class="notice ${sc.enabled ? '' : 'warn'}" style="margin:0 0 10px">
      ${sc.enabled
        ? `<b>Schedule on</b> - ${sc.what === 'all' ? 'every site' : 'the queued sites'} at ${h(sc.time || '')} on ${h((sc.days || []).map(d => days[d]).join(', ') || 'no days')}${when ? `. Next run: <b>${h(when)}</b>` : ''}.`
        : '<b>Schedule off</b> - queued tests only run when you press Run now.'}
      ${info.last ? `<br><span class="muted">Last scheduled run: ${h(new Date(info.last.at).toLocaleString())} - ${h(info.last.sites)} site(s)${info.last.note ? ` (${h(info.last.note)})` : ''}</span>` : ''}
      <br><a href="#" data-action="queue-settings">${sc.enabled ? 'Change or turn off the schedule' : 'Turn on the schedule'} in Settings</a>
    </div>
    ${queued.length ? `<div class="tablewrap"><table class="list">
      <thead><tr><th>Site</th><th>Queued</th><th></th></tr></thead>
      <tbody>${queued.map(s => `<tr data-site="${h(s.id)}">
        <td><b>${h(s.name)}</b>${agencies().length > 1 && agencyOf(s) ? ` <span class="tag">${h(agencyOf(s).label)}</span>` : ''}${s.asanaWaiting ? ' <span class="tag warn" title="The last run\'s Asana comment goes out with this form test. If you remove it, send the comment from the site\'s Asana &amp; login tab.">Asana comment waiting</span>' : ''}</td>
        <td class="muted" title="${h(new Date(s.formTestQueued).toLocaleString())}">${h(ago(s.formTestQueued))}</td>
        <td class="acts"><button type="button" class="btn sm" data-action="queue-run-one">Run now</button><button type="button" class="btn sm ghost danger" data-action="queue-remove">Remove</button></td>
      </tr>`).join('')}</tbody></table></div>`
      : '<p class="muted" style="margin:0">Nothing is queued. Sites are queued by <b>Queue form test</b>, and by <b>Update everything</b> when Settings › Updates says to leave the form test for the morning run.</p>'}`;
  for (const b of document.querySelectorAll('#dlg-queue [data-action=queue-clear], #dlg-queue [data-action=run-queue]')) b.disabled = !queued.length;
}

const chevron = `<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function statusPill(kind, text, title = '') {
  return `<span class="pill ${kind}" title="${h(title)}"><span class="dot"></span>${h(text)}</span>`;
}

function healthPill(site) {
  if (site.overviewError) return statusPill('bad', 'Unreachable', site.overviewError.message);
  const hs = site.health;
  if (!hs) return site.overview ? statusPill('', 'Not checked') : '<span class="faint">-</span>';
  const why = [hs.inside?.message, hs.outside?.message].filter(Boolean).join(' · ');
  if (hs.status === 'fatal') return statusPill('bad', 'Broken', why);
  if (hs.status === 'warning') return statusPill('warn', 'Check', why);
  return statusPill('ok', 'Healthy', `Homepage ${hs.outside?.code} in ${hs.outside?.ms} ms · checked ${ago(hs.at)}`);
}

function formPill(site) {
  const f = site.formTest;
  if (site.formTestQueued && (!f || f.at < site.formTestQueued)) return statusPill('accent', 'Queued', `Queued ${ago(site.formTestQueued)} for the morning run`);
  if (!f) return '<span class="faint">-</span>';
  const t = `${f.message || ''}${f.ref ? ` · ref ${f.ref}` : ''} · ${ago(f.at)}`;
  const map = { sent: ['ok', 'Sent'], mail_sent: ['ok', 'Mail sent'], failed: ['bad', 'Failed'], mail_failed: ['bad', 'Mail failed'], error: ['bad', 'Error'], blocked: ['warn', 'Captcha'], unknown: ['warn', 'No reply'], no_form: ['warn', 'No form'] };
  const [k, l] = map[f.status] || ['', f.status];
  return statusPill(k, l, t);
}

function lastRunCell(site) {
  const r = site.lastRun;
  if (!r) return '<span class="faint">Never</span>';
  const k = r.status === 'ok' ? 'ok' : r.status === 'warning' ? 'warn' : r.status === 'failed' ? 'bad' : '';
  return `<span title="${h(r.summary || '')}"><span class="pill ${k}"><span class="dot"></span>${h(ago(r.at))}</span></span>`;
}

function siteRow(site) {
  const ov = site.overview;
  const c = counts(site);
  const run = running(site.id);
  const php = phpInfo(ov?.php_version);
  const wp = ov ? `${h(ov.core.version)}${ov.core.minor ? ` <span class="ver-arrow" title="Minor update available">→ ${h(ov.core.minor.version)}</span>` : ov.core.major ? ` <span class="tag accent" title="Major update available">${h(ov.core.major.version)}</span>` : ''}` : '<span class="faint">-</span>';
  const upd = !ov ? (site.overviewError ? '<span class="faint">-</span>' : '<span class="faint">Not checked</span>')
    : c.total ? `<span class="pill warn" title="${c.plugins} plugins · ${c.themes} themes${c.core ? ' · WordPress' : ''}${c.translations ? ' · translations' : ''}${c.held ? ` · ${c.held} held` : ''}">${c.total} update${c.total === 1 ? '' : 's'}</span>${c.held ? ` <span class="tag" title="Held - skipped by Update everything">${c.held} held</span>` : ''}`
    : '<span class="pill ok">Up to date</span>';
  const open = S.open.has(site.id);
  return `
  <section class="site ${open ? 'open' : ''} ${S.selected.has(site.id) ? 'selected' : ''}" data-site="${h(site.id)}">
    <div class="row" data-action="toggle-site">
      <input type="checkbox" data-action="select-site" ${S.selected.has(site.id) ? 'checked' : ''} aria-label="Select ${h(site.name)}">
      <div class="name">${chevron}<div class="title"><b>${h(site.name)}${S.newSites.has(site.id) ? ' <span class="tag accent">New</span>' : ''}${asanaTodo().has(site.id) ? ' <span class="tag warn" title="Its “WordPress update” task is open in Asana">Asana to-do</span>' : ''}${site.careful ? ` <span class="tag bad" title="${h(site.careful.note || 'Handle with care')}">Careful</span>` : ''}${wooTag(site)}</b>${addrBlock(site)}</div></div>
      <div class="cells">
        <div class="cell"><small>WordPress</small>${wp}</div>
        <div class="cell"><small>PHP</small>${php ? `<span class="pill ${php.cls}" title="${h(php.title)}">${h(ov.php_version)}</span>` : '<span class="faint">-</span>'}</div>
        <div class="cell"><small>Updates</small>${upd}</div>
        <div class="cell"><small>Health</small>${healthPill(site)}${site.security?.summary?.high ? ` <span class="tag bad" title="Last security check: ${h(site.security.summary.high)} high">security</span>` : ''}</div>
        <div class="cell"><small>Form test</small>${formPill(site)}</div>
        <div class="cell"><small>Last run</small>${lastRunCell(site)}</div>
      </div>
      <div class="row-actions">
        <button class="btn sm icon" data-action="site-check" data-stop ${run ? 'disabled' : ''} title="Check - read-only: updates, health, security, Divi forms" aria-label="Check ${h(site.name)}">${ICON.refresh}</button>
        <button class="btn sm ${c.total ? 'primary' : ''}" data-action="site-maintain" data-stop ${run ? 'disabled' : ''} title="Update WordPress, plugins and themes">${ICON.download}Update</button>
        <a class="btn sm ghost icon" href="${h(site.url)}/wp-admin/" target="_blank" rel="noopener" data-stop title="Login on WP" aria-label="Login on WP - ${h(site.name)}">${ICON.wp}</a>
        <button class="btn sm ghost icon" data-action="open-editor" data-stop title="Open in VS Code - the site's Claude Code workspace" aria-label="Open ${h(site.name)} in VS Code">${ICON.code}</button>
      </div>
      ${run ? `<div class="progress"><span class="spin"></span><span>${h(run.label)}</span></div>` : ''}
    </div>
    ${open ? `<div class="panel">${panel(site)}</div>` : ''}
  </section>`;
}

function panel(site) {
  const ov = site.overview;
  const tab = S.tab[site.id] || 'plugins';
  const c = counts(site);
  const run = running(site.id);
  let notice = '';
  if (site.overviewError) notice = `<div class="notice bad"><b>Could not reach the site:</b> ${h(site.overviewError.message)}</div>`;
  else if (!ov) notice = `<div class="notice">Not checked yet. <button class="btn sm" data-action="site-refresh">Check now</button></div>`;
  if (ov?.stuck_maintenance) notice += `<div class="notice warn">A <code>.maintenance</code> file from an interrupted update is still in place - visitors see "Briefly unavailable for scheduled maintenance". Delete it from the site root.</div>`;
  if (ov && !ov.filesystem.file_mods) notice += `<div class="notice warn">This site blocks installs and updates (DISALLOW_FILE_MODS).</div>`;
  if (ov && ov.filesystem.method !== 'direct') notice += `<div class="notice warn">WordPress cannot write files directly here (method: ${h(ov.filesystem.method)}). Updates need FTP credentials in wp-config.php.</div>`;
  if (run) notice += `<div class="notice"><ul class="steps">${run.entry.steps.slice(-6).map(stepLi).join('')}</ul></div>`;

  const tabs = [
    ['plugins', 'Plugins', ov ? ov.plugins.length : null, c.plugins],
    ['themes', 'Themes', ov ? ov.themes.length : null, c.themes],
    ['wordpress', 'WordPress & server', null, c.core + c.translations],
    ['forms', 'Form test', null, 0],
    ['asana', 'Asana & login', null, 0],
    ['security', 'Security', null, site.security?.summary?.high || 0],
    ['history', 'History', null, 0],
  ];
  const body = !ov && ['plugins', 'themes'].includes(tab) ? '' :
    tab === 'plugins' ? pluginsTab(site) : tab === 'themes' ? themesTab(site) : tab === 'wordpress' ? wordpressTab(site) : tab === 'forms' ? formsTab(site) : tab === 'asana' ? asanaTab(site) : tab === 'security' ? securityTab(site) : historyTab(site);
  return `${notice}
    <div class="tabs">${tabs.map(([k, l, n, u]) => `<button data-action="tab" data-v="${k}" class="${tab === k ? 'on' : ''}">${l}${u ? `<span class="n warn">${u}</span>` : n != null ? `<span class="n">${n}</span>` : ''}</button>`).join('')}
      <span style="flex:1"></span>
      <button class="btn ghost sm" data-action="site-refresh" title="Re-check updates now">↻ ${site.overviewAt ? `Checked ${h(ago(site.overviewAt))}` : 'Check'}</button>
    </div>
    ${body}`;
}

function pluginsTab(site) {
  const ov = site.overview;
  const sel = S.pluginSel[site.id] || (S.pluginSel[site.id] = new Set());
  const n = [...sel].filter(f => ov.plugins.some(p => p.file === f)).length;
  const withUpd = ov.plugins.filter(p => p.update && p.update.package && p.update.php_ok !== false && !isHeld(site, `plugin:${p.file}`));
  const sr = S.search[site.id] || {};
  const dis = n ? '' : 'disabled';
  const rows = ov.plugins.map(p => {
    const u = p.update;
    const updCell = !u ? '<span class="faint">-</span>'
      : `<span class="ver-arrow">→ ${h(u.version)}</span>${!u.package ? '<span class="tag warn" title="No download - licence key missing or expired">licence</span>' : ''}${!u.php_ok ? `<span class="tag bad" title="Needs PHP ${h(u.requires_php)}">PHP ${h(u.requires_php)}</span>` : u.requires_php ? `<span class="tag hide-sm" title="Requires PHP ${h(u.requires_php)}">PHP ${h(u.requires_php)}+</span>` : ''}`;
    return `<tr class="${p.active ? '' : 'inactive'}" data-file="${h(p.file)}">
      <td class="w1"><input type="checkbox" data-action="select-plugin" ${sel.has(p.file) ? 'checked' : ''} aria-label="Select ${h(p.name)}"></td>
      <td class="pname"><b>${h(p.name)}</b>${isHeld(site, `plugin:${p.file}`) ? '<span class="tag accent" title="Kept at this version - skipped by Update everything">held</span>' : ''}${p.self ? '<span class="tag accent">this connector</span>' : ''}${p.auto_update ? '<span class="tag" title="WordPress auto-updates this plugin">auto</span>' : ''}<code>${h(p.file)}</code></td>
      <td>${h(p.version)}</td>
      <td>${updCell}</td>
      <td><label class="switch" title="${p.self ? 'Claude Connector must stay active' : ''}"><input type="checkbox" data-action="toggle-plugin" ${p.active ? 'checked' : ''} ${p.self ? 'disabled' : ''}><span class="track"></span>${p.active ? 'Active' : 'Inactive'}</label></td>
      <td class="acts">
        ${u && u.package ? `<button class="btn sm" data-action="plugin-update">Update</button>` : ''}
        ${u || isHeld(site, `plugin:${p.file}`) ? `<button class="btn sm ghost" data-action="plugin-hold" title="${isHeld(site, `plugin:${p.file}`) ? 'Allow updates again' : 'Keep this version - Update everything skips it'}">${isHeld(site, `plugin:${p.file}`) ? 'Release' : 'Hold'}</button>` : ''}
        ${p.wporg ? `<button class="btn sm ghost" data-action="plugin-rollback" data-slug="${h(p.slug)}" data-name="${h(p.name)}" title="Install another version from wordpress.org">Versions</button>` : ''}
        ${p.self ? '' : `<button class="btn sm ghost danger" data-action="plugin-delete" title="Delete">Delete</button>`}
      </td>
    </tr>`;
  }).join('');
  return `
    <div class="bar">
      <button class="btn sm primary" data-action="plugins-update-all" ${withUpd.length ? '' : 'disabled'}>Update all plugins (${withUpd.length})</button>
      <span class="sep"></span>
      <button class="btn sm" data-action="plugins-bulk" data-v="update" ${dis}>Update selected</button>
      <button class="btn sm" data-action="plugins-bulk" data-v="activate" ${dis}>Activate</button>
      <button class="btn sm" data-action="plugins-bulk" data-v="deactivate" ${dis}>Deactivate</button>
      <button class="btn sm danger" data-action="plugins-bulk" data-v="delete" ${dis}>Delete</button>
      <span class="grow"></span>
      <input type="search" placeholder="Install a plugin from wordpress.org…" data-action="wporg-search" data-scope="site" value="${h(sr.q || '')}" style="width:280px">
    </div>
    ${sr.results ? `<div class="search-results">${sr.results.length ? sr.results.map(r => {
      const installed = ov.plugins.find(p => p.slug === r.slug || p.file.split('/')[0] === r.slug);
      return `<div class="r"><div class="t"><b>${h(r.name)}</b><span>${h(r.slug)} · v${h(r.version)} · ${Number(r.installs || 0).toLocaleString()}+ installs · ${h(r.short || '')}</span></div>
        ${installed ? '<span class="tag">installed</span>' : `<button class="btn sm" data-action="plugin-install" data-slug="${h(r.slug)}">Install</button><button class="btn sm primary" data-action="plugin-install" data-slug="${h(r.slug)}" data-activate="1">Install &amp; activate</button>`}</div>`;
    }).join('') : '<div class="r muted">No plugins found.</div>'}</div>` : ''}
    <div class="tablewrap"><table class="list">
      <thead><tr><th class="w1"><input type="checkbox" data-action="select-all-plugins" ${n && n === ov.plugins.length ? 'checked' : ''} aria-label="Select all plugins"></th><th>Plugin</th><th>Version</th><th>Update</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// WordPress's default themes, newest first; one is worth keeping as a fallback.
const DEFAULT_THEMES = ['twentytwentyfive', 'twentytwentyfour', 'twentytwentythree', 'twentytwentytwo', 'twentytwentyone', 'twentytwenty', 'twentynineteen', 'twentyseventeen', 'twentysixteen', 'twentyfifteen', 'twentyfourteen', 'twentythirteen', 'twentytwelve', 'twentyeleven', 'twentyten'];
const defaultRank = ss => { const i = DEFAULT_THEMES.indexOf(ss); return i >= 0 ? i : ss.startsWith('twenty') ? -1 : Infinity; };

/** Themes nothing uses, minus the newest default theme kept as a fallback (unless the active theme is one). */
function unusedThemes(ov) {
  const unused = ov.themes.filter(t => !t.active && !t.in_use);
  const activeIsDefault = ov.themes.some(t => (t.active || t.in_use) && defaultRank(t.stylesheet) !== Infinity);
  const keep = activeIsDefault ? null : [...unused].filter(t => defaultRank(t.stylesheet) !== Infinity).sort((a, b) => defaultRank(a.stylesheet) - defaultRank(b.stylesheet))[0] || null;
  return { remove: unused.filter(t => t !== keep), keep };
}

function themesTab(site) {
  const ov = site.overview;
  const withUpd = ov.themes.filter(t => t.update && t.update.package && !isHeld(site, `theme:${t.stylesheet}`));
  const { remove, keep } = unusedThemes(ov);
  return `
    <div class="bar"><button class="btn sm primary" data-action="themes-update-all" ${withUpd.length ? '' : 'disabled'}>Update all themes (${withUpd.length})</button>
      <button class="btn sm ghost danger" data-action="themes-delete-unused" ${remove.length ? '' : 'disabled'} title="${h(keep ? `Keeps ${keep.name} as the fallback WordPress uses if the active theme breaks` : 'Themes that are neither active nor the parent of the active theme')}">Delete unused themes (${remove.length})</button></div>
    <div class="tablewrap"><table class="list">
      <thead><tr><th>Theme</th><th>Version</th><th>Update</th><th></th></tr></thead>
      <tbody>${ov.themes.map(t => `<tr data-theme="${h(t.stylesheet)}">
        <td class="pname"><b>${h(t.name)}</b>${isHeld(site, `theme:${t.stylesheet}`) ? '<span class="tag accent">held</span>' : ''}${t.active ? '<span class="tag accent">active</span>' : t.in_use ? '<span class="tag accent">parent of active</span>' : ''}${t.parent ? `<span class="tag">child of ${h(t.parent)}</span>` : ''}<code>${h(t.stylesheet)}</code></td>
        <td>${h(t.version || '-')}</td>
        <td>${t.update ? `<span class="ver-arrow">→ ${h(t.update.version)}</span>${!t.update.package ? '<span class="tag warn">licence</span>' : ''}` : '<span class="faint">-</span>'}</td>
        <td class="acts">${t.update && t.update.package ? '<button class="btn sm" data-action="theme-update">Update</button>' : ''}${t.update || isHeld(site, `theme:${t.stylesheet}`) ? `<button class="btn sm ghost" data-action="theme-hold">${isHeld(site, `theme:${t.stylesheet}`) ? 'Release' : 'Hold'}</button>` : ''}${!t.active && !t.in_use ? '<button class="btn sm ghost danger" data-action="theme-delete">Delete</button>' : ''}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

function manageCard(site) {
  const ov = site.overview;
  return `<div class="card"><h4>Manage site</h4>
      <dl class="kv">
        <dt>Address</dt><dd><a href="${h(site.url)}" target="_blank" rel="noopener">${h(site.url)}</a></dd>
        <dt>Connection</dt><dd>${h(site.mode)}</dd>
        ${ov ? `<dt>Connector</dt><dd>${h(ov.plugin_version)}</dd><dt>File writes</dt><dd>${h(ov.filesystem.method)}${ov.filesystem.file_mods ? '' : ' (blocked)'}</dd>` : ''}
        <dt>Found in</dt><dd>${h(site.source)}</dd></dl>
      <div class="careful-box" style="margin-top:10px">
        <label class="check"><input type="checkbox" data-careful ${site.careful ? 'checked' : ''}> <span><b>Handle with care</b> - leave out of "Update everything" across sites unless ticked, and show this note before updating</span></label>
        <div class="bar" style="margin:6px 0 0"><input type="text" data-careful-note value="${h(site.careful?.note || '')}" placeholder="Why, e.g. custom WooCommerce templates - check the shop and checkout first" style="flex:1"><button class="btn sm" data-action="save-careful">Save</button></div>
        ${ov?.woocommerce?.overrides ? `<p class="hint" style="margin:6px 0 0">The theme overrides ${ov.woocommerce.overrides} WooCommerce template${ov.woocommerce.overrides === 1 ? '' : 's'}${ov.woocommerce.outdated ? ` - <b>${ov.woocommerce.outdated} outdated</b> (${h(ov.woocommerce.files.filter(f => f.outdated).slice(0, 4).map(f => f.file.split('/').slice(-2).join('/')).join(', '))}${ov.woocommerce.outdated > 4 ? ', …' : ''})` : ''}. WooCommerce and theme updates are checked on the shop, cart and checkout and rolled back if they break${site.careful ? '' : ' - consider marking this site Handle with care'}.</p>` : ''}
      </div>
      <div class="bar" style="margin:10px 0 0">
        <button class="btn sm" data-action="site-url">Edit address</button>
        <button class="btn sm ghost" data-action="site-check">Re-check</button>
        <button class="btn sm ghost" data-action="open-editor">Open in VS Code</button>
        ${site.source !== 'manual' ? '<button class="btn sm ghost" data-action="site-hide">Hide from dashboard</button>' : ''}
        <button class="btn sm ghost danger" data-action="site-delete">${site.source === 'manual' ? 'Remove site' : 'Delete site'}</button>
      </div></div>`;
}

function wordpressTab(site) {
  const ov = site.overview;
  if (!ov) return `<div class="grid2">${manageCard(site)}<div class="card"><h4>Not checked yet</h4><p class="hint">Press <b>Re-check</b> or <b>Check</b> to read this site's WordPress, PHP and update status. If the site is unreachable, use <b>Change URL…</b> (for a moved site) or <b>Delete site</b>.</p></div></div>`;
  const php = phpInfo(ov.php_version);
  const core = ov.core;
  return `<div class="grid2">
    <div class="card"><h4>WordPress core</h4>
      <dl class="kv"><dt>Installed</dt><dd>${h(core.version)}</dd>
        <dt>Minor update</dt><dd>${core.minor ? `<span class="ver-arrow">${h(core.minor.version)}</span>` : 'None'}</dd>
        <dt>Major update</dt><dd>${core.major ? `${h(core.major.version)}${core.major.php_compatible ? '' : ` <span class="tag bad">needs PHP ${h(core.major.php_required)}</span>`}` : 'None'}</dd></dl>
      <div class="bar" style="margin:10px 0 0">
        ${core.minor ? `<button class="btn sm primary" data-action="core-update">Update to ${h(core.minor.version)}</button>` : ''}
        ${core.major ? `<button class="btn sm" data-action="core-update" data-major="1" ${core.major.php_compatible ? '' : 'disabled'}>Update to ${h(core.major.version)} (major)</button>` : ''}
      </div></div>
    <div class="card"><h4>PHP</h4>
      <dl class="kv"><dt>Version</dt><dd><span class="pill ${php.cls}">${h(ov.php_version)}</span></dd><dt>Support</dt><dd>${h(php.title.replace(/^PHP [\d.]+ - /, ''))}</dd></dl>
      ${php.cls !== 'ok' ? '<p class="hint" style="margin-top:8px">PHP is changed in the hosting control panel (cPanel → Select PHP Version / MultiPHP Manager, or the host\'s dashboard), not in WordPress.</p>' : ''}</div>
    <div class="card"><h4>Translations</h4>
      <p style="margin:0 0 10px">${ov.translations ? `${ov.translations} translation update${ov.translations === 1 ? '' : 's'} available` : 'Up to date'}</p>
      ${ov.translations ? '<button class="btn sm" data-action="translations-update">Update translations</button>' : ''}</div>
    ${manageCard(site)}
  </div>`;
}

// Same order the form test picks in (lib/jobs.js formStep).
const NOT_CONTACT = /career|job|employ|recruit|vacanc|apply|application|newsletter|subscribe|login|register|sign-?up/i;
const rankForms = forms => [...forms].sort((a, b) => {
  const r = f => (f.contact ? 3 : 0) + (f.via && f.via !== 'content' ? 1 : 0) - (NOT_CONTACT.test(`${f.title} ${f.url}`) ? 5 : 0);
  return r(b) - r(a);
});

function formsTab(site) {
  const f = site.formTest;
  const forms = rankForms(site.forms || []);
  const current = site.formUrl || '';
  const ag = agencyOf(site);
  const fields = f?.fields?.length ? `<div class="tablewrap"><table class="list" style="margin-top:8px"><thead><tr><th>Field</th><th>Filled with</th></tr></thead><tbody>${f.fields.map(x => `<tr><td>${h(x.label)}${x.rule ? ` <span class="tag accent" title="From the agency's field rule">rule: ${h(x.rule)}</span>` : ''}</td><td>${h(x.value)}${x.shown ? ` <span class="faint">(${h(x.shown)})</span>` : ''}${x.error ? ` <span class="tag bad" title="${h(x.error)}">not filled</span>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '';
  return `<div class="grid2">
    <div class="card"><h4>Agency</h4>
      <label class="field">The form is filled in with this agency's details
        <select data-action="site-agency">${agencies().map(a => `<option value="${h(a.id)}" ${ag?.id === a.id ? 'selected' : ''}>${h(a.label)}${a.id === S.settings.defaultAgency ? ' (default)' : ''}</option>`).join('')}</select>
      </label>
      <dl class="kv" style="margin-top:10px"><dt>Name</dt><dd>${h(ag?.name)}</dd><dt>Email</dt><dd>${ag?.email ? h(ag.email) : '<span class="tag bad">not set</span>'}</dd><dt>Phone</dt><dd>${h(ag?.phone)}</dd>${ag?.rules?.length ? `<dt>Field rules</dt><dd>${ag.rules.length}</dd>` : ''}</dl>
    </div>
    <div class="card"><h4>Form to test</h4>
      <label class="field">Page
        <select data-action="form-url">
          <option value="">${forms.length ? `Automatic - ${h(forms[0].title)}` : 'Automatic (first contact form found)'}</option>
          ${forms.map(x => `<option value="${h(x.url)}" ${current === x.url ? 'selected' : ''}>${h(x.title)} - ${h(x.plugins.join(', '))}${x.via !== 'content' ? ` (${h(x.via)})` : ''}</option>`).join('')}
          ${current && !forms.some(x => x.url === current) ? `<option value="${h(current)}" selected>${h(current)}</option>` : ''}
        </select>
      </label>
      <div class="bar" style="margin:10px 0 0">
        <button class="btn sm primary" data-action="site-form">Run form test</button>
        <button class="btn sm" data-action="find-forms">${site.forms ? 'Find forms again' : 'Find forms'}</button>
        <button class="btn sm ghost" data-action="form-custom">Other URL…</button>
        <button class="btn sm ghost" data-action="site-mail" title="Send a plain wp_mail() test - tells a broken form apart from broken email">wp_mail test</button>
      </div>
      ${site.mailer ? `<p class="hint" style="margin-top:10px">${site.mailer.plugin ? `Mail is sent through ${h(site.mailer.plugin)}.` : h(site.mailer.warning)}</p>` : ''}
    </div>
  </div>
  ${diviCard(site)}
  ${f ? `<div class="card" style="margin-top:12px"><h4>Last result · ${h(ago(f.at))}${f.agency ? ` · as ${h(f.agency)}` : ''}</h4>
    <p style="margin:0">${formPill(site)} ${h(f.message || '')}</p>
    <dl class="kv" style="margin-top:8px">${f.ref ? `<dt>Reference</dt><dd><code>${h(f.ref)}</code> - search the inbox for this</dd>` : ''}${f.kind ? `<dt>Form</dt><dd>${h(f.kind)}</dd>` : ''}${f.url ? `<dt>Page</dt><dd><a href="${h(f.url)}" target="_blank" rel="noopener">${h(f.url)}</a></dd>` : ''}${f.to ? `<dt>Sent to</dt><dd>${h(f.to)}</dd>` : ''}</dl>
    ${fields}
    ${f.screenshot ? `<a href="/screens/${encodeURIComponent(f.screenshot)}" target="_blank" rel="noopener"><img class="shot" style="margin-top:10px" src="/screens/${encodeURIComponent(f.screenshot)}" alt="Page after submitting"></a>` : ''}
  </div>` : ''}`;
}

const SEV_CLS = { high: 'bad', medium: 'warn', low: '', info: '' };

/** This site's own trusted administrator emails (several at once), next to its agency's list. */
function trustedCard(site) {
  const ag = agencyOf(site);
  const mine = site.trustedAdmins || [];
  const agList = ag?.trustedAdmins || [];
  return `<details class="card" style="margin-top:8px" ${mine.length || agList.length ? '' : 'open'}>
    <summary style="cursor:pointer"><b>Trusted admin emails</b> <span class="muted">· ${mine.length} for this site${agList.length ? ` + ${agList.length} for every ${h(ag.label)} site` : ''}</span></summary>
    <p class="hint" style="margin:8px 0 6px">Administrators with these emails are never flagged, whatever their username; every other administrator is flagged. One per line - the client's staff, for example. <code>@domain.com</code> trusts a whole domain but still flags accounts created in the last 30 days.</p>
    <textarea data-trusted-site rows="${Math.max(3, mine.length + 1)}" placeholder="owner@client.com&#10;office@client.com" style="width:100%">${h(mine.join('\n'))}</textarea>
    <div class="bar" style="margin:6px 0 0"><button class="btn sm primary" data-action="save-trusted">Save</button>
      ${agList.length ? `<span class="muted" style="font-size:12.5px">Also trusted for ${h(ag.label)}: ${h(agList.join(', '))} - <a href="#" data-action="settings">change in Settings</a></span>` : `<span class="muted" style="font-size:12.5px">Your own staff's emails go on the agency, in <a href="#" data-action="settings">Settings › Agencies</a>.</span>`}</div>
  </details>`;
}

/** Mark one warning item checked (reviewed, fine), or undo that. */
function ackButton(i) {
  if (i.checked) {
    const when = new Date(i.checked.at).toLocaleDateString();
    return ` <span class="tag ok" title="${h(i.checked.note || 'Marked checked')}">✓ checked ${h(when)}${i.checked.note ? `: ${h(i.checked.note.slice(0, 60))}` : ''}</span> <button class="btn sm ghost" data-action="sec-unack" data-key="${h(i.ackKey)}">Undo</button>`;
  }
  return ` <button class="btn sm ghost" data-action="sec-ack" data-key="${h(i.ackKey)}" title="You reviewed it and it is fine - it stops counting, until it changes">Mark checked</button>`;
}

// Shared storage / hosting anyone can put files on (same list as the server's SHARED_HOSTING).
const SHARED_HOSTING = /^(?:(?:s3(?:[.-][a-z0-9-]+)?\.)?amazonaws\.com|(?:storage\.|firebasestorage\.)?googleapis\.com|(?:raw\.|objects\.)?githubusercontent\.com|googleusercontent\.com|cloudfront\.net|github\.io|blob\.core\.windows\.net|r2\.dev|pages\.dev|workers\.dev|netlify\.app|vercel\.app|herokuapp\.com|web\.app|firebaseapp\.com|digitaloceanspaces\.com|backblazeb2\.com)$/;

/** A widget's domain from an injected-code warning, with a button to trust it on every site. */
function hostButton(f, i) {
  if (!/^Injected code|containing scripts/.test(f.title)) return '';
  const host = i.host || (String(i.detail || '').match(/(?:script|iframe) from ([a-z0-9.-]+)/i) || [])[1];
  if (!host) return '';
  if ((S.settings.trustedHosts || []).some(t => host === t || host.endsWith(`.${t}`))) return ' <span class="tag ok">trusted widget - run the check again</span>';
  if (SHARED_HOSTING.test(host)) return ' <span class="tag warn" title="Anyone can store files there, so it cannot be trusted as a whole - check what this script is">shared hosting - cannot be trusted</span>';
  return ` <button class="btn sm ghost" data-action="trust-host" data-host="${h(host)}" title="A widget you recognise: its scripts and iframes are no longer flagged, on every site">Trust ${h(host)}</button>`;
}

/** Trust / untrust an administrator's email for this site (agency-wide ones are set in Settings). */
function trustButton(site, email) {
  const agencyList = agencyOf(site)?.trustedAdmins || [];
  const domain = email.slice(email.indexOf('@'));
  if (agencyList.includes(email) || agencyList.includes(domain)) return ` <span class="tag ok" title="Trusted for every ${h(agencyOf(site)?.label || '')} site - change it in Settings › Agencies">trusted (agency)</span>`;
  if ((site.trustedAdmins || []).includes(email)) return ` <button class="btn sm ghost" data-action="untrust-admin" data-email="${h(email)}">Untrust</button>`;
  return ` <button class="btn sm ghost" data-action="trust-admin" data-email="${h(email)}" title="Trust this administrator on this site - it will not be flagged again">Trust this email</button>`;
}

function securityTab(site) {
  const sc = site.security;
  const run = running(site.id);
  const head = `<div class="bar">
      <button class="btn sm primary" data-action="site-security" ${run ? 'disabled' : ''}>${sc ? 'Run the security check again' : 'Run security check'}</button>
      <button class="btn sm" data-action="claude-review" ${sc ? '' : 'disabled'} title="Writes SECURITY-REPORT.md into the site's workspace and opens it in VS Code for Claude">Open in VS Code with Claude</button>
      <span class="grow"></span>
      ${sc ? `<span class="muted" style="font-size:12.5px">Checked ${h(ago(sc.at))} · ${h(sc.stats?.php_files_pattern_scanned ?? '?')} files scanned · ${h(sc.stats?.wporg_plugins_verified ?? 0)} plugins verified against wordpress.org</span>` : ''}
    </div>`;
  if (!sc) return `${head}${trustedCard(site)}<p class="hint">Read-only: compares WordPress core and wordpress.org plugins with their published checksums, looks for PHP in uploads, known malware patterns, active plugins whose files are missing, new administrators, .htaccess redirects and scripts injected into posts and settings. Nothing on the site is changed.</p>`;
  const s = sc.summary || {};
  // Warnings you have fully checked go last, closed, and no longer count.
  const ordered = [...(sc.findings || [])].sort((a, b) => (a.checked ? 1 : 0) - (b.checked ? 1 : 0));
  const findings = ordered.map(f => {
    const open = (f.items || []).filter(i => !i.checked && i.ackKey);
    const canAck = f.severity !== 'info';
    return `
    <details class="card sec ${f.checked ? 'sec-checked' : SEV_CLS[f.severity] || ''}" ${f.severity === 'high' && !f.checked ? 'open' : ''} style="margin-top:8px">
      <summary>${f.checked ? '<span class="pill ok"><span class="dot"></span>checked</span>' : `<span class="pill ${SEV_CLS[f.severity] || ''}">${h(f.severity)}</span>`} <b>${h(f.title)}</b> <span class="muted">(${h(f.count)}${f.checkedCount && !f.checked ? `, ${h(f.checkedCount)} checked` : ''})</span></summary>
      ${f.note ? `<p class="hint" style="margin:6px 0">${h(f.note)}</p>` : ''}
      ${canAck && open.length > 1 ? `<div class="bar" style="margin:4px 0"><button class="btn sm ghost" data-action="sec-ack-all" data-keys="${h(open.map(i => i.ackKey).join(','))}" title="You have reviewed every item here and they are fine">Mark all ${open.length} checked</button></div>` : ''}
      <ul class="sec-items">${(f.items || []).map(i => `<li class="${i.checked ? 'sec-item-checked' : ''}"><code>${h(i.path)}</code>${i.detail ? ` <span class="muted">${h(i.detail)}</span>` : ''}${f.category === 'users' && i.email ? trustButton(site, i.email) : ''}${hostButton(f, i)}${canAck && i.ackKey ? ackButton(i) : ''}${(i.hits || []).map(x => `<div class="sec-hit">${h(x.label)}, line ${h(x.line)}: <code>${h(x.snippet)}</code></div>`).join('')}</li>`).join('')}
      ${f.count > (f.items || []).length ? `<li class="muted">… and ${f.count - f.items.length} more</li>` : ''}</ul>
    </details>`;
  }).join('');
  return `${head}${trustedCard(site)}
    <div class="notice ${s.high ? 'bad' : s.medium ? 'warn' : ''}" style="margin-top:8px">${s.high || s.medium
      ? `<b>${s.high} high · ${s.medium} medium</b> warning sign${s.high + s.medium === 1 ? '' : 's'}. These are leads, not proof - open the site in VS Code and let Claude look into each one before anything is changed.`
      : 'No warning signs found. The items below are for review.'}</div>
    ${findings}`;
}

/** Divi contact forms: does the email (Message Pattern) carry every field? */
function diviCard(site) {
  const d = site.diviForms;
  const forms = (d?.forms || []).filter(f => f.fields.length);
  const head = `<div class="bar" style="margin:0"><h4 style="margin:0;flex:1">Divi email pattern</h4>
    <button class="btn sm" data-action="check-divi">${d ? 'Check again' : 'Check Divi forms'}</button></div>`;
  if (!d) return `<div class="card" style="margin-top:12px">${head}<p class="hint" style="margin:8px 0 0">Divi only emails the fields named in a form's Message Pattern. This lists every Divi contact form and any field its emails leave out.</p></div>`;
  if (!forms.length) return `<div class="card" style="margin-top:12px">${head}<p class="hint" style="margin:8px 0 0">No Divi 4 contact forms on this site${d.divi5?.length ? ` (${d.divi5.length} Divi 5 form page${d.divi5.length === 1 ? '' : 's'} - check those in the builder)` : ''}.</p></div>`;
  return `<div class="card" style="margin-top:12px">${head}
    ${forms.map(f => `<div class="divi-form" data-post="${h(f.post_id)}" data-index="${h(f.index)}">
      <div class="bar" style="margin:10px 0 4px">
        ${f.ok ? '<span class="pill ok"><span class="dot"></span>sends every field</span>' : '<span class="pill warn"><span class="dot"></span>drops fields</span>'}
        <b>${h(f.post)}</b><span class="muted">${h(f.where)}${f.title ? ` · ${h(f.title)}` : ''}${f.recipient ? ` · to ${h(f.recipient)}` : ''}</span>
        ${f.url ? `<a href="${h(f.url)}" target="_blank" rel="noopener" class="faint">open ↗</a>` : ''}
      </div>
      ${!f.ok ? `<p class="hint" style="margin:0 0 6px">${!f.pattern ? 'No Message Pattern set.' : ''}${f.missing.length ? ` Not in the email: <b>${h(f.missing.join(', '))}</b>.` : ''}${f.unknown.length ? ` Placeholders that match no field (the ID differs): <code>${h(f.unknown.map(u => `%%${u}%%`).join(' '))}</code>.` : ''} Field IDs: <code>${h(f.fields.map(x => x.id).join(', '))}</code></p>` : ''}
      <div class="grid2">
        <label class="field">Current pattern<textarea rows="${Math.min(8, (f.pattern || '').split('\n').length + 1)}" readonly>${h(f.pattern || '')}</textarea></label>
        <label class="field">${f.ok ? 'Pattern' : 'Suggested pattern'} (edit if you like)<textarea data-pattern rows="${Math.min(8, f.suggested.split('\n').length + 1)}">${h(f.ok ? f.pattern : f.suggested)}</textarea></label>
      </div>
      <div class="bar" style="margin:6px 0 0"><button class="btn sm ${f.ok ? '' : 'primary'}" data-action="set-divi-pattern">Set this pattern</button></div>
    </div>`).join('')}
    ${d.divi5?.length ? `<p class="hint">Divi 5 forms on ${h(d.divi5.map(x => x.post).join(', '))} are not checked here - set their pattern in the builder.</p>` : ''}
  </div>`;
}

function stepLi(s) {
  const ic = { ok: '✓', warning: '!', failed: '✕', running: '<span class="spin"></span>' }[s.status] || '•';
  return `<li class="${h(s.status)}"><span class="ic">${ic}</span><span>${h(s.label)}${s.detail ? `<span class="d">${h(s.detail)}</span>` : ''}</span></li>`;
}

function historyTab(site) {
  const list = S.history[site.id];
  if (!list) { loadHistory(site.id); return '<p class="muted">Loading…</p>'; }
  if (!list.length) return '<p class="muted">Nothing has been run on this site from the dashboard yet.</p>';
  return list.map(e => {
    if (e.type === 'asana') {
      return `<div class="card hist-asana" style="margin-bottom:8px"><span class="pill ${e.title === 'Update done' ? 'ok' : 'warn'}"><span class="dot"></span>Asana</span> <b>${h(e.title)}</b> <span class="muted">· ${h(new Date(e.at).toLocaleString())}${e.summary ? ` · ${h(e.summary)}` : ''}</span>${e.url ? ` <a href="${h(e.url)}" target="_blank" rel="noopener" class="faint">open ↗</a>` : ''}</div>`;
    }
    const k = e.status === 'ok' ? 'ok' : e.status === 'warning' ? 'warn' : e.status === 'failed' ? 'bad' : '';
    return `<details class="card" style="margin-bottom:8px"><summary style="cursor:pointer"><span class="pill ${k}"><span class="dot"></span>${h(e.status)}</span> <b>${h(e.title)}</b> <span class="muted">· ${h(new Date(e.at).toLocaleString())}${e.summary ? ` · ${h(e.summary)}` : ''}</span></summary>
      <ul class="steps" style="margin-top:8px">${e.steps.map(stepLi).join('')}</ul></details>`;
  }).join('');
}

async function loadHistory(id) {
  try { S.history[id] = await api('GET', `/api/history?site=${encodeURIComponent(id)}`); } catch { S.history[id] = []; }
  renderSite(id);
}

function groupHeader(ag, sites) {
  const ids = sites.map(s => s.id);
  const all = ids.length && ids.every(id => S.selected.has(id));
  const upd = sites.reduce((n, s) => n + counts(s).total, 0);
  const bad = sites.filter(s => issue(s) === 'bad').length;
  const collapsed = S.collapsed.has(ag.id);
  return `<div class="group" data-group="${h(ag.id)}">
    <input type="checkbox" data-action="select-group" ${all ? 'checked' : ''} aria-label="Select all ${h(ag.label)} sites">
    <button class="gname" data-action="toggle-group"><span class="swatch" style="background:${h(ag.color)}"></span>${h(ag.label)}<span class="muted">${sites.length} site${sites.length === 1 ? '' : 's'}${upd ? ` · ${upd} updates` : ''}${bad ? ` · <span style="color:var(--bad)">${bad} need attention</span>` : ''}</span>${collapsed ? '<span class="faint">(hidden)</span>' : ''}</button>
    <span style="flex:1"></span>
    <button class="btn sm" data-action="group-maintain" ${sites.length ? '' : 'disabled'}>Update everything for ${h(ag.label)}</button>
  </div>`;
}

const ICON = {
  refresh: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 0 1-9.6 3.7M2.5 8a5.5 5.5 0 0 1 9.6-3.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12.6 1.8v2.8H9.8M3.4 14.2v-2.8h2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  download: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 2.5v7.5M4.8 7.2 8 10.4l3.2-3.2M2.5 11.5V13a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  wp: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.9 5.6 6 11.2 8 6.6l2 4.6 2.1-5.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  code: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/** A tag when the theme overrides WooCommerce templates - a WooCommerce or theme update can break the shop. */
function wooTag(site) {
  const w = site.overview?.woocommerce;
  if (!w?.overrides) return '';
  return ` <span class="tag ${w.outdated ? 'warn' : ''}" title="${h(`The theme overrides ${w.overrides} WooCommerce template${w.overrides === 1 ? '' : 's'}${w.outdated ? `, ${w.outdated} outdated` : ''}. After WooCommerce or theme updates the shop, cart and checkout are loaded too, and the update is rolled back if they break.`)}">Woo templates${w.outdated ? ` (${w.outdated} outdated)` : ''}</span>`;
}

const PEN = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M11.1 1.9a1.5 1.5 0 0 1 2.1 0l.9.9a1.5 1.5 0 0 1 0 2.1L5.6 13.4l-3.4.8.8-3.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9.8 3.2l3 3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

/** The site's address under its name, with a pen to edit it in place. */
function addrBlock(site) {
  if (S.editUrl === site.id) {
    return `<div class="addr-edit" data-stop>
      <input type="url" data-url-input value="${h(S.urlDraft)}" aria-label="Website address for ${h(site.name)}" spellcheck="false" autocomplete="off">
      <button class="btn sm primary" data-action="save-url" data-stop>Save</button>
      <button class="btn sm ghost" data-action="cancel-url" data-stop>Cancel</button>
    </div>`;
  }
  return `<div class="addr"><a href="${h(site.url)}" target="_blank" rel="noopener" data-stop>${h(site.url.replace(/^https?:\/\//, ''))}</a><button class="pen" data-action="site-url" data-stop title="Edit website address" aria-label="Edit website address for ${h(site.name)}">${PEN}</button></div>`;
}

function focusUrl() {
  const i = document.querySelector('[data-url-input]');
  if (i && document.activeElement !== i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
}

async function saveUrl(site) {
  const url = (S.urlDraft || '').trim();
  if (!url || url === site.url) { S.editUrl = null; renderSites(); return; }
  try {
    await api('POST', `/api/sites/${encodeURIComponent(site.id)}/url`, { url });
    S.editUrl = null;
    toast('Address changed - press Check to re-scan the site');
    await load();
  } catch (e) { toast(e.message); focusUrl(); }
}

function renderSites() {
  const el = $('#sites');
  const all = S.sites.filter(s => !s.hidden);
  if (!all.length) {
    el.innerHTML = `<div class="empty"><h2>No sites yet</h2><p>Sites set up with the one-click installer in <code>~/claude-sites</code> appear here automatically.<br>Or add one by hand with its API key.</p><button class="btn primary" data-action="add-site">Add site</button></div>`;
    return;
  }
  if (S.filter === 'asana' && !S.tasks?.tasks) { el.innerHTML = '<div class="empty"><p class="muted">Loading your Asana tasks…</p></div>'; return; }
  if (S.filter === 'asana' && S.tasks.error) { el.innerHTML = `<div class="empty"><h2>Could not read Asana</h2><p>${h(S.tasks.error)}</p></div>`; return; }
  const vis = visibleSites();
  if (!vis.length) {
    el.innerHTML = S.filter === 'asana'
      ? '<div class="empty"><h2>Nothing to do in Asana</h2><p>No site has an open “WordPress update” task that still needs the updates.</p></div>'
      : '<div class="empty"><h2>No sites match</h2><p>Change the filter or search.</p></div>';
    return;
  }
  // Group by agency once there is more than one, in settings order.
  if (agencies().length > 1) {
    el.innerHTML = agencies().map(ag => {
      const sites = vis.filter(s => agencyOf(s)?.id === ag.id);
      if (!sites.length) return '';
      return groupHeader(ag, sites) + (S.collapsed.has(ag.id) ? '' : sites.map(siteRow).join(''));
    }).join('');
  } else {
    el.innerHTML = vis.map(siteRow).join('');
  }
  if (S.editUrl) focusUrl();
}

/** Re-render one site, unless the user is typing inside it (then on blur). */
const pendingSites = new Set();
function renderSite(id) {
  const el = document.querySelector(`[data-site="${CSS.escape(id)}"]`);
  const site = S.sites.find(s => s.id === id);
  if (!el || !site) return;
  if (el.contains(document.activeElement) && document.activeElement.matches('input[type=search], input[type=text], input[type=url], select, textarea')) {
    pendingSites.add(id);
    return;
  }
  el.outerHTML = siteRow(site);
}
document.addEventListener('focusout', () => setTimeout(() => {
  for (const id of [...pendingSites]) { pendingSites.delete(id); renderSite(id); }
}, 0));

function renderDrawer() {
  const d = $('#drawer');
  const list = [...S.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!list.length) { d.hidden = true; return; }
  d.hidden = false;
  const runningN = list.filter(j => j.status === 'running').length;
  d.className = `drawer ${S.drawerMin ? 'min' : ''}`;
  d.innerHTML = `<header data-action="toggle-drawer"><b>Activity</b>${runningN ? `<span class="pill run"><span class="spin"></span>${runningN} running</span>` : ''}<span class="faint">${S.drawerMin ? '▲' : '▼'}</span></header>
    <div class="body">${list.slice(0, 15).map(j => {
      const entries = Object.entries(j.sites);
      const done = entries.filter(([, e]) => !['queued', 'running'].includes(e.status)).length;
      const k = j.status === 'done' ? 'ok' : j.status === 'warning' ? 'warn' : j.status === 'failed' ? 'bad' : 'run';
      return `<div class="job ${S.openJobs.has(j.id) ? 'open' : ''}" data-job="${h(j.id)}">
        <div class="jh" data-action="toggle-job"><span class="pill ${k}">${j.status === 'running' ? '<span class="spin"></span>' : '<span class="dot"></span>'}${done}/${entries.length}</span><span class="t">${h(j.title)}</span><span class="faint">${h(ago(j.createdAt))}</span></div>
        <div class="jb">${entries.map(([id, e]) => `<div class="js"><div>${h(e.name)} <span class="pill ${e.status === 'ok' ? 'ok' : e.status === 'warning' ? 'warn' : e.status === 'failed' ? 'bad' : 'run'}">${h(e.status)}</span>${e.summary ? `<span class="muted" style="font-weight:400">${h(e.summary)}</span>` : ''}</div><ul class="steps">${e.steps.map(stepLi).join('')}</ul></div>`).join('')}</div>
      </div>`;
    }).join('')}</div>`;
}

function renderBanner() {
  const el = $('#banner');
  const f = S.failures;
  if (!f.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="notice bad banner">
    <div><b>${f.length} site${f.length === 1 ? '' : 's'} had failures in the last run</b>
      <ul>${f.slice(0, 5).map(x => `<li><b>${h(x.siteName)}</b> - ${h(x.first || x.summary || x.title)} <span class="faint">· ${h(ago(x.at))}</span></li>`).join('')}${f.length > 5 ? `<li>and ${f.length - 5} more</li>` : ''}</ul></div>
    <div class="banner-acts"><button class="btn sm" data-action="view" data-v="log">View log</button><button class="btn sm ghost" data-action="dismiss-failures">Dismiss</button></div>
  </div>`;
}

function renderAll() {
  renderStats();
  renderBanner();
  $('#view-sites').hidden = S.view !== 'sites';
  $('#view-tasks').hidden = S.view !== 'tasks';
  $('#view-log').hidden = S.view !== 'log';
  for (const b of document.querySelectorAll('.views button')) b.classList.toggle('on', b.dataset.v === S.view);
  if (S.view === 'sites') { renderToolbar(); renderSites(); } else if (S.view === 'tasks') renderTasks(); else renderLog();
  renderDrawer();
}

// ── Log in: new tab through the extension, or a separate window ──────────────

// Fixed by the "key" in extension/manifest.json, so the dashboard can find it.
const EXT_ID = 'ocideoajgbmhcophohnnighielchjmlg';

/** Asks the Site Maintenance Login extension to answer; false when it is not installed. */
function extensionRuntime() {
  return new Promise(resolve => {
    const rt = window.chrome?.runtime;
    if (!rt?.sendMessage) return resolve(null);
    const timer = setTimeout(() => resolve(null), 1200);
    try {
      rt.sendMessage(EXT_ID, { type: 'ping' }, r => { clearTimeout(timer); void rt.lastError; resolve(r?.ok ? r : null); });
    } catch { clearTimeout(timer); resolve(null); }
  });
}

function extensionLogin(msg) {
  return new Promise((resolve, reject) => {
    window.chrome.runtime.sendMessage(EXT_ID, { type: 'login', ...msg }, r => {
      const err = window.chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      r?.ok ? resolve(r) : reject(new Error(r?.error || 'The extension did not answer.'));
    });
  });
}

/** Same rule as the server's loginUrlFor(): a site address gets /wp-admin/. */
function loginUrlFor(url) {
  const u = new URL(url);
  if (/wp-login\.php|wp-admin|login|admin/i.test(u.pathname)) return u.toString();
  u.pathname = u.pathname.replace(/\/?$/, '/') + 'wp-admin/';
  u.search = '';
  return u.toString();
}

/**
 * Makes sure you have the latest plugin zip before Install connector: asks only
 * when a newer release is out than the one you last downloaded or said you have
 * (or, when GitHub cannot be reached, once a month).
 * @returns {Promise<'downloaded'|'have'|null>} null when cancelled.
 */
async function ensureConnectorZip() {
  const latest = await api('GET', '/api/connector/latest').catch(() => ({}));
  const have = latest.have;
  const current = latest.version ? have?.version === latest.version : !!have?.at && thisMonth(have.at);
  if (current) return 'have';
  const d = $('#dlg-zip');
  const v = latest.version ? `v${latest.version}` : '';
  $('[data-msg]', d).innerHTML = latest.version
    ? `The latest Claude Connector is <b>${h(v)}</b>${latest.published ? ` (released ${h(new Date(latest.published).toLocaleDateString())})` : ''}.${have?.version ? ` You last downloaded v${h(have.version)}.` : ''} Install it from the latest zip.`
    : 'Could not check GitHub for the latest version. Download the latest zip unless you already have it.';
  $('[data-vtext]', d).textContent = v ? ` (${v})` : '';
  $('[data-dl]', d).textContent = `Download ${v || 'latest'}`;
  d.querySelector('[name=have]').checked = false;
  d.returnValue = '';
  d.showModal();
  const choice = await new Promise(r => d.addEventListener('close', () => r(d.returnValue), { once: true }));
  if (choice === 'download') {
    const a = document.createElement('a');
    a.href = latest.zip || 'https://github.com/wisnuub/claude-connector/releases/latest/download/claude-connector.zip';
    a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    await api('POST', '/api/connector/have', { version: latest.version || '' }).catch(() => {});
    return 'downloaded';
  }
  if (choice === 'skip') {
    if (d.querySelector('[name=have]').checked) await api('POST', '/api/connector/have', { version: latest.version || '' }).catch(() => {});
    return 'have';
  }
  return null;
}

async function signIn(url, user, pass) {
  if ((S.settings.loginMode || 'tab') === 'tab') {
    if (await extensionRuntime()) {
      await extensionLogin({ url: loginUrlFor(url), user, pass });
      return 'Opened in a new tab - signing in there.';
    }
    toast('The Site Maintenance Login extension is not installed - using a separate window (see Settings → Log in).');
  }
  const r = await api('POST', '/api/login', { url, user, pass });
  return r.status === 'logged_in' ? 'Signed in - see the browser window.' : r.message;
}

async function renderExtStatus() {
  const el = $('#ext-status');
  if (!el) return;
  el.innerHTML = '<p class="hint">Checking for the extension…</p>';
  const ext = await extensionRuntime();
  el.innerHTML = ext
    ? `<p class="hint" style="margin:0">✓ The Claude Connector extension ${h(ext.version)} is installed in this browser. Click its toolbar icon any time to open this dashboard.</p>`
    : `<div class="notice" style="margin:0">
        <b>Install the Claude Connector extension once</b> (Chrome or Edge, Windows or Mac) so Log in opens a new tab in this browser:
        <ol style="margin:6px 0 6px 18px;padding:0">
          <li>Open <code>chrome://extensions</code> (or <code>edge://extensions</code>) in a new tab.</li>
          <li>Turn on <b>Developer mode</b> (top-right toggle).</li>
          <li>Click <b>Load unpacked</b> and choose the <code>extension</code> folder: <button type="button" class="btn sm" data-action="reveal-extension">Open the folder</button></li>
          <li>Come back here - this message turns into a tick. (Its icon then opens this dashboard in one click.)</li>
        </ol>
        <span class="hint">Folder: <code>${h(S.extensionDir || 'dashboard/extension')}</code>. It only answers this dashboard, and keeps each login in memory for that one tab.</span>
      </div>`;
}

// ── Asana: tasks, logins, Log in ─────────────────────────────────────────────

async function loadAsana() {
  try { S.asana = await api('GET', '/api/asana/status'); } catch { S.asana = { connected: false }; }
}

async function loadTasks(refresh = false) {
  try { S.tasks = await api('GET', `/api/asana/tasks${refresh ? '?refresh=1' : ''}`); }
  catch (e) { S.tasks = { error: e.message, tasks: [] }; }
  if (S.view === 'tasks') renderTasks();
  else if (S.view === 'sites') { renderToolbar(); renderSites(); }
}

function minutes(m) {
  if (m == null) return '';
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/** The login list for a task, with copy / show / Log in for each. */
function loginsBlock(gid, fallbackUrl) {
  const L = S.logins[gid];
  if (!L) return '';
  if (L.busy) return '<p class="muted" style="margin:6px 0">Reading Asana…</p>';
  if (L.error) return `<div class="notice bad" style="margin:6px 0">${h(L.error)}</div>`;
  if (!L.logins.length) return `<div class="notice" style="margin:6px 0">No login found. The dashboard looks for a task called <b>Login</b>, <b>Logins</b>, <b>Login detail</b> or <b>Login details</b> in ${L.task?.project ? `<b>${h(L.task.project)}</b>` : 'the project'} - username on the first line of its description, password on the second - then in this task, the project's description and its comments.</div>`;
  fallbackUrl = fallbackUrl || L.siteUrl;
  return `<div class="tablewrap"><table class="list logins" style="margin:6px 0"><thead><tr><th>Found in</th><th>Address</th><th>Username</th><th>Password</th><th></th></tr></thead><tbody>${L.logins.map((l, i) => {
    const key = `${gid}|${i}`;
    const addr = l.url || fallbackUrl || '';
    return `<tr data-login="${i}" data-gid="${h(gid)}">
      <td class="faint">${l.link ? `<a href="${h(l.link)}" target="_blank" rel="noopener">${h(l.where)}</a>` : h(l.where)}</td>
      <td>${addr ? `<a href="${h(addr)}" target="_blank" rel="noopener">${h(addr.replace(/^https?:\/\//, ''))}</a>` : '<span class="faint">unknown</span>'}</td>
      <td><code>${h(l.user)}</code> <button class="btn sm ghost" data-action="copy-cred" data-k="user">Copy</button></td>
      <td><code>${S.reveal.has(key) ? h(l.pass) : '••••••••'}</code> <button class="btn sm ghost" data-action="reveal-cred">${S.reveal.has(key) ? 'Hide' : 'Show'}</button><button class="btn sm ghost" data-action="copy-cred" data-k="pass">Copy</button></td>
      <td class="acts"><button class="btn sm primary" data-action="log-in" ${addr ? '' : 'title="No address - you will be asked for it"'}>Log in</button></td>
    </tr>`;
  }).join('')}</tbody></table></div>`;
}

async function fetchLogins(gid) {
  S.logins[gid] = { busy: true };
  rerenderLogins();
  try { const r = await api('GET', `/api/asana/logins?task=${encodeURIComponent(gid)}`); S.logins[gid] = { logins: r.logins, task: r.task, siteUrl: r.siteUrl }; }
  catch (e) { S.logins[gid] = { error: e.message }; }
  rerenderLogins();
  loadTasks(); // the login may have taught the dashboard this project's address
}

function rerenderLogins() {
  if (S.view === 'tasks') renderTasks();
  for (const id of S.open) renderSite(id);
}

function asanaTab(site) {
  if (!S.asana) { loadAsana().then(() => renderSite(site.id)); return '<p class="muted">Checking Asana…</p>'; }
  if (!S.asana.connected) return `<div class="notice">Connect Asana in <a href="#" data-action="settings">Settings</a> to see this site's task, post results to it and read its WordPress login.</div>`;
  if (!S.tasks) { loadTasks(); return '<p class="muted">Loading your tasks…</p>'; }
  const link = site.asana;
  const has = t => (t.siteIds || [t.siteId]).includes(site.id);
  const mine = (S.tasks.tasks || []).filter(has);
  const others = (S.tasks.tasks || []).filter(t => !has(t));
  const alsoFor = t => (t.siteIds || []).filter(id => id !== site.id).map(id => S.sites.find(x => x.id === id)?.name || id);
  const opt = t => `<option value="${h(t.gid)}" ${link?.taskGid === t.gid ? 'selected' : ''}>${h(t.project?.name ? `${t.project.name} › ` : '')}${h(t.name)}${alsoFor(t).length ? ` (also: ${h(alsoFor(t).join(', '))})` : ''}</option>`;
  const sharedWith = link ? alsoFor((S.tasks.tasks || []).find(t => t.gid === link.taskGid) || {}) : [];
  return `<div class="grid2">
    <div class="card"><h4>Asana task</h4>
      <label class="field">Results of each run are posted to
        <select data-action="asana-link">
          <option value="">Not linked</option>
          ${mine.length ? `<optgroup label="Matching this site">${mine.map(opt).join('')}</optgroup>` : ''}
          <optgroup label="All my tasks">${others.map(opt).join('')}</optgroup>
          ${link && !(S.tasks.tasks || []).some(t => t.gid === link.taskGid) ? `<option value="${h(link.taskGid)}" selected>${h(link.taskName)} (not in my tasks)</option>` : ''}
        </select>
      </label>
      ${link ? `<p class="hint" style="margin-top:8px">${link.auto ? 'Matched by project name. ' : ''}<a href="${h(link.url)}" target="_blank" rel="noopener">Open in Asana ↗</a>${S.settings.asana.postResults ? '' : ' · posting results is off in Settings'}</p>` : '<p class="hint" style="margin-top:8px">No task matched this site by project name - pick one. A task can be shared: pick the same task on each site it covers.</p>'}
      ${sharedWith.length ? `<p class="hint">Shared with ${h(sharedWith.join(', '))} - each site's comment starts with its name, and each site counts as done only once its own updates are.</p>` : ''}
    </div>
    <div class="card"><h4>Last WordPress update</h4>${taskStatusCard(site)}</div>
    <div class="card" style="grid-column:1/-1"><h4>Comment for Asana</h4>${commentCard(site)}</div>
    <div class="card"><h4>WordPress login</h4>
      ${link ? `<button class="btn sm" data-action="asana-logins" data-gid="${h(link.taskGid)}">${S.logins[link.taskGid] ? 'Read again' : 'Show login from Asana'}</button>${loginsBlock(link.taskGid, site.url)}`
        : '<p class="hint">Link the site\'s Asana task to read its login.</p>'}
    </div>
  </div>`;
}

function taskStatusCard(site) {
  if (!site.asana) return '<p class="hint">Link an Asana task to track its status.</p>';
  if (!(site.id in S.taskStatus)) { loadTaskStatus(site.id); return '<p class="muted">Checking Asana…</p>'; }
  const t = S.taskStatus[site.id];
  if (t === null) return '<p class="muted">Checking Asana…</p>';
  if (t?.error) return `<div class="notice bad">${h(t.error)}</div>`;
  const comment = c => c ? `“${h(c.text)}”<span class="muted"> - ${h(c.by || 'someone')}, ${h(ago(c.at))}</span>` : null;
  const rows = [];
  rows.push(['Status', t.completed
    ? `<span class="pill ok"><span class="dot"></span>Done</span> ${h(t.completedBy ? `marked by ${t.completedBy}` : 'completed')}${t.completedAt ? ` · ${h(new Date(t.completedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }))}` : ''}`
    : `<span class="pill"><span class="dot"></span>Open</span> <span class="muted">not marked complete yet</span>`]);
  if (t.lastDoneComment) rows.push(['Last "update done"', comment(t.lastDoneComment)]);
  rows.push(['Latest comment', comment(t.lastComment) || '<span class="faint">none</span>']);
  // Told the boss but not acknowledged yet?
  const told = t.lastDoneComment && !t.completed;
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${h(k)}</dt><dd>${v}</dd>`).join('')}</dl>
    ${told ? '<p class="hint" style="margin-top:8px">You\'ve already posted an "update done" comment - waiting for it to be marked complete in Asana. No need to comment again.</p>' : ''}
    <div class="bar" style="margin:8px 0 0"><a class="btn sm ghost" href="${h(t.url || site.asana.url)}" target="_blank" rel="noopener">Open in Asana ↗</a><button class="btn sm ghost" data-action="refresh-task-status">Refresh</button></div>`;
}

async function loadTaskStatus(id) {
  S.taskStatus[id] = null; // "loading" marker distinct from undefined
  try {
    const r = await api('GET', `/api/sites/${encodeURIComponent(id)}/asana-task`);
    S.taskStatus[id] = r.linked ? r : { error: 'No Asana task linked.' };
  } catch (e) { S.taskStatus[id] = { error: e.message }; }
  renderSite(id);
}

function commentCard(site) {
  if (!site.asana) return '<p class="hint">Link the site\'s Asana task above to post comments to it.</p>';
  const d = S.drafts[site.id];
  if (!d) { loadDraft(site.id); return '<p class="muted">Writing the comment from the last run…</p>'; }
  if (d.error) return `<div class="notice bad">${h(d.error)}</div>`;
  return `${d.pending ? '<div class="notice" style="margin-bottom:8px">This run\'s comment is waiting for the morning form test. Sending now posts it as written here.</div>' : ''}
    <textarea id="draft-${h(site.id)}" data-draft="${h(site.id)}" rows="3" style="width:100%">${h(d.text)}</textarea>
    <div class="bar" style="margin:8px 0 0">
      <button class="btn sm primary" data-action="send-comment">Send to ${h(site.asana.project ? `${site.asana.project} › ` : '')}${h(site.asana.taskName)}</button>
      <button class="btn sm ghost" data-action="rebuild-comment" title="Start again from the last run">Rewrite from last run</button>
      <span class="grow"></span>
      <span class="hint">${d.basedOn ? `From the run ${h(ago(d.basedOn))}` : 'No run yet'}${S.settings.asana.postResults ? ' · runs also post automatically' : ' · automatic posting is off'}</span>
    </div>`;
}

async function loadDraft(id) {
  try { S.drafts[id] = await api('POST', `/api/sites/${encodeURIComponent(id)}/asana-comment`, {}); }
  catch (e) { S.drafts[id] = { error: e.message }; }
  renderSite(id);
}

const thisMonth = at => { const d = new Date(at), n = new Date(); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth(); };

/** "Updates done" commented in the current calendar month. */
const doneThisMonth = t => !!t.lastDone?.at && thisMonth(t.lastDone.at);

/**
 * Whether one site's updates are done this month. On a task several sites
 * share, the task's latest "done" comment may be about another site, so it
 * counts only when it names this site - or this site posted its own.
 */
function siteDoneThisMonth(siteId, t) {
  const ids = t.siteIds || [t.siteId];
  if (ids.length < 2) return doneThisMonth(t);
  const site = S.sites.find(s => s.id === siteId);
  if (!site) return false;
  if (site.asanaDone?.taskGid === t.gid && thisMonth(site.asanaDone.at)) return true;
  return doneThisMonth(t) && (t.lastDone.text || '').toLowerCase().includes(site.name.toLowerCase());
}

function renderTasks() {
  const el = $('#view-tasks');
  if (!S.asana) { el.innerHTML = '<p class="muted">Checking Asana…</p>'; loadAsana().then(renderTasks); return; }
  if (!S.asana.connected) {
    el.innerHTML = `<div class="empty"><h2>Connect Asana</h2><p>See your tasks here, post each run's results to the site's task, and log in to WordPress with the logins written in Asana.</p>${S.asana.error ? `<p class="notice bad">${h(S.asana.error)}</p>` : ''}<button class="btn primary" data-action="settings">Open Settings</button></div>`;
    return;
  }
  if (!S.tasks) { el.innerHTML = '<p class="muted">Loading your tasks from Asana…</p>'; loadTasks(); return; }
  const q = S.tasksQ.toLowerCase();
  const hiddenDone = (S.tasks.tasks || []).filter(doneThisMonth).length;
  const list = (S.tasks.tasks || []).filter(t => {
    if (!S.showDone && doneThisMonth(t)) return false;
    if (q && !`${t.name} ${t.project?.name || ''} ${t.siteName || ''}`.toLowerCase().includes(q)) return false;
    if (S.tasksShow === 'site') return !!t.siteId;
    if (S.tasksShow === 'nosite') return !t.siteId;
    return true;
  }).sort((a, b) => (a.project?.name || '').localeCompare(b.project?.name || ''));
  const conn = (S.asana.agencies || []).filter(a => a.connected);
  const who = conn.map(a => `${a.label}: ${a.user.name} · ${a.workspaces.find(w => w.gid === a.workspace)?.name || ''}`).join(' | ');
  const agTag = id => { const a = conn.length > 1 && conn.find(x => x.id === id); return a ? `<span class="tag" style="border-color:${h(a.color)};color:${h(a.color)}">${h(a.label)}</span> ` : ''; };
  const focused = document.activeElement?.id === 'tq';
  el.innerHTML = `
    <div class="toolbar">
      <span class="count">${list.length} task${list.length === 1 ? '' : 's'}</span>
      <div class="seg" role="group" aria-label="Show">${[['all', 'All'], ['site', 'Connected'], ['nosite', 'Not connected']].map(([k, l]) => `<button data-action="tasks-show" data-v="${k}" class="${S.tasksShow === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <input type="search" id="tq" placeholder="Search tasks" value="${h(S.tasksQ)}" data-action="search-tasks">
      <label class="check" title="WordPress update tasks with an 'update done' comment this month"><input type="checkbox" data-action="show-done" ${S.showDone ? 'checked' : ''}> Show done this month${hiddenDone ? ` (${hiddenDone})` : ''}</label>
      <span class="grow"></span>
      <span class="muted" style="font-size:13px">${h(who)}${S.tasks.at ? ` · ${h(ago(S.tasks.at))}` : ''}</span>
      <button class="btn sm" data-action="tasks-refresh">↻ Refresh</button>
      ${(() => { const n = wpUpdateTasks().length; return `<button class="btn sm primary" data-action="do-wp-updates" ${n ? '' : 'disabled'} title="Every open WordPress update task whose site is connected">Do WordPress updates (${n})</button>`; })()}
    </div>
    ${S.tasks.error ? `<div class="notice bad">${h(S.tasks.error)}</div>` : ''}
    ${(S.tasks.errors || []).map(e => `<div class="notice warn">Could not read ${h(e.label)}'s Asana: ${h(e.message)}</div>`).join('')}
    <div class="card" style="padding:0">
      <div class="tablewrap"><table class="list tasks">
        <thead><tr><th>Task</th><th>Project</th><th>Site</th><th class="hide-sm">Due</th><th class="hide-sm">Actual time</th><th></th></tr></thead>
        <tbody>${list.map(t => `<tr data-gid="${h(t.gid)}">
          <td><a href="${h(t.url)}" target="_blank" rel="noopener">${h(t.name)}</a>${doneThisMonth(t) ? ` <span class="tag accent" title="${h(`${t.lastDone.text}${t.lastDone.by ? ` - ${t.lastDone.by}` : ''}`)}">✓ updated ${h(new Date(t.lastDone.at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }))}</span>` : ''}</td>
          <td>${agTag(t.agency)}${h(t.project?.name || '')}</td>
          <td>${t.siteId ? (t.siteIds || [t.siteId]).map(id => `<a href="#" data-action="goto-site" data-site="${h(id)}">${h(S.sites.find(x => x.id === id)?.name || id)}</a>`).join(' + ')
            : `<span class="tag" title="Log in works on any site. Updates, form tests and the security check need Claude Connector installed and connected: install it from wp-admin, then click Connect on this Mac (or PC) on its settings page.">Not connected</span>${t.siteUrl ? ` <a href="${h(t.siteUrl)}" target="_blank" rel="noopener" class="faint">${h(t.siteUrl.replace(/^https?:\/\//, '').replace(/\/wp-(admin|login\.php).*$/, ''))}</a>` : ''}`}</td>
          <td class="hide-sm">${t.due ? `<span class="${t.due < new Date().toISOString().slice(0, 10) ? 'ver-arrow' : ''}">${h(new Date(t.due + 'T00:00').toLocaleDateString())}</span>` : ''}</td>
          <td class="hide-sm">${h(minutes(t.minutes))}</td>
          <td class="acts">${t.siteId ? '' : `<button class="btn sm" data-action="install-connector" data-gid="${h(t.gid)}" title="Downloads claude-connector.zip and opens the site's Add Plugins › Upload page, signed in with the login from Asana when there is one">Install connector</button>`}<button class="btn sm" data-action="asana-logins" data-gid="${h(t.gid)}">${S.logins[t.gid] ? 'Hide login' : 'Login'}</button></td>
        </tr>${S.logins[t.gid] ? `<tr class="logins-row"><td colspan="6">${loginsBlock(t.gid, S.sites.find(s => s.id === t.siteId)?.url)}</td></tr>` : ''}`).join('')}</tbody>
      </table></div>
    </div>`;
  if (focused) { const i = $('#tq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
}

/** Sites with an open "WordPress update" task in Asana (see wpUpdateTasks). */
function asanaTodo() { return new Set(wpUpdateTasks().map(t => t.siteId)); }

/** Open "WordPress update(s)" tasks whose site is on the dashboard - one per site. */
function wpUpdateTasks() {
  const seen = new Set(), out = [];
  for (const t of S.tasks?.tasks || []) {
    if (!/^\s*wordpress\s+updates?\s*$/i.test(t.name)) continue;
    // One entry per site - a task shared by several sites gives one for each still to do.
    for (const id of t.siteIds || (t.siteId ? [t.siteId] : [])) {
      if (seen.has(id) || siteDoneThisMonth(id, t)) continue;
      seen.add(id);
      out.push({ ...t, siteId: id });
    }
  }
  return out;
}

function renderAsanaSettings() {
  const el = $('#asana-settings');
  const a = S.asana;
  if (!a) { el.innerHTML = '<p class="muted">Checking…</p>'; loadAsana().then(renderAsanaSettings); return; }
  const st = draft?.asana || S.settings.asana;
  const acct = ag => {
    const head = `<span class="swatch" style="background:${h(ag.color)}"></span><b>${h(ag.label)}</b>`;
    if (!ag.connected) {
      return `<div class="card asana-acct" data-agency="${h(ag.id)}">
        <div class="bar" style="margin:0">${head}<span class="muted">not connected</span></div>
        ${ag.error ? `<div class="notice bad" style="margin:6px 0 0">${h(ag.error)}</div>` : ''}
        <div class="bar" style="margin:6px 0 0"><input type="password" data-asana-token placeholder="${h(ag.label)}'s personal access token" autocomplete="off" style="flex:1"><button type="button" class="btn sm primary" data-action="asana-connect">Connect</button></div>
      </div>`;
    }
    return `<div class="card asana-acct" data-agency="${h(ag.id)}">
      <div class="bar" style="margin:0">${head}<span class="muted">${h(ag.user.name)}${ag.user.email ? ` (${h(ag.user.email)})` : ''}</span><span class="grow"></span><button type="button" class="btn sm ghost danger" data-action="asana-disconnect">Disconnect</button></div>
      <label class="field" style="max-width:360px;margin:6px 0 0">Workspace<select data-asana-workspace>${ag.workspaces.map(w => `<option value="${h(w.gid)}" ${w.gid === ag.workspace ? 'selected' : ''}>${h(w.name)}</option>`).join('')}</select></label>
    </div>`;
  };
  el.innerHTML = `<p class="hint" style="margin:0 0 6px">Each agency can have its own Asana account and workspace - its sites' tasks, comments and logins use it. Create a personal access token in Asana: profile picture → <b>Settings → Apps → Developer apps → + Create new token</b>. Tokens are kept in your Mac's Keychain.</p>
    ${(a.agencies || []).map(acct).join('')}
    ${a.connected ? `
    <label class="check"><input type="checkbox" name="asanaPost" ${st.postResults ? 'checked' : ''}> After each run, post the results as a comment on the site's Asana task automatically (you can always send one by hand from the site's Asana & login tab)</label>
    <label class="field" style="max-width:520px">Comment
      <select name="asanaStyle">
        <option value="short" ${st.commentStyle !== 'detailed' ? 'selected' : ''}>Short - "WP core + plugin update done, test form sent"</option>
        <option value="detailed" ${st.commentStyle === 'detailed' ? 'selected' : ''}>Detailed - every update, what was not done and what failed</option>
      </select>
    </label>
    <label class="check"><input type="checkbox" name="asanaTime" ${st.logTime ? 'checked' : ''}> Also add the run's time to the task's Actual time</label>` : ''}`;
}

// ── Log view ─────────────────────────────────────────────────────────────────

async function loadLog() {
  try { S.log = await api('GET', `/api/log?days=${S.logDays}`); } catch (e) { S.log = { entries: [], error: e.message }; }
  if (S.view === 'log') renderLog();
}

const LOG_CATS = [
  ['updated', 'Updated', 'ok', '✓'],
  ['notdone', 'Not done', 'warn', '–'],
  ['failed', 'Failed', 'bad', '✕'],
  ['notice', 'Check', 'warn', '!'],
];

function siteAgencyLabel(siteId) {
  const site = S.sites.find(s => s.id === siteId);
  return site ? agencyOf(site)?.label || '' : '';
}

/** Log entries after the view's filters, grouped by job, newest first. */
function logJobs() {
  const entries = (S.log?.entries || []).filter(e => {
    if (S.agency !== 'all') { const site = S.sites.find(s => s.id === e.site); if (!site || agencyOf(site)?.id !== S.agency) return false; }
    if (S.logShow === 'problems') return e.log.failed.length || e.log.notdone.length || e.log.notice.length;
    if (S.logShow === 'updates') return e.log.updated.length;
    return true;
  });
  const byJob = new Map();
  for (const e of entries) {
    if (!byJob.has(e.jobId)) byJob.set(e.jobId, { jobId: e.jobId, title: e.title, at: e.at, entries: [] });
    const j = byJob.get(e.jobId);
    j.entries.push(e);
    if (e.at > j.at) j.at = e.at;
  }
  return [...byJob.values()].sort((a, b) => b.at.localeCompare(a.at));
}

function renderLog() {
  const el = $('#view-log');
  if (!S.log) { el.innerHTML = '<p class="muted">Loading…</p>'; loadLog(); return; }
  const list = logJobs();
  const total = { updated: 0, notdone: 0, failed: 0, notice: 0 };
  for (const j of list) for (const e of j.entries) for (const k of Object.keys(total)) total[k] += e.log[k].length;
  el.innerHTML = `
    <div class="toolbar">
      <select data-action="log-days" aria-label="Period">${[7, 30, 90, 365].map(d => `<option value="${d}" ${S.logDays === d ? 'selected' : ''}>Last ${d} days</option>`).join('')}</select>
      <div class="seg" role="group" aria-label="Show">${[['problems', 'Problems'], ['updates', 'Updates'], ['all', 'Everything']].map(([k, l]) => `<button data-action="log-show" data-v="${k}" class="${S.logShow === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${agencies().length > 1 ? `<select data-action="agency-filter" aria-label="Agency"><option value="all">All agencies</option>${agencies().map(a => `<option value="${h(a.id)}" ${S.agency === a.id ? 'selected' : ''}>${h(a.label)}</option>`).join('')}</select>` : ''}
      <span class="count">${total.updated} updated · ${total.notdone} not done · <span style="color:${total.failed ? 'var(--bad)' : 'inherit'}">${total.failed} failed</span></span>
      <span class="grow"></span>
      <button class="btn sm" data-action="log-copy" ${list.length ? '' : 'disabled'}>Copy report</button>
      <button class="btn sm" data-action="log-csv" ${list.length ? '' : 'disabled'}>Download CSV</button>
    </div>
    ${S.log.error ? `<div class="notice bad">${h(S.log.error)}</div>` : ''}
    ${!list.length ? `<div class="empty"><h2>${S.logShow === 'problems' ? 'No problems' : 'Nothing logged'} in the last ${S.logDays} days</h2><p>${S.logShow === 'problems' ? 'Switch to "Everything" to see every run.' : 'Runs from the dashboard appear here.'}</p></div>` : ''}
    ${list.map(j => {
      const c = { updated: 0, notdone: 0, failed: 0 };
      for (const e of j.entries) for (const k of Object.keys(c)) c[k] += e.log[k].length;
      return `<section class="card logjob">
        <h4>${h(j.title)} <span class="muted" style="font-weight:400">· ${h(new Date(j.at).toLocaleString())} ${String(j.jobId).startsWith('asana:') ? '· from Asana' : `· ${j.entries.length} site${j.entries.length === 1 ? '' : 's'} · ${c.updated} updated${c.notdone ? ` · ${c.notdone} not done` : ''}${c.failed ? ` · <span style="color:var(--bad)">${c.failed} failed</span>` : ''}`}</span></h4>
        ${j.entries.map(e => {
          const k = e.status === 'ok' ? 'ok' : e.status === 'warning' ? 'warn' : e.status === 'failed' ? 'bad' : '';
          const ag = siteAgencyLabel(e.site);
          const cats = LOG_CATS.filter(([key]) => e.log[key].length);
          return `<div class="logsite">
            <div class="logsite-h"><span class="pill ${k}"><span class="dot"></span>${h(e.status)}</span> <b>${h(e.siteName)}</b>${ag && agencies().length > 1 ? ` <span class="tag">${h(ag)}</span>` : ''}${e.summary ? ` <span class="muted">· ${h(e.summary)}</span>` : ''}</div>
            ${cats.length ? `<div class="logcats">${cats.map(([key, name, cls, ic]) => `<div class="logcat ${cls}"><div class="logcat-h">${name} (${e.log[key].length})</div><ul>${e.log[key].map(st => `<li><span class="ic">${ic}</span><span>${h(st.label)}${st.detail && key !== 'updated' ? `<span class="d">${h(String(st.detail).split('\n')[0].slice(0, 400))}</span>` : ''}</span></li>`).join('')}</ul></div>`).join('')}</div>`
              : '<p class="muted" style="margin:4px 0 0">Nothing updated, nothing failed.</p>'}
          </div>`;
        }).join('')}
      </section>`;
    }).join('')}
    ${S.logDir ? `<p class="hint">Also written as text files in <code>${h(S.logDir)}</code></p>` : ''}`;
}

function logReportText() {
  const lines = [];
  for (const j of logJobs()) {
    lines.push(`${j.title} - ${new Date(j.at).toLocaleString()}`);
    for (const e of j.entries) {
      const ag = siteAgencyLabel(e.site);
      lines.push(`  ${e.siteName}${ag && agencies().length > 1 ? ` (${ag})` : ''}: ${e.status.toUpperCase()}${e.summary ? ` - ${e.summary}` : ''}`);
      for (const [key, name] of LOG_CATS) for (const st of e.log[key]) {
        lines.push(`    ${name.padEnd(9)} ${st.label}`);
        if (st.detail && key !== 'updated') lines.push(`              ${String(st.detail).split('\n')[0].slice(0, 300)}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function logCsv() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Agency', 'Site', 'Run', 'Result', 'Item', 'From', 'To', 'Details']];
  for (const j of logJobs()) for (const e of j.entries) for (const [key, name] of LOG_CATS) for (const st of e.log[key]) {
    rows.push([new Date(e.at).toLocaleString(), siteAgencyLabel(e.site), e.siteName, e.title, name, st.meta?.name || st.label, st.meta?.from || '', st.meta?.to || '', key === 'updated' ? '' : String(st.detail || st.label).split('\n')[0]]);
  }
  return rows.map(r => r.map(q).join(',')).join('\r\n');
}

// ── Data ─────────────────────────────────────────────────────────────────────

async function load() {
  const d = await api('GET', '/api/state');
  S.version = d.version;
  S.sites = d.sites;
  S.settings = d.settings;
  S.schedule = d.schedule;
  S.failures = d.failures || [];
  S.newSites = new Set(d.newSites || []);
  S.logDir = d.logDir || '';
  S.extensionDir = d.extensionDir || '';
  S.sitesDir = d.sitesDir || '';
  for (const j of d.jobs) S.jobs.set(j.id, j);
  renderAll();
  if (!S.asana) loadAsana().then(() => { if (S.asana?.connected && !S.tasks) loadTasks(); else renderToolbar(); });
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('site', ev => {
    const s = JSON.parse(ev.data);
    const i = S.sites.findIndex(x => x.id === s.id);
    const wasQueued = i >= 0 && !!S.sites[i].formTestQueued;
    if (i >= 0) S.sites[i] = s; else S.sites.push(s);
    delete S.history[s.id];
    renderStats();
    renderSite(s.id);
    if (wasQueued !== !!s.formTestQueued) { if (S.view === 'sites') renderToolbar(); if ($('#dlg-queue').open) renderQueue(); }
  });
  // A connect link handed over by a tab WP Admin just opened (see checkConnectHash).
  es.addEventListener('connect', ev => { queueConnect(JSON.parse(ev.data).link); focusThisTab(); });
  es.addEventListener('schedule', ev => { S.schedule = JSON.parse(ev.data); renderToolbar(); });
  es.addEventListener('failures', ev => { S.failures = JSON.parse(ev.data); renderBanner(); if (S.view === 'log') loadLog(); });
  es.addEventListener('sites', async ev => {
    const { added } = JSON.parse(ev.data);
    await load();
    if (added.length) toast(`New site${added.length === 1 ? '' : 's'} found: ${added.map(a => a.name).join(', ')} - open ${added.length === 1 ? 'it' : 'them'} and press Check`);
  });
  let drawerTimer;
  es.addEventListener('job', ev => {
    const j = JSON.parse(ev.data);
    const prev = S.jobs.get(j.id);
    S.jobs.set(j.id, j);
    if (!prev) { S.drawerMin = false; S.openJobs.add(j.id); }
    if (j.status !== 'running') for (const id of Object.keys(j.sites)) delete S.drafts[id];
    for (const id of Object.keys(j.sites)) renderSite(id);
    clearTimeout(drawerTimer);
    drawerTimer = setTimeout(renderDrawer, 120);
    if (prev?.status === 'running' && j.status !== 'running') {
      renderStats();
      toast(`${j.title}: ${j.status === 'done' ? 'done' : j.status}`);
      if (S.view === 'log') loadLog(); else S.log = null;
    }
  });
  es.onerror = () => { /* EventSource reconnects by itself */ };
}

async function startJob(body, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  try {
    await api('POST', '/api/jobs', body);
  } catch (e) { toast(e.message); }
}

const selectedIds = () => [...S.selected].filter(id => S.sites.some(s => s.id === id && !s.hidden));
const siteOf = el => S.sites.find(s => s.id === el.closest('[data-site]')?.dataset.site);

// ── wordpress.org search ─────────────────────────────────────────────────────

let searchTimer;
async function wporgSearch(q) {
  if (q.trim().length < 2) return [];
  return api('GET', `/api/wporg?q=${encodeURIComponent(q.trim())}`);
}

// ── Settings dialog ──────────────────────────────────────────────────────────

let draft = null;       // working copy of settings while the dialog is open
let draftAgency = null;

function renderAgencyEditor() {
  $('#agency-tabs').innerHTML = draft.agencies.map(a => `<button type="button" class="btn sm ${a.id === draftAgency ? 'on' : ''}" data-action="pick-agency" data-v="${h(a.id)}"><span class="swatch" style="background:${h(a.color)}"></span>${h(a.label)}${a.id === draft.defaultAgency ? ' ★' : ''}</button>`).join('')
    + '<button type="button" class="btn sm ghost" data-action="add-agency">+ Add agency</button>';
  const a = draft.agencies.find(x => x.id === draftAgency);
  const used = S.sites.filter(s => s.agencyId === a.id).length;
  $('#agency-editor').innerHTML = `
    <div class="fields" data-agency-form>
      <label class="field">Agency name<input type="text" data-k="label" value="${h(a.label)}"></label>
      <label class="field">Colour<input type="color" data-k="color" value="${h(a.color)}" style="height:32px;width:64px;padding:2px"></label>
      <label class="field">Name typed into forms<input type="text" data-k="name" value="${h(a.name)}"></label>
      <label class="field">Email<input type="email" data-k="email" value="${h(a.email)}" placeholder="where test replies can go"></label>
      <label class="field">Phone<input type="text" data-k="phone" value="${h(a.phone)}"></label>
      <label class="field">Company<input type="text" data-k="company" value="${h(a.company)}"></label>
      <label class="field full">Subject<input type="text" data-k="subject" value="${h(a.subject)}"></label>
      <label class="field full">Message<textarea data-k="message" rows="3">${h(a.message)}</textarea></label>
      <label class="field full">Trusted administrator emails
        <textarea data-trusted rows="3" placeholder="One per line - you@youragency.com, or @youragency.com for the whole domain">${h((a.trustedAdmins || []).join('\n'))}</textarea>
        <span class="hint">The security check trusts administrators with these emails on this agency's sites, whatever their username, and flags every other administrator. A whole @domain still flags accounts created in the last 30 days. A client's own emails can be trusted per site from its Security tab.</span>
      </label>
      <label class="field full">Dropdowns and radio buttons no rule covers
        <select data-k="choices">
          <option value="first" ${a.choices !== 'random' ? 'selected' : ''}>Pick the first real option</option>
          <option value="random" ${a.choices === 'random' ? 'selected' : ''}>Pick a random option</option>
        </select>
      </label>
    </div>
    <p class="hint">{ref} is replaced with a short code you can search the inbox for. First/last-name fields are split from the name.</p>
    <div>
      <h5 style="margin-bottom:6px">Field rules</h5>
      <p class="hint" style="margin-bottom:8px">For fields the form test cannot guess, or to answer them your way. If a field's label, placeholder or name contains the text on the left, it gets the value on the right. For a dropdown or radio buttons the value picks the option with that text; <code>{random}</code> picks a random option, <code>{first}</code> the first one, and <code>{skip}</code> leaves the field alone. "yes" ticks a single checkbox.</p>
      <div id="rules">${a.rules.map((r, i) => ruleRow(r, i)).join('')}</div>
      <datalist id="rule-values"><option value="{random}"><option value="{first}"><option value="{skip}"><option value="yes"><option value="Google"><option value="{ref}"></datalist>
      <button type="button" class="btn sm" data-action="add-rule" style="margin-top:6px">+ Add rule</button>
    </div>
    <div class="bar" style="margin:0">
      ${a.id === draft.defaultAgency ? '<span class="muted">★ Default - sites with no agency use these details.</span>' : '<button type="button" class="btn sm" data-action="default-agency">Make default</button>'}
      <span class="grow"></span>
      ${draft.agencies.length > 1 ? `<button type="button" class="btn sm ghost danger" data-action="delete-agency">Delete agency${used ? ` (${used} sites move to the default)` : ''}</button>` : ''}
    </div>`;
}

function ruleRow(r, i) {
  return `<div class="bar" data-rule="${i}" style="margin-bottom:6px">
    <input type="text" data-r="match" value="${h(r.match)}" placeholder="Label contains… e.g. hear about us" style="flex:1">
    <input type="text" data-r="value" value="${h(r.value)}" placeholder="Value, e.g. Google or {random}" list="rule-values" style="flex:1">
    <button type="button" class="btn sm ghost danger" data-action="del-rule" aria-label="Remove rule">✕</button>
  </div>`;
}

function readAgencyForm() {
  const a = draft.agencies.find(x => x.id === draftAgency);
  if (!a) return;
  for (const el of document.querySelectorAll('[data-agency-form] [data-k]')) a[el.dataset.k] = el.value;
  const tr = document.querySelector('[data-agency-form] [data-trusted]');
  if (tr) a.trustedAdmins = tr.value.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
  a.rules = [...document.querySelectorAll('#rules [data-rule]')].map(row => ({ match: $('[data-r=match]', row).value, value: $('[data-r=value]', row).value }));
}

function openSettings() {
  draft = JSON.parse(JSON.stringify(S.settings));
  draftAgency = draft.defaultAgency;
  const f = $('#form-settings');
  for (const k of ['allowMajorCore', 'mailTestWhenNoForm', 'showBrowser', 'notifyOnFailure', 'securityAfterUpdate']) f.elements[k].checked = draft[k] !== false && !!draft[k];
  f.elements.concurrency.value = draft.concurrency;
  f.elements.formTestMode.value = draft.formTestMode;
  f.elements.scheduleEnabled.checked = draft.schedule.enabled;
  f.elements.scheduleTime.value = draft.schedule.time;
  f.elements.scheduleWhat.value = draft.schedule.what;
  $('#sched-days').innerHTML = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => `<label class="check"><input type="checkbox" data-day="${i}" ${draft.schedule.days.includes(i) ? 'checked' : ''}>${d}</label>`).join('');
  const hidden = S.sites.filter(s => s.hidden);
  $('#hidden-sites').innerHTML = hidden.length ? `<div class="bar"><span class="muted">${hidden.length} hidden site${hidden.length === 1 ? '' : 's'}: ${hidden.map(s => h(s.name)).join(', ')}</span><button type="button" class="btn sm" data-action="unhide">Show again</button></div>` : '';
  renderAgencyEditor();
  renderAsanaSettings();
  f.elements.loginMode.value = draft.loginMode || 'tab';
  if (f.elements.sitesDir) f.elements.sitesDir.value = draft.sitesDir || '';
  f.elements.trustedHosts.value = (draft.trustedHosts || []).join('\n');
  const sdn = document.getElementById('sites-dir-note'); if (sdn) sdn.textContent = S.sitesDir ? `Currently scanning: ${S.sitesDir}` : '';
  renderExtStatus();
  $('#dlg-settings').showModal();
}

function agencyOptions(sel, current) {
  sel.innerHTML = agencies().map(a => `<option value="${h(a.id)}" ${a.id === current ? 'selected' : ''}>${h(a.label)}${a.id === S.settings.defaultAgency ? ' (default)' : ''}</option>`).join('');
}

// ── Events ───────────────────────────────────────────────────────────────────

let rollbackCtx = null;

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-action]');
  if (ev.target.closest('[data-stop]') && t?.dataset.action === 'toggle-site') return;
  if (!t) return;
  const a = t.dataset.action;
  const site = siteOf(t);

  switch (a) {
    case 'toggle-site': {
      if (ev.target.closest('input, button, a, select, label')) return;
      S.open.has(site.id) ? S.open.delete(site.id) : S.open.add(site.id);
      if (S.newSites.delete(site.id) && !S.newSites.size) api('POST', '/api/sites/seen', {}).catch(() => {});
      renderSite(site.id);
      return;
    }
    case 'select-site':
      ev.stopPropagation();
      t.checked ? S.selected.add(site.id) : S.selected.delete(site.id);
      renderToolbar(); renderSite(site.id);
      if (agencies().length > 1) renderSites();
      return;
    case 'select-all': {
      const vis = visibleSites();
      const on = t.checked;
      for (const s of vis) on ? S.selected.add(s.id) : S.selected.delete(s.id);
      renderToolbar(); renderSites();
      return;
    }
    case 'select-group': {
      const g = t.closest('[data-group]').dataset.group;
      for (const s of visibleSites().filter(s => agencyOf(s)?.id === g)) t.checked ? S.selected.add(s.id) : S.selected.delete(s.id);
      renderToolbar(); renderSites();
      return;
    }
    case 'toggle-group': {
      const g = t.closest('[data-group]').dataset.group;
      S.collapsed.has(g) ? S.collapsed.delete(g) : S.collapsed.add(g);
      renderSites();
      return;
    }
    case 'group-maintain': {
      const g = t.closest('[data-group]').dataset.group;
      const ids = visibleSites().filter(s => agencyOf(s)?.id === g).map(s => s.id);
      const ag = agencies().find(x => x.id === g);
      return openReview(ids, `Update everything for ${ag.label} (${ids.length} site${ids.length === 1 ? '' : 's'})`);
    }
    case 'filter':
      S.filter = t.dataset.v;
      if (S.filter === 'asana' && !S.tasks) loadTasks();
      renderToolbar(); renderSites(); return;
    case 'scan-sites': {
      const dir = $('#form-settings').elements.sitesDir.value.trim();
      t.disabled = true;
      try {
        S.settings = await api('POST', '/api/settings', { sitesDir: dir });
        const r = await api('POST', '/api/sites/scan', {});
        S.sitesDir = r.dir;
        document.getElementById('sites-dir-note').textContent = `Scanned ${r.dir} - ${r.sites} site${r.sites === 1 ? '' : 's'} found.`;
        await load();
      } catch (e) { toast(e.message); }
      t.disabled = false;
      return;
    }
    case 'reveal-extension': await api('POST', '/api/extension/reveal', {}).catch(e => toast(e.message)); return;
    case 'asana-connect': {
      const box = t.closest('[data-agency]');
      const agency = box.dataset.agency;
      t.disabled = true;
      try {
        S.asana = await api('POST', '/api/asana/connect', { token: $('[data-asana-token]', box).value, agency });
        S.tasks = null;
        // The workspace picked on connect must survive this dialog's Save.
        const ws = S.asana.agencies.find(x => x.id === agency)?.workspace;
        const da = draft?.agencies.find(x => x.id === agency);
        if (da) da.asana = { ...(da.asana || {}), workspace: ws || null };
      } catch (e) {
        S.asana = { ...(S.asana || {}), agencies: (S.asana?.agencies || []).map(x => x.id === agency ? { ...x, connected: false, error: e.message } : x) };
      }
      renderAsanaSettings();
      return;
    }
    case 'asana-disconnect': {
      const agency = t.closest('[data-agency]').dataset.agency;
      const label = S.asana.agencies.find(x => x.id === agency)?.label || agency;
      if (!confirm(`Disconnect ${label}'s Asana? Its token is removed from the Keychain.`)) return;
      await api('POST', '/api/asana/disconnect', { agency }).catch(() => {});
      await loadAsana(); S.tasks = null; S.logins = {};
      renderAsanaSettings();
      return;
    }
    case 'tasks-refresh': S.tasks = null; renderTasks(); loadTasks(true); return;
    case 'do-wp-updates': {
      const list = wpUpdateTasks();
      // Results go to these tasks: link each site to its WordPress update task first.
      for (const t of list) {
        const site = S.sites.find(s => s.id === t.siteId);
        if (site?.asana?.taskGid !== t.gid) await api('POST', '/api/asana/link', { site: t.siteId, task: { gid: t.gid, name: t.name, url: t.url, project: t.project, agency: t.agency } }).catch(() => {});
      }
      return openReview(list.map(t => t.siteId), `WordPress update tasks - ${list.length} site${list.length === 1 ? '' : 's'}`);
    }
    case 'refresh-task-status': delete S.taskStatus[site.id]; renderSite(site.id); return;
    case 'send-comment': {
      const ta = $(`#draft-${CSS.escape(site.id)}`);
      t.disabled = true;
      try {
        const r = await api('POST', `/api/sites/${encodeURIComponent(site.id)}/asana-comment`, { text: ta.value });
        toast(`Posted to ${r.project ? `${r.project} › ` : ''}${r.task}`);
        delete S.drafts[site.id];
        delete S.taskStatus[site.id];
        loadTasks();
        renderSite(site.id);
      } catch (e) { toast(e.message); t.disabled = false; }
      return;
    }
    case 'rebuild-comment': delete S.drafts[site.id]; renderSite(site.id); return;
    case 'tasks-show': S.tasksShow = t.dataset.v; renderTasks(); return;
    case 'goto-site': {
      ev.preventDefault();
      S.view = 'sites'; S.open.add(t.dataset.site); S.tab[t.dataset.site] = 'asana';
      renderAll();
      document.querySelector(`[data-site="${CSS.escape(t.dataset.site)}"]`)?.scrollIntoView({ block: 'start' });
      return;
    }
    case 'asana-logins': {
      const gid = t.dataset.gid;
      // In the task list the button toggles; in a site panel it reads again.
      if (S.view === 'tasks' && S.logins[gid] && !S.logins[gid].busy) { delete S.logins[gid]; renderTasks(); return; }
      return fetchLogins(gid);
    }
    case 'reveal-cred': {
      const row = t.closest('[data-login]');
      const key = `${row.dataset.gid}|${row.dataset.login}`;
      S.reveal.has(key) ? S.reveal.delete(key) : S.reveal.add(key);
      rerenderLogins();
      return;
    }
    case 'copy-cred': {
      const row = t.closest('[data-login]');
      const l = S.logins[row.dataset.gid].logins[Number(row.dataset.login)];
      try { await navigator.clipboard.writeText(t.dataset.k === 'user' ? l.user : l.pass); toast(`${t.dataset.k === 'user' ? 'Username' : 'Password'} copied`); }
      catch { toast('Could not copy - the browser blocked clipboard access'); }
      return;
    }
    case 'install-connector': {
      // You upload and activate it yourself; the dashboard only gets you to the right page with the file ready.
      const gid = t.dataset.gid;
      const task = (S.tasks?.tasks || []).find(x => x.gid === gid);
      t.disabled = true;
      t.textContent = 'Opening…';
      try {
        if (!S.logins[gid]?.logins) await fetchLogins(gid);
        const L = S.logins[gid] || {};
        const login = (L.logins || [])[0];
        let url = login?.url || task?.siteUrl || L.siteUrl;
        if (!url) {
          url = prompt(`Site address for ${task?.project?.name || 'this task'} (e.g. https://example.com.au) - remembered for next time`);
          if (!url) return;
          if (!/^https?:\/\//.test(url)) url = `https://${url.trim()}`;
          await api('POST', '/api/asana/site-url', { project: L.task?.projectGid || task?.project?.gid, url }).catch(() => {});
        }
        const base = url.replace(/\/(wp-admin|wp-login\.php).*$/, '').replace(/\/+$/, '');
        const upload = `${base}/wp-admin/plugin-install.php?tab=upload`;
        const got = await ensureConnectorZip();
        if (!got) return;
        if (login) await signIn(upload, login.user, login.pass);
        else window.open(upload, '_blank', 'noopener');
        toast(`${got === 'downloaded' ? 'claude-connector.zip is downloading. ' : ''}On the page that opened: choose claude-connector.zip, Install Now, then Activate - it lands on Connect on this Mac (or PC).`);
      } catch (e) { toast(`Could not open the upload page: ${e.message}`); }
      finally { t.disabled = false; t.textContent = 'Install connector'; }
      return;
    }
    case 'log-in': {
      const row = t.closest('[data-login]');
      const gid = row.dataset.gid;
      const l = S.logins[gid].logins[Number(row.dataset.login)];
      const task = (S.tasks?.tasks || []).find(x => x.gid === gid);
      const proj = S.logins[gid].task;
      let url = l.url || S.sites.find(s => s.id === (site?.id || task?.siteId))?.url || S.logins[gid].siteUrl;
      if (!url) {
        url = prompt(`Site address for ${proj?.project || task?.project?.name || 'this login'} (e.g. https://example.com.au) - remembered for next time`);
        if (!url) return;
        if (!/^https?:\/\//.test(url)) url = `https://${url.trim()}`;
        await api('POST', '/api/asana/site-url', { project: proj?.projectGid, url }).catch(() => {});
        S.logins[gid].siteUrl = url;
        loadTasks();
      }
      t.disabled = true;
      t.textContent = 'Opening…';
      try { toast(await signIn(url, l.user, l.pass)); }
      catch (e) { toast(`Log in failed: ${e.message}`); }
      t.disabled = false;
      t.textContent = 'Log in';
      return;
    }
    case 'view': S.view = t.dataset.v; if (S.view === 'log') { S.log = null; } renderAll(); window.scrollTo(0, 0); return;
    case 'dismiss-failures': await api('POST', '/api/failures/dismiss', {}).catch(e => toast(e.message)); return;
    case 'log-show': S.logShow = t.dataset.v; renderLog(); return;
    case 'log-copy': {
      try { await navigator.clipboard.writeText(logReportText()); toast('Report copied - paste it into an email or chat'); }
      catch { toast('Could not copy - your browser blocked clipboard access'); }
      return;
    }
    case 'log-csv': {
      const blob = new Blob(['\ufeff' + logCsv()], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const d = new Date();
      a.download = `maintenance-log-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    case 'tab': S.tab[site.id] = t.dataset.v; renderSite(site.id); return;
    case 'toggle-drawer': S.drawerMin = !S.drawerMin; renderDrawer(); return;
    case 'toggle-job': {
      const id = t.closest('[data-job]').dataset.job;
      S.openJobs.has(id) ? S.openJobs.delete(id) : S.openJobs.add(id);
      renderDrawer();
      return;
    }

    case 'check-all': return startJob({ type: 'check', sites: S.sites.filter(s => !s.hidden).map(s => s.id) });
    case 'bulk-refresh': return startJob({ type: 'refresh', sites: selectedIds() });
    case 'bulk-check': return startJob({ type: 'check', sites: selectedIds() });
    case 'bulk-maintain': {
      return openReview(selectedIds());
    }
    case 'bulk-queue': {
      await api('POST', '/api/jobs', { type: 'queue-form', sites: selectedIds() }).catch(e => toast(e.message));
      toast(`Queued ${selectedIds().length} site(s) for the morning form test`);
      return;
    }
    case 'run-queue': {
      const ids = S.sites.filter(s => !s.hidden && s.formTestQueued).map(s => s.id);
      if (!ids.length) return;
      return startJob({ type: 'formtest', sites: ids }, `Run the ${ids.length} queued form test(s) now? Each sends a real enquiry.`);
    }
    case 'open-queue': renderQueue(); $('#dlg-queue').showModal(); return;
    case 'queue-run-one': return startJob({ type: 'formtest', sites: [site.id] }, `Run the form test on ${site.name} now? It sends a real enquiry.`);
    case 'queue-remove': {
      if (site.asanaWaiting && !confirm(`Remove ${site.name} from the queue?\n\nThe last run's Asana comment was waiting for this form test - send it from the site's Asana & login tab.`)) return;
      await api('POST', '/api/jobs', { type: 'queue-form', sites: [site.id], queued: false }).catch(e => toast(e.message));
      return;
    }
    case 'queue-clear': {
      const ids = S.sites.filter(s => !s.hidden && s.formTestQueued).map(s => s.id);
      if (!ids.length || !confirm(`Remove all ${ids.length} site(s) from the form test queue?`)) return;
      await api('POST', '/api/jobs', { type: 'queue-form', sites: ids, queued: false }).catch(e => toast(e.message));
      return;
    }
    case 'queue-settings': $('#dlg-queue').close(); openSettings(); document.querySelector('#form-settings [name=scheduleEnabled]')?.scrollIntoView({ block: 'center' }); return;
    case 'bulk-form': return startJob({ type: 'formtest', sites: selectedIds() }, `Submit the contact form on ${selectedIds().length} site(s)? Each sends a real enquiry to that site's form recipients.`);
    case 'bulk-plugin': {
      const f = $('#form-plugin');
      f.reset();
      $('[data-n]', f).textContent = `${selectedIds().length} site${selectedIds().length === 1 ? '' : 's'}`;
      $('[data-results]', f).hidden = true;
      $('[data-install-only]', f).hidden = false;
      $('#dlg-plugin').showModal();
      return;
    }
    case 'bulk-agency': {
      const f = $('#form-agency');
      $('[data-n]', f).textContent = `${selectedIds().length} site${selectedIds().length === 1 ? '' : 's'}`;
      agencyOptions(f.elements.agencyId, S.settings.defaultAgency);
      $('#dlg-agency').showModal();
      return;
    }
    case 'rv-all': case 'rv-none':
      for (const b of document.querySelectorAll(`#review-body input[data-rv="${CSS.escape(t.dataset.site)}"]:not(:disabled)`)) b.checked = a === 'rv-all';
      updateReviewCount();
      return;
    case 'rv-hold': {
      const target = S.sites.find(s => s.id === t.dataset.site);
      const held = !isHeld(target, t.dataset.key);
      try {
        const r = await api('POST', '/api/sites/held', { site: target.id, key: t.dataset.key, held });
        target.held = r.held;
      } catch (e) { return toast(e.message); }
      renderReview();
      renderSite(target.id);
      return;
    }
    case 'run-review': {
      ev.preventDefault();
      const f = $('#form-review');
      const exclude = {};
      for (const b of document.querySelectorAll('#review-body input[data-rv]')) {
        if (!b.checked && !b.disabled) (exclude[b.dataset.rv] ||= []).push(b.dataset.key);
      }
      const ids = reviewSites();
      $('#dlg-review').close();
      if (!ids.length) return;
      return startJob({ type: 'maintain', sites: ids, exclude, formTest: f.elements.formTest.value, allowMajorCore: f.elements.allowMajorCore.checked });
    }
    case 'plugin-hold': case 'theme-hold': {
      const key = a === 'plugin-hold' ? `plugin:${t.closest('[data-file]').dataset.file}` : `theme:${t.closest('[data-theme]').dataset.theme}`;
      try {
        const r = await api('POST', '/api/sites/held', { site: site.id, key, held: !isHeld(site, key) });
        site.held = r.held;
        renderSite(site.id);
        renderStats();
      } catch (e) { toast(e.message); }
      return;
    }
    case 'run-assign': {
      ev.preventDefault();
      const f = $('#form-agency');
      await api('POST', '/api/sites/meta', { sites: selectedIds(), agencyId: f.elements.agencyId.value }).catch(e => toast(e.message));
      $('#dlg-agency').close();
      await load();
      return;
    }
    case 'run-plugin-bulk': {
      ev.preventDefault();
      const f = $('#form-plugin');
      const action = f.elements.action.value;
      const slug = f.elements.slug.value.trim();
      if (!slug) { f.elements.slug.focus(); return; }
      const ids = selectedIds();
      if (action === 'delete' && !confirm(`Delete ${slug} from ${ids.length} site(s)? This removes its files.`)) return;
      $('#dlg-plugin').close();
      return startJob({ type: 'plugin', sites: ids, action, slug, activate: f.elements.activate.checked });
    }
    case 'pick-slug': {
      const f = $('#form-plugin');
      f.elements.slug.value = t.dataset.slug;
      $('[data-results]', f).hidden = true;
      return;
    }

    case 'site-maintain': {
      ev.stopPropagation();
      return openReview([site.id], `Update everything on ${site.name}`);
    }
    case 'site-refresh': return startJob({ type: 'refresh', sites: [site.id] });
    case 'site-check': ev.stopPropagation(); return startJob({ type: 'check', sites: [site.id] });
    case 'site-form': return startJob({ type: 'formtest', sites: [site.id], url: site.formUrl || undefined }, `Submit the contact form on ${site.name}? It sends a real enquiry to the form's recipients.`);
    case 'site-mail': return startJob({ type: 'mailtest', sites: [site.id] });
    case 'check-divi': return startJob({ type: 'diviforms', sites: [site.id] });
    case 'bulk-divi': return startJob({ type: 'diviforms', sites: selectedIds() });
    case 'set-divi-pattern': {
      const box = t.closest('.divi-form');
      const pattern = $('textarea[data-pattern]', box).value;
      if (!confirm(`Set this Message Pattern on ${site.name}?\n\n${pattern}\n\nThe current one is kept on the site and can be put back.`)) return;
      t.disabled = true;
      try {
        const r = await api('POST', `/api/sites/${encodeURIComponent(site.id)}/divi-pattern`, { post_id: Number(box.dataset.post), index: Number(box.dataset.index), pattern });
        toast(r.missing?.length || r.unknown?.length ? 'Saved - some placeholders still match no field' : 'Pattern saved - the form now emails every field');
      } catch (e) { toast(e.message); t.disabled = false; }
      return;
    }
    case 'site-security': S.tab[site.id] = 'security'; return startJob({ type: 'security', sites: [site.id] });
    case 'bulk-security': return startJob({ type: 'security', sites: selectedIds() });
    case 'open-editor': {
      ev.stopPropagation();
      t.disabled = true;
      try {
        const r = await api('POST', `/api/sites/${encodeURIComponent(site.id)}/open-editor`, {});
        toast(r.opened ? `Opening ${site.name} in VS Code` : `VS Code did not open - the workspace is ${r.folder}`);
      } catch (e) { toast(e.message); }
      t.disabled = false;
      return;
    }
    case 'claude-review': {
      t.disabled = true;
      try {
        const r = await api('POST', `/api/sites/${encodeURIComponent(site.id)}/claude-review`, {});
        toast(r.opened ? 'Opened in VS Code - ask Claude to "investigate SECURITY-REPORT.md"' : `Report written to ${r.file} - VS Code did not open`);
      } catch (e) { toast(e.message); }
      t.disabled = false;
      return;
    }
    case 'find-forms': {
      t.disabled = true;
      try { await api('POST', `/api/sites/${encodeURIComponent(site.id)}/forms`, {}); } catch (e) { toast(e.message); }
      return;
    }
    case 'form-custom': {
      const url = prompt('URL of the page with the form', site.formUrl || site.url + '/contact/');
      if (url) await api('POST', '/api/sites/meta', { sites: [site.id], formUrl: url }).catch(e => toast(e.message));
      return;
    }
    case 'site-hide': {
      if (!confirm(`Hide ${site.name}? Its ~/claude-sites folder is not touched; show it again from Settings.`)) return;
      await api('DELETE', `/api/sites/${encodeURIComponent(site.id)}`).catch(e => toast(e.message));
      await load();
      return;
    }
    case 'site-delete': {
      const hard = site.source !== 'manual';
      const msg = hard
        ? `Delete ${site.name} from the dashboard AND delete its workspace folder (~/claude-sites/${site.name})?\n\nThis removes the connection to the site for good. The WordPress site itself is not touched. You'd set it up again with "Connect on this Mac".`
        : `Remove ${site.name} from the dashboard?`;
      if (!confirm(msg)) return;
      await api('DELETE', `/api/sites/${encodeURIComponent(site.id)}${hard ? '?hard=1' : ''}`).catch(e => toast(e.message));
      await load();
      toast(`${site.name} removed`);
      return;
    }
    case 'sec-ack':
    case 'sec-ack-all':
    case 'sec-unack': {
      const keys = (t.dataset.keys || t.dataset.key || '').split(',').filter(Boolean);
      let note = '';
      if (a !== 'sec-unack') {
        note = prompt(`Mark ${keys.length === 1 ? 'this item' : `these ${keys.length} items`} checked - reviewed and fine? It stops counting as a warning until it changes.\n\nOptional note (why it is fine):`, '');
        if (note === null) return;
      }
      try { await api('POST', `/api/sites/${encodeURIComponent(site.id)}/security-ack`, { keys, note, undo: a === 'sec-unack' }); }
      catch (e) { toast(e.message); }
      return;
    }
    case 'trust-host': {
      const host = t.dataset.host;
      if (!confirm(`Trust ${host} as a widget on every site?\n\nIts scripts and iframes will no longer be flagged. Only do this for a service you recognise - you can remove it in Settings.`)) return;
      try {
        const r = await api('POST', '/api/trusted-hosts', { add: host });
        S.settings.trustedHosts = r.trustedHosts;
        renderSite(site.id);
        toast(`${host} trusted - run the security check again to clear its warnings`);
      } catch (e) { toast(e.message); }
      return;
    }
    case 'save-trusted': {
      const box = t.closest('details').querySelector('[data-trusted-site]');
      t.disabled = true;
      try {
        const r = await api('POST', `/api/sites/${encodeURIComponent(site.id)}/trusted`, { set: box.value });
        toast(`${r.trustedAdmins.length} trusted email${r.trustedAdmins.length === 1 ? '' : 's'} saved${r.rejected.length ? ` - not an email, left out: ${r.rejected.join(', ')}` : ''}. Run the security check again to update the results.`);
      } catch (e) { toast(e.message); }
      t.disabled = false;
      return;
    }
    case 'save-careful': {
      const box = t.closest('.careful-box');
      const on = $('[data-careful]', box).checked;
      try {
        await api('POST', '/api/sites/meta', { sites: [site.id], careful: on ? { note: $('[data-careful-note]', box).value } : null });
        toast(on ? 'Marked Handle with care' : 'No longer marked Handle with care');
      } catch (e) { toast(e.message); }
      return;
    }
    case 'trust-admin':
    case 'untrust-admin': {
      const email = t.dataset.email;
      if (t.dataset.action === 'trust-admin' && !confirm(`Trust ${email} as an administrator of ${site.name}?\n\nOnly do this for an account you know is genuine - the security check stops flagging it.`)) return;
      try {
        await api('POST', `/api/sites/${encodeURIComponent(site.id)}/trusted`, t.dataset.action === 'trust-admin' ? { add: email } : { remove: email });
        toast('Saved - run the security check again to update the results');
      } catch (e) { toast(e.message); }
      return;
    }
    case 'theme-delete': {
      const ss = t.closest('[data-theme]').dataset.theme;
      const th = site.overview.themes.find(x => x.stylesheet === ss);
      const { keep } = unusedThemes(site.overview);
      const lastDefault = keep && keep.stylesheet === ss;
      if (!confirm(`Delete the theme “${th?.name || ss}” from ${site.name}?\n\nIts files are removed from the server (not moved to quarantine).${lastDefault ? '\n\nIt is the only default WordPress theme left - WordPress falls back to it if the active theme breaks.' : ''}`)) return;
      return startJob({ type: 'theme-delete', sites: [site.id], stylesheets: [ss] });
    }
    case 'themes-delete-unused': {
      const { remove, keep } = unusedThemes(site.overview);
      if (!remove.length) return;
      if (!confirm(`Delete ${remove.length} unused theme${remove.length === 1 ? '' : 's'} from ${site.name}?\n\n${remove.map(x => `• ${x.name}`).join('\n')}\n\nTheir files are removed from the server.${keep ? `\n${keep.name} is kept as the fallback theme.` : ''}`)) return;
      return startJob({ type: 'theme-delete', sites: [site.id], stylesheets: remove.map(x => x.stylesheet) });
    }
    case 'site-url': {
      S.editUrl = site.id;
      S.urlDraft = site.url;
      renderSites();
      document.querySelector(`[data-site="${CSS.escape(site.id)}"]`)?.scrollIntoView({ block: 'nearest' });
      focusUrl();
      document.querySelector('[data-url-input]')?.select();
      return;
    }
    case 'save-url': return saveUrl(site);
    case 'cancel-url': S.editUrl = null; renderSites(); return;

    case 'select-plugin': {
      const sel = S.pluginSel[site.id] || (S.pluginSel[site.id] = new Set());
      const file = t.closest('[data-file]').dataset.file;
      t.checked ? sel.add(file) : sel.delete(file);
      renderSite(site.id);
      return;
    }
    case 'select-all-plugins': {
      S.pluginSel[site.id] = new Set(t.checked ? site.overview.plugins.map(p => p.file) : []);
      renderSite(site.id);
      return;
    }
    case 'toggle-plugin': {
      const file = t.closest('[data-file]').dataset.file;
      return startJob({ type: 'plugin', sites: [site.id], action: t.checked ? 'activate' : 'deactivate', files: [file] });
    }
    case 'plugin-update': {
      const file = t.closest('[data-file]').dataset.file;
      const p = site.overview.plugins.find(x => x.file === file);
      return startJob({ type: 'update', sites: [site.id], items: [{ type: 'plugin', item: file, name: p.name }] });
    }
    case 'plugin-delete': {
      const file = t.closest('[data-file]').dataset.file;
      const p = site.overview.plugins.find(x => x.file === file);
      return startJob({ type: 'plugin', sites: [site.id], action: 'delete', files: [file] }, `Delete ${p.name} from ${site.name}? This removes its files.`);
    }
    case 'plugins-bulk': {
      const files = [...(S.pluginSel[site.id] || [])].filter(f => site.overview.plugins.some(p => p.file === f && !(p.self && ['deactivate', 'delete'].includes(t.dataset.v))));
      if (!files.length) return toast('Claude Connector cannot be deactivated or deleted from here.');
      const action = t.dataset.v;
      if (action === 'update') {
        const items = files.map(f => site.overview.plugins.find(p => p.file === f)).filter(p => p.update && p.update.package).map(p => ({ type: 'plugin', item: p.file, name: p.name }));
        if (!items.length) return toast('None of the selected plugins has an update to install.');
        S.pluginSel[site.id].clear();
        return startJob({ type: 'update', sites: [site.id], items });
      }
      S.pluginSel[site.id].clear();
      return startJob({ type: 'plugin', sites: [site.id], action, files }, action === 'delete' ? `Delete ${files.length} plugin(s) from ${site.name}? This removes their files.` : undefined);
    }
    case 'plugins-update-all': {
      const items = site.overview.plugins.filter(p => p.update && p.update.package).map(p => ({ type: 'plugin', item: p.file, name: p.name }));
      return startJob({ type: 'update', sites: [site.id], items });
    }
    case 'plugin-install':
      return startJob({ type: 'plugin', sites: [site.id], action: 'install', slug: t.dataset.slug, activate: !!t.dataset.activate });
    case 'plugin-rollback': {
      rollbackCtx = { site: site.id, slug: t.dataset.slug, file: t.closest('[data-file]').dataset.file };
      const f = $('#form-rollback');
      $('[data-name]', f).textContent = t.dataset.name;
      f.elements.version.innerHTML = '<option>Loading…</option>';
      $('#dlg-rollback').showModal();
      try {
        const v = await api('GET', `/api/wporg/versions?slug=${encodeURIComponent(t.dataset.slug)}`);
        const installed = site.overview.plugins.find(p => p.file === rollbackCtx.file)?.version;
        f.elements.version.innerHTML = v.versions.map(x => `<option value="${h(x)}" ${x === installed ? 'disabled' : ''}>${h(x)}${x === installed ? ' (installed)' : ''}${x === v.current ? ' (latest)' : ''}</option>`).join('');
        const firstOlder = v.versions.find(x => x !== installed && x !== v.current);
        if (firstOlder) f.elements.version.value = firstOlder;
      } catch (e) { f.elements.version.innerHTML = `<option>${h(e.message)}</option>`; }
      return;
    }
    case 'run-rollback': {
      ev.preventDefault();
      const v = $('#form-rollback').elements.version.value;
      $('#dlg-rollback').close();
      return startJob({ type: 'plugin', sites: [rollbackCtx.site], action: 'install', slug: rollbackCtx.slug, version: v });
    }
    case 'theme-update': {
      const st = t.closest('[data-theme]').dataset.theme;
      const th = site.overview.themes.find(x => x.stylesheet === st);
      return startJob({ type: 'update', sites: [site.id], items: [{ type: 'theme', item: st, name: th.name }] });
    }
    case 'themes-update-all': {
      const items = site.overview.themes.filter(x => x.update && x.update.package).map(x => ({ type: 'theme', item: x.stylesheet, name: x.name }));
      return startJob({ type: 'update', sites: [site.id], items });
    }
    case 'core-update': {
      const major = !!t.dataset.major;
      const v = major ? site.overview.core.major.version : site.overview.core.minor.version;
      return startJob({ type: 'update', sites: [site.id], items: [{ type: 'core', name: `WordPress ${v}` }], allowMajorCore: major }, major ? `Update ${site.name} to WordPress ${v}? Major updates can break older plugins and themes - there is no automatic rollback for core.` : undefined);
    }
    case 'translations-update': return startJob({ type: 'update', sites: [site.id], items: [{ type: 'translations', name: 'Translations' }] });

    // Settings
    case 'settings': return openSettings();
    case 'pick-agency': readAgencyForm(); draftAgency = t.dataset.v; renderAgencyEditor(); return;
    case 'add-agency': {
      readAgencyForm();
      const base = draft.agencies.find(x => x.id === draft.defaultAgency);
      const id = `agency-${Date.now().toString(36)}`;
      const colors = ['#2459d6', '#c2410c', '#0f766e', '#7c3aed', '#be185d', '#4d7c0f'];
      draft.agencies.push({ ...base, id, label: `Agency ${draft.agencies.length + 1}`, color: colors[draft.agencies.length % colors.length], rules: [] });
      draftAgency = id;
      renderAgencyEditor();
      return;
    }
    case 'default-agency': readAgencyForm(); draft.defaultAgency = draftAgency; renderAgencyEditor(); return;
    case 'delete-agency': {
      draft.agencies = draft.agencies.filter(x => x.id !== draftAgency);
      if (draft.defaultAgency === draftAgency) draft.defaultAgency = draft.agencies[0].id;
      draftAgency = draft.defaultAgency;
      renderAgencyEditor();
      return;
    }
    case 'add-rule': {
      readAgencyForm();
      draft.agencies.find(x => x.id === draftAgency).rules.push({ match: '', value: '' });
      renderAgencyEditor();
      $('#rules [data-rule]:last-child [data-r=match]')?.focus();
      return;
    }
    case 'del-rule': {
      readAgencyForm();
      const i = Number(t.closest('[data-rule]').dataset.rule);
      draft.agencies.find(x => x.id === draftAgency).rules.splice(i, 1);
      renderAgencyEditor();
      return;
    }
    case 'unhide': await api('POST', '/api/sites/unhide', {}); await load(); openSettings(); return;
    case 'save-settings': {
      ev.preventDefault();
      readAgencyForm();
      const f = $('#form-settings');
      for (const k of ['allowMajorCore', 'mailTestWhenNoForm', 'showBrowser', 'notifyOnFailure', 'securityAfterUpdate']) draft[k] = f.elements[k].checked;
      draft.concurrency = Number(f.elements.concurrency.value);
      draft.formTestMode = f.elements.formTestMode.value;
      draft.loginMode = f.elements.loginMode.value;
      if (f.elements.sitesDir) draft.sitesDir = f.elements.sitesDir.value.trim();
      draft.trustedHosts = f.elements.trustedHosts.value.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
      if (f.elements.asanaPost) {
        draft.asana = { ...draft.asana, postResults: f.elements.asanaPost.checked, logTime: f.elements.asanaTime.checked, commentStyle: f.elements.asanaStyle.value };
      }
      for (const sel of document.querySelectorAll('#asana-settings [data-asana-workspace]')) {
        const da = draft.agencies.find(x => x.id === sel.closest('[data-agency]').dataset.agency);
        if (da && da.asana?.workspace !== sel.value) { da.asana = { ...(da.asana || {}), workspace: sel.value }; S.tasks = null; }
      }
      draft.schedule = {
        enabled: f.elements.scheduleEnabled.checked,
        time: f.elements.scheduleTime.value || '08:30',
        what: f.elements.scheduleWhat.value,
        days: [...document.querySelectorAll('#sched-days [data-day]')].filter(x => x.checked).map(x => Number(x.dataset.day)),
      };
      try {
        S.settings = await api('POST', '/api/settings', draft);
        $('#dlg-settings').close();
        await load();
        toast('Settings saved');
      } catch (e) { toast(e.message); }
      return;
    }
    case 'add-site': {
      const f = $('#form-add');
      f.reset();
      agencyOptions(f.elements.agencyId, S.agency !== 'all' ? S.agency : S.settings.defaultAgency);
      $('#dlg-add').showModal();
      return;
    }
    case 'save-site': {
      const f = $('#form-add');
      if (!f.reportValidity()) { ev.preventDefault(); return; }
      ev.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      try {
        await api('POST', '/api/sites', body);
        await load();
        const added = S.sites.find(s => s.url.replace(/\/+$/, '') === body.url.replace(/\/+$/, '') || s.url === `https://${body.url}`);
        if (added) {
          await api('POST', '/api/sites/meta', { sites: [added.id], agencyId: body.agencyId });
          startJob({ type: 'refresh', sites: [added.id] });
        }
        $('#dlg-add').close();
      } catch (e) { toast(e.message); }
      return;
    }
  }
});

document.addEventListener('change', async (ev) => {
  const t = ev.target;
  const a = t.dataset.action;
  const site = siteOf(t);
  if (a === 'agency-filter') { S.agency = t.value; if (S.view === 'log') renderLog(); else { renderToolbar(); renderSites(); } }
  if (t.dataset.rv) updateReviewCount();
  if (t.dataset.rvInclude) renderReview();
  if (t.form?.id === 'form-review' && (t.name === 'allowMajorCore' || t.name === 'formTest')) renderReview();
  if (a === 'show-done') { S.showDone = t.checked; renderTasks(); return; }
  if (a === 'asana-link') {
    const task = (S.tasks?.tasks || []).find(x => x.gid === t.value);
    await api('POST', '/api/asana/link', { site: site.id, task: task ? { gid: task.gid, name: task.name, url: task.url, project: task.project, agency: task.agency } : null }).catch(e => toast(e.message));
    delete S.taskStatus[site.id];
    loadTasks(); // the task now lists this site too
  }
  if (a === 'log-days') { S.logDays = Number(t.value); S.log = null; renderLog(); }
  if (a === 'site-agency') { await api('POST', '/api/sites/meta', { sites: [site.id], agencyId: t.value }).catch(e => toast(e.message)); if (agencies().length > 1) { await load(); } }
  if (a === 'form-url') await api('POST', '/api/sites/meta', { sites: [site.id], formUrl: t.value }).catch(e => toast(e.message));
  if (t.form?.id === 'form-plugin' && t.name === 'action') $('[data-install-only]', t.form).hidden = t.value !== 'install';
  if (t.dataset.k === 'label' || t.dataset.k === 'color') { readAgencyForm(); const keep = document.activeElement; renderAgencyEditor(); keep?.focus?.(); }
});

document.addEventListener('keydown', (ev) => {
  const t = ev.target;
  if (!t.matches?.('[data-url-input]')) return;
  if (ev.key === 'Enter') { ev.preventDefault(); saveUrl(siteOf(t)); }
  if (ev.key === 'Escape') { ev.preventDefault(); S.editUrl = null; renderSites(); }
});

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.matches('[data-url-input]')) { S.urlDraft = t.value; return; }
  if (t.dataset.draft && S.drafts[t.dataset.draft]) { S.drafts[t.dataset.draft].text = t.value; return; }
  if (t.dataset.action === 'search-sites') { S.q = t.value; renderSites(); renderToolbar(); return; }
  if (t.dataset.action === 'search-tasks') { S.tasksQ = t.value; renderTasks(); return; }
  if (t.dataset.action === 'wporg-search') {
    const site = siteOf(t);
    const q = t.value;
    S.search[site.id] = { q, results: S.search[site.id]?.results };
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const results = q.trim().length >= 2 ? await wporgSearch(q).catch(() => []) : null;
      if (S.search[site.id]?.q !== q) return;
      S.search[site.id].results = results;
      const el = document.querySelector(`[data-site="${CSS.escape(site.id)}"]`);
      el.outerHTML = siteRow(site);
      const input = document.querySelector(`[data-site="${CSS.escape(site.id)}"] [data-action=wporg-search]`);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 350);
    return;
  }
  if (t.form?.id === 'form-plugin' && t.name === 'slug') {
    const box = $('[data-results]', t.form);
    const q = t.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const results = await wporgSearch(q).catch(() => []);
      if (t.value !== q) return;
      box.hidden = !results.length;
      box.innerHTML = results.map(r => `<div class="r"><div class="t"><b>${h(r.name)}</b><span>${h(r.slug)} · ${Number(r.installs || 0).toLocaleString()}+ installs</span></div><button type="button" class="btn sm" data-action="pick-slug" data-slug="${h(r.slug)}">Use</button></div>`).join('');
    }, 350);
  }
});

// Refresh relative times once a minute.
setInterval(() => { renderStats(); if (S.view === 'sites') renderSites(); }, 60_000);

// ── Connect on this Mac / PC ────────────────────────────────────────────────────
// The Site Maintenance app (Mac) or WP Admin itself (Windows) opens /#connect=<claude-connector:// link>.

let connectPreview = null;
let connectBusy = false;
// Connect links waiting their turn: one dialog at a time, the next when it closes.
const connectQueue = [];

function queueConnect(link) {
  if (!connectQueue.includes(link)) connectQueue.push(link);
  if (!$('#dlg-connect').open) nextConnect();
  else connectTitle();
}
function nextConnect() {
  const link = connectQueue.shift();
  if (link) startConnect(link);
}
function connectTitle() {
  const n = connectQueue.length;
  $('#dlg-connect .dh h3').textContent = `Connect a site${n ? ` (${n} more waiting)` : ''}`;
}
$('#dlg-connect').addEventListener('cancel', ev => { if (connectBusy) ev.preventDefault(); }); // no Esc mid-setup
$('#dlg-connect').addEventListener('close', () => setTimeout(nextConnect));

/** Asks the extension, when installed, to bring this tab to the front. */
function focusThisTab() {
  try { window.chrome?.runtime?.sendMessage?.(EXT_ID, { type: 'focus' }, () => void window.chrome.runtime.lastError); } catch {}
}

async function startConnect(link) {
  history.replaceState(null, '', location.pathname); // a reload must not reuse the link
  const dlg = $('#dlg-connect');
  const body = $('[data-body]', dlg);
  const go = $('[data-action=run-connect]', dlg);
  connectTitle();
  go.disabled = true;
  go.textContent = 'Connect';
  body.innerHTML = '<p class="muted">Fetching the site\'s details…</p>';
  dlg.showModal();
  try {
    connectPreview = await api('POST', '/api/connect/preview', { link });
  } catch (e) {
    body.innerHTML = `<div class="notice bad">${h(e.message)}</div>`;
    return;
  }
  const c = connectPreview;
  body.innerHTML = `
    <dl class="kv"><dt>Site</dt><dd><b>${h(c.name)}</b></dd><dt>Address</dt><dd><a href="${h(c.url)}" target="_blank" rel="noopener">${h(c.url)}</a></dd>
      <dt>Workspace</dt><dd><code>${h(c.folder)}</code></dd>${c.pluginVersion ? `<dt>Connector</dt><dd>${h(c.pluginVersion)}</dd>` : ''}</dl>
    ${c.exists ? '<div class="notice">This site is already set up here - its API key and MCP bridge are refreshed; CLAUDE.md is kept.</div>' : ''}
    <p class="hint" style="margin:0">Only connect sites you opened this from yourself.</p>
    <label class="field">Agency<select name="agencyId"></select></label>
    <label class="check"><input type="checkbox" name="openEditor"> Open the workspace in VS Code</label>`;
  agencyOptions($('select[name=agencyId]', dlg), S.agency !== 'all' ? S.agency : S.settings.defaultAgency);
  go.disabled = false;
}

document.addEventListener('click', async (ev) => {
  if (!ev.target.closest('[data-action=run-connect]')) return;
  ev.preventDefault();
  const dlg = $('#dlg-connect');
  const go = $('[data-action=run-connect]', dlg);
  go.disabled = true;
  go.textContent = 'Setting up… (installing the MCP bridge can take a minute)';
  connectBusy = true;
  try {
    const r = await api('POST', '/api/connect/confirm', {
      id: connectPreview.id,
      agencyId: $('select[name=agencyId]', dlg).value,
      openEditor: $('input[name=openEditor]', dlg).checked,
    });
    connectBusy = false;
    dlg.close();
    await load();
    toast(`${r.name} connected${r.opened ? ' - opening VS Code' : ''}. Press Check to see its updates.`);
    if (r.siteId) { S.open.add(r.siteId); renderSites(); }
  } catch (e) {
    connectBusy = false;
    $('[data-body]', dlg).insertAdjacentHTML('beforeend', `<div class="notice bad">${h(e.message)}</div>`);
    go.textContent = 'Connect';
  }
});

/**
 * A #connect= link in the address. In a tab just opened for it, while another
 * dashboard tab is open, the link goes to that tab and this one closes, so
 * connecting several sites keeps to one tab.
 * @returns true when the link was handed to another tab
 */
async function checkConnectHash(justOpened = false) {
  const m = location.hash.match(/^#connect=(.+)$/);
  if (!m) return false;
  const link = decodeURIComponent(m[1]);
  history.replaceState(null, '', location.pathname); // a reload must not reuse the link
  if (justOpened) {
    const r = await api('POST', '/api/connect/handoff', { link }).catch(() => null);
    if (r?.delivered) {
      window.close();
      // Still here: the browser did not let this tab close itself.
      $('#sites').innerHTML = '<div class="empty"><h2>Sent to your dashboard tab</h2><p>The site is waiting for you to confirm it in the dashboard tab that was already open. You can close this tab.</p></div>';
      return true;
    }
  }
  queueConnect(link);
  return false;
}
window.addEventListener('hashchange', () => checkConnectHash());
window.addEventListener('focus', () => { if ($('#dlg-settings').open) renderExtStatus(); });

load().then(async () => { if (!(await checkConnectHash(true))) connect(); }).catch(e => { $('#sites').innerHTML = `<div class="empty"><h2>Could not load</h2><p>${h(e.message)}</p></div>`; });
