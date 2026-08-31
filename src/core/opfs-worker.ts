/**
 * Owns the origin-private filesystem handles for incoming transfers.
 *
 * This runs in a dedicated worker because `createSyncAccessHandle()` is only exposed
 * there — that restriction is in the spec and every engine honours it. It is also the
 * one OPFS write path that works on every target: Chrome 102, Chrome Android 109,
 * Firefox 111 and Safari/iOS 15.2. The async `createWritable()` alternative would be
 * simpler but needs Safari 26, and it only commits on close, so a crash mid-transfer
 * would lose everything. `flush()` here makes partial writes durable as we go.
 */

const DIRECTORY = "incoming";
const FLUSH_EVERY_WRITES = 32;
/** Files left behind by transfers that never finished are swept after this long. */
const STALE_FILE_MS = 60 * 60 * 1000;

interface OpenRequest {
  t: "open";
  seq: number;
  id: string;
}
/** Reopen a file left behind by a reload, keeping whatever was already written. */
interface ReopenRequest {
  t: "reopen";
  seq: number;
  id: string;
}
interface WriteRequest {
  t: "write";
  seq: number;
  id: string;
  offset: number;
  data: ArrayBuffer;
}
interface FinishRequest {
  t: "finish";
  seq: number;
  id: string;
}
interface DiscardRequest {
  t: "discard";
  seq: number;
  id: string;
}
interface SweepRequest {
  t: "sweep";
  seq: number;
}

type Request =
  | OpenRequest
  | ReopenRequest
  | WriteRequest
  | FinishRequest
  | DiscardRequest
  | SweepRequest;

interface OpenFile {
  handle: FileSystemSyncAccessHandle;
  writesSinceFlush: number;
}

const ctx = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent<Request>) => void): void;
};

const open = new Map<string, OpenFile>();
let directory: FileSystemDirectoryHandle | null = null;

async function incoming(): Promise<FileSystemDirectoryHandle> {
  if (!directory) {
    const root = await navigator.storage.getDirectory();
    directory = await root.getDirectoryHandle(DIRECTORY, { create: true });
  }
  return directory;
}

async function closeFile(id: string, flush: boolean): Promise<void> {
  const file = open.get(id);
  if (!file) return;
  open.delete(id);
  try {
    if (flush) await file.handle.flush();
    await file.handle.close();
  } catch {
    /* the handle is going away either way */
  }
}

async function handle(request: Request): Promise<unknown> {
  switch (request.t) {
    case "open": {
      await closeFile(request.id, false);
      const dir = await incoming();
      const fileHandle = await dir.getFileHandle(request.id, { create: true });
      const accessHandle = await fileHandle.createSyncAccessHandle();
      await accessHandle.truncate(0);
      open.set(request.id, { handle: accessHandle, writesSinceFlush: 0 });
      return undefined;
    }

    case "reopen": {
      await closeFile(request.id, false);
      const dir = await incoming();
      // Throws if the file is gone, which is the caller's signal to give up on it.
      const fileHandle = await dir.getFileHandle(request.id);
      const accessHandle = await fileHandle.createSyncAccessHandle();
      open.set(request.id, { handle: accessHandle, writesSinceFlush: 0 });
      // The file itself is the record of how much arrived; nothing else is trusted.
      return await accessHandle.getSize();
    }

    case "write": {
      const file = open.get(request.id);
      if (!file) throw new Error("no open file for this transfer");
      await file.handle.write(new Uint8Array(request.data), { at: request.offset });
      file.writesSinceFlush += 1;
      if (file.writesSinceFlush >= FLUSH_EVERY_WRITES) {
        file.writesSinceFlush = 0;
        await file.handle.flush();
      }
      return undefined;
    }

    case "finish": {
      await closeFile(request.id, true);
      return undefined;
    }

    case "discard": {
      await closeFile(request.id, false);
      const dir = await incoming();
      try {
        await dir.removeEntry(request.id);
      } catch {
        /* nothing written yet */
      }
      return undefined;
    }

    case "sweep": {
      const dir = await incoming();
      const cutoff = Date.now() - STALE_FILE_MS;
      const names: string[] = [];
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
        names.push(name);
      }
      for (const name of names) {
        if (open.has(name)) continue;
        try {
          const entry = await dir.getFileHandle(name);
          const file = await entry.getFile();
          if (file.lastModified < cutoff) await dir.removeEntry(name);
        } catch {
          /* raced with another sweep */
        }
      }
      return undefined;
    }
  }
}

ctx.addEventListener("message", (event) => {
  const request = event.data;
  void handle(request).then(
    (value) => ctx.postMessage({ seq: request.seq, ok: true, value }),
    (error: unknown) => ctx.postMessage({ seq: request.seq, ok: false, message: String(error) }),
  );
});
