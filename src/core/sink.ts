/**
 * Where received bytes land while a transfer is in flight.
 *
 * The best path writes straight into a folder the person picked, through the File
 * System Access API: nothing is buffered on the way, so the ceiling is their free disk
 * and a finished file is already saved. Where that API is missing the bytes go to the
 * origin-private filesystem instead, which is quota-bound and needs a second save step
 * but survives a reload. Memory is the last resort, for contexts with neither.
 */
export interface FileSink {
  /**
   * The name the file was written under in the person's own folder, when it went
   * straight to disk. Null means the bytes are being held for them to save later.
   */
  readonly savedAs: string | null;
  write(offset: number, chunk: Uint8Array): Promise<void>;
  /** A blob to offer for saving, or null when the file is already on their disk. */
  finish(mime: string): Promise<Blob | null>;
  abort(): Promise<void>;
}

const DIRECTORY = "incoming";
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
/** Used when the origin will not tell us its quota; the ceiling this app shipped with. */
const OPFS_FALLBACK_BYTES = 1024 * 1024 * 1024;
/** A quota estimate above this is not believed enough to advertise as a per-file limit. */
const OPFS_CEILING_MAX_BYTES = 64 * 1024 * 1024 * 1024;
/** Refuse a file unless the origin reports at least this much headroom beyond it. */
const QUOTA_HEADROOM_BYTES = 256 * 1024 * 1024;

/** No app-imposed ceiling: the bytes stream into the person's own filesystem. */
export const UNLIMITED = Number.POSITIVE_INFINITY;

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

// --- the folder the person picked ------------------------------------------

interface DirectoryPicker {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: string;
  }) => Promise<FileSystemDirectoryHandle>;
}

let saveDirectory: FileSystemDirectoryHandle | null = null;

export function directPickerSupported(): boolean {
  return typeof (globalThis as unknown as DirectoryPicker).showDirectoryPicker === "function";
}

/**
 * Ask for a folder to write into. This has to be called straight out of a click:
 * the picker needs transient user activation, which expires within seconds, so there
 * is no way to defer it until the connection is up and the file list is known.
 *
 * Returns the folder's name, or null if the person dismissed the dialog.
 */
export async function chooseSaveDirectory(): Promise<string | null> {
  const picker = (globalThis as unknown as DirectoryPicker).showDirectoryPicker;
  if (!picker) return null;
  try {
    // `id` makes the browser reopen where this app was last used rather than at the
    // top of the filesystem, which is most of the friction in a folder picker.
    const handle = await picker({ id: "gsend-incoming", mode: "readwrite", startIn: "downloads" });
    saveDirectory = handle;
    return handle.name;
  } catch {
    // Dismissed, or blocked by policy. The OPFS path still works.
    return null;
  }
}

export function saveDirectoryName(): string | null {
  return saveDirectory?.name ?? null;
}

export function forgetSaveDirectory(): void {
  saveDirectory = null;
}

/**
 * The name arrives from the other device, and unlike the OPFS path — which files
 * everything under an opaque id — it is about to be written into a real folder the
 * person chose. Anything that could climb out of that folder, hide itself, or upset
 * the platform is neutralised here rather than trusted.
 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    // Windows silently drops trailing dots and spaces, so a name ending in them would
    // not be the name we then look for.
    .replace(/[. ]+$/, "")
    .slice(0, 200)
    .trim();
  if (!cleaned || RESERVED_NAMES.test(cleaned)) return `gsend-file-${Date.now()}`;
  return cleaned;
}

/** Never overwrite something already sitting in the folder; suffix instead. */
async function freeName(dir: FileSystemDirectoryHandle, raw: string): Promise<string> {
  const safe = safeName(raw);
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : "";

  for (let n = 1; n <= 200; n += 1) {
    const candidate = n === 1 ? safe : `${stem} (${n})${extension}`;
    try {
      await dir.getFileHandle(candidate);
    } catch (error) {
      if ((error as DOMException).name === "NotFoundError") return candidate;
      // Something else is in the way (a directory, most likely); try the next suffix.
    }
  }
  return `${stem} (${Date.now()})${extension}`;
}

// --- sinks -----------------------------------------------------------------

