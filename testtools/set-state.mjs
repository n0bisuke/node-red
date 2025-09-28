#!/usr/bin/env node
// Start/Stop runtime flows (no fetch)
import http from 'http';
import https from 'https';

const BASE_URL = process.env.BASE_URL || 'http://localhost:1880';
const TOKEN = process.env.NR_SERVER_TOKEN || process.env.TOKEN || '';
const state = (process.argv[2] || '').toLowerCase();

if (!['start', 'stop'].includes(state)) {
  console.error('Usage: node testtools/set-state.mjs <start|stop>');
  process.exit(2);
}

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
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
    const url = new URL('/state', BASE_URL).toString();
    const res = await httpRequest('POST', url, headers, JSON.stringify({ state }));
    const text = res.text || '';
    let data; try { data = JSON.parse(text) } catch { data = text }
    if (res.status < 200 || res.status >= 300) {
      console.error('Set state failed:', res.status, res.statusText, '\n', data);
      process.exit(1);
    }
    console.log('OK:', data);
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
}

main();
