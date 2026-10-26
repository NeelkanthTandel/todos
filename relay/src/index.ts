// Router: CORS, request shape and channel creation. Everything about a channel (auth, storage, limits,
// sockets) lives in the Channel Durable Object. The relay only ever sees ciphertext and never logs bodies.
import { Channel, KINDS, fail, randomId, readCapped } from "./channel";

export { Channel };

const ID_RE = /^[A-Za-z0-9_-]{22}$/; // 128-bit, base64url
const LOCAL_RE = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

function originAllowed(origin: string, env: Env): boolean {
  if (LOCAL_RE.test(origin)) return true;
  return (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean).includes(origin);
}

function cors(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "ETag",
    Vary: "Origin",
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get("Origin");
    // Requests without an Origin (curl, the Claude Code hook) aren't from a browser page, so CORS doesn't apply.
    if (origin && !originAllowed(origin, env)) return new Response("Origin not allowed", { status: 403, headers: { Vary: "Origin" } });
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors(origin),
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    let res: Response;
    try {
      res = await route(req, env);
    } catch {
      res = fail(500, "internal error");
    }
    if (res.status === 101 || !origin) return res; // WebSocket upgrades can't be re-wrapped and don't need CORS
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors(origin))) out.headers.set(k, v);
    return out;
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 0 && req.method === "GET") return new Response("Todos relay. See https://github.com/NeelkanthTandel/todos/tree/main/relay\n");
  if (parts[0] !== "c") return fail(404, "not found");

  if (parts.length === 1) {
    if (req.method !== "POST") return fail(405, "method not allowed");
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    if (env.CREATE_LIMIT && !(await env.CREATE_LIMIT.limit({ key: ip })).success) return fail(429, "too many channels created, try again in a minute");
    const body = await readCapped(req, 1024);
    if (body === null) return fail(413, "body too large");
    let kind: unknown;
    try { kind = JSON.parse(body).kind; } catch { return fail(400, "body must be JSON: { kind }"); }
    if (typeof kind !== "string" || !KINDS.includes(kind)) return fail(400, "kind must be one of " + KINDS.join(", "));
    const id = randomId(16);
    const stub = env.CHANNEL.get(env.CHANNEL.idFromName(id));
    // The internal init path isn't reachable from outside: the router below never forwards it.
    return stub.fetch(new Request(url.origin + "/c/" + id + "/init", { method: "POST", body: JSON.stringify({ kind }) }));
  }

  const id = parts[1];
  if (!ID_RE.test(id)) return fail(404, "no such channel");
  const rest = parts.slice(2);
  const known =
    rest.length === 0 ||
    (rest.length === 1 && (rest[0] === "state" || rest[0] === "messages" || rest[0] === "writers")) ||
    (rest.length === 2 && (rest[0] === "messages" || rest[0] === "writers") && /^[A-Za-z0-9_-]{1,32}$/.test(rest[1]));
  if (!known) return fail(404, "not found");
  return env.CHANNEL.get(env.CHANNEL.idFromName(id)).fetch(req);
}
