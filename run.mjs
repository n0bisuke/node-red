// run.mjs - headless runtime + minimal API server
import { createRequire } from 'module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { URL } from 'node:url';

const require = createRequire(import.meta.url);
const runtime = require('@node-red/runtime');
const utilPkg = require('@node-red/util');
const { i18n, events } = utilPkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// @node-red/nodes の core へのフルパス
const nodesPkgDir = path.dirname(require.resolve('@node-red/nodes/package.json'));
const coreNodesDir = path.join(nodesPkgDir, 'core');

const settings = {
  userDir: path.resolve(__dirname, 'data'),
  flowFile: 'flows.json',
  disableEditor: true,
  coreNodesDir,
  logging: { console: { level: 'debug', metrics: true, audit: false } },
  // enable programmatic start/stop via runtime.flows.setState
  runtimeState: { enabled: true }
};

console.log('Settings:', settings);

// ① flows.json の存在＆内容を起動前に確認
const flowsPath = path.join(settings.userDir, settings.flowFile);
console.log('[preflight] flowsPath =', flowsPath, 'exists =', fs.existsSync(flowsPath));
try {
  const txt = await fsp.readFile(flowsPath, 'utf8');
  const arr = JSON.parse(txt);
  const tabs = arr.filter(x => x.type === 'tab').length;
  const injects = arr.filter(x => x.type === 'inject').length;
  const fns = arr.filter(x => x.type === 'function').length;
  console.log(`[preflight] items=${arr.length} tabs=${tabs} inject=${injects} function=${fns}`);
} catch (e) {
  console.error('[preflight] read/parse error:', e.message);
}

// ② 一部バージョンで必要：core/examples が無いと落ちる対策
const examplesDir = path.join(coreNodesDir, 'examples');
if (!fs.existsSync(examplesDir)) {
  await fsp.mkdir(examplesDir, { recursive: true });
}

// ③ ランタイムのイベント/ログを可視化
events.on('runtime-event', (ev) => console.log('[runtime-event]', ev));
events.on('log', (rec) => console.log(`[log:${rec.level}]`, rec.msg || rec));

try {
  await i18n.init(settings);
  await runtime.init(settings, null, null);
  await runtime.start();
  console.log('Node-RED runtime started successfully (headless mode).');
} catch (err) {
  console.error('Failed to start Node-RED runtime:', err);
  process.exit(1);
}

// ④ Minimal API server to receive flows from external editors
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

const methodNotAllowed = (res) => {
  res.statusCode = 405;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'method_not_allowed' }));
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
