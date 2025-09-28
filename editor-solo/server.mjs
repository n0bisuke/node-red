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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Locate core nodes
const nodesPkgDir = path.dirname(require.resolve('@node-red/nodes/package.json'));
const coreNodesDir = path.join(nodesPkgDir, 'core');

// Settings
const PORT = Number(process.env.EDITOR_PORT || 1881); // separate from runtime (1880)
const HOST = process.env.EDITOR_HOST || '0.0.0.0';

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
    // Get current flows directly from the runtime API
    const current = await runtime.flows.getFlows({});
    const body = { flows: current.flows || [], credentials: current.credentials || {} };
    const url = new URL('/flows', REMOTE_BASE_URL);
    url.searchParams.set('deploymentType', REMOTE_DEPLOYMENT_TYPE);

    const headers = { 'Content-Type': 'application/json' };
    if (REMOTE_TOKEN) headers['Authorization'] = `Bearer ${REMOTE_TOKEN}`;

    // minimal http/https client
    const useHttps = url.protocol === 'https:';
    const lib = await import(useHttps ? 'https' : 'http');
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (useHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      headers
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

    if (resp.status < 200 || resp.status >= 300) {
      return res.status(502).json({ error: 'remote_deploy_failed', status: resp.status, body: resp.text });
    }
    let parsed; try { parsed = JSON.parse(resp.text) } catch { parsed = { raw: resp.text } }
    return res.json({ ok: true, remote: parsed });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: e?.message || String(e) });
  }
});

// Start editor server (runtime + editor)
await runtime.start();
await editorAPI.start();

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
