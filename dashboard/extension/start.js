// "Try again" on the help page: open the dashboard if it is up by now.
const error = new URLSearchParams(location.search).get('error');
if (error) { const el = document.getElementById('err'); el.textContent = `Details: ${error}`; el.hidden = false; }
document.getElementById('again').addEventListener('click', async () => {
  try {
    const r = await fetch('http://127.0.0.1:4590/api/state', { signal: AbortSignal.timeout(2000) });
    if (r.ok) { location.href = 'http://127.0.0.1:4590/'; return; }
  } catch {}
  const r = await new Promise(resolve => chrome.runtime.sendNativeMessage('com.claude_connector.dashboard', { type: 'start' }, resp => resolve(resp || { ok: false, error: chrome.runtime.lastError?.message })));
  if (r.ok) location.href = r.url;
  else { const el = document.getElementById('err'); el.textContent = `Still not running. ${r.error || ''}`; el.hidden = false; }
});
