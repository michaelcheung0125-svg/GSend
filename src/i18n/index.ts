import { useSyncExternalStore } from "react";
import {
  DICTIONARIES,
  format,
  type Language,
  type Message,
  type MessageKey,
  type MessageParams,
} from "./strings";

export type { Language, Message, MessageKey, MessageParams } from "./strings";

const STORAGE_KEY = "gsend.language";

/**
 * A deliberate choice is remembered; otherwise the browser's own preference decides.
 * Kept in localStorage rather than sessionStorage because a language preference is
 * about the person, not about one transfer.
 */
function detect(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh") return saved;
  } catch {
    /* private browsing; fall through to the browser preference */
  }

  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of tags) {
    if (tag?.toLowerCase().startsWith("zh")) return "zh";
  }
  return "en";
}

let current: Language = detect();
const listeners = new Set<() => void>();

function applyDocumentLanguage(): void {
  document.documentElement.lang = current === "zh" ? "zh-Hant" : "en";
}

applyDocumentLanguage();

function getLanguage(): Language {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setLanguage(next: Language): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* the choice still applies for this visit */
  }
  applyDocumentLanguage();
  for (const listener of listeners) listener();
}

export interface Translator {
  language: Language;
  /** Translate a key, filling any `{placeholders}`. */
  t(key: MessageKey, params?: MessageParams): string;
  /** Translate a message carried in application state, or nothing. */
  tm(message?: Message | null): string | null;
  toggle(): void;
}

export function useI18n(): Translator {
  const language = useSyncExternalStore(subscribe, getLanguage, getLanguage);
  const dictionary = DICTIONARIES[language];

  const t = (key: MessageKey, params?: MessageParams) => format(dictionary[key], params);

  return {
    language,
    t,
    tm: (message) => (message ? t(message.key, message.params) : null),
    toggle: () => setLanguage(language === "en" ? "zh" : "en"),
  };
}
