/**
 * The mutual proof two devices exchange as soon as their control channel opens.
 *
 * Both sides send a claim and a nonce, then each signs the other's nonce with the
 * private key behind its claim. Nothing here is secret — the channel is already
 * DTLS-encrypted — the point is that a device cannot assert an identity it does not
 * hold the key for.
 *
 * What that proof is worth depends on how the two met:
 *
 * - Through a 4-digit code, the code itself is the security, and the handshake only
 *   establishes a pairing for next time. It is therefore advisory: a peer that never
 *   answers simply does not get remembered, and the transfer proceeds regardless. That
 *   keeps a tab running an older build working.
 * - Through the rendezvous room, nobody typed anything, so the proof is the only thing
 *   standing between a stranger who somehow reached the room and the person's files.
 *   There it is mandatory, checked against the public key stored at pairing time, and
 *   nothing moves until it passes.
 */
import { AUTH_LABEL, type PeerControl } from "./protocol";
import {
  adoptGroup,
  createGroup,
  groupSecret,
  knownDevices,
  rememberDevice,
  type KnownDevice,
} from "./devices";
import { fromBase64url, signBytes, toBase64url, toHex, verifyBytes, type Identity } from "./identity";

export type HandshakeMode = "code" | "group";

export type RejectReason = "unknown-device" | "bad-proof" | "rejected-by-peer";

export interface HandshakeOutcome {
  device: KnownDevice;
  /** Devices left behind in a group this device gave up. Zero in the ordinary case. */
  stranded: number;
}

export interface HandshakeHandlers {
  send(msg: PeerControl): void;
  onVerified(outcome: HandshakeOutcome): void;
  onRejected(reason: RejectReason): void;
}

/** The id is a hash of the public key, so a claim can be checked against itself. */
async function idMatchesKey(id: string, publicKey: string): Promise<boolean> {
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      fromBase64url(publicKey) as unknown as BufferSource,
    );
    return toHex(digest.slice(0, 8)) === id;
  } catch {
    return false;
  }
}

function proofBytes(signer: string, recipient: string, nonce: string): Uint8Array {
  return new TextEncoder().encode(`${AUTH_LABEL}${signer}>${recipient}:${nonce}`);
}

export class Handshake {
  private readonly nonce: string;
  private claim: { id: string; name: string; publicKey: string; devices: number } | null = null;
  /** True once the peer's signature over our nonce has checked out. */
  private proved = false;
  /** True once we have answered their nonce, so they can prove us in turn. */
  private answered = false;
  private settled = false;
  private invited = false;

  constructor(
    private readonly identity: Identity,
    private readonly mode: HandshakeMode,
    private readonly handlers: HandshakeHandlers,
  ) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    this.nonce = toBase64url(bytes);
  }

  async begin(): Promise<void> {
    this.handlers.send({
      t: "auth",
      id: this.identity.id,
      name: this.identity.name,
      publicKey: this.identity.publicKey,
      nonce: this.nonce,
      devices: (await knownDevices()).length,
    });
  }

  /** Returns true when the message belonged to the handshake and was consumed. */
  handle(msg: PeerControl): boolean {
    switch (msg.t) {
      case "auth":
        void this.onClaim(msg);
        return true;
      case "auth-proof":
        void this.onProof(msg.sig);
        return true;
      case "group-invite":
        void this.onInvite(msg.secret);
        return true;
      case "auth-fail":
        this.reject("rejected-by-peer");
        return true;
      default:
        return false;
    }
  }

  private async onClaim(msg: Extract<PeerControl, { t: "auth" }>): Promise<void> {
    if (this.claim || this.settled) return;
    if (typeof msg.id !== "string" || typeof msg.publicKey !== "string") return;

    // A device that names itself something other than its own key's hash is either
    // broken or trying to borrow another device's slot in the list.
    if (!(await idMatchesKey(msg.id, msg.publicKey))) {
      this.reject("bad-proof");
      return;
    }

    if (this.mode === "group") {
      const known = (await knownDevices()).find((device) => device.id === msg.id);
      if (!known || known.publicKey !== msg.publicKey) {
        this.reject("unknown-device");
        return;
      }
    }

    this.claim = {
      id: msg.id,
      name: typeof msg.name === "string" && msg.name ? msg.name.slice(0, 40) : msg.id,
      publicKey: msg.publicKey,
      devices: Number.isFinite(msg.devices) ? msg.devices : 0,
    };

    const sig = await signBytes(
      this.identity,
      proofBytes(this.identity.id, msg.id, msg.nonce),
    );
    this.answered = true;
    this.handlers.send({ t: "auth-proof", sig });
    await this.maybeSettle();
  }

  private async onProof(sig: string): Promise<void> {
    const claim = this.claim;
    if (!claim || this.proved || this.settled) return;

    const ok = await verifyBytes(
      claim.publicKey,
      sig,
      proofBytes(claim.id, this.identity.id, this.nonce),
    );
    if (!ok) {
      this.reject("bad-proof");
      return;
    }

    this.proved = true;
    await this.maybeSettle();
  }

  private async maybeSettle(): Promise<void> {
    if (this.settled || !this.proved || !this.answered || !this.claim) return;
    this.settled = true;

    const claim = this.claim;

    if (this.mode === "code") {
      // Only one side hands over its group, or the two would swap and neither would
      // keep any pairings. The larger group wins because it has more to lose; equal
      // sizes are broken by id, which both sides can evaluate identically.
      const mine = (await knownDevices()).length;
      const iInvite = mine > claim.devices || (mine === claim.devices && this.identity.id < claim.id);
      if (iInvite) {
        this.invited = true;
        this.handlers.send({ t: "group-invite", secret: await createGroup() });
      }
    }

    await rememberDevice({
      id: claim.id,
      name: claim.name,
      publicKey: claim.publicKey,
      addedAt: Date.now(),
    });

    // An invitation we are owed arrives separately and reports its own count then.
    this.handlers.onVerified({
      device: {
        id: claim.id,
        name: claim.name,
        publicKey: claim.publicKey,
        addedAt: Date.now(),
      },
      stranded: 0,
    });
  }

  private async onInvite(secret: string): Promise<void> {
    if (this.invited || typeof secret !== "string" || !secret) return;
    // Only a peer that has proved itself gets to move this device into another group.
    if (!this.proved || !this.claim) return;
    if (await groupSecret() === secret) return;

    const stranded = await adoptGroup(secret);
    // Re-record the peer, which the adoption's merged list may not carry yet.
    await rememberDevice({
      id: this.claim.id,
      name: this.claim.name,
      publicKey: this.claim.publicKey,
      addedAt: Date.now(),
    });
    this.handlers.onVerified({
      device: {
        id: this.claim.id,
        name: this.claim.name,
        publicKey: this.claim.publicKey,
        addedAt: Date.now(),
      },
      stranded,
    });
  }

  private reject(reason: RejectReason): void {
    if (this.settled) return;
    this.settled = true;
    // Tell them before hanging up, so the refusal reads as a refusal on both screens.
    if (reason !== "rejected-by-peer") this.handlers.send({ t: "auth-fail" });
    this.handlers.onRejected(reason);
  }
}
