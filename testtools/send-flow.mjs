#!/usr/bin/env node
// Send a flow to the runtime's /flows endpoint (no fetch, no node: prefix)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';

const BASE_URL = process.env.BASE_URL || 'http://localhost:1880';
const TOKEN = process.env.NR_SERVER_TOKEN || process.env.TOKEN || '';
const DEPLOYMENT_TYPE = process.env.DEPLOYMENT_TYPE || 'full';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultFlow = path.join(__dirname, 'basic-flow.json');
const file = process.argv[2] ? path.resolve(process.argv[2]) : defaultFlow;

function httpRequest(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === 'https:' ? https : http;
      const options = {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        headers: headers || {}
      };
      const req = lib.request(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, statusText: res.statusMessage, text: data }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function main() {
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    let body;
    try {
      const parsed = JSON.parse(raw);
      // Accept array or object; normalize to {flows, credentials}
      body = Array.isArray(parsed) ? { flows: parsed, credentials: {} } : parsed;
      if (!body.credentials) body.credentials = {};
    } catch (e) {
      console.error('JSON parse error:', e.message);
      process.exit(2);
    }

    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

    const url = new URL('/flows', BASE_URL);
    url.searchParams.set('deploymentType', DEPLOYMENT_TYPE);

    const res = await httpRequest('POST', url.toString(), headers, JSON.stringify(body));
    const text = res.text || '';
    let maybeJson;
    try { maybeJson = JSON.parse(text) } catch { maybeJson = text }
    if (res.status < 200 || res.status >= 300) {
      console.error('Deploy failed:', res.status, res.statusText, '\n', maybeJson);
      process.exit(1);
    }
    console.log('Deploy OK:', maybeJson);
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
}

main();
