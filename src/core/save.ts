/**
 * Handing several received files over at once, for when they went to browser storage
 * rather than straight into a folder the person picked.
 *
 * There is no single browser call for "save these", so this takes whichever route the
 * platform handles well, in order of how reliably the files actually arrive:
 *
 * - A folder, wherever one can be had (Chromium desktop). The files are written into it
 *   directly, and it is the only route that reports whether each one was written.
 * - The share sheet on iPhone and iPad, which takes a whole set in one go and offers
 *   "Save to Files", or the photo library for pictures and video.
 * - One download per file otherwise. Browsers ask before the second file and drop the
 *   rest while nobody answers, which is why this comes last.
 */
import {
  chooseSaveDirectory,
  directPickerSupported,
  saveDirectoryName,
  writeToSaveDirectory,
} from "./sink";

export interface SavableFile {
  id: string;
  name: string;
  url: string;
  blob: Blob;
}

/** Which route the files took, so the session can say what to expect of it. */
export type SaveRoute = "folder" | "share" | "download" | "cancelled";

/**
 * Chrome quietly loses some of a burst of downloads started in the same instant, so
 * they are spaced out. Short enough that a dozen files still feel like one action.
 */
const DOWNLOAD_GAP_MS = 250;

/**
 * Must be called straight out of a click: the folder picker, the share sheet and the
 * first download all need the user activation, so nothing may be awaited before them.
 * `onSaved` fires for each file as it is handed over, carrying the name it was written
 * under when it went into a folder.
 */
export async function saveFiles(
  files: SavableFile[],
  onSaved: (id: string, savedAs: string | null) => void,
): Promise<SaveRoute> {
  if (files.length === 0) return "cancelled";

  if (prefersShareSheet()) {
    const outcome = await shareFiles(files);
    if (outcome === "cancelled") return "cancelled";
    if (outcome === "shared") {
      for (const file of files) onSaved(file.id, null);
      return "share";
    }
    // Not shareable after all; the other routes still beat nothing.
  } else if (!saveDirectoryName() && directPickerSupported()) {
    // Asked once, rather than a download per file that the browser may refuse halfway
    // through. Coming back empty-handed is taken as "not into a folder, then".
    await chooseSaveDirectory();
  }

  const leftover: SavableFile[] = [];
  for (const file of files) {
    const savedAs = saveDirectoryName() ? await writeToSaveDirectory(file.name, file.blob) : null;
    if (savedAs) onSaved(file.id, savedAs);
    else leftover.push(file);
  }
  if (leftover.length === 0) return "folder";

  for (const [index, file] of leftover.entries()) {
    if (index > 0) await delay(DOWNLOAD_GAP_MS);
    triggerDownload(file.url, file.name);
    onSaved(file.id, null);
  }
  return "download";
}

function triggerDownload(url: string, name: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  // Firefox ignores clicks on links that are not in the document.
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
}

async function shareFiles(files: SavableFile[]): Promise<"shared" | "cancelled" | "unsupported"> {
  const shared = files.map((file) => new File([file.blob], file.name, { type: file.blob.type }));
  if (!navigator.canShare?.({ files: shared })) return "unsupported";
  try {
    await navigator.share({ files: shared });
    return "shared";
  } catch (error) {
    // Closing the sheet is an AbortError. Anything else means it could not be shown.
    return (error as DOMException).name === "AbortError" ? "cancelled" : "unsupported";
  }
}

/**
 * Only iPhone and iPad. Elsewhere the share sheet has no plain "save" in it — on a
 * desktop it offers mail and messaging, on Android a list of apps — while downloads
 * work, so it would be a step backwards. iPadOS reports itself as a Mac, and the touch
 * points are what give it away.
 */
function prefersShareSheet(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
