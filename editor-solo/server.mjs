// editor-solo/server.mjs - Standalone Node-RED Editor (safe mode)
// - Serves official editor via modular packages (@node-red/runtime + @node-red/editor-api)
// - Keeps runtime in safe mode (no flow execution)
// - Adds helper endpoint to mirror current flows to a remote runtime

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';
import fsp from 'fs/promises';
import express from 'express';

const require = createRequire(import.meta.url);
const runtime = require('@node-red/runtime');
const editorAPI = require('@node-red/editor-api');
const utilPkg = require('@node-red/util');
const { i18n, events } = utilPkg;
let bcrypt;
try { bcrypt = require('bcryptjs'); } catch {}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Locate core nodes
const nodesPkgDir = path.dirname(require.resolve('@node-red/nodes/package.json'));
const coreNodesDir = path.join(nodesPkgDir, 'core');

// Settings
const PORT = Number(process.env.EDITOR_PORT || 1881); // separate from runtime (1880)
const HOST = process.env.EDITOR_HOST || '0.0.0.0';
const AUTO_MIRROR = (process.env.EDITOR_AUTO_MIRROR || 'true') !== 'false';
const ADMIN_USER = process.env.EDITOR_ADMIN_USER || '';
const ADMIN_PASSWORD_HASH = process.env.EDITOR_ADMIN_PASSWORD_HASH || '';
const ADMIN_PASSWORD = process.env.EDITOR_ADMIN_PASSWORD || '';

const settings = {
  httpAdminRoot: '/admin',
  httpNodeRoot: false, // disable HTTP In/Out routes in this editor instance
  userDir: path.resolve(__dirname, 'data-editor'),
  flowFile: 'flows.json',
  disableEditor: false,
  safeMode: true, // ensure flows do not execute in the editor instance
  coreNodesDir,
  logging: { console: { level: 'debug', metrics: false, audit: true } }
};

// Optional adminAuth (basic credentials) via env vars
if (ADMIN_USER && (ADMIN_PASSWORD_HASH || ADMIN_PASSWORD)) {
  let hash = ADMIN_PASSWORD_HASH;
  if (!hash && ADMIN_PASSWORD) {
    if (!bcrypt) {
      console.warn('[editor] EDITOR_ADMIN_PASSWORD set but bcryptjs not installed. Skipping adminAuth.');
    } else {
      try { hash = bcrypt.hashSync(ADMIN_PASSWORD, 8); } catch {}
    }
  }
  if (hash) {
    settings.adminAuth = {
      type: 'credentials',
      users: [
        { username: ADMIN_USER, password: hash, permissions: '*' }
      ]
    };
    console.log('[editor] adminAuth enabled for user:', ADMIN_USER);
  }
}

// Optional remote runtime to mirror deployments to
const REMOTE_BASE_URL = process.env.REMOTE_BASE_URL || '';
const REMOTE_TOKEN = process.env.REMOTE_TOKEN || '';
const REMOTE_DEPLOYMENT_TYPE = process.env.REMOTE_DEPLOYMENT_TYPE || 'full';

const app = express();
const server = http.createServer(app);

// Initialize Node-RED Runtime and Editor API (modular)
await i18n.init(settings);
// Some versions expect an examples dir to exist under core nodes
const examplesDir = path.join(coreNodesDir, 'examples');
if (!fs.existsSync(examplesDir)) {
  await fsp.mkdir(examplesDir, { recursive: true });
}
await runtime.init(settings, server, null);
// Init editor-api with access to runtime internals
// Pass the public runtime API, not the internal `_` object
editorAPI.init(settings, server, runtime.storage, runtime);

// Proxy Inject click from Editor to remote runtime before admin apps handle it
if (process.env.REMOTE_BASE_URL) {
  app.post(settings.httpAdminRoot + '/inject/:id', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const id = req.params.id;
      const url = new URL(`/inject/${id}`, REMOTE_BASE_URL);
      const useHttps = url.protocol === 'https:';
      const lib = await import(useHttps ? 'https' : 'http');
      const headers = { 'Content-Type': 'application/json' };
      if (REMOTE_TOKEN) headers['Authorization'] = `Bearer ${REMOTE_TOKEN}`;
      const resp = await new Promise((resolve, reject) => {
        const r = lib.request({
          method: 'POST', hostname: url.hostname,
          port: url.port || (useHttps ? 443 : 80),
          path: url.pathname + (url.search || ''), headers
        }, (rr) => {
          let data = '';
          rr.setEncoding('utf8');
          rr.on('data', (c) => (data += c));
          rr.on('end', () => resolve({ status: rr.statusCode, text: data }));
        });
        r.on('error', reject);
        r.write(JSON.stringify(req.body || {}));
        r.end();
      });
      res.status(resp.status).type('application/json');
      try { res.send(JSON.parse(resp.text)); } catch { res.send(resp.text); }
    } catch (e) {
      res.status(502).json({ error: 'bad_gateway', message: e?.message || String(e) });
    }
  });
}

