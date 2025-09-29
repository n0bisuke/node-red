// run.mjs - headless runtime + minimal API server
import { createRequire } from 'module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
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

// ④ Minimal API server を別ファイルに切り出し（独立/無効化可能）
if ((process.env.ENABLE_API_SERVER || 'true') !== 'false') {
  const { startApiServer } = await import('./api-server.mjs');
  await startApiServer({ runtime });
}
