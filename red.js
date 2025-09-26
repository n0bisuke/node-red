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
