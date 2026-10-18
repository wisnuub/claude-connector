#!/usr/bin/env node
// Keeps the dashboard running in the background on macOS (launchd), so the
// morning form test happens without a terminal window open.
//
//   npm run service:install     start now and at every login
//   npm run service:uninstall   stop and remove
//   npm run service:status
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LABEL = 'com.claude-connector.dashboard';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const DOMAIN = `gui/${process.getuid?.() ?? ''}`;
const LOG = path.join(ROOT, 'data', 'dashboard.log');
const cmd = process.argv[2] || 'status';

if (process.platform !== 'darwin') {
  console.log('The background service is macOS only. On other systems keep `npm start` running (e.g. with pm2 or a scheduled task at login).');
  process.exit(cmd === 'status' ? 0 : 1);
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const launchctl = (...args) => { try { return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return e.stdout || e.stderr || ''; } };

if (cmd === 'install') {
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  // launchd starts with a bare PATH; pass ours so a Chrome/Edge lookup and node itself resolve.
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(process.execPath)}</string><string>${esc(path.join(ROOT, 'server.js'))}</string></array>
  <key>WorkingDirectory</key><string>${esc(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(process.env.PATH || '/usr/local/bin:/usr/bin:/bin')}</string>
    ${process.env.PORT ? `<key>PORT</key><string>${esc(process.env.PORT)}</string>` : ''}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
</dict>
</plist>
`;
  launchctl('bootout', `${DOMAIN}/${LABEL}`);
  fs.writeFileSync(PLIST, plist);
  launchctl('bootstrap', DOMAIN, PLIST);
  console.log(`Installed. The dashboard now runs in the background and starts at login:\n  http://127.0.0.1:${process.env.PORT || 4590}\nLog: ${LOG}`);
  console.log('\nTo wake a sleeping Mac a few minutes before the morning run (optional, asks for your password):\n  sudo pmset repeat wake MTWRF 08:25:00');
} else if (cmd === 'uninstall') {
  launchctl('bootout', `${DOMAIN}/${LABEL}`);
  if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
  console.log('Removed. Run `npm start` to use the dashboard in a terminal again.');
} else {
  const out = launchctl('print', `${DOMAIN}/${LABEL}`);
  if (!fs.existsSync(PLIST) || /could not find/i.test(out)) console.log('Not installed. Run: npm run service:install');
  else console.log(`Installed (${PLIST})\n${(out.match(/state = .*/) || ['state = unknown'])[0]}\nLog: ${LOG}`);
}
