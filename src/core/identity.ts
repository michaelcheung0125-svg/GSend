/**
 * This device's long-lived identity.
 *
 * There are no accounts here and there is no server-side registry. A device is a
 * keypair it generated itself: the private half is non-extractable, so it cannot leave
 * the browser even if the page is compromised, and the public half is what other
 * devices remember after a pairing. The id is a hash of that public key, so two devices
 * never have to agree on one — it falls out of the key.
 */
import { dbAvailable, dbGet, dbPut } from "./store-db";

const KEY = "identity";

export interface Identity {
  /** Hash of the public key; short enough to show, unique enough to route on. */
  id: string;
  name: string;
  /** Base64url SPKI, which is what travels to the other device during pairing. */
  publicKey: string;
  privateKey: CryptoKey;
}

interface StoredIdentity {
  id: string;
  name: string;
  publicKey: string;
  privateKey: CryptoKey;
}

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;

// --- encoding ---------------------------------------------------------------

export function toBase64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...view].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// --- identity ---------------------------------------------------------------

/**
 * A first guess at a name the person will recognise in a device list. It is only a
 * default — the point is that "Windows · Chrome" beats a hex string on first sight,
 * not that the guess is accurate.
 */
function guessName(): string {
  const ua = navigator.userAgent;
  const platform =
    /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Macintosh/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "Device";

  // Order matters: every one of these also claims to be Chrome or Safari.
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";

  return `${platform} · ${browser}`;
}

let cached: Identity | null = null;
let loading: Promise<Identity | null> | null = null;

async function create(): Promise<Identity> {
  // `false` makes only the private key non-extractable; the spec always leaves a
  // generated public key exportable, which is exactly the split we want.
  const pair = await crypto.subtle.generateKey(ALGORITHM, false, ["sign", "verify"]);
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const digest = await crypto.subtle.digest("SHA-256", spki);

  const identity: Identity = {
    id: toHex(digest.slice(0, 8)),
    name: guessName(),
    publicKey: toBase64url(spki),
    privateKey: pair.privateKey,
  };

  await dbPut(KEY, {
    id: identity.id,
    name: identity.name,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
  } satisfies StoredIdentity);

  return identity;
}

/**
 * Load this device's identity, creating one the first time. Returns null where the
 * browser will not give us a durable store at all (private browsing, mostly), which
 * callers read as "this device cannot be remembered" rather than as a failure.
 */
export function loadIdentity(): Promise<Identity | null> {
  if (cached) return Promise.resolve(cached);
  if (loading) return loading;

  loading = (async () => {
    if (!dbAvailable()) return null;
    try {
      const stored = await dbGet<StoredIdentity>(KEY);
      cached = stored ?? (await create());
      return cached;
    } catch {
      return null;
    }
  })();

  loading.finally(() => {
    loading = null;
  });

  return loading;
}

export async function renameDevice(name: string): Promise<Identity | null> {
  const identity = await loadIdentity();
  const trimmed = name.trim().slice(0, 40);
  if (!identity || !trimmed) return identity;

  cached = { ...identity, name: trimmed };
  await dbPut(KEY, {
    id: cached.id,
    name: cached.name,
    publicKey: cached.publicKey,
    privateKey: cached.privateKey,
  } satisfies StoredIdentity);
  return cached;
}

// --- proving it -------------------------------------------------------------

export async function signBytes(identity: Identity, data: Uint8Array): Promise<string> {
  const signature = await crypto.subtle.sign(
    SIGN_ALGORITHM,
    identity.privateKey,
    data as unknown as BufferSource,
  );
  return toBase64url(signature);
}

/**
 * Check a signature against a public key remembered from a previous pairing. This is
 * what makes the rendezvous room safe to be wrong about: knowing the room's name is
 * not enough to be treated as one of the person's devices.
 */
export async function verifyBytes(
  publicKey: string,
  signature: string,
  data: Uint8Array,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      fromBase64url(publicKey) as unknown as BufferSource,
      ALGORITHM,
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      SIGN_ALGORITHM,
      key,
      fromBase64url(signature) as unknown as BufferSource,
      data as unknown as BufferSource,
    );
  } catch {
    return false;
  }
}
