/**
 * Peer-to-peer protocol. These messages never touch the server: they travel over
 * the WebRTC data channels between the two browsers.
 */

export const WIRE_VERSION = 1;

/** version(1) + kind(1) + wireId(2) + reserved(4) + offset(8) */
export const HEADER_BYTES = 16;

export const FRAME_CHUNK = 1;

/**
 * Why a transfer stopped, as a code rather than a sentence. The two devices may be
 * reading the interface in different languages, so the wording has to be chosen by
 * whoever is looking at the screen, not by whoever sent the message.
 */
export type CancelCode =
  | "sender-cancelled"
  | "receiver-cancelled"
  | "sender-reloaded"
  | "too-large"
  | "peer-lost"
  | "write-failed"
  | "assemble-failed"
  | "stream-gap"
  | "read-failed";

/** A stopped transfer, ready to be phrased in whichever language is on screen. */
export interface TransferProblem {
  code: CancelCode;
  limit?: number;
}

export interface FileMeta {
  id: string;
  /** Compact id used in the binary header, unique within a session. */
  wireId: number;
  name: string;
  size: number;
  mime: string;
}

export type PeerControl =
  | { t: "offer"; batchId: string; files: FileMeta[] }
  | { t: "accept"; batchId: string; offsets: Record<string, number> }
  | { t: "decline"; batchId: string; reason: string }
  /** Receiver's durable watermark; doubles as the resume point. */
  | { t: "ack"; fileId: string; received: number }
  | { t: "done"; fileId: string }
  | { t: "cancel"; fileId: string; reason: CancelCode; limit?: number }
  /** Sent after a reconnect so the sender knows where to pick each file up. */
  | { t: "resume"; offsets: Record<string, number> }
  | { t: "text"; id: string; body: string; at: number };

export function encodeHeader(target: Uint8Array, wireId: number, offset: number): void {
  const view = new DataView(target.buffer, target.byteOffset, HEADER_BYTES);
  view.setUint8(0, WIRE_VERSION);
  view.setUint8(1, FRAME_CHUNK);
  view.setUint16(2, wireId, false);
  view.setUint32(4, 0, false);
  view.setBigUint64(8, BigInt(offset), false);
}

export interface FrameHeader {
  version: number;
  kind: number;
  wireId: number;
  offset: number;
}

export function decodeHeader(buffer: ArrayBuffer): FrameHeader | null {
  if (buffer.byteLength < HEADER_BYTES) return null;
  const view = new DataView(buffer);
  return {
    version: view.getUint8(0),
    kind: view.getUint8(1),
    wireId: view.getUint16(2, false),
    offset: Number(view.getBigUint64(8, false)),
  };
}
