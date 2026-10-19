import { listSites } from './lib/store.js';
import { call, externalCheck } from './lib/wp.js';
const VERSION = '1.8.5';
const ZIP = `https://github.com/wisnuub/claude-connector/releases/download/v${VERSION}/claude-connector.zip`;
const only = process.argv.slice(2);
const wp = (s, args, timeout = 180000) => call(s, 'POST', '/wpcli', { body: { args }, timeout });
const status = async s => { for (let i = 0; i < 3; i++) { try { return await call(s, 'GET', '/status', { timeout: 30000 }); } catch (e) { if (i === 2) throw e; await new Promise(r => setTimeout(r, 4000)); } } };
for (const s of listSites().filter(x => !only.length || only.includes(x.name))) {
  const log = (...a) => console.log(s.name.padEnd(28), ...a);
  let st;
  try { st = await status(s); } catch { log('skip - unreachable'); continue; }
  if (st.plugin_version === VERSION) { log(`already ${VERSION}`); continue; }
  const before = await externalCheck(st.home_url || s.url);
  if (before.status === 'fatal') { log(`skip - homepage already broken (${before.message})`); continue; }
  const r = await wp(s, ['plugin', 'install', ZIP, '--force']);
  if (r.exit_code !== 0) { log('INSTALL FAILED', (r.stderr || r.stdout).trim().split('\n').pop()); continue; }
  await wp(s, ['transient', 'delete', 'claude_connector_gh_release']);
  await wp(s, ['transient', 'delete', 'update_plugins', '--network']);
  let after; try { after = await status(s); } catch (e) { after = { error: e.message }; }
  const health = await call(s, 'GET', '/maintenance/health', { timeout: 60000 }).catch(e => ({ status: 'error: ' + e.message.slice(0, 50) }));
  const out = await externalCheck(st.home_url || s.url);
  log(`${st.plugin_version} -> ${after.plugin_version || 'ERROR ' + after.error}`, `| inside: ${health.status}`, `| homepage: ${out.status} ${out.code}`);
}
