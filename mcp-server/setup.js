#!/usr/bin/env node
import http from 'http';
import fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITES_FILE = path.join(__dirname, 'sites.json');
const SITES_DIR  = path.join(__dirname, '..', 'sites');
const PORT = 3131;

function urlToSlug(url) {
  try {
    const host = new URL(String(url).replace(/\/$/, '') || 'http://x').hostname.replace(/^www\./, '');
    return host.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '-') || 'site';
  } catch {
    return String(url).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'site';
  }
}

function loadSites() {
  try { return JSON.parse(fs.readFileSync(SITES_FILE, 'utf8')); }
  catch { return []; }
}

function saveSites(sites) {
  fs.writeFileSync(SITES_FILE, JSON.stringify(sites, null, 2) + '\n');
}

function createSiteFolder(site) {
  const slug    = site.slug || urlToSlug(site.url);
  const siteDir = path.join(SITES_DIR, slug);
  fs.mkdirSync(siteDir, { recursive: true });

  // .mcp.json - credentials (gitignored)
  const mcpContent = JSON.stringify({
    mcpServers: {
      'claude-connector': {
        command: 'node',
        args: ['../../mcp-server/index.js'],
        env: { WP_URL: site.url, WP_KEY: site.key, WP_MODE: site.mode || 'rest' },
      },
    },
  }, null, 2) + '\n';
  fs.writeFileSync(path.join(siteDir, '.mcp.json'), mcpContent);

  // CLAUDE.md - context only, no secrets (committed); never overwrite user edits
  const claudeMdPath = path.join(siteDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    const hostname = (() => { try { return new URL(site.url).hostname; } catch { return site.url; } })();
    const title    = slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' ');
    const modeDesc = site.mode === 'ajax' ? 'Admin AJAX (Cloudflare bypass)' : 'Direct REST API';
    fs.writeFileSync(claudeMdPath,
      `# ${title} - ${hostname}\n\n` +
      `WordPress site managed via Claude Connector.\n\n` +
      `**URL:** ${site.url}  \n` +
      `**Mode:** ${modeDesc}\n\n` +
      `## Notes\n<!-- Theme, active plugins, custom post types, client context, etc. -->\n`
    );
  }
}

function openVSCode(folderPath) {
  const cmds = [
    `code "${folderPath}"`,
    `open -a "Visual Studio Code" "${folderPath}"`,
  ];
  for (const cmd of cmds) {
    try { execSync(cmd, {stdio: 'ignore'}); return true; } catch {}
  }
  return false;
}

