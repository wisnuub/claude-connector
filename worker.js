/**
 * Claude Connector – Relay Worker
 *
 * KV namespace binding required: CC_QUEUE
 * Secret env variable required:  RELAY_SECRET
 *
 * Endpoints:
 *   POST /push          – Claude pushes a command
 *   GET  /poll          – WP plugin polls for the next command
 *   POST /result/:id    – WP plugin posts the result
 *   GET  /result/:id    – Claude fetches the result (202 while pending)
 *   GET  /              – Health check
 */

const CMD_TTL    = 300; // 5 min – command waits for plugin to pick up
const RESULT_TTL = 300; // 5 min – result waits for Claude to fetch

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // ── Auth ──────────────────────────────────────────────────────────────────
    const key = request.headers.get('X-Relay-Key');
    if (!key || key !== env.RELAY_SECRET) {
      return json({ error: 'Unauthorized' }, 401);
    }

    // ── Health check ──────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/') {
      return json({ status: 'ok', service: 'claude-connector-relay' });
    }

    // ── POST /push  (Claude → Worker) ─────────────────────────────────────────
    if (method === 'POST' && path === '/push') {
      const body = await request.json();
      const id   = crypto.randomUUID();

      const command = {
        id,
        method:   (body.method   || 'GET').toUpperCase(),
        endpoint: body.endpoint  || '/status',
        params:   body.params    || {},
        body:     body.body      || null,
        created:  Date.now(),
      };

      await env.CC_QUEUE.put(`cmd:${id}`, JSON.stringify(command), { expirationTtl: CMD_TTL });

      // Append to pending list
      const raw     = await env.CC_QUEUE.get('pending');
      const pending = raw ? JSON.parse(raw) : [];
      pending.push(id);
      await env.CC_QUEUE.put('pending', JSON.stringify(pending), { expirationTtl: CMD_TTL });

      return json({ id }, 201);
    }

    // ── GET /poll  (Worker → WP plugin) ──────────────────────────────────────
    if (method === 'GET' && path === '/poll') {
      const raw     = await env.CC_QUEUE.get('pending');
      const pending = raw ? JSON.parse(raw) : [];

      if (!pending.length) {
        return json({ command: null });
      }

      const id = pending.shift();
      // Write back the shortened queue (no expiry reset needed – it'll age out)
      await env.CC_QUEUE.put('pending', JSON.stringify(pending));

      const cmdRaw = await env.CC_QUEUE.get(`cmd:${id}`);
      if (!cmdRaw) {
        // Command expired before plugin could pick it up – return nothing
        return json({ command: null });
      }

      return json({ command: JSON.parse(cmdRaw) });
    }

    // ── POST /result/:id  (WP plugin → Worker) ───────────────────────────────
    if (method === 'POST' && path.startsWith('/result/')) {
      const id   = path.slice('/result/'.length);
      const body = await request.json();
      await env.CC_QUEUE.put(`result:${id}`, JSON.stringify(body), { expirationTtl: RESULT_TTL });
      return json({ ok: true });
    }

    // ── GET /result/:id  (Worker → Claude) ───────────────────────────────────
    if (method === 'GET' && path.startsWith('/result/')) {
      const id  = path.slice('/result/'.length);
      const raw = await env.CC_QUEUE.get(`result:${id}`);
      if (!raw) {
        return json({ pending: true }, 202);
      }
      // Clean up after delivery
      await env.CC_QUEUE.delete(`result:${id}`);
      return json(JSON.parse(raw));
    }

    return json({ error: 'Not found' }, 404);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
