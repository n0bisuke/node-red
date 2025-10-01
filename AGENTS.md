# Agent Notes: Two-Layer Node-RED (Editor + Runtime) and Edge Path

This repo provides a split architecture:
- Editor layer (editor-solo): full Node-RED Editor UI via `@node-red/editor-api` + `@node-red/editor-client` running in safeMode (no flow execution). It mirrors deployments and interactive actions to a runtime.
- Runtime layer (run.mjs + api-server.mjs): headless `@node-red/runtime` that executes flows and exposes a minimal API. Future path includes a small edge runtime (Deno/Workers) with the same minimal API.

## High-Level Design
- Editor (port 1881 by default)
  - `safeMode: true`, `httpNodeRoot: false` — edit-only.
  - Uses local `@node-red/nodes` to render the palette.
  - On Deploy: auto-mirror current flows to the runtime (`/flows`).
  - Inject click: proxied to the runtime (`/inject/:id`).
  - Debug messages: streamed from runtime SSE (`/events/debug`) and shown in the Debug sidebar.
  - Optional adminAuth via env vars.
- Runtime (port 1880 by default)
  - Headless `@node-red/runtime` + lightweight HTTP server.
  - Provides minimal API and streams debug SSE.
  - Future: may be swapped for an edge small runtime (Deno/Workers) that implements the same API.

## Minimal Runtime API (implemented in `api-server.mjs`)
Base path supports both direct and `/admin` prefix (e.g. `/flows` and `/admin/flows`).

- `GET /health` → `{ ok, started, rev }`
- `GET /flows` → returns current flows `{ rev, flows, credentials? }`
- `POST /flows?deploymentType=full|flows|nodes|reload` → deploys, returns `{ ok, rev }`
- `GET /state` / `POST /state` → get/set run state (`start|stop`)
- `POST /reload` → reload from storage
- `POST /inject/:id` → manually trigger a node's `receive()`
- `GET /events/debug` → SSE stream of debug messages (for Editor UI)
- `GET /caps` → capability report: supported node types and API flags

Notes:
- CORS enabled; origin via `CORS_ORIGIN` (default `*`).
- Body limit: `BODY_LIMIT` (default 10MB).
- Auth: `NR_SERVER_TOKEN` enables Bearer token check.

## Editor–Runtime Bridge (implemented in `editor-solo/server.mjs`)
- Auto-mirror on Deploy: after successful `POST /admin/flows`, Editor posts to runtime `/flows` (controllable by `EDITOR_AUTO_MIRROR`, default true).
- Inject proxy: `POST /admin/inject/:id` → runtime `/inject/:id`.
- Debug bridge: consumes runtime `/events/debug` via SSE and republishes on Editor comms so the Debug panel shows messages.
- Caps proxy: `GET /admin/remote/caps` → runtime `/caps` (used for soft validation during Deploy).

## Soft Validation (compatibility check)
- During Deploy, Editor fetches runtime `/caps` and compares the set of node types used in the current flows.
- For unknown types, Editor logs a warning but does not block deployment (soft-fail). This prepares for smaller runtimes (e.g., edge) with limited node support.
- Future: promote to hard validation or grey-out unsupported nodes in the palette when an "edge profile" is active.

## Environment Variables
- Runtime:
  - `PORT` (default 1880), `HOST` (default 0.0.0.0)
  - `NR_SERVER_TOKEN` (Bearer token)
  - `CORS_ORIGIN` (default `*`), `BODY_LIMIT` (default `10MB`)
  - `ENABLE_API_SERVER` (`false` to disable minimal API)
- Editor:
  - `EDITOR_PORT` (default 1881), `EDITOR_HOST` (default 0.0.0.0)
  - `REMOTE_BASE_URL`, `REMOTE_TOKEN`, `REMOTE_DEPLOYMENT_TYPE`
  - `EDITOR_AUTO_MIRROR` (default true)
  - `EDITOR_ADMIN_USER`, `EDITOR_ADMIN_PASSWORD_HASH` (or `EDITOR_ADMIN_PASSWORD` with bcryptjs)

## Test Tools (`testtools/`)
- `testtools/send-flow.mjs` — POST a flow to runtime `/flows` (uses `BASE_URL`, `NR_SERVER_TOKEN`)
- `testtools/get-flows.mjs` — GET runtime `/flows`
- `testtools/set-state.mjs` — POST runtime `/state` with `start`/`stop`

NPM scripts:
- `npm run tools:push`
- `npm run tools:get`
- `npm run tools:start`
- `npm run tools:stop`

## Edge Path (Deno/Workers)
- Keep Editor UI unchanged. Implement a small runtime with the same minimal API: `/flows`, `/inject/:id`, `/events/debug`, `/health` (plus `/state`, `/caps`).
- Start with Deno Deploy MVP (inject/function/debug), then add `change` and `http request`.
- Add `/caps` to declare supported node types; Editor uses it for Deploy-time validation.

## Changelog
- 2025-09-28
  - Headless runtime + minimal API, `/admin` prefix support, `NR_SERVER_TOKEN`, CORS.
  - `editor-solo` added: safeMode editor, auto-mirror on Deploy, Inject proxy, Debug SSE bridge.
  - Added `/caps` design; bridge and soft validation plan.