// Helper to POST current flows to remote runtime
async function mirrorToRemote() {
  if (!REMOTE_BASE_URL) return { ok: false, error: 'remote_not_configured' };
  try {
    const current = await runtime.flows.getFlows({});
    const body = { flows: current.flows || [], credentials: current.credentials || {} };
    const url = new URL('/flows', REMOTE_BASE_URL);
    url.searchParams.set('deploymentType', REMOTE_DEPLOYMENT_TYPE);
    const headers = { 'Content-Type': 'application/json' };
    if (REMOTE_TOKEN) headers['Authorization'] = `Bearer ${REMOTE_TOKEN}`;
    const useHttps = url.protocol === 'https:';
    const lib = await import(useHttps ? 'https' : 'http');
    const options = {
      method: 'POST', hostname: url.hostname,
      port: url.port || (useHttps ? 443 : 80),
      path: url.pathname + (url.search || ''), headers
    };
    const resp = await new Promise((resolve, reject) => {
      const r = lib.request(options, (rr) => {
        let data = '';
        rr.setEncoding('utf8');
        rr.on('data', (c) => (data += c));
        rr.on('end', () => resolve({ status: rr.statusCode, text: data }));
      });
      r.on('error', reject);
      r.write(JSON.stringify(body));
      r.end();
    });
    let parsed; try { parsed = JSON.parse(resp.text) } catch { parsed = { raw: resp.text } }
    return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, body: parsed };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Auto-mirror on successful deploy via POST /admin/flows
if (AUTO_MIRROR) {
  app.use(async (req, res, next) => {
    if (req.method === 'POST' && req.path === settings.httpAdminRoot + '/flows') {
      const originalEnd = res.end;
      res.end = function(chunk, encoding, cb) {
        const status = res.statusCode;
        try { originalEnd.call(this, chunk, encoding, cb); }
        finally {
          if (status >= 200 && status < 300) {
            mirrorToRemote().then(r => {
              if (!r.ok) console.warn('[editor] auto-mirror failed:', r);
              else console.log('[editor] auto-mirror ok:', r.status);
            }).catch(err => console.warn('[editor] auto-mirror error:', err?.message || err));
          }
        }
      };
    }
    next();
  });
}

// Bridge remote debug SSE to local editor comms (so Debug panel shows messages)
async function startRemoteDebugBridge() {
  if (!REMOTE_BASE_URL) return;
  try {
    const url = new URL('/events/debug', REMOTE_BASE_URL);
    const useHttps = url.protocol === 'https:';
    const lib = await import(useHttps ? 'https' : 'http');
    const headers = {};
    if (REMOTE_TOKEN) headers['Authorization'] = `Bearer ${REMOTE_TOKEN}`;
    const req = lib.request({
      method: 'GET', hostname: url.hostname,
      port: url.port || (useHttps ? 443 : 80),
      path: url.pathname + (url.search || ''), headers
    }, (res) => {
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = block.split('\n').find(l => l.startsWith('data: '));
          if (line) {
            const json = line.slice(6);
            try {
              const payload = JSON.parse(json);
              // Re-publish into local editor comms as 'debug'
              runtime.events.emit('comms', { topic: 'debug', data: payload, retain: false });
            } catch {}
          }
        }
      });
    });
    req.on('error', (e) => {
      console.warn('[editor] debug bridge error:', e?.message || e);
      setTimeout(startRemoteDebugBridge, 5000);
    });
    req.end();
  } catch (e) {
    console.warn('[editor] debug bridge setup failed:', e?.message || e);
  }
}

// Mount runtime admin app first to serve node-provided admin assets
app.use(settings.httpAdminRoot, runtime.httpAdmin);
// Then mount the editor-api app under the same root
app.use(settings.httpAdminRoot, editorAPI.httpAdmin);
// We keep httpNode disabled in this editor instance

// Basic health for the editor instance
app.get('/healthz', async (_req, res) => {
  res.json({ ok: true, editor: true, safeMode: !!settings.safeMode });
});

// Helper: mirror current editor flows to a remote runtime
// Usage: curl -X POST /admin/remote/deploy
app.post('/admin/remote/deploy', express.json({ limit: '10mb' }), async (req, res) => {
  if (!REMOTE_BASE_URL) {
    return res.status(400).json({ error: 'remote_not_configured' });
  }
  try {
    const result = await mirrorToRemote();
    if (!result.ok) return res.status(502).json({ error: 'remote_deploy_failed', detail: result });
    return res.json({ ok: true, remote: result.body });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: e?.message || String(e) });
  }
});

// Health check proxy to remote runtime
app.get('/admin/remote/health', async (req, res) => {
  if (!REMOTE_BASE_URL) return res.status(400).json({ error: 'remote_not_configured' });
  try {
    const url = new URL('/health', REMOTE_BASE_URL);
    const useHttps = url.protocol === 'https:';
    const lib = await import(useHttps ? 'https' : 'http');
    const headers = {};
    if (REMOTE_TOKEN) headers['Authorization'] = `Bearer ${REMOTE_TOKEN}`;
    const resp = await new Promise((resolve, reject) => {
      const r = lib.request({ method: 'GET', hostname: url.hostname, port: url.port || (useHttps ? 443 : 80), path: url.pathname + (url.search || ''), headers }, (rr) => {
        let data = '';
        rr.setEncoding('utf8');
        rr.on('data', (c) => (data += c));
        rr.on('end', () => resolve({ status: rr.statusCode, text: data }));
      });
      r.on('error', reject);
      r.end();
    });
    let body; try { body = JSON.parse(resp.text) } catch { body = { raw: resp.text } }
    res.status(resp.status).json(body);
  } catch (e) {
    res.status(502).json({ error: 'bad_gateway', message: e?.message || String(e) });
  }
});

// Start editor server (runtime + editor)
await runtime.start();
await editorAPI.start();

// Start debug bridge after editor is ready
startRemoteDebugBridge();

// Log runtime messages for troubleshooting
events.on('log', (rec) => {
  try {
    const level = rec?.level || 'info';
    const msg = rec?.msg || rec;
    console.log(`[editor:${level}]`, msg);
  } catch {}
});
server.listen(PORT, HOST, () => {
  console.log(`Editor listening on http://${HOST}:${PORT}${settings.httpAdminRoot}`);
  if (REMOTE_BASE_URL) {
    console.log(`Remote runtime configured: ${REMOTE_BASE_URL}`);
  }
});
