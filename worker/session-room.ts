import { DurableObject } from "cloudflare:workers";
import {
  CODE_TTL_MS,
  ERROR_TEXT,
  MAX_SIGNAL_BYTES,
  RESUME_GRACE_MS,
  SESSION_IDLE_MS,
  type ClientMessage,
  type Role,
  type ServerErrorCode,
  type ServerMessage,
} from "../shared/protocol";

interface Meta {
  code: string;
  hostKey: string;
  guestKey: string | null;
  joinExpiresAt: number;
  lastActiveAt: number;
  /** When the last socket detached, or null while at least one peer is attached. */
  emptySince: number | null;
}

const META_KEY = "meta";

/** Sockets in this tag are one-shot error replies, not session participants. */
const REJECT_TAG = "reject";

/** Writing `lastActiveAt` on every relayed message would be a storage write per ICE candidate. */
const ACTIVITY_WRITE_INTERVAL_MS = 30_000;

/**
 * One instance per 4-digit code. The code is also the routing address, so it stays
 * reserved for the session's whole life even though it stops being *joinable*
 * after 60 seconds or after the first guest pairs.
 */
export class SessionRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/host":
        return this.openHost(url);
      case "/guest":
        return this.openGuest();
      case "/resume":
        return this.openResume(url);
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private async openHost(url: URL): Promise<Response> {
    if (await this.ctx.storage.get<Meta>(META_KEY)) {
      // Code already taken; the Worker will roll another one.
      return new Response("code in use", { status: 409 });
    }

    const now = Date.now();
    const meta: Meta = {
      code: url.searchParams.get("code") ?? "",
      hostKey: randomKey(),
      guestKey: null,
      joinExpiresAt: now + CODE_TTL_MS,
      lastActiveAt: now,
      emptySince: null,
    };
    await this.ctx.storage.put(META_KEY, meta);
    await this.ctx.storage.setAlarm(meta.joinExpiresAt + 500);

    const { server, response } = this.acceptSocket("host");
    send(server, {
      t: "hello",
      role: "host",
      code: meta.code,
      sessionKey: meta.hostKey,
      joinExpiresAt: meta.joinExpiresAt,
      peerPresent: false,
    });
    return response;
  }

  private async openGuest(): Promise<Response> {
    const meta = await this.ctx.storage.get<Meta>(META_KEY);
    if (!meta) return this.rejectSocket("code_not_found");
    if (meta.guestKey) return this.rejectSocket("session_full");

    const now = Date.now();
    if (now > meta.joinExpiresAt) {
      await this.destroy("expired");
      return this.rejectSocket("code_expired");
    }

    meta.guestKey = randomKey();
    meta.lastActiveAt = now;
    meta.emptySince = null;
    await this.ctx.storage.put(META_KEY, meta);
    await this.ctx.storage.setAlarm(now + SESSION_IDLE_MS);

    const { server, response } = this.acceptSocket("guest");
    send(server, {
      t: "hello",
      role: "guest",
      code: meta.code,
      sessionKey: meta.guestKey,
      joinExpiresAt: meta.joinExpiresAt,
      peerPresent: this.liveSockets("host").length > 0,
    });
    this.sendTo("host", { t: "peer-joined" });
    return response;
  }

  private async openResume(url: URL): Promise<Response> {
    const role = url.searchParams.get("as");
    const key = url.searchParams.get("key") ?? "";
    if (role !== "host" && role !== "guest") return this.rejectSocket("bad_request");

    const meta = await this.ctx.storage.get<Meta>(META_KEY);
    if (!meta) return this.rejectSocket("code_not_found");

    const expected = role === "host" ? meta.hostKey : meta.guestKey;
    if (!expected || !constantTimeEqual(key, expected)) return this.rejectSocket("bad_key");

    // A resume supersedes whatever stale socket the same role still holds.
    for (const stale of this.liveSockets(role)) {
      try {
        stale.close(4002, "replaced");
      } catch {
        /* already gone */
      }
    }

    const now = Date.now();
    meta.lastActiveAt = now;
    meta.emptySince = null;
    await this.ctx.storage.put(META_KEY, meta);

    const other: Role = role === "host" ? "guest" : "host";
    const { server, response } = this.acceptSocket(role);
    send(server, {
      t: "hello",
      role,
      code: meta.code,
      sessionKey: key,
      joinExpiresAt: meta.joinExpiresAt,
      peerPresent: this.liveSockets(other).length > 0,
    });
    this.sendTo(other, { t: "peer-resumed" });
    return response;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_SIGNAL_BYTES) return;

    const role = this.roleOf(ws);
    if (!role) return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }

    if (msg.t === "signal") {
      this.sendTo(role === "host" ? "guest" : "host", { t: "signal", data: msg.data });
      await this.touch();
      return;
    }

    if (msg.t === "bye") {
      await this.destroy("peer closed the session");
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleDetach(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleDetach(ws);
  }

  private async handleDetach(ws: WebSocket): Promise<void> {
    const role = this.roleOf(ws);
    if (!role) return;

    this.sendTo(role === "host" ? "guest" : "host", { t: "peer-left" });

    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws);
    if (remaining.length > 0) return;

    const meta = await this.ctx.storage.get<Meta>(META_KEY);
    if (!meta) return;
    meta.emptySince = Date.now();
    await this.ctx.storage.put(META_KEY, meta);
    await this.ctx.storage.setAlarm(meta.emptySince + RESUME_GRACE_MS + 1_000);
  }

  async alarm(): Promise<void> {
    const meta = await this.ctx.storage.get<Meta>(META_KEY);
    if (!meta) return;

    const now = Date.now();

    if (!meta.guestKey && now >= meta.joinExpiresAt) {
      this.broadcast({ t: "code-expired" });
      await this.destroy("code expired");
      return;
    }

    if (meta.emptySince !== null && now - meta.emptySince >= RESUME_GRACE_MS) {
      await this.destroy("both devices left");
      return;
    }

    if (now - meta.lastActiveAt >= SESSION_IDLE_MS) {
      this.broadcast({ t: "closed", reason: "session idle" });
      await this.destroy("idle");
      return;
    }

    const nextCheck =
      meta.emptySince !== null
        ? meta.emptySince + RESUME_GRACE_MS + 1_000
        : meta.lastActiveAt + SESSION_IDLE_MS;
    await this.ctx.storage.setAlarm(nextCheck);
  }

  private async touch(): Promise<void> {
    const meta = await this.ctx.storage.get<Meta>(META_KEY);
    if (!meta) return;
    const now = Date.now();
    if (now - meta.lastActiveAt < ACTIVITY_WRITE_INTERVAL_MS) return;
    meta.lastActiveAt = now;
    await this.ctx.storage.put(META_KEY, meta);
  }

  private async destroy(reason: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4003, reason);
      } catch {
        /* already gone */
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  private acceptSocket(tag: string): { server: WebSocket; response: Response } {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [tag]);
    return { server, response: new Response(null, { status: 101, webSocket: client }) };
  }

  /** Reply with a real WebSocket so the browser can show *why* it failed. */
  private rejectSocket(code: ServerErrorCode): Response {
    const { server, response } = this.acceptSocket(REJECT_TAG);
    send(server, { t: "error", code, message: ERROR_TEXT[code] });
    try {
      server.close(4000, code);
    } catch {
      /* already gone */
    }
    return response;
  }

  private roleOf(ws: WebSocket): Role | null {
    const tag = this.ctx.getTags(ws)[0];
    return tag === "host" || tag === "guest" ? tag : null;
  }

  private liveSockets(role: Role): WebSocket[] {
    return this.ctx.getWebSockets(role);
  }

  private sendTo(role: Role, msg: ServerMessage): void {
    for (const ws of this.liveSockets(role)) send(ws, msg);
  }

  private broadcast(msg: ServerMessage): void {
    this.sendTo("host", msg);
    this.sendTo("guest", msg);
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* socket already closing */
  }
}

function randomKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
