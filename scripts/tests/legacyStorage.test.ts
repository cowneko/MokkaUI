import assert from "node:assert/strict";
import test from "node:test";
import { isLegacyKey, migrateLegacyStorageKeys, modernKeyFor } from "../../src/lib/utils/legacyStorage.ts";

/** Minimal localStorage double: enough of the DOM Storage contract for the
 *  migration, including the index-based `key(i)` enumeration it relies on. */
function fakeStore(initial: Record<string, string> = {}, opts: { throwOnEnumerate?: boolean } = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  const store: any = {
    get length() {
      return map.size;
    },
    key(i: number) {
      if (opts.throwOnEnumerate) throw new Error("SecurityError");
      return Array.from(map.keys())[i] ?? null;
    },
    getItem(k: string) {
      return map.has(k) ? (map.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      map.set(k, String(v));
    },
    removeItem(k: string) {
      map.delete(k);
    },
    clear() {
      map.clear();
    },
    _map: map,
  };
  return store;
}

test("a settings key is copied under the modern prefix", () => {
  const store = fakeStore({ "mooshieui.styles.v1": JSON.stringify({ a: 1 }) });
  assert.equal(migrateLegacyStorageKeys(store), 1);
  assert.equal(store.getItem("mokkaui.styles.v1"), JSON.stringify({ a: 1 }));
});

test("per-user scoped keys migrate too, suffix intact", () => {
  const store = fakeStore({ "mooshieui.styles.v1::user:42": "scoped" });
  migrateLegacyStorageKeys(store);
  assert.equal(store.getItem("mokkaui.styles.v1::user:42"), "scoped");
});

test("underscore and auth prefixes migrate as well", () => {
  const store = fakeStore({
    mooshieui_pending_update: "1",
    "mooshie:auth_token": "tok",
    "mooshie:remember_me": "1",
  });
  assert.equal(migrateLegacyStorageKeys(store), 3);
  assert.equal(store.getItem("mokkaui_pending_update"), "1");
  assert.equal(store.getItem("mokkaui:auth_token"), "tok");
  assert.equal(store.getItem("mokkaui:remember_me"), "1");
});

test("an existing modern value is never overwritten", () => {
  const store = fakeStore({
    "mooshieui.window.state.v1": "OLD",
    "mokkaui.window.state.v1": "NEW",
  });
  assert.equal(migrateLegacyStorageKeys(store), 0);
  assert.equal(store.getItem("mokkaui.window.state.v1"), "NEW");
});

test("legacy keys survive the copy so downgrades and backups still work", () => {
  const store = fakeStore({ "mooshieui.notes.v1": "keep me" });
  migrateLegacyStorageKeys(store);
  assert.equal(store.getItem("mooshieui.notes.v1"), "keep me");
});

test("translated prose that starts like a key is not a key", () => {
  const prose = "mooshieui のアドレスを開けないデバイスでは IP を使って";
  assert.equal(isLegacyKey(prose), false);
  assert.equal(modernKeyFor(prose), prose);
  const store = fakeStore({ [prose]: "value" });
  assert.equal(migrateLegacyStorageKeys(store), 0);
  assert.equal(store._map.size, 1);
});

test("keys already on the modern prefix are left alone", () => {
  assert.equal(modernKeyFor("mokkaui.styles.v1"), "mokkaui.styles.v1");
  assert.equal(isLegacyKey("mokkaui:auth_token"), false);
});

test("a hostile store cannot stop the app from booting", () => {
  const store = fakeStore({ "mooshieui.styles.v1": "x" }, { throwOnEnumerate: true });
  assert.equal(migrateLegacyStorageKeys(store), 0);
  assert.equal(migrateLegacyStorageKeys(null), 0);
  assert.equal(migrateLegacyStorageKeys(undefined), 0);
});
