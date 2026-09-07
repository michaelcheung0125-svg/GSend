/**
 * The set of devices this one has been paired with, and the secret they use to find
 * each other again without a code.
 *
 * The trick that makes this work without a server-side registry: a signalling room is
 * addressed by nothing more than a name string (`idFromName` in the Worker), so a group
 * of devices that share a secret can *derive* a room name only they can compute. The
 * server stores no membership and learns no identities — it sees an opaque name, the
 * same way it already sees an opaque 4-digit code.
 *
 * The name is derived per time window rather than once, so it is not a permanent
 * identifier the server could use to link a person's sessions together across days.
 */
import { GROUP_WINDOW_MS, RENDEZVOUS_LABEL } from "../../shared/protocol";
import { fromBase64url, toBase64url, toHex } from "./identity";
import { dbAvailable, dbDelete, dbGet, dbPut } from "./store-db";

const KEY = "group";

export interface KnownDevice {
  id: string;
  name: string;
  /** Base64url SPKI, used to verify that a device in the room is really that device. */
  publicKey: string;
  addedAt: number;
}

interface StoredGroup {
  /** Base64url of 32 random bytes. Shared with a new device only over an open, paired channel. */
  secret: string;
  devices: KnownDevice[];
}

let cached: StoredGroup | null = null;

async function read(): Promise<StoredGroup | null> {
  if (cached) return cached;
  if (!dbAvailable()) return null;
  try {
    cached = (await dbGet<StoredGroup>(KEY)) ?? null;
    return cached;
  } catch {
    return null;
  }
}

async function write(group: StoredGroup): Promise<void> {
  cached = group;
  try {
    await dbPut(KEY, group);
  } catch {
    /* the group still applies for this visit */
  }
}

export async function loadGroup(): Promise<StoredGroup | null> {
  return read();
}

export async function knownDevices(): Promise<KnownDevice[]> {
  return (await read())?.devices ?? [];
}

export async function groupSecret(): Promise<string | null> {
  return (await read())?.secret ?? null;
}

/** Start a group. Called by whichever side of a fresh pairing does not already have one. */
export async function createGroup(): Promise<string> {
  const existing = await read();
  if (existing) return existing.secret;

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = toBase64url(bytes);
  await write({ secret, devices: [] });
  return secret;
}

/**
 * Take on another device's group. The device list is merged rather than replaced: a
 * device from the old group cannot be reached in the new room, but dropping it silently
 * would look like the app forgot it, and it comes back by pairing again.
 *
 * Returns how many previously known devices are now in the wrong group, so the
 * interface can say so instead of leaving it to be discovered.
 */
export async function adoptGroup(secret: string): Promise<number> {
  const existing = await read();
  if (existing?.secret === secret) return 0;

  const stranded = existing?.devices.length ?? 0;
  await write({ secret, devices: existing?.devices ?? [] });
  return stranded;
}

export async function rememberDevice(device: KnownDevice): Promise<void> {
  const group = (await read()) ?? { secret: await createGroup(), devices: [] };
  const devices = group.devices.filter((known) => known.id !== device.id);
  devices.push(device);
  await write({ ...group, devices });
}

export async function forgetDevice(id: string): Promise<void> {
  const group = await read();
  if (!group) return;
  await write({ ...group, devices: group.devices.filter((known) => known.id !== id) });
}

/** Leave the group entirely: this device stops being findable and forgets the others. */
export async function forgetGroup(): Promise<void> {
  cached = null;
  try {
    await dbDelete(KEY);
  } catch {
    /* nothing to clean up */
  }
}

// --- rendezvous -------------------------------------------------------------

function windowIndex(at: number): number {
  return Math.floor(at / GROUP_WINDOW_MS);
}

/** When the current window ends, so the client can move rooms before it does. */
export function windowEndsAt(at: number = Date.now()): number {
  return (windowIndex(at) + 1) * GROUP_WINDOW_MS;
}

/**
 * The room name for this window. Every paired device computes the same string from the
 * shared secret and the clock; nobody else can, and it changes every few hours.
 */
export async function rendezvousName(secret: string, at: number = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64url(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = new TextEncoder().encode(`${RENDEZVOUS_LABEL}${windowIndex(at)}`);
  const mac = await crypto.subtle.sign("HMAC", key, message as unknown as BufferSource);
  return toHex(mac);
}
