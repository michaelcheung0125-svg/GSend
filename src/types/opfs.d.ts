/**
 * `FileSystemSyncAccessHandle` is missing from the bundled DOM lib, so the parts the
 * OPFS worker uses are declared here.
 *
 * The methods are synchronous in the spec and in Chrome 108+/Safari 16.4+, but Safari
 * 15.2 to 16.3 returned promises from them. Every call site awaits the result, which
 * is correct for both shapes.
 */
interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}
