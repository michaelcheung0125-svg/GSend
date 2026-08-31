/**
 * Collects files handed over by the system share sheet.
 *
 * A share arrives as a POST that the page never sees: the service worker takes it,
 * parks the payload, and redirects here. This reads what was parked and clears it, so
 * the same files cannot be sent twice by a stray reload.
 */

const SHARE_CACHE = "gsend-share";
const SHARE_MANIFEST = "/__share/manifest";

interface ShareEntry {
  key: string;
  name: string;
  type?: string;
}

export interface SharedPayload {
  files: File[];
  text: string | null;
}

export async function collectShare(): Promise<SharedPayload | null> {
  try {
    const response = await fetch(SHARE_MANIFEST);
    if (!response.ok) return null;

    const manifest = (await response.json()) as { files?: ShareEntry[]; text?: string } | null;
    if (!manifest) return null;

    const files: File[] = [];
    for (const entry of manifest.files ?? []) {
      const stored = await fetch(entry.key);
      if (!stored.ok) continue;
      const blob = await stored.blob();
      files.push(new File([blob], entry.name, { type: entry.type || blob.type }));
    }

    const text = manifest.text?.trim() ? manifest.text : null;
    await clearShare();

    return files.length > 0 || text ? { files, text } : null;
  } catch {
    return null;
  }
}

async function clearShare(): Promise<void> {
  try {
    const cache = await caches.open(SHARE_CACHE);
    for (const key of await cache.keys()) await cache.delete(key);
  } catch {
    /* the payload will be replaced by the next share anyway */
  }
}
