# Agent Notes: Node-RED Headless Runtime + API Server

This repository runs a headless Node-RED runtime (no Editor) and exposes a minimal HTTP API to push/get flows and control run state. This file documents decisions, endpoints, env vars, and test tools for future maintainers/agents.

## Overview
- Runtime: `@node-red/runtime` (no `@node-red/editor-api`).
- Entry: `run.mjs` — starts Node-RED headless and a lightweight HTTP server (no extra deps).
- Default port: `1880` (aligned with Node-RED default).
- Editor UI is disabled: `disableEditor: true`.
- Programmatic start/stop enabled: `settings.runtimeState.enabled = true`.
- Preflight: validates `data/flows.json`, ensures `@node-red/nodes/core/examples` exists to avoid crashes on some versions.

## API Endpoints (implemented in `run.mjs`)
Base path supports both direct and `/admin` prefix (e.g. `/flows` and `/admin/flows`).

- `GET /health` → `{ ok, started, rev }`
- `GET /flows` → `{ rev, flows, ... }`
- `POST /flows?deploymentType=full|flows|nodes|reload`
  - Body: either an array of nodes, or `{ flows: [...], credentials: {} }`
  - Response: `{ ok: true, rev }`
- `GET /state` → runtime state
- `POST /state` with `{ state: "start" | "stop" }`
- `POST /reload` → reload flows from storage

Notes:
- CORS enabled; origin configurable via `CORS_ORIGIN` (default `*`).
- Request body limit: 10MB (configurable via `BODY_LIMIT`).

## Security
- Bearer token required if `NR_SERVER_TOKEN` is set. All endpoints check `Authorization: Bearer <token>`.
- If `NR_SERVER_TOKEN` is NOT set, endpoints are open — do not use in production without a reverse proxy/firewall.
- Recommended: run behind TLS-terminating reverse proxy and restrict IPs as needed.

## Environment Variables
- `PORT` (default `1880`): API server port
- `HOST` (default `0.0.0.0`): bind address
- `NR_SERVER_TOKEN` (optional): Bearer token to protect endpoints
- `CORS_ORIGIN` (default `*`): CORS allowed origin
- `BODY_LIMIT` (default `10485760`): request body size limit in bytes

## Test Tools (`testtools/`)
Lightweight Node scripts for manual testing (compatible with older Node — no `fetch`, no `node:` imports).

- `testtools/send-flow.mjs` — POST a flow to `/flows`
  - Defaults to `testtools/basic-flow.json`
  - Env: `BASE_URL` (default `http://localhost:1880`), `NR_SERVER_TOKEN`, `DEPLOYMENT_TYPE` (default `full`)
- `testtools/get-flows.mjs` — GET `/flows`
- `testtools/set-state.mjs` — POST `/state` with `start`/`stop`

NPM scripts:
- `npm run tools:push`
- `npm run tools:get`
- `npm run tools:start`
- `npm run tools:stop`

## Current Limitations
- No official Admin API (`/auth/token`, nodes install/remove, etc.) — we do not include `@node-red/editor-api`.
- No Node-RED Editor UI.
- No live log streaming endpoint (SSE/WS) yet.

## Possible Next Steps
- Optional integration with `@node-red/editor-api` to support `node-red-admin` and richer management endpoints.
- SSE/WS endpoint to stream logs/debug events to external tools.
- Dockerfile/Compose for deployment, plus reverse proxy examples (Nginx/Caddy).
- Flow schema validation and improved error reporting.

## Changelog (2025-09-28)
- Added minimal HTTP API server to `run.mjs` with endpoints: `/health`, `/flows` (GET/POST), `/state` (GET/POST), `/reload`.
- Enabled `/admin`-prefixed path aliases (e.g. `/admin/flows`).
- Default port changed to `1880`.
- Added security via `NR_SERVER_TOKEN` and CORS support (`CORS_ORIGIN`).
- Created `testtools/` with `send-flow.mjs`, `get-flows.mjs`, `set-state.mjs`, and `basic-flow.json`.
- Updated `README.md` with usage and examples.

