/**
 * Handing several received files over at once, for when they went to browser storage
 * rather than straight into a folder the person picked.
 *
 * There is no single browser call for "save these", so this takes whichever route the
 * platform handles well. Almost everywhere that is one download per file, fired in a
 * row: browsers ask once whether the site may download several files and then take the
 * rest. iOS is the exception — Safari drops every download after the first when they
 * arrive back to back — but its share sheet takes a whole set in one go and offers
 * "Save to Files" or, for photos and videos, saving them to the library.
 */

export interface SavableFile {
  id: string;
  name: string;
  url: string;
  blob: Blob;
}

/**
 * Chrome quietly loses some of a burst of downloads started in the same instant, so
 * they are spaced out. Short enough that a dozen files still feel like one action.
 */
const DOWNLOAD_GAP_MS = 250;

/**
 * Must be called straight out of a click: the share sheet and the first download both
 * need the user activation, so nothing may be awaited before them. `onSaved` fires for
 * each file as it is handed over, so the rows can say which ones are done.
 */
export async function saveFiles(
  files: SavableFile[],
  onSaved: (id: string) => void,
): Promise<void> {
  if (files.length === 0) return;

  if (prefersShareSheet()) {
    const outcome = await shareFiles(files);
    if (outcome === "cancelled") return;
    if (outcome === "shared") {
      for (const file of files) onSaved(file.id);
      return;
    }
    // Not shareable after all; downloads are still better than nothing.
  }

  for (const [index, file] of files.entries()) {
    if (index > 0) await delay(DOWNLOAD_GAP_MS);
    triggerDownload(file.url, file.name);
    onSaved(file.id);
  }
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