/**
 * Streams into the person's own folder. Chrome writes through a swap file that is only
 * committed on close, so a dropped connection is survivable — the stream stays open
 * across a WebRTC reconnect — but a page reload is not. That is the trade for having
 * no size ceiling and no second copy, and `viaDisk` on the stored record is what stops
 * a reloaded page from claiming it can resume one of these.
 */
class DiskSink implements FileSink {
  /** Writes are queued rather than issued concurrently, so bytes land in order. */
  private tail: Promise<void> = Promise.resolve();

  private constructor(
    private readonly directory: FileSystemDirectoryHandle,
    private stream: FileSystemWritableFileStream | null,
    readonly savedAs: string,
  ) {}

  static async create(dir: FileSystemDirectoryHandle, name: string): Promise<DiskSink> {
    const filename = await freeName(dir, name);
    const handle = await dir.getFileHandle(filename, { create: true });
    const stream = await handle.createWritable({ keepExistingData: false });
    return new DiskSink(dir, stream, filename);
  }

  write(offset: number, chunk: Uint8Array): Promise<void> {
    const stream = this.stream;
    if (!stream) return Promise.reject(new Error("stream closed"));
    // The write is queued behind the ones before it and may run long after this call,
    // so it cannot hold a view onto a frame the caller is free to reuse.
    const copy = new Uint8Array(chunk);
    this.tail = this.tail.then(() =>
      stream.write({ type: "write", position: offset, data: copy }),
    );
    return this.tail;
  }

  async finish(): Promise<Blob | null> {
    const stream = this.stream;
    if (!stream) return null;
    this.stream = null;
    await this.tail;
    await stream.close();
    // Already where the person asked for it; there is nothing left to hand back.
    return null;
  }

  async abort(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    try {
      await stream?.abort();
    } catch {
      /* already gone */
    }
    // Aborting discards the swap file but leaves behind the empty file that reserving
    // the name created, which would otherwise look like a transfer that worked.
    try {
      await this.directory.removeEntry(this.savedAs);
    } catch {
      /* never created, or removed already */
    }
  }
}

class OpfsSink implements FileSink {
  readonly savedAs = null;

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
  readonly savedAs = null;
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
/** What the origin's quota says it can hold, once the probe has asked. */
let opfsCeiling: number | null = null;

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
    await measureOpfsCeiling();
  } catch {
    diskAvailable = false;
  }

  return diskAvailable;
}

/**
 * The per-file ceiling on the OPFS path is whatever the origin will actually give us,
 * not a number picked in advance. Browsers grant very different amounts — a share of
 * total disk on Chrome, a flat cap on Firefox, a growing allowance on Safari — so
 * asking is the only way to get this right on all of them.
 */
async function measureOpfsCeiling(): Promise<void> {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota === undefined) return;
    const free = quota - (usage ?? 0) - QUOTA_HEADROOM_BYTES;
    opfsCeiling = Math.min(Math.max(free, MEMORY_LIMIT_BYTES), OPFS_CEILING_MAX_BYTES);
  } catch {
    /* leave it null; the fallback ceiling applies */
  }
}

/** Placeholder for a transfer that already finished; nothing more will be written. */
class CompletedSink implements FileSink {
  readonly savedAs: string | null;
  constructor(savedAs: string | null = null) {
    this.savedAs = savedAs;
  }
  async write(): Promise<void> {}
  async finish(): Promise<Blob | null> {
    return null;
  }
  async abort(): Promise<void> {}
}

export function createCompletedSink(savedAs: string | null = null): FileSink {
  return new CompletedSink(savedAs);
}

export async function createSink(id: string, name: string): Promise<FileSink> {
  if (saveDirectory) {
    try {
      return await DiskSink.create(saveDirectory, name);
    } catch {
      // Permission revoked, or the folder went away (an unplugged drive). Falling back
      // beats failing the transfer outright.
      saveDirectory = null;
    }
  }
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
  if (saveDirectory) return UNLIMITED;
  if (!diskAvailable) return MEMORY_LIMIT_BYTES;
  return opfsCeiling ?? OPFS_FALLBACK_BYTES;
}

/** Whether this device can plausibly take a file of this size right now. */
export async function canAccept(size: number): Promise<boolean> {
  // A folder of their own has no quota attached to it, so none of the rest applies.
  if (saveDirectory) return true;

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
