import type { IceServer } from "../shared/protocol";

const CREDENTIALS_URL = "https://rtc.live.cloudflare.com/v1/turn/keys";

/**
 * How long minted credentials stay valid. Long enough to outlast a transfer and a
 * reconnect, short enough that a leaked pair is not worth much.
 */
const TTL_SECONDS = 2 * 60 * 60;

/** Free, unlimited, and useful even when no relay is configured. */
export const STUN_ONLY: IceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

interface CredentialsResponse {
  iceServers?: IceServer | IceServer[];
}

/**
 * Mints short-lived relay credentials from Cloudflare Realtime.
 *
 * The API key never leaves the Worker: handing it to a browser would let anyone spend
 * the account's relay allowance. Returns STUN alone when no key is configured, which is
 * exactly how the app behaved before relaying existed, so a missing secret degrades
 * instead of breaking.
 */
export async function mintIceServers(env: Env): Promise<IceServer[]> {
  const keyId = env.TURN_KEY_ID?.trim();
  const token = env.TURN_KEY_API_TOKEN?.trim();
  if (!keyId || !token) {
    console.warn("[turn] no relay configured", { hasKeyId: Boolean(keyId), hasToken: Boolean(token) });
    return STUN_ONLY;
  }

  try {
    const response = await fetch(`${CREDENTIALS_URL}/${keyId}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    });

    if (!response.ok) {
      // Never the token, but the status and Cloudflare's own message: without them a
      // misconfigured relay is indistinguishable from no relay at all.
      console.warn("[turn] credentials rejected", response.status, await response.text());
      return STUN_ONLY;
    }

    const body = (await response.json()) as CredentialsResponse;
    // The API answers with a single object; accept a list too rather than depend on it.
    const servers = body.iceServers
      ? Array.isArray(body.iceServers)
        ? body.iceServers
        : [body.iceServers]
      : [];

    if (servers.length === 0) console.warn("[turn] credentials response had no servers");
    return servers.length > 0 ? [...STUN_ONLY, ...servers] : STUN_ONLY;
  } catch (error) {
    // A relay that cannot be reached must not stop a session that may not need one.
    console.warn("[turn] credentials request threw", String(error));
    return STUN_ONLY;
  }
}

export function credentialsLifetimeMs(): number {
  // Expire our copy early so a peer never receives credentials about to lapse.
  return (TTL_SECONDS - 300) * 1000;
}

export interface RelayStatus {
  configured: boolean;
  ok: boolean;
  status?: number;
  detail?: string;
  /** Lengths only — enough to spot a swapped pair or a stray newline, and reveal nothing. */
  keyIdLength?: number;
  tokenLength?: number;
  hadWhitespace?: boolean;
}

/**
 * Reports whether the relay is actually usable. Without this a misconfigured relay is
 * indistinguishable from a deliberately absent one, since both fall back to STUN.
 * Carries no secret: only whether the keys exist and what Cloudflare said about them.
 */
export async function checkRelay(env: Env): Promise<RelayStatus> {
  const keyId = env.TURN_KEY_ID?.trim();
  const token = env.TURN_KEY_API_TOKEN?.trim();
  if (!keyId || !token) return { configured: false, ok: false };

  const shape = {
    keyIdLength: keyId.length,
    tokenLength: token.length,
    hadWhitespace:
      keyId.length !== (env.TURN_KEY_ID ?? "").length ||
      token.length !== (env.TURN_KEY_API_TOKEN ?? "").length,
  };

  try {
    const response = await fetch(`${CREDENTIALS_URL}/${keyId}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 600 }),
    });

    if (!response.ok) {
      return {
        configured: true,
        ok: false,
        status: response.status,
        detail: (await response.text()).slice(0, 300),
        ...shape,
      };
    }

    const body = (await response.json()) as CredentialsResponse;
    const servers = body.iceServers ? (Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers]) : [];
    const urls = servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
    return {
      configured: true,
      ok: urls.some((u) => u.startsWith("turn:") || u.startsWith("turns:")),
      detail: urls.join(", ").slice(0, 300),
      ...shape,
    };
  } catch (error) {
    return { configured: true, ok: false, detail: String(error).slice(0, 300), ...shape };
  }
}
