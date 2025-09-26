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

var fs = require('fs');
var util = require('util');
var path = require('path');
var createUI = require("./ui");
var redNodes = require("./nodes");

//TODO: relocated user dir

var flowfile = '';

var app = null;
var server = null;

function createServer(_server,settings) {
    server = _server;
    app = createUI(settings);
    
    flowfile = settings.flowFile || 'flows_'+require('os').hostname()+'.json';
    
    //TODO: relocated user dir
    fs.exists("lib/",function(exists) {
            if (!exists) {
                fs.mkdir("lib");
            }
    });
    
    app.get("/nodes",function(req,res) {
            res.writeHead(200, {'Content-Type': 'text/plain'});
            res.write(redNodes.getNodeConfigs());
            res.end();
    });
    
    app.get("/flows",function(req,res) {
            fs.exists(flowfile, function (exists) {
                    if (exists) {
                        res.sendFile(path.resolve(flowfile));
                    } else {
                        res.writeHead(200, {'Content-Type': 'text/plain'});
                        res.write("[]");
                        res.end();
                    }
            });
    });
    
    app.post("/flows",function(req,res) {
            var fullBody = '';
            req.on('data', function(chunk) {
                    fullBody += chunk.toString();
            });
            req.on('end', function() {
                    res.writeHead(204, {'Content-Type': 'text/plain'});
                    res.end();
                    fs.writeFile(flowfile, fullBody, function(err) {
                            if(err) {
                                console.log(err);
                            } else {
                                redNodes.setConfig(JSON.parse(fullBody));
                            }
                    });
            });
    });
}

function start() {
    console.log("\nWelcome to Node-RED\n===================\n");
    console.log("[red] Loading palette nodes");
    console.log("------------------------------------------");
    redNodes.load();
    console.log("");
    console.log('You may ignore any errors above here if they are for');
    console.log('nodes you are not using. The nodes indicated will not');
    console.log('be available in the main palette until any missing');
    console.log('modules are installed, typically by running:');
    console.log('   npm install {the module name}');
    console.log('or any other errors are resolved');
    console.log("------------------------------------------");
    
    
    fs.exists(flowfile, function (exists) {
            if (exists) {
                console.log("[red] Loading flows : "+flowfile);
                fs.readFile(flowfile,'utf8',function(err,data) {
                        redNodes.setConfig(JSON.parse(data));
                });
            } else {
                console.log("[red] Flows file not found : "+flowfile);
            }
    });
}

function stop() {
    redNodes.stopFlows();
}

module.exports = { 
    init: createServer,
    start: start,
    stop: stop
}

module.exports.__defineGetter__("app", function() { return app });
module.exports.__defineGetter__("server", function() { return server });
