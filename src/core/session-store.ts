import { RESUME_GRACE_MS, type Role } from "../../shared/protocol";

const STORAGE_KEY = "gsend.session";

export interface StoredSession {
  code: string;
  sessionKey: string;
  role: Role;
  approved: boolean;
  savedAt: number;
}

/**
 * Session credentials survive a reload here, which is what makes resume possible at
 * all: the 4-digit code is long dead by then, so the 256-bit session key is the only
 * way back into the room. sessionStorage (not localStorage) keeps the scope right —
 * one tab, cleared when the tab closes.
 */
export function saveSession(session: Omit<StoredSession, "savedAt">): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...session, savedAt: Date.now() }));
  } catch {
    /* private browsing or a full quota; resume is a bonus, not a requirement */
  }
}

export function loadSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (!parsed.code || !parsed.sessionKey || !parsed.role || !parsed.savedAt) return null;

    // The server reaps a session once both peers have been gone this long, so an
    // older record can only lead to a confusing failed resume.
    if (Date.now() - parsed.savedAt > RESUME_GRACE_MS) {
      clearSession();
      return null;
    }

    return parsed as StoredSession;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clean up */
  }
}
