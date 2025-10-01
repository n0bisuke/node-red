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
- リモートデプロイ連携:
  - 手動: `POST /admin/remote/deploy`
  - 自動: Deploy 成功後に `REMOTE_BASE_URL/flows` へ自動POST（`EDITOR_AUTO_MIRROR`、既定 true）
  - ヘルス: `GET /admin/remote/health`（リモートの `/health` をプロキシ）

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
- リモートへデプロイ（手動）: `curl -X POST http://localhost:1881/admin/remote/deploy`
- リモートへデプロイ（自動）: Deploy 成功後に自動ミラー（`EDITOR_AUTO_MIRROR=false` で無効化可）

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
- `EDITOR_AUTO_MIRROR`（既定 true）
- `EDITOR_ADMIN_USER` + `EDITOR_ADMIN_PASSWORD_HASH`（任意: editor 側 adminAuth）
- `EDITOR_ADMIN_PASSWORD`（任意: 平文 → 起動時に bcryptjs でハッシュ化）

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
- editor 側の adminAuth は簡易（環境変数での資格情報指定）。細かな権限分離は未対応

## 次のステップ（TODO）
- Deploy UI にリモート送信結果（成功/失敗）を通知表示
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

## 接続確認（Editor → Runtime）
1. ランタイム起動: `NR_SERVER_TOKEN=... node run.mjs`
2. エディタ起動: `EDITOR_PORT=1881 REMOTE_BASE_URL=http://localhost:1880 REMOTE_TOKEN=... npm start`
3. エディタで Deploy 実行
   - ターミナル: `[editor] auto-mirror ok: 200` が表示
   - ランタイム: `BASE_URL=http://localhost:1880 NR_SERVER_TOKEN=... npm run tools:get` で反映確認
4. 失敗時の代表例
   - 401/403: REMOTE_TOKEN 不一致
   - 404: ランタイムの `/flows` 無効（`ENABLE_API_SERVER=false`）
   - 5xx: ランタイム側エラー（ランタイムログ参照）
