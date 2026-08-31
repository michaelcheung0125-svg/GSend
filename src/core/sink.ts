/**
 * Where received bytes land while a transfer is in flight.
 *
 * The default path streams straight to the origin-private filesystem through a worker,
 * so the ceiling is disk rather than tab memory. Memory is only the fallback for
 * contexts where OPFS is unavailable (Safari private browsing, most notably).
 */
export interface FileSink {
  write(offset: number, chunk: Uint8Array): Promise<void>;
  finish(mime: string): Promise<Blob>;
  abort(): Promise<void>;
}

const DIRECTORY = "incoming";
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const DISK_LIMIT_BYTES = 1024 * 1024 * 1024;
/** Refuse a file unless the origin reports at least this much headroom beyond it. */
const QUOTA_HEADROOM_BYTES = 256 * 1024 * 1024;

// --- worker plumbing -------------------------------------------------------

interface WorkerReply {
  seq: number;
  ok: boolean;
  value?: unknown;
  message?: string;
}

class OpfsPool {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(new URL("./opfs-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
      const waiter = this.pending.get(event.data.seq);
      if (!waiter) return;
      this.pending.delete(event.data.seq);
      if (event.data.ok) waiter.resolve(event.data.value);
      else waiter.reject(new Error(event.data.message ?? "OPFS write failed"));
    });
    this.worker = worker;
    return worker;
  }

  private request(
    message: Record<string, unknown>,
    transfer: Transferable[] = [],
  ): Promise<unknown> {
    const worker = this.ensureWorker();
    const seq = ++this.seq;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      worker.postMessage({ ...message, seq }, transfer);
    });
  }

  async open(id: string): Promise<void> {
    await this.request({ t: "open", id });
  }

  async reopen(id: string): Promise<number> {
    const size = await this.request({ t: "reopen", id });
    return typeof size === "number" ? size : 0;
  }

  async write(id: string, offset: number, chunk: Uint8Array): Promise<void> {
    // The chunk is a view onto the received frame, which the caller reuses, and
    // transferring detaches whatever buffer it points at — so send a copy.
    const copy = new Uint8Array(chunk);
    await this.request({ t: "write", id, offset, data: copy.buffer }, [copy.buffer]);
  }

  async finish(id: string): Promise<void> {
    await this.request({ t: "finish", id });
  }

  async discard(id: string): Promise<void> {
    await this.request({ t: "discard", id });
  }

  async sweep(): Promise<void> {
    await this.request({ t: "sweep" });
  }
}

const pool = new OpfsPool();

// --- sinks -----------------------------------------------------------------

class OpfsSink implements FileSink {
  constructor(private readonly id: string) {}

  async write(offset: number, chunk: Uint8Array): Promise<void> {
    await pool.write(this.id, offset, chunk);
  }

  async finish(mime: string): Promise<Blob> {
    await pool.finish(this.id);

    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(DIRECTORY, { create: true });
    const file = await (await dir.getFileHandle(this.id)).getFile();

    // Re-wrapping keeps the blob backed by the file on disk rather than copying it
    // into memory, which matters on iOS where large in-memory blobs crash the tab.
    return mime ? new Blob([file], { type: mime }) : file;
  }

  async abort(): Promise<void> {
    await pool.discard(this.id).catch(() => undefined);
  }
}

class MemorySink implements FileSink {
  private parts: Uint8Array[] = [];

  async write(_offset: number, chunk: Uint8Array): Promise<void> {
    this.parts.push(new Uint8Array(chunk));
  }

  async finish(mime: string): Promise<Blob> {
    return new Blob(this.parts as BlobPart[], { type: mime || "application/octet-stream" });
  }

  async abort(): Promise<void> {
    this.parts = [];
  }
}

let diskAvailable: boolean | null = null;

function opfsPresent(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

/**
 * Probes once by actually opening a file: feature detection alone cannot tell whether
 * `createSyncAccessHandle` will work here, and Safari private browsing has OPFS
 * present but unusable.
 */
export async function prepareStorage(): Promise<boolean> {
  if (diskAvailable !== null) return diskAvailable;
  if (!opfsPresent()) {
    diskAvailable = false;
    return false;
  }

  try {
    const probe = `probe-${Math.random().toString(36).slice(2)}`;
    await pool.open(probe);
    await pool.discard(probe);
    diskAvailable = true;
    // Exempts us from least-recently-used eviction. It does not raise the quota, and
    // on Safari it also holds off the seven-day no-interaction cleanup.
    void navigator.storage.persist?.().catch(() => undefined);
    void pool.sweep().catch(() => undefined);
  } catch {
    diskAvailable = false;
  }

  return diskAvailable;
}

/** Placeholder for a transfer that already finished; nothing more will be written. */
class CompletedSink implements FileSink {
  async write(): Promise<void> {}
  async finish(): Promise<Blob> {
    return new Blob([]);
  }
  async abort(): Promise<void> {}
}

export function createCompletedSink(): FileSink {
  return new CompletedSink();
}

export async function createSink(id: string): Promise<FileSink> {
  if (await prepareStorage()) {
    try {
      await pool.open(id);
      return new OpfsSink(id);
    } catch {
      /* fall through to memory */
    }
  }
  return new MemorySink();
}

/**
 * Pick a partially received file back up after a reload. The byte count comes from the
 * file on disk rather than from anything we remembered, so it cannot drift.
 * Returns null when the file is gone, which means the transfer cannot be resumed.
 */
export async function reopenSink(id: string): Promise<{ sink: FileSink; received: number } | null> {
  if (!(await prepareStorage())) return null;
  try {
    const received = await pool.reopen(id);
    return { sink: new OpfsSink(id), received };
  } catch {
    return null;
  }
}

/**
 * Read back a file that finished arriving before the page reloaded, so it can be
 * offered for saving again instead of being stranded on disk.
 */
export async function readCompleted(id: string, mime: string): Promise<Blob | null> {
  if (!(await prepareStorage())) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(DIRECTORY);
    const file = await (await dir.getFileHandle(id)).getFile();
    return mime ? new Blob([file], { type: mime }) : file;
  } catch {
    return null;
  }
}

// --- limits ----------------------------------------------------------------

export function maxFileBytes(): number {
  return diskAvailable ? DISK_LIMIT_BYTES : MEMORY_LIMIT_BYTES;
}

/** Whether this device can plausibly take a file of this size right now. */
export async function canAccept(size: number): Promise<boolean> {
  // Must settle before reading the limit: until the probe runs the answer defaults to
  // the memory ceiling, which would refuse files this device can comfortably take.
  const disk = await prepareStorage();
  if (size > maxFileBytes()) return false;
  if (!disk) return true;

  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota === undefined || usage === undefined) return true;
    // Reported quota is padded and approximate, so leave real headroom on top.
    return quota - usage > size + QUOTA_HEADROOM_BYTES;
  } catch {
    return true;
  }
}

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
