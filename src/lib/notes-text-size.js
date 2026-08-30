// Text size for the shared notes textarea only — not a site-wide setting.
// Like theme, this is a per-browser display preference: host and guest each
// pick their own, and it's never sent over the room WS, so there's nothing
// to keep in sync between them.

const STORAGE_KEY = "notesTextSize";
export const SIZES = [14, 16, 18, 20];
const DEFAULT_SIZE = 16;

export function getNotesTextSize() {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    if (SIZES.includes(stored)) return stored;
  } catch {}
  return DEFAULT_SIZE;
}

export function setNotesTextSize(size) {
  try { localStorage.setItem(STORAGE_KEY, String(size)); } catch {}
}
