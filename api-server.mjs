// api-server.mjs - Minimal HTTP API around Node-RED runtime (extracted)
import http from 'http';
import { URL } from 'url';

export async function startApiServer({ runtime }) {
  // Node-RED のデフォルトに合わせて 1880 を既定ポートに
  const PORT = Number(process.env.PORT || 1880);
  const HOST = process.env.HOST || '0.0.0.0';
  const TOKEN = process.env.NR_SERVER_TOKEN || '';
  const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
  const BODY_LIMIT = Number(process.env.BODY_LIMIT || 10 * 1024 * 1024); // 10MB

  const setCors = (res) => {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  };

  const unauthorized = (res) => {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'unauthorized' }));
  };

  const notFound = (res) => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'not_found' }));
  };

  const badRequest = (res, message = 'bad_request') => {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: message }));
  };

  const serverError = (res, err) => {
    res.statusCode = err?.status || 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err?.code || 'server_error', message: err?.message || String(err) }));
  };

  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0;
    let data = '';
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('payload_too_large'), { status: 413 }));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try {
        const json = data ? JSON.parse(data) : {};
        resolve(json);
      } catch (e) {
        e.status = 400;
        e.code = 'invalid_json';
        reject(e);
      }
    });
    req.on('error', reject);
  });

  const checkAuth = (req, res) => {
    if (!TOKEN) return true; // no auth required when token unset
    const auth = req.headers['authorization'] || '';
    const ok = auth.startsWith('Bearer ') && auth.slice(7) === TOKEN;
    if (!ok) unauthorized(res);
    return ok;
  };

  const ensureStarted = async () => {
    try {
      return await runtime.isStarted();
    } catch {
      return false;
    }
  };

  const api = http.createServer(async (req, res) => {
    setCors(res);
    const url = new URL(req.url, `http://${req.headers.host}`);
    // '/admin' をベースパスとして指定された場合の互換（/admin/flows など）
    const pathname = url.pathname.startsWith('/admin') ? url.pathname.slice(6) || '/' : url.pathname;

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    if (!checkAuth(req, res)) return; // sent response already if not ok

    // Health
    if (req.method === 'GET' && pathname === '/health') {
      const started = await ensureStarted();
      let rev = undefined;
      try {
        const f = await runtime.flows.getFlows({});
        rev = f?.rev;
      } catch {}
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, started, rev }));
    }

    // Get current flows
    if (req.method === 'GET' && pathname === '/flows') {
      try {
        const flows = await runtime.flows.getFlows({});
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(flows));
      } catch (e) {
        return serverError(res, e);
      }
    }

    // Set/Deploy flows
    if (req.method === 'POST' && pathname === '/flows') {
      try {
        const body = await readJson(req);
        // Accept either an array-of-nodes or full object {flows:[...], credentials:{}}
        let payload;
        if (Array.isArray(body)) {
          payload = { flows: body, credentials: {} };
        } else if (body && (Array.isArray(body.flows) || body.hasOwnProperty('rev'))) {
          payload = body;
          if (!payload.credentials) payload.credentials = {};
        } else {
          return badRequest(res, 'invalid_flows_payload');
        }

        const deploymentType = url.searchParams.get('deploymentType') || 'full';
        const result = await runtime.flows.setFlows({
          user: { username: 'api' },
          flows: payload,
          deploymentType
        });

        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ ok: true, rev: result.rev }));
      } catch (e) {
        return serverError(res, e);
      }
    }

    // Runtime state
    if (req.method === 'GET' && pathname === '/state') {
      try {
        const s = await runtime.flows.getState({});
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(s));
      } catch (e) {
        return serverError(res, e);
      }
    }
    if (req.method === 'POST' && pathname === '/state') {
      try {
        const body = await readJson(req);
        const state = body?.state;
        if (state !== 'start' && state !== 'stop') return badRequest(res, 'invalid_state');
        const s = await runtime.flows.setState({ state });
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(s));
      } catch (e) {
        return serverError(res, e);
      }
    }

    // Reload flows from storage
    if (req.method === 'POST' && pathname === '/reload') {
      try {
        const result = await runtime.flows.setFlows({ deploymentType: 'reload' });
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ ok: true, rev: result?.rev }));
      } catch (e) {
        return serverError(res, e);
      }
    }

    return notFound(res);
  });

  api.listen(PORT, HOST, () => {
    console.log(`API server listening on http://${HOST}:${PORT}`);
    if (TOKEN) console.log('Auth: Bearer token required (NR_SERVER_TOKEN set)');
  });
}

