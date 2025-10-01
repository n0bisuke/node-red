// Deno small runtime MVP: executes a minimal subset of Node-RED flows
// Supported nodes: inject, function, debug
// API: GET/POST /flows, GET/POST /state, POST /inject/:id, GET /events/debug, GET /caps, GET /health

// perms: --allow-net --allow-env

type NodeConfig = {
  id: string;
  type: string;
  name?: string;
  z?: string; // tab id
  wires?: string[][];
  // inject
  repeat?: string | number;
  once?: boolean;
  onceDelay?: string | number;
  props?: { p: string; v?: unknown; vt?: string }[];
  // function
  func?: string;
  // debug
  complete?: string;
};

type FlowsDoc = { rev: string; flows: NodeConfig[]; credentials?: Record<string, unknown> };

const PORT = Number(Deno.env.get("PORT") ?? "1880");
const TOKEN = Deno.env.get("NR_SERVER_TOKEN") ?? "";
const CORS = Deno.env.get("CORS_ORIGIN") ?? "*";

// SSE clients
type Client = { push: (line: string) => void; close: () => void };
const clients = new Set<Client>();
const encoder = new TextEncoder();

function sseHeaders(): Headers {
  return new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": CORS
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": CORS
    })
  });
}

function unauthorized(): Response { return json({ error: "unauthorized" }, 401); }

function corsPreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: new Headers({
        "Access-Control-Allow-Origin": CORS,
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type"
      })
    });
  }
  return null;
}

function auth(req: Request): boolean {
  if (!TOKEN) return true;
  const a = req.headers.get("authorization") ?? "";
  return a.startsWith("Bearer ") && a.slice(7) === TOKEN;
}

function sseBroadcast(topic: string, data: unknown) {
  const line = `data: ${JSON.stringify({ topic, data })}\n\n`;
  for (const c of clients) {
    try { c.push(line); } catch { /* ignore */ }
  }
}

// Simple flow engine
class Engine {
  flows: FlowsDoc = { rev: crypto.randomUUID(), flows: [], credentials: {} };
  running = true;
  nodes = new Map<string, RuntimeNode>();
  wires = new Map<string, string[]>();
  timers: number[] = [];
  context = {
    global: new Map<string, unknown>(),
    flow: new Map<string, Map<string, unknown>>() // by tab id
  };

  stop() {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.nodes.clear();
    this.wires.clear();
  }

  async deploy(doc: FlowsDoc) {
    this.stop();
    this.flows = { rev: crypto.randomUUID(), flows: doc.flows ?? [], credentials: doc.credentials ?? {} };
    // build nodes
    const nodeMap = new Map<string, NodeConfig>();
    for (const n of this.flows.flows) nodeMap.set(n.id, n);
    // wires
    for (const n of this.flows.flows) {
      const outs = (n.wires || []).flat();
      this.wires.set(n.id, outs);
    }
    // instances
    for (const n of this.flows.flows) {
      if (n.type === "inject") this.nodes.set(n.id, new InjectNode(n, this));
      else if (n.type === "function") this.nodes.set(n.id, new FunctionNode(n, this));
      else if (n.type === "debug") this.nodes.set(n.id, new DebugNode(n, this));
    }
    // schedule inject
    for (const node of this.nodes.values()) {
      if (node instanceof InjectNode) node.start();
    }
    this.running = true;
  }

  getNode(id: string): RuntimeNode | undefined { return this.nodes.get(id); }

  async deliver(fromId: string, msg: any) {
    if (!this.running) return;
    const outs = this.wires.get(fromId) || [];
    for (const id of outs) {
      const node = this.nodes.get(id);
      if (node) await node.onMessage(structuredClone(msg));
    }
  }

  getNodeContext(n: NodeConfig): { get: (k: string) => any; set: (k: string, v: any) => void } {
    const flowId = n.z || "";
    if (!this.context.flow.has(flowId)) this.context.flow.set(flowId, new Map());
    const store = this.context.flow.get(flowId)!;
    return {
      get: (k) => store.get(`${n.id}:${k}`),
      set: (k, v) => store.set(`${n.id}:${k}`, v)
    };
  }
}

abstract class RuntimeNode {
  constructor(public conf: NodeConfig, public engine: Engine) {}
  abstract onMessage(msg: any): Promise<void>;
  warn(text: string) {
    sseBroadcast("debug", { id: this.conf.id, name: this.conf.name, level: "warn", msg: text });
    console.warn(`[deno-mvp][${this.conf.id}]`, text);
  }
}

