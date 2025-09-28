# Editor Solo (Standalone Node-RED Editor)

This is a minimal standalone Node-RED Editor suitable for experiments where the editor is separated from the runtime. It serves the official editor UI using the modular packages (`@node-red/runtime` + `@node-red/editor-api` + `@node-red/editor-client`) and runs in safe mode so flows do not execute here.

## Run

```
$ cd editor-solo
$ npm i
$ EDITOR_PORT=1881 node server.mjs
```

- Editor URL: `http://localhost:1881/admin`
- Safe mode: enabled (flows won’t run in this instance)

## Env Vars
- `EDITOR_PORT` (default 1881): Port for the editor server
- `EDITOR_HOST` (default 0.0.0.0): Bind address
- `REMOTE_BASE_URL` (optional): Remote runtime base URL (e.g. `http://localhost:1880`)
- `REMOTE_TOKEN` (optional): Bearer for the remote runtime
- `REMOTE_DEPLOYMENT_TYPE` (default `full`): `full|nodes|flows|reload`

## Remote deploy helper
After saving flows in the editor, you can mirror them to the separate runtime:

```
# In another terminal
curl -X POST \
  -H "Authorization: Bearer $REMOTE_TOKEN" \
  http://localhost:1881/admin/remote/deploy
```

The endpoint fetches the current editor flows and POSTs them to `${REMOTE_BASE_URL}/flows` in the same shape the runtime expects.

## Notes
- This subproject uses the modular packages: `@node-red/runtime`, `@node-red/editor-api`, `@node-red/editor-client`, `@node-red/nodes`.
- The editor instance disables `httpNodeRoot` and runs with `safeMode: true` to avoid executing flows locally.
- For a full official setup, the unified `node-red` package could be used to simplify embedding; here we keep modules explicit as a step towards deeper separation experiments.
