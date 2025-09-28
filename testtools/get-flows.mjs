#!/usr/bin/env node
// Fetch current flows from the runtime (no fetch)
import http from 'http';
import https from 'https';

const BASE_URL = process.env.BASE_URL || 'http://localhost:1880';
const TOKEN = process.env.NR_SERVER_TOKEN || process.env.TOKEN || '';

function httpRequest(method, urlStr, headers) {
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
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function main() {
  try {
    const headers = {};
    if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
    const url = new URL('/flows', BASE_URL).toString();
    const res = await httpRequest('GET', url, headers);
    const text = res.text || '';
    let data; try { data = JSON.parse(text) } catch { data = text }
    if (res.status < 200 || res.status >= 300) {
      console.error('Request failed:', res.status, res.statusText, '\n', data);
      process.exit(1);
    }
    if (typeof data === 'object' && data && Array.isArray(data.flows)) {
      console.log(`rev=${data.rev} items=${data.flows.length}`);
    }
    if (typeof data === 'string') console.log(data); else console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
}

main();