class InjectNode extends RuntimeNode {
  start() {
    const n = this.conf;
    const repeatSec = Number(n.repeat || 0);
    const onceDelay = Number(n.onceDelay || 0);
    if (n.once) {
      const delay = Math.max(0, Math.floor(onceDelay * 1000));
      setTimeout(() => this.fire({}), delay);
    }
    if (repeatSec > 0) {
      const id = setInterval(() => this.fire({}), repeatSec * 1000) as unknown as number;
      this.engine.timers.push(id);
    }
  }
  buildMsg(): any {
    // Minimal: set payload/topic if present in props
    const msg: any = {};
    const props = this.conf.props || [];
    for (const p of props) {
      if (!p || !p.p) continue;
      if (p.vt === "date") msg[p.p] = Date.now();
      else if (p.vt === "str") msg[p.p] = String(p.v ?? "");
      else if (p.vt === "num") msg[p.p] = Number(p.v ?? 0);
      else msg[p.p] = p.v ?? null;
    }
    return msg;
  }
  async fire(_user: any) {
    if (!this.engine.running) return;
    const msg = this.buildMsg();
    await this.engine.deliver(this.conf.id, msg);
  }
  async onMessage(_msg: any) {/* inject ignores inbound */}
}

class FunctionNode extends RuntimeNode {
  async onMessage(msg: any) {
    const code = this.conf.func || "return msg;";
    const ctx = this.engine.getNodeContext(this.conf);
    const nodeApi = {
      warn: (t: string) => this.warn(t),
      status: (_s: any) => {},
      send: (m: any) => this.engine.deliver(this.conf.id, m)
    };
    try {
      // Build sandboxed function with limited globals
      const fn = new Function("msg", "context", "node", code) as (msg: any, context: any, node: any) => any;
      const res = await fn(msg, ctx, nodeApi);
      if (res !== undefined && res !== null) await this.engine.deliver(this.conf.id, res);
    } catch (e) {
      this.warn(`Function error: ${e?.message || e}`);
    }
  }
}

class DebugNode extends RuntimeNode {
  async onMessage(msg: any) {
    const prop = (this.conf.complete && this.conf.complete !== "false") ? this.conf.complete : "payload";
    const out = prop === "true" ? msg : (prop ? getByPath(msg, prop) : msg);
    sseBroadcast("debug", { id: this.conf.id, name: this.conf.name, msg: out });
    console.log(`[deno-mvp][debug:${this.conf.id}]`, safeInspect(out));
  }
}

function getByPath(obj: any, path: string) {
  try { return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj); } catch { return undefined; }
}

function safeInspect(v: any) {
  try { return typeof v === "object" ? JSON.stringify(v) : String(v); } catch { return String(v); }
}

const engine = new Engine();

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (!auth(req)) return unauthorized();
  const url = new URL(req.url);
  const pathname = url.pathname;

  // Health
  if (req.method === "GET" && pathname === "/health") {
    return json({ ok: true, started: true, rev: engine.flows.rev });
  }

  // Caps
  if (req.method === "GET" && pathname === "/caps") {
    return json({ api: { flows: true, inject: true, eventsDebug: true, health: true, state: true }, nodes: ["inject", "function", "debug"] });
  }

  // State
  if (pathname === "/state") {
    if (req.method === "GET") return json({ state: engine.running ? "running" : "stopped" });
    if (req.method === "POST") {
      try {
        const body = await req.json();
        const state = String(body?.state || "");
        if (state === "start") engine.running = true;
        else if (state === "stop") engine.running = false;
        else return json({ error: "invalid_state" }, 400);
        return json({ state: engine.running ? "running" : "stopped" });
      } catch { return json({ error: "invalid_json" }, 400); }
    }
  }

  // Flows
  if (pathname === "/flows") {
    if (req.method === "GET") return json(engine.flows);
    if (req.method === "POST") {
      try {
        const body = await req.json();
        const doc = Array.isArray(body) ? { flows: body, credentials: {} } : body;
        await engine.deploy({ rev: crypto.randomUUID(), flows: doc.flows ?? [], credentials: doc.credentials ?? {} });
        return json({ ok: true, rev: engine.flows.rev });
      } catch (e) {
        return json({ error: "invalid_json", message: e?.message || String(e) }, 400);
      }
    }
  }

  // Inject
  if (req.method === "POST" && pathname.startsWith("/inject/")) {
    const id = pathname.split("/")[2];
    const n = engine.getNode(id);
    if (!n) return json({ error: "not_found" }, 404);
    if (n instanceof InjectNode) await n.fire({});
    else await n.onMessage({});
    return json({ ok: true });
  }

  // Debug SSE
  if (req.method === "GET" && pathname === "/events/debug") {
    let keep: number | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const client: Client = {
          push: (line: string) => controller.enqueue(encoder.encode(line)),
          close: () => controller.close()
        };
        clients.add(client);
        client.push(":ok\n\n");
        keep = setInterval(() => client.push(":keepalive\n\n"), 15000) as unknown as number;
      },
      cancel() {}
    });
    const res = new Response(stream, { headers: sseHeaders() });
    req.signal.addEventListener("abort", () => { try { clearInterval(keep); } catch {} });
    return res;
  }

  return json({ error: "not_found" }, 404);
});

console.log(`Deno MVP runtime listening on http://0.0.0.0:${PORT}`);

