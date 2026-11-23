/**
 * Startup side effect: copy settings written under the upstream product
 * prefixes before any store reads them.
 *
 * This module must stay the first non-CSS import of `main.ts`. ES modules
 * evaluate their imports in order, so putting it here guarantees the copy
 * happens before any module-level store initialisation touches
 * `localStorage` — a later call in the function body would already be too
 * late for those.
 */
import { migrateLegacyStorageKeys } from "./legacyStorage.js";

/** How many values were copied, for the startup log. */
export const legacyKeysMigrated = migrateLegacyStorageKeys();
