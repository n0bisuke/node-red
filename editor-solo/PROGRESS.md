# editor-solo 進捗ログ / 設計メモ

日付: 2025-09-28

## 目的
- 公式エディタ（@node-red/editor-api + @node-red/editor-client）を、ランタイムと分離して単体起動できる形で検証する。
- エディタ側は safeMode で実行を止め、編集・保存のみ行う。
- 保存したフローを、別プロセスで動かす headless ランタイムへミラー送信できるようにする。

## 現状の構成
- モジュール: `@node-red/runtime`, `@node-red/editor-api`, `@node-red/editor-client`, `@node-red/nodes`, `@node-red/util`, `express`
- エントリ: `editor-solo/server.mjs`
- ポート: 既定 `1881`（ランタイムの 1880 と分離）
- 設定:
  - `httpAdminRoot: '/admin'`
  - `httpNodeRoot: false`（HTTP In/Out を無効化）
  - `safeMode: true`（エディタ側ではフローを実行しない）
  - `coreNodesDir` を `@node-red/nodes/core` に設定（必須）
- マウント順（重要）:
  1. `app.use('/admin', runtime.httpAdmin)`
  2. `app.use('/admin', editorAPI.httpAdmin)`
  - ノードが提供する管理用アセット（例: `/admin/debug/view/debug-utils.js`）を先に解決させるため、`runtime.httpAdmin` を前に配置
- リモートデプロイ補助:
  - `POST /admin/remote/deploy`
  - 実装: `runtime.flows.getFlows({})` で現在フローを取得し、`REMOTE_BASE_URL/flows?deploymentType=...` に POST（Bearer `REMOTE_TOKEN` 対応）

## 起動方法（エディタ）
```
cd editor-solo
npm i            # 初回のみ
EDITOR_PORT=1881 \
REMOTE_BASE_URL=http://localhost:1880 \
REMOTE_TOKEN=<ランタイム側のNR_SERVER_TOKEN> \
npm start
```
- エディタ: `http://localhost:1881/admin`
- リモートへデプロイ: `curl -X POST http://localhost:1881/admin/remote/deploy`

## 起動方法（ランタイム側・参考）
- ルートの `run.mjs` は headless ランタイム + 最小API サーバー
- 既定: `PORT=1880`
```
NR_SERVER_TOKEN=<長いトークン> node run.mjs
# API: GET/POST /flows, GET/POST /state, GET /health, POST /reload
```
- ランタイムのみ（APIサーバー無効）:
```
ENABLE_API_SERVER=false node run.mjs
```

## 環境変数（editor-solo）
- `EDITOR_PORT`（既定 1881）
- `EDITOR_HOST`（既定 0.0.0.0）
- `REMOTE_BASE_URL`（例: `http://localhost:1880`）
- `REMOTE_TOKEN`（ランタイム側 `NR_SERVER_TOKEN`）
- `REMOTE_DEPLOYMENT_TYPE`（既定 `full`）

## これまでに解消した問題
- editor-api 初期化で `runtimeAPI.isStarted(...).then is not a function`
  - 原因: editor-api に内部オブジェクト `runtime._` を渡していた
  - 対応: 公開APIの `runtime` を渡す（`editorAPI.init(settings, server, runtime.storage, runtime)`）
- `/admin` 直下で 404、debug アセットが text/html で返る
  - 原因: `/admin` のマウント順と対象が不正（`runtime.adminApp` ではなく `runtime.httpAdmin`）
  - 対応: `runtime.httpAdmin` → `editorAPI.httpAdmin` の順で同一ルートにマウント
- ノードが「不明」扱い・UI初期化で停止（2/37 で止まる等）
  - 原因: `coreNodesDir` 未指定、`examples` ディレクトリ不在
  - 対応: `coreNodesDir` を `@node-red/nodes/core` に設定／`core/examples` を事前作成

## 既知の制限
- エディタ側は safeMode のためフローは実行されない（設計通り）
- 認証（adminAuth）は未設定。実験用途前提
- Deploy ボタン押下時に自動ミラー送信は未連携（手動で `/admin/remote/deploy`）

## 次のステップ（TODO）
- エディタの「デプロイ」操作にフックしてリモートへ自動ミラー送信
- editor 側の認証（`adminAuth`）追加
- リモートランタイムのログをエディタでライブ表示（SSE/WS 中継）
- Docker/Compose 化（editor と runtime を別サービスに）
- Cloudflare Workers 等の非 Node 環境を想定した API 互換範囲の洗い出し

## トラブルシューティング・チェックリスト
- Network タブ
  - `GET /admin/nodes` が 200 か
  - `GET /admin/debug/view/debug-utils.js` が 200 か（Content-Type: application/javascript）
  - `GET /admin/nodes/messages?lng=ja` が 200 か
- サーバーログ
  - `[editor:error]` が出ていないか
- データ
  - `editor-solo/data-editor/flows.json` を一旦退避し空で起動し直す

