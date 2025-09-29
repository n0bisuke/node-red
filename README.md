# ランタイム + サーバー実行版

Node.js v22 で動作します。

## セットアップ / 起動

```
$ npm i
$ NR_SERVER_TOKEN=your-secret node run.mjs
```

- `PORT` (任意): API サーバーのポート。デフォルト `1880`（Node-RED規定）。
- `HOST` (任意): 受付アドレス。デフォルト `0.0.0.0`。
- `NR_SERVER_TOKEN` (任意): Bearer トークン。設定した場合は全 API で `Authorization: Bearer <token>` が必須。
- `CORS_ORIGIN` (任意): CORS の許可オリジン。デフォルト `*`。

起動すると Node-RED ランタイムが headless モードで立ち上がり、同時にシンプルな HTTP API が開きます。

### ランタイムのみで起動（サーバー無効化）

```
ENABLE_API_SERVER=false node run.mjs
```

`ENABLE_API_SERVER=false` を指定すると、HTTP API サーバー部分を起動しません。別プロジェクトのサーバーと分離運用する際に利用します。

## 分離エディタ（editor-solo）

実験用に、公式エディタを独立起動するサブプロジェクトを同梱しています（safe modeで実行停止）。

起動手順:
```
$ npm run editor:start   # 初回は editor-solo ディレクトリで npm i が必要
```

環境変数（例）:
- `EDITOR_PORT=1881`（デフォルト）
- `REMOTE_BASE_URL=http://localhost:1880`（このリポジトリのランタイム）
- `REMOTE_TOKEN=<NR_SERVER_TOKEN>`

リモートへデプロイ（ミラー送信）:
```
curl -X POST http://localhost:1881/admin/remote/deploy
```

## API エンドポイント

- `GET /health` ランタイムの起動状態と現在の `rev` を返します。
- `GET /flows` 現在のフロー定義 (`{ rev, flows, ... }`) を返します。
- `POST /flows` フローをデプロイします。
  - ボディは次のいずれか:
    - 配列のまま: `[{...node...}, ...]`
    - オブジェクト: `{ "flows": [...], "credentials": { ... } }`
  - クエリ `deploymentType` に `full|flows|nodes|reload` を指定可能。省略時は `full`。
  - レスポンス: `{ ok: true, rev: "..." }`
- `GET /state` ランタイムの状態を取得します (`{ state: "running" | "stopped" }` など)。
- `POST /state` ランタイムを開始/停止します。
  - ボディ: `{ "state": "start" }` または `{ "state": "stop" }`
- `POST /reload` ストレージ上のフローを再読込します。

## テスト用ツール（npm scripts）

- `npm run tools:push` サンプルフローをデプロイ（`testtools/basic-flow.json`）。
  - 環境変数: `BASE_URL`（既定 `http://localhost:1880`）、`NR_SERVER_TOKEN`（設定時はBearer付与）、`DEPLOYMENT_TYPE`（既定 `full`）
  - 任意のフローを送る: `npm run tools:push -- path/to/flow.json`
- `npm run tools:get` 現在のフローを取得し表示
- `npm run tools:start` / `npm run tools:stop` フローの開始/停止

例:
```
NR_SERVER_TOKEN=your-secret npm run tools:push -- testtools/basic-flow.json
NR_SERVER_TOKEN=your-secret npm run tools:get
NR_SERVER_TOKEN=your-secret npm run tools:stop
NR_SERVER_TOKEN=your-secret npm run tools:start
```

### 例: フローをデプロイ

```
curl -X POST \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer your-secret' \
  --data @flow.json \
  http://localhost:1880/flows
```

`flow.json` は配列（または `{flows:[...], credentials:{}}` 形式）を想定しています。

## 試すフロー

```json
[
    {
        "id": "function-logger",
        "type": "function",
        "z": "flow-main",
        "name": "Console Logger",
        "func": "const now = new Date();\nconst counter = context.get('counter') || 0;\ncontext.set('counter', counter + 1);\n\nconst message = `はろー🚀 Node-RED Runtime Working! Count: ${counter + 1}, Time: ${now.toLocaleString('ja-JP')}`;\nconsole.log(message);\nnode.warn(message);\n\nreturn msg;",
        "outputs": 1,
        "timeout": "",
        "noerr": 0,
        "initialize": "",
        "finalize": "",
        "libs": [],
        "x": 320,
        "y": 80,
        "wires": [
            []
        ]
    },
    {
        "id": "inject-timer",
        "type": "inject",
        "z": "flow-main",
        "name": "3秒毎実行",
        "props": [
            {
                "p": "payload"
            },
            {
                "p": "topic",
                "vt": "str"
            }
        ],
        "repeat": "3",
        "crontab": "",
        "once": true,
        "onceDelay": "2",
        "topic": "heartbeat",
        "payload": "",
        "payloadType": "date",
        "x": 120,
        "y": 80,
        "wires": [
            [
                "function-logger"
            ]
        ]
    }
]
```

この JSON をファイルに保存し、上記の `POST /flows` に送ることで即時に起動・実行されます。
