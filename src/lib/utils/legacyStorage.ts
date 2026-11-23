/**
 * Settings used to be stored under the upstream product prefixes
 * (`mooshieui.`, `mooshieui_`, `mooshie:`). This fork stores them under
 * `mokkaui` instead, and this module copies the old values across exactly
 * once, on startup, before anything reads them.
 *
 * Two rules that are not negotiable, because getting them wrong silently
 * resets a user's setup:
 *
 *  - A copy never overwrites. If a modern key already exists, whatever is
 *    in it wins, even if it looks newer or older.
 *  - The legacy key is left in place. Old releases and restored backups
 *    keep working, and a user who downgrades does not lose settings.
 *
 * Keys are scoped for logged-in browser mode by appending `::user:<id>`
 * (see `userScopedKey` in `ipc.ts`), which happens *after* the prefix, so
 * the prefix rule below covers those too.
 */

/** Prefixes written by older releases, longest-first so `mooshieui_` never
 *  matches as a `mooshie:` rewrite. */
const LEGACY_PREFIXES = ["mooshieui.", "mooshieui_", "mooshie:"] as const;

/** What `mooshieui.` / `mooshieui_` / `mooshie:` become. */
const MODERN_PREFIX = "mokkaui";

/**
 * Map one storage key to its current name. Keys that never belonged to a
 * product prefix (including translated prose that happens to begin with
 * `mooshieui.local`) are returned unchanged.
 */
export function modernKeyFor(key: string): string {
  for (const prefix of LEGACY_PREFIXES) {
    if (!key.startsWith(prefix)) continue;
    // A prefix counts only when a real key name follows it. Text such as
    // "mooshieui のアドレス…" is a translated sentence, not a key.
    if (!/[A-Za-z]/.test(key.charAt(prefix.length))) return key;
    return MODERN_PREFIX + key.slice(prefix.length - 1);
  }
  return key;
}

/** True when this key still carries an old prefix. */
export function isLegacyKey(key: string): boolean {
  return modernKeyFor(key) !== key;
}

/**
 * Copy every legacy key to its modern name unless that name is taken.
 * Returns how many values were copied, so callers can log it once.
 * Never throws: a locked or full store must not take the app down.
 */
export function migrateLegacyStorageKeys(store: Storage | null | undefined = typeof localStorage !== "undefined" ? localStorage : null): number {
  if (!store) return 0;
  let copied = 0;
  try {
    // Collect first: some stores invalidate indices if mutated while
    // iterating, and deleting nothing means the index stays honest anyway.
    const legacy: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && isLegacyKey(key)) legacy.push(key);
    }
    for (const key of legacy) {
      const target = modernKeyFor(key);
      if (store.getItem(target) !== null) continue;
      const value = store.getItem(key);
      if (value === null) continue;
      store.setItem(target, value);
      copied++;
    }
  } catch {
    // Private browsing, quota or a store that forbids enumeration: settings
    // simply stay where they are, and the app boots regardless.
  }
  return copied;
}
