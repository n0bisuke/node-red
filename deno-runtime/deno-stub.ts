// Minimal Deno runtime stub that implements the small API used by editor-solo
// Endpoints: /health, /caps, /flows (GET/POST), /inject/:id (POST), /events/debug (SSE)

const PORT = Number(Deno.env.get("PORT") ?? "1880");
const TOKEN = Deno.env.get("NR_SERVER_TOKEN") ?? "";
const CORS = Deno.env.get("CORS_ORIGIN") ?? "*";

type FlowsDoc = { rev: string; flows: unknown[]; credentials?: Record<string, unknown> };
let flows: FlowsDoc = { rev: crypto.randomUUID(), flows: [], credentials: {} };

// SSE clients: each entry holds push/close functions
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

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

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

function ok(): Response { return json({ ok: true }); }

function auth(req: Request): boolean {
  if (!TOKEN) return true;
  const a = req.headers.get("authorization") ?? "";
  return a.startsWith("Bearer ") && a.slice(7) === TOKEN;
}

function sseBroadcast(data: unknown) {
  const line = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try { c.push(line); } catch { /* ignore */ }
  }
}

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const url = new URL(req.url);
  const pathname = url.pathname;

  if (!auth(req)) return unauthorized();

  // Health
  if (req.method === "GET" && pathname === "/health") {
    return json({ ok: true, started: true, rev: flows.rev });
  }

  // Capabilities: declare supported minimal node types and API flags
  if (req.method === "GET" && pathname === "/caps") {
    return json({
      api: { flows: true, inject: true, eventsDebug: true, health: true, state: false },
      nodes: ["inject", "function", "debug", "change", "http request"]
    });
  }

  // Flows (GET/POST)
  if (pathname === "/flows") {
    if (req.method === "GET") {
      return json(flows);
    }
    if (req.method === "POST") {
      try {
        const body = await req.json();
        const doc = Array.isArray(body) ? { flows: body, credentials: {} } : body;
        flows = { rev: crypto.randomUUID(), flows: doc.flows ?? [], credentials: doc.credentials ?? {} };
        return json({ ok: true, rev: flows.rev });
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
    }
  }

  // Inject: emit a debug message to SSE (no real execution)
  if (req.method === "POST" && pathname.startsWith("/inject/")) {
    const id = pathname.split("/")[2];
    sseBroadcast({ id, msg: { payload: `Injected @ ${new Date().toISOString()}` } });
    return ok();
  }

  // Debug stream (SSE)
  if (req.method === "GET" && pathname === "/events/debug") {
    let keep: number | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const client: Client = {
          push: (line: string) => controller.enqueue(encoder.encode(line)),
          close: () => controller.close()
        };
        clients.add(client);
        // initial ping
        client.push(":ok\n\n");
        keep = setInterval(() => client.push(":keepalive\n\n"), 15000) as unknown as number;
      },
      cancel() {
        // closed by client
      }
    });
    // On close, remove client
    const res = new Response(stream, { headers: sseHeaders() });
    req.signal.addEventListener("abort", () => {
      try { clearInterval(keep); } catch {}
      // Remove any client that cannot be written anymore: best-effort cleanup
      // (Set cleanup happens when GC collects, acceptable for stub)
    });
    return res;
  }

  return json({ error: "not_found" }, 404);
});

console.log(`Deno stub runtime listening on http://0.0.0.0:${PORT}`);

