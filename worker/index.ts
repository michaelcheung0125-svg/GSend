import { CODE_LENGTH, ERROR_TEXT, isValidCode, type ServerErrorCode } from "../shared/protocol";

export { SessionRoom } from "./session-room";
export { JoinGuard } from "./join-guard";
export { Metrics } from "./metrics";

/** How many random codes to try before giving up on finding a free one. */
const CODE_ATTEMPTS = 8;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/ws") return openSocket(request, env, url);
    // Only reached when no service worker is installed to intercept it; without this
    // the asset server answers a share POST with a bare 405.
    if (url.pathname === "/share") return Response.redirect(new URL("/", url).toString(), 303);

    if (url.pathname === "/api/health") return Response.json({ ok: true });

    // Public on purpose: these are anonymous counts with nothing to protect, and
    // showing them is part of being honest about what this service records.
    if (url.pathname === "/api/stats") {
      const metrics = env.METRICS.get(env.METRICS.idFromName("global"));
      return Response.json(await metrics.summary());
    }
    if (url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function openSocket(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected a WebSocket upgrade", { status: 426 });
  }

  switch (url.searchParams.get("role")) {
    case "host":
      return openHost(request, env);
    case "guest":
      return openGuest(request, env, url);
    case "resume":
      return openResume(request, env, url);
    default:
      return rejectSocket("bad_request");
  }
}

async function openHost(request: Request, env: Env): Promise<Response> {
  // The code is the Durable Object's name, so claiming one means asking that
  // object whether it is free. Collisions just cost another round trip.
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = randomCode();
    const room = env.SESSION.get(env.SESSION.idFromName(code));
    const response = await room.fetch(
      new Request(`https://session/host?code=${code}`, request),
    );
    if (response.status === 101) return response;
  }
  return rejectSocket("no_capacity");
}

async function openGuest(request: Request, env: Env, url: URL): Promise<Response> {
  const code = url.searchParams.get("code") ?? "";
  if (!isValidCode(code)) return rejectSocket("bad_request");

  const ip = request.headers.get("CF-Connecting-IP") ?? "anonymous";
  const guard = env.JOIN_GUARD.get(env.JOIN_GUARD.idFromName(ip));
  if (!(await guard.consume())) return rejectSocket("rate_limited");

  const room = env.SESSION.get(env.SESSION.idFromName(code));
  return room.fetch(new Request("https://session/guest", request));
}

async function openResume(request: Request, env: Env, url: URL): Promise<Response> {
  const code = url.searchParams.get("code") ?? "";
  const key = url.searchParams.get("key") ?? "";
  const as = url.searchParams.get("as") ?? "";
  if (!isValidCode(code) || !key || (as !== "host" && as !== "guest")) {
    return rejectSocket("bad_request");
  }

  const room = env.SESSION.get(env.SESSION.idFromName(code));
  return room.fetch(
    new Request(`https://session/resume?as=${as}&key=${encodeURIComponent(key)}`, request),
  );
}

/**
 * A plain 4xx makes the browser report an opaque "connection failed", so errors
 * that a real user can hit are delivered over an accepted socket instead.
 */
function rejectSocket(code: ServerErrorCode): Response {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  server.accept();
  server.send(JSON.stringify({ t: "error", code, message: ERROR_TEXT[code] }));
  server.close(4000, code);
  return new Response(null, { status: 101, webSocket: client });
}

function randomCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const max = 10 ** CODE_LENGTH;
  return String(buf[0] % max).padStart(CODE_LENGTH, "0");
}
