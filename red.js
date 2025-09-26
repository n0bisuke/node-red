/**
 * Copyright 2013 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/
var http = require('http');
var https = require('https');
var express = require("express");
var crypto = require("crypto");
var basicAuth = require("basic-auth");
var { Hono } = require('hono');
var { serve } = require('@hono/node-server');
var settings = require("./settings");
var RED = require("./red/red.js");

var server;
var app = express();
var honoApp = new Hono(); // 将来のHono移行用

if (settings.https) {
    server = https.createServer(settings.https,function(req,res){app(req,res);});
} else {
    server = http.createServer(function(req,res){app(req,res);});
}

settings.httpRoot = settings.httpRoot||"/";

if (settings.httpRoot[0] != "/") {
    settings.httpRoot = "/"+settings.httpRoot;
}
if (settings.httpRoot.slice(-1) != "/") {
    settings.httpRoot = settings.httpRoot + "/";
}
settings.uiPort = settings.uiPort||1880;

if (settings.httpAuth) {
    app.use(settings.httpRoot, function(req, res, next) {
        var credentials = basicAuth(req);
        if (!credentials ||
            credentials.name !== settings.httpAuth.user ||
            crypto.createHash('md5').update(credentials.pass,'utf8').digest('hex') !== settings.httpAuth.pass) {
            res.statusCode = 401;
            res.setHeader('WWW-Authenticate', 'Basic realm="Node-RED"');
            res.end('Access denied');
        } else {
            next();
        }
    });
}

// コマンドライン引数の処理
var args = process.argv.slice(2);
for (var i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
        settings.uiPort = parseInt(args[i + 1]);
        i++; // 次の引数をスキップ
    } else if (args[i].indexOf('.json') > -1) {
        settings.flowFile = args[i];
    }
}
settings.flowFile = settings.flowFile;

var red = RED.init(server,settings);

// Hono エンドポイントの追加テスト
honoApp.get('/nodes', async (c) => {
    const redNodes = require('./red/nodes.js');
    return c.text(redNodes.getNodeConfigs(), 200, {
        'Content-Type': 'text/plain'
    });
});

// /flows GETエンドポイントのHono実装
honoApp.get('/flows', async (c) => {
    const fs = require('fs');
    const path = require('path');
    const flowfile = settings.flowFile || 'flows_'+require('os').hostname()+'.json';

    return new Promise((resolve, reject) => {
        fs.exists(flowfile, (exists) => {
            if (exists) {
                fs.readFile(path.resolve(flowfile), 'utf8', (err, data) => {
                    if (err) {
                        resolve(c.text('[]', 200, {'Content-Type': 'application/json'}));
                    } else {
                        resolve(c.text(data, 200, {'Content-Type': 'application/json'}));
                    }
                });
            } else {
                resolve(c.text('[]', 200, {'Content-Type': 'application/json'}));
            }
        });
    });
});

// /flows POSTエンドポイントのHono実装
honoApp.post('/flows', async (c) => {
    const fs = require('fs');
    const path = require('path');
    const flowfile = settings.flowFile || 'flows_'+require('os').hostname()+'.json';

    try {
        const body = await c.req.text();

        return new Promise((resolve, reject) => {
            fs.writeFile(flowfile, body, (err) => {
                if (err) {
                    console.log('[hono] Error saving flows:', err);
                } else {
                    console.log('[hono] Flows saved to:', flowfile);
                }
                resolve(c.text('', 204));
            });
        });
    } catch (error) {
        return c.text('Error processing request', 500);
    }
});

// UI関連エンドポイントのHono実装
// ルートパス（/）のリダイレクト処理
honoApp.get('/', async (c) => {
    const url = new URL(c.req.url);
    if (!url.pathname.endsWith('/')) {
        return c.redirect(url.pathname + '/', 301);
    }
    // 静的ファイル配信は別途実装が必要
    return c.text('Node-RED UI - Static files need implementation', 200, {
        'Content-Type': 'text/html'
    });
});

// アイコンエンドポイント
honoApp.get('/icons/:icon', async (c) => {
    const fs = require('fs');
    const path = require('path');
    const icon = c.req.param('icon');

    const icon_paths = [
        path.resolve(__dirname + '/nodes/core/icons'),
        path.resolve(__dirname + '/nodes/io/icons'),
        path.resolve(__dirname + '/nodes/social/icons'),
        path.resolve(__dirname + '/nodes/hardware/icons'),
        path.resolve(__dirname + '/nodes/analysis/icons'),
        path.resolve(__dirname + '/nodes/storage/icons')
    ];

    return new Promise((resolve, reject) => {
        let found = false;
        for (let p of icon_paths) {
            const iconPath = path.join(p, icon);
            if (fs.existsSync(iconPath)) {
                fs.readFile(iconPath, (err, data) => {
                    if (err) {
                        resolve(c.notFound());
                    } else {
                        const ext = path.extname(icon).toLowerCase();
                        let contentType = 'image/png';
                        if (ext === '.svg') contentType = 'image/svg+xml';
                        if (ext === '.gif') contentType = 'image/gif';
                        if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';

                        resolve(c.body(data, 200, {
                            'Content-Type': contentType
                        }));
                    }
                });
                found = true;
                break;
            }
        }
        if (!found) {
            // デフォルトアイコン
            const defaultIcon = path.resolve(__dirname + '/public/icons/arrow-in.png');
            fs.readFile(defaultIcon, (err, data) => {
                if (err) {
                    resolve(c.notFound());
                } else {
                    resolve(c.body(data, 200, {
                        'Content-Type': 'image/png'
                    }));
                }
            });
        }
    });
});

// コアノードのHTTP APIをHono実装
// Debug ノード API
honoApp.post('/debug/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.text();

    // デバッグノードの処理をここに実装
    console.log('[hono] Debug node:', id, 'data:', body);

    return c.text('OK', 200);
});

// Inject ノード API
honoApp.post('/inject/:id', async (c) => {
    const id = c.req.param('id');

    // Injectノードの処理をここに実装
    console.log('[hono] Inject triggered for node:', id);

    return c.text('OK', 200);
});

// Serial ポート API（存在する場合）
honoApp.get('/serialports', async (c) => {
    // シリアルポート一覧を返す
    // 実際の実装では利用可能なポートをスキャンする
    return c.json([]);
});

// HonoアプリケーションをExpressミドルウェアとして統合

// Honoを手動でExpressミドルウェアに変換
const honoToExpress = (req, res, next) => {
    // HonoのRequest オブジェクトを作成
    const url = new URL(req.url, `http://${req.headers.host}`);
    const honoRequest = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? req : undefined
    });

    honoApp.fetch(honoRequest)
        .then(async (response) => {
            if (response.status === 404) {
                next(); // Honoで処理されなかった場合はExpressに委譲
                return;
            }

            res.status(response.status);
            response.headers.forEach((value, key) => {
                res.setHeader(key, value);
            });

            const body = await response.text();
            res.send(body);
        })
        .catch(() => {
            next(); // エラーの場合はExpressに委譲
        });
};

app.use('/hono', honoToExpress);
app.use(settings.httpRoot,red);

// 将来的にHonoに移行するための準備
// honoApp.mount(settings.httpRoot, convertExpressToHono(red));

RED.start();

server.listen(settings.uiPort,function() {
	console.log('[red] Server now running at http'+(settings.https?'s':'')+'://127.0.0.1:'+settings.httpRoot);
});

process.on('uncaughtException',function(err) {
        if (err.errno === "EADDRINUSE") {
            console.log('[red] Unable to listen on http'+(settings.https?'s':'')+'://127.0.0.1:'+settings.uiPort+settings.httpRoot);
            console.log('[red] Error: port in use');
        } else {
            console.log('[red] Uncaught Exception:');
            console.log(err.stack);
        }
        process.exit(1);
});

process.on('SIGINT', function () {
    RED.stop();
    // TODO: need to allow nodes to close asynchronously before terminating the
    // process - ie, promises 
    process.exit();
});
