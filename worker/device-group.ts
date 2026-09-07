import { DurableObject } from "cloudflare:workers";
import {
  ERROR_TEXT,
  MAX_GROUP_DEVICES,
  MAX_SIGNAL_BYTES,
  isDeviceId,
  type GroupClientMessage,
  type GroupServerMessage,
  type IceServer,
  type ServerErrorCode,
} from "../shared/protocol";
import { STUN_ONLY, credentialsLifetimeMs, mintIceServers } from "./turn";

const ICE_KEY = "ice";

/** Sockets in this tag are one-shot error replies, not room members. */
const REJECT_TAG = "reject";

/**
 * A meeting point for one person's paired devices.
 *
 * The room's name is an HMAC only those devices can compute, so arriving here is
 * already evidence of belonging — but the room deliberately does not act on that. It
 * keeps no membership, verifies no identity and stores nothing but a cached set of
 * relay credentials. Devices prove who they are to *each other* over the encrypted
 * data channel once it is up; this object only introduces them, exactly as
 * `SessionRoom` does for a 4-digit code.
 *
 * Because the name rotates every few hours, these objects are disposable: one goes
 * quiet when its window passes, and the alarm clears the only thing it ever wrote.
 */
export class DeviceGroup extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/join") return new Response("not found", { status: 404 });

    const device = url.searchParams.get("device") ?? "";
    if (!isDeviceId(device)) return this.rejectSocket("bad_request");

    // A device reconnecting supersedes its own stale socket rather than counting twice
    // against the room, which is what a phone waking up looks like from here.
    for (const stale of this.ctx.getWebSockets(device)) {
      try {
        stale.close(4002, "replaced");
      } catch {
        /* already gone */
      }
    }

    if (this.deviceIds().filter((id) => id !== device).length >= MAX_GROUP_DEVICES) {
      return this.rejectSocket("session_full");
    }

    const peers = this.deviceIds()
      .filter((id) => id !== device)
      .map((id) => ({ id }));

    const { server, response } = this.acceptSocket(device);
    send(server, { t: "group", self: device, peers });
    this.broadcast({ t: "joined", peer: { id: device } }, device);
    return response;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > MAX_SIGNAL_BYTES) return;

    const from = this.deviceOf(ws);
    if (!from) return;

    let msg: GroupClientMessage;
    try {
      msg = JSON.parse(raw) as GroupClientMessage;
    } catch {
      return;
    }

    if (msg.t === "to") {
      if (typeof msg.peer !== "string" || !isDeviceId(msg.peer) || msg.peer === from) return;
      for (const target of this.ctx.getWebSockets(msg.peer)) {
        send(target, { t: "from", peer: from, data: msg.data });
      }
      return;
    }

    if (msg.t === "ice") {
      send(ws, { t: "ice", iceServers: await this.iceServers() });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.announceDeparture(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.announceDeparture(ws);
  }

  private announceDeparture(ws: WebSocket): void {
    const device = this.deviceOf(ws);
    if (!device) return;

    // A reconnect closes the socket it replaces, and that close lands afterwards.
    // Reporting it would take the device off the other screens seconds after it
    // arrived, with nothing to correct the impression.
    if (this.ctx.getWebSockets(device).some((other) => other !== ws)) return;
    this.broadcast({ t: "left", peer: device }, device);
  }

  /**
   * Relay credentials are billable, so one set is minted per room and shared, and the
   * alarm exists purely to take this object back down to nothing once they expire.
   */
  private async iceServers(): Promise<IceServer[]> {
    const now = Date.now();
    const cached = await this.ctx.storage.get<{ servers: IceServer[]; expiresAt: number }>(ICE_KEY);
    if (cached && cached.expiresAt > now) return cached.servers;

    const servers = await mintIceServers(this.env).catch(() => STUN_ONLY);
    const expiresAt = now + credentialsLifetimeMs();
    await this.ctx.storage.put(ICE_KEY, { servers, expiresAt });
    await this.ctx.storage.setAlarm(expiresAt + 1_000);
    return servers;
  }

  async alarm(): Promise<void> {
    const cached = await this.ctx.storage.get<{ expiresAt: number }>(ICE_KEY);
    if (cached && cached.expiresAt > Date.now()) {
      await this.ctx.storage.setAlarm(cached.expiresAt + 1_000);
      return;
    }
    await this.ctx.storage.deleteAll();
  }

  private deviceIds(): string[] {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const id = this.deviceOf(ws);
      if (id) ids.add(id);
    }
    return [...ids];
  }

  private deviceOf(ws: WebSocket): string | null {
    const tag = this.ctx.getTags(ws)[0];
    return tag && tag !== REJECT_TAG && isDeviceId(tag) ? tag : null;
  }

  private broadcast(msg: GroupServerMessage, except: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.deviceOf(ws) === except) continue;
      send(ws, msg);
    }
  }

  private acceptSocket(tag: string): { server: WebSocket; response: Response } {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [tag]);
    return { server, response: new Response(null, { status: 101, webSocket: client }) };
  }

  /** Reply over a real socket so the browser can show why, not just "connection failed". */
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
}

function send(ws: WebSocket, msg: GroupServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* socket already closing */
  }
}
