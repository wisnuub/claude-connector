// Morning form-test run. Checks once a minute while the dashboard is running.
//
// A Mac that was asleep at the set time runs the test when it wakes, as long
// as that is before CATCH_UP_UNTIL - so a closed lid at 8:30 still gets the
// day's test, but waking it at 9 pm does not fire a "morning" test.
import { getSettings, listSites, siteState, getMeta, patchMeta } from './store.js';
import { startFormTest, bus } from './jobs.js';

const CATCH_UP_UNTIL = 12; // hour of day, local time

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function at(date, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

/** The sites the next run will test. */
export function scheduledSites() {
  const sc = getSettings().schedule;
  const sites = listSites();
  return sc.what === 'all' ? sites.map(s => s.id) : sites.filter(s => siteState(s.id).formTestQueued).map(s => s.id);
}

/** When the next run is due, for display. */
export function nextRun(now = new Date()) {
  const sc = getSettings().schedule;
  if (!sc.enabled || !sc.days.length) return null;
  for (let i = 0; i < 8; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const t = at(d, sc.time);
    if (!sc.days.includes(t.getDay())) continue;
    if (i === 0 && (getMeta().lastScheduledRun === localDate(now) || now > at(now, `${CATCH_UP_UNTIL}:00`))) continue;
    return (i === 0 && t < now ? now : t).toISOString();
  }
  return null;
}

function tick() {
  const sc = getSettings().schedule;
  if (!sc.enabled) return;
  const now = new Date();
  if (!sc.days.includes(now.getDay())) return;
  if (now < at(now, sc.time) || now.getHours() >= CATCH_UP_UNTIL) return;
  if (getMeta().lastScheduledRun === localDate(now)) return;

  patchMeta({ lastScheduledRun: localDate(now) });
  const sites = scheduledSites();
  if (!sites.length) {
    patchMeta({ lastScheduledResult: { at: now.toISOString(), sites: 0, note: 'Nothing queued' } });
    return;
  }
  const job = startFormTest({ sites, title: `Morning form test - ${sites.length} site${sites.length === 1 ? '' : 's'}` });
  patchMeta({ lastScheduledResult: { at: now.toISOString(), sites: sites.length, jobId: job.id } });
}

export function startScheduler() {
  setTimeout(tick, 5_000); // on start-up / wake, catch up a missed run
  setInterval(tick, 60_000);
  bus.on('settings', tick);
}
