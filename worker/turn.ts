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
  const keyId = env.TURN_KEY_ID;
  const token = env.TURN_KEY_API_TOKEN;
  if (!keyId || !token) return STUN_ONLY;

  try {
    const response = await fetch(`${CREDENTIALS_URL}/${keyId}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    });

    if (!response.ok) return STUN_ONLY;

    const body = (await response.json()) as CredentialsResponse;
    // The API answers with a single object; accept a list too rather than depend on it.
    const servers = body.iceServers
      ? Array.isArray(body.iceServers)
        ? body.iceServers
        : [body.iceServers]
      : [];

    return servers.length > 0 ? [...STUN_ONLY, ...servers] : STUN_ONLY;
  } catch {
    // A relay that cannot be reached must not stop a session that may not need one.
    return STUN_ONLY;
  }
}

export function credentialsLifetimeMs(): number {
  // Expire our copy early so a peer never receives credentials about to lapse.
  return (TTL_SECONDS - 300) * 1000;
}
