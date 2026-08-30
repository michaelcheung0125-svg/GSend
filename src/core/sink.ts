/**
 * Where received bytes land while a transfer is in flight.
 *
 * M1 buffers in memory, which is why the ceiling below is well under the 1 GB the
 * plan promises. M2 adds streaming sinks (File System Access on Chromium desktop,
 * OPFS elsewhere) behind this same interface and raises the limit.
 */
export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  finish(mime: string): Promise<Blob>;
  abort(): Promise<void>;
}

export class MemorySink implements FileSink {
  private parts: Uint8Array[] = [];

  async write(chunk: Uint8Array): Promise<void> {
    // The chunk is a view onto the received frame, which is recycled; copy it.
    this.parts.push(new Uint8Array(chunk));
  }

  async finish(mime: string): Promise<Blob> {
    return new Blob(this.parts as BlobPart[], { type: mime || "application/octet-stream" });
  }

  async abort(): Promise<void> {
    this.parts = [];
  }
}

export function createSink(): FileSink {
  return new MemorySink();
}

const SAFARI_LIMIT_BYTES = 200 * 1024 * 1024;
const DEFAULT_LIMIT_BYTES = 256 * 1024 * 1024;

function isWebKit(): boolean {
  const ua = navigator.userAgent;
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
}

export const MAX_FILE_BYTES = isWebKit() ? SAFARI_LIMIT_BYTES : DEFAULT_LIMIT_BYTES;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