function readBody(req) {
  return new Promise(res => { let s = ''; req.on('data', c => s += c); req.on('end', () => res(s)); });
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Connector</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh;padding:40px 16px}
.wrap{max-width:580px;margin:0 auto}
h1{font-size:1.2rem;font-weight:600;margin-bottom:3px}
.sub{font-size:.82rem;color:#8b949e;margin-bottom:32px}
.lbl{font-size:.72rem;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.09em;margin-bottom:10px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:8px;display:flex;align-items:center;gap:12px}
.dot{width:8px;height:8px;border-radius:50%;background:#484f58;flex-shrink:0;margin-top:1px}
.dot.ok{background:#3fb950}.dot.err{background:#f85149}
.info{flex:1;min-width:0}
.sname{font-weight:600;font-size:.9rem}
.surl{font-size:.78rem;color:#8b949e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.smeta{display:flex;gap:10px;margin-top:3px;align-items:center}
.stag{font-size:.7rem;color:#58a6ff;background:rgba(88,166,255,.1);border:1px solid rgba(88,166,255,.2);border-radius:4px;padding:1px 5px;white-space:nowrap}
.stag.ajax{color:#d2a8ff;background:rgba(210,168,255,.1);border-color:rgba(210,168,255,.2)}
.sslug{font-size:.7rem;color:#484f58}
.sst{font-size:.74rem;margin-top:2px;min-height:.9em}
.sst.ok{color:#3fb950}.sst.err{color:#f85149}
.btn{border:1px solid #30363d;background:#21262d;color:#e6edf3;padding:5px 11px;border-radius:6px;font-size:.8rem;cursor:pointer;flex-shrink:0;white-space:nowrap}
.btn:hover{background:#30363d}
.btn.del{border-color:rgba(248,81,73,.35)}.btn.del:hover{background:rgba(248,81,73,.12);color:#f85149}
.btn.pri{background:#238636;border-color:#2ea043}.btn.pri:hover{background:#2ea043}
.empty{color:#8b949e;font-size:.88rem;padding:12px 0}
.form{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px;margin-top:24px}
.field{margin-bottom:14px}
label{display:block;font-size:.78rem;color:#8b949e;margin-bottom:5px}
input,select{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#e6edf3;padding:7px 11px;font-size:.88rem;outline:none;font-family:inherit;appearance:none}
input:focus,select:focus{border-color:#58a6ff}
select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%238b949e'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center;padding-right:28px;cursor:pointer}
select option{background:#0d1117}
.row{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
.msg{font-size:.78rem;min-height:1.1em;margin-top:8px}
.foot{font-size:.74rem;color:#484f58;border-top:1px solid #21262d;margin-top:32px;padding-top:16px;text-align:center}
</style>
</head>
<body>
<div class="wrap">
  <h1>Claude Connector</h1>
  <p class="sub">Site Manager &mdash; configure WordPress sites for MCP</p>
  <div class="lbl">Configured Sites</div>
  <div id="list"></div>
  <div class="form">
    <div class="lbl" style="margin-bottom:16px">Add Site</div>
    <div class="field">
      <label for="fn">Name</label>
      <input id="fn" placeholder="Production" autocomplete="off">
    </div>
    <div class="field">
      <label for="fu">WordPress URL</label>
      <input id="fu" placeholder="https://twinshields.com.au" autocomplete="off">
    </div>
    <div class="field">
      <label for="fk">API Key &mdash; <span style="font-weight:normal">WP Admin &rarr; Settings &rarr; Claude Connector</span></label>
      <input id="fk" type="password" placeholder="paste key here" autocomplete="new-password">
    </div>
    <div class="field">
      <label for="fm">Connection Mode</label>
      <select id="fm">
        <option value="ajax">Admin AJAX &mdash; recommended (bypasses Cloudflare WAF)</option>
        <option value="rest">Direct REST API &mdash; /wp-json/ (use if no Cloudflare)</option>
      </select>
    </div>
    <div class="row">
      <button class="btn" onclick="testNew()">Test Connection</button>
      <button class="btn pri" onclick="addSite()">Add Site</button>
    </div>
    <div class="msg" id="msg"></div>
  </div>
  <p class="foot">Changes save immediately to sites.json &bull; Restart Claude Code after adding or removing sites</p>
</div>
<script>
var sites=[];
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':'&quot;';});}
function slugFromUrl(url){try{var h=new URL(String(url).replace(/\/$/,'')||'http://x').hostname.replace(/^www\./,'');return h.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g,'-')||'site';}catch{return String(url).toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,40)||'site';}}
async function load(){
  sites=await fetch('/api/sites').then(function(r){return r.json();});
  var el=document.getElementById('list');
  if(!sites.length){el.innerHTML='<div class="empty">No sites configured yet.</div>';return;}
  el.innerHTML=sites.map(function(s,i){
    var slug=s.slug||slugFromUrl(s.url);
    var mode=s.mode||'rest';
    return '<div class="card" id="c'+i+'">'+
      '<div class="dot" id="d'+i+'"></div>'+
      '<div class="info">'+
        '<div class="sname">'+esc(s.name)+'</div>'+
        '<div class="surl">'+esc(s.url)+'</div>'+
        '<div class="smeta">'+
          '<span class="stag'+(mode==='ajax'?' ajax':'')+'">'+esc(mode==='ajax'?'Admin AJAX':'REST API')+'</span>'+
          '<span class="sslug">sites/'+esc(slug)+'</span>'+
        '</div>'+
        '<div class="sst" id="s'+i+'"></div>'+
      '</div>'+
      '<button class="btn" onclick="testSite('+i+')">Test</button>'+
      '<button class="btn del" onclick="rmSite('+i+')">Remove</button>'+
    '</div>';
  }).join('');
}
async function testSite(i){
  var s=sites[i];
  var dot=document.getElementById('d'+i),st=document.getElementById('s'+i);
  dot.className='dot';st.textContent='Testing…';st.className='sst';
  var r=await fetch('/api/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:s.url,key:s.key,mode:s.mode||'rest'})}).then(function(r){return r.json();});
  if(r.ok){dot.className='dot ok';st.textContent=r.version?'Connected \xb7 WP '+r.version:'Connected';st.className='sst ok';}
  else{dot.className='dot err';st.textContent=r.error||'Connection failed';st.className='sst err';}
}
async function rmSite(i){
  if(!confirm('Remove "'+sites[i].name+'"?'))return;
  await fetch('/api/sites/'+encodeURIComponent(sites[i].name),{method:'DELETE'});
  load();
}
async function testNew(){
  var url=document.getElementById('fu').value.trim(),key=document.getElementById('fk').value.trim(),mode=document.getElementById('fm').value;
  var msg=document.getElementById('msg');
  if(!url||!key){msg.textContent='Enter a URL and key first.';msg.style.color='#8b949e';return;}
  msg.textContent='Testing…';msg.style.color='#8b949e';
  var r=await fetch('/api/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url,key:key,mode:mode})}).then(function(r){return r.json();});
  if(r.ok){msg.style.color='#3fb950';msg.textContent=r.version?'Connected \xb7 WP '+r.version:'Connected';}
  else{msg.style.color='#f85149';msg.textContent=r.error||'Connection failed';}
}
async function addSite(){
  var name=document.getElementById('fn').value.trim(),url=document.getElementById('fu').value.trim(),key=document.getElementById('fk').value.trim(),mode=document.getElementById('fm').value;
  if(!name||!url||!key){alert('All fields are required.');return;}
  var r=await fetch('/api/sites',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,url:url,key:key,mode:mode})}).then(function(r){return r.json();});
  document.getElementById('fn').value='';document.getElementById('fu').value='';document.getElementById('fk').value='';
  if(r.slug){document.getElementById('msg').textContent=r.vscode?'Site added - opening VSCode for sites/'+r.slug+'…':'Site added - open sites/'+r.slug+' in VSCode to connect';document.getElementById('msg').style.color='#3fb950';}
  else{document.getElementById('msg').textContent='';}
  load();
}
load();
</script>
</body>
</html>`;

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const send = (code, ct, data) => { res.writeHead(code, {'Content-Type': ct}); res.end(data); };

  if (u.pathname === '/' && req.method === 'GET')
    return send(200, 'text/html; charset=utf-8', HTML);

  if (u.pathname === '/api/sites' && req.method === 'GET')
    return send(200, 'application/json', JSON.stringify(loadSites()));

  if (u.pathname === '/api/sites' && req.method === 'POST') {
    const site = JSON.parse(await readBody(req));
    site.url  = site.url.replace(/\/$/, '');
    site.mode = site.mode || 'rest';
    site.slug = urlToSlug(site.url);
    const all = loadSites();
    const idx = all.findIndex(s => s.name === site.name);
    if (idx >= 0) all[idx] = site; else all.push(site);
    saveSites(all);
    try { createSiteFolder(site); } catch (e) { process.stderr.write('folder create: ' + e.message + '\n'); }
    const siteDir = path.join(SITES_DIR, site.slug);
    const vscode  = openVSCode(siteDir);
    return send(200, 'application/json', JSON.stringify({ok: true, slug: site.slug, vscode}));
  }

  if (u.pathname.startsWith('/api/sites/') && req.method === 'DELETE') {
    const name = decodeURIComponent(u.pathname.slice('/api/sites/'.length));
    saveSites(loadSites().filter(s => s.name !== name));
    return send(200, 'application/json', '{"ok":true}');
  }

  if (u.pathname === '/api/test' && req.method === 'POST') {
    const {url, key, mode} = JSON.parse(await readBody(req));
    const cleanUrl = url.replace(/\/$/, '');
    try {
      if (mode === 'ajax') {
        const r = await fetch(cleanUrl + '/wp-admin/admin-ajax.php?action=claude_cmd', {
          method: 'POST',
          headers: { 'X-Claude-Key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'GET', endpoint: '/status', params: {}, body: null }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await r.json().catch(() => ({}));
        const body = data.body || {};
        const isOk = r.ok && (data.status || 0) < 400;
        return send(200, 'application/json', JSON.stringify(
          isOk ? {ok: true,  version: body.wp_version || body.version || null}
               : {ok: false, error: data.status ? `WP ${data.status}` : `HTTP ${r.status}`}
        ));
      } else {
        const r = await fetch(cleanUrl + '/wp-json/claude/v1/status', {
          headers: {'X-Claude-Key': key},
          signal: AbortSignal.timeout(8000),
        });
        const data = await r.json().catch(() => ({}));
        return send(200, 'application/json', JSON.stringify(
          r.ok ? {ok: true,  version: data.wp_version || data.version || null}
               : {ok: false, error: 'HTTP ' + r.status}
        ));
      }
    } catch (e) {
      return send(200, 'application/json', JSON.stringify({ok: false, error: e.message}));
    }
  }

  send(404, 'text/plain', 'Not found');
});

srv.listen(PORT, '127.0.0.1', () => {
  const url = 'http://localhost:' + PORT;
  process.stdout.write('\nClaude Connector Site Manager\n  ' + url + '\n\nCtrl+C to stop.\n\n');
  try { execSync('open ' + url); } catch {}
});
