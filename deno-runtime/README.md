# Deno Minimal Runtime (Stub)

This is a minimal Deno runtime stub that exposes the small API used by `editor-solo`:
- GET `/health` → `{ ok, started, rev }`
- GET `/caps` → `{ api: {...}, nodes: [...] }`
- GET `/flows` / POST `/flows` → get/set flows
- POST `/inject/:id` → simulate a trigger (emits a debug event)
- GET `/events/debug` → Server‑Sent Events stream of debug messages

It does NOT execute flows. It is for checking the Editor bridge (Deploy → /flows, Inject proxy, Debug SSE).

## Run locally

```
# from repo root
NR_SERVER_TOKEN=hogehoge deno run --allow-net --allow-env deno-runtime/deno-stub.ts
```

- Default port: 1880 (override with `PORT`)
- CORS: `CORS_ORIGIN` (default `*`)

## Test endpoints

```
curl http://localhost:1880/health
curl http://localhost:1880/caps
curl -N http://localhost:1880/events/debug
```

## Connect editor-solo

```
# in another terminal
cd editor-solo && npm i   # first time only
EDITOR_PORT=1881 \
REMOTE_BASE_URL=http://localhost:1880 \
REMOTE_TOKEN=hogehoge \
npm start
```

- Open: http://localhost:1881/admin
- Create a small flow (inject → function → debug), Deploy
- Click Inject → see debug messages on the SSE terminal and in the Editor Debug panel

## Next steps
- Replace the stub with a small runtime that actually executes inject/function/debug nodes
- Keep the same API surface so the Editor bridge works unmodified

