/**
 * Two different webview faults are handled here, and they have different scopes.
 *
 * 1. Images. Whether an `<img src="thumbnail://…">` paints depends on the origin
 *    the page is served from, measured on the WebKitGTK build this project runs
 *    on Linux: a packaged build serves the front-end from `tauri://localhost`,
 *    shares that origin with the media handlers (`http://thumbnail.localhost`
 *    and friends) and paints natively; a `tauri dev` page comes from
 *    `http://localhost:1420`, is cross-origin to those handlers, and paints
 *    nothing — the request never leaves the webview, and a `fetch()` of the same
 *    URL reaches the handler (the WebP really is written to disk) but its
 *    response is rejected client-side with `TypeError: Load failed`. So native
 *    URLs are used where they are expected to work, and the Rust byte commands
 *    are the fallback transport: attempted up front when the page is known to
 *    be cross-origin, and re-tried on the element's `error` event otherwise, so
 *    a platform that rejects custom schemes is covered without paying a copy
 *    through IPC on the platforms that do not need it.
 *
 * 2. Video. Media elements are not origin-dependent here: a custom URI scheme
 *    cannot feed one at all, in either origin (`MEDIA_ERR_SRC_NOT_SUPPORTED`,
 *    and often no usable `error` event), while the identical bytes from a
 *    `blob:` URL demux, decode and seek. Video therefore always goes through the
 *    byte transport — see `createVideoObjectUrl`.
 *
 * Plain http(s)/data/blob URLs are always returned untouched, so browser mode
 * and ComfyUI's own HTTP URLs keep their streaming behaviour.
 */

import { invoke } from "@tauri-apps/api/core";

const CUSTOM_SCHEME = /^(?:asset|thumbnail|gallery):\/\//;
const TAURI_HTTP_FORM = /^https?:\/\/(?:asset|thumbnail|gallery)\.localhost\//;

/** True when `url` addresses a file through one of the app's own media schemes. */
export function isCustomSchemeMediaUrl(url: string): boolean {
  return CUSTOM_SCHEME.test(url) || TAURI_HTTP_FORM.test(url);
}

/**
 * True when the page itself is served by the app rather than by the dev server.
 * Only then do the custom media schemes share the page's origin, which is what
 * lets a media subresource load at all: a packaged build runs from
 * `tauri://localhost` (or `http://tauri.localhost` on Windows), `tauri dev` runs
 * from `http://localhost:1420` and is a different host from
 * `http://thumbnail.localhost`.
 */
function servedFromAppOrigin(): boolean {
  if (typeof window === "undefined") return false;
  const { protocol, hostname } = window.location;
  return protocol === "tauri:" || hostname === "tauri.localhost";
}

/** True when `url` must be resolved instead of being set as `src` directly. */
export function needsBlobSrc(url: string): boolean {
  if (servedFromAppOrigin()) return false;
  return isCustomSchemeMediaUrl(url);
}

/** A gallery file addressed through one of the custom media schemes. */
interface MediaRequest {
  /** `thumb` for the generated WebP, `image` for the stored file itself. */
  kind: "thumb" | "image";
  filename: string;
  /** Requested thumbnail edge in pixels, when the URL carried `?size=`. */
  size?: number;
}

/**
 * Split a `thumbnail://` / `gallery://` URL (or its dev-mode
 * `http://<scheme>.localhost/` spelling) into the command arguments that serve
 * the same bytes. `asset://` has no byte command and returns null.
 */
export function parseMediaUrl(url: string): MediaRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.replace(":", "");
  const name = scheme === "http" || scheme === "https" ? parsed.hostname.split(".")[0] : scheme;
  if (name !== "thumbnail" && name !== "gallery") return null;
  let filename = parsed.pathname.replace(/^\//, "");
  try {
    filename = decodeURIComponent(filename);
  } catch {
    /* leave the raw path; the Rust side validates it either way */
  }
  if (!filename) return null;
  const rawSize = Number(parsed.searchParams.get("size"));
  return {
    kind: name === "thumbnail" ? "thumb" : "image",
    filename,
    size: Number.isFinite(rawSize) && rawSize > 0 ? Math.round(rawSize) : undefined,
  };
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  jxl: "image/jxl",
  avif: "image/avif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  webm: "video/webm",
};

function mimeFor(filename: string, kind: MediaRequest["kind"]): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[ext] ?? (kind === "thumb" ? "image/webp" : "application/octet-stream");
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(data as number[]);
  throw new Error("unexpected IPC payload");
}

/** The bytes behind a custom-scheme media URL, over IPC. */
async function fetchIpcBlob(request: MediaRequest): Promise<Blob> {
  const payload =
    request.kind === "thumb"
      ? await invoke<unknown>("get_desktop_gallery_thumbnail_bytes", {
          filename: request.filename,
          maxSize: request.size ?? 256,
        })
      : await invoke<unknown>("get_desktop_gallery_image_bytes", { filename: request.filename });
  return new Blob([toBytes(payload) as BlobPart], {
    type: mimeFor(request.filename, request.kind),
  });
}

/**
 * A direct load that neither resolves nor rejects within this window is a dead
 * transport, not a slow disk; give the byte command a chance instead of letting
 * the tile hang.
 */
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), 4000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function objectUrlFrom(url: string): Promise<string> {
  const resp = await withTimeout(fetch(url), `fetch ${url.slice(0, 48)}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  if (!blob.size) throw new Error("empty body");
  return URL.createObjectURL(blob);
}

// Object URLs are process-wide and never freed by the GC, so bound the cache
// and revoke the oldest entries: a virtualised grid walks a lot of them.
const MAX_CACHED = 600;
const cache = new Map<string, Promise<string>>();

function evictOldest(): void {
  if (cache.size <= MAX_CACHED) return;
  const oldest = cache.keys().next();
  if (oldest.done) return;
  const key = oldest.value;
  const pending = cache.get(key);
  cache.delete(key);
  pending?.then((href) => URL.revokeObjectURL(href)).catch(() => {});
}

/** The transport itself: direct load first (fast where the scheme works), IPC second. */
async function resolveFresh(url: string): Promise<string> {
  const request = parseMediaUrl(url);
  try {
    return await objectUrlFrom(url);
  } catch (directError) {
    if (!request) throw directError;
    try {
      return URL.createObjectURL(await fetchIpcBlob(request));
    } catch {
      throw directError;
    }
  }
}

/**
 * Resolve `url` to something safe to assign to an element `src`. Non-custom
 * schemes resolve immediately; custom schemes resolve once (and are memoized so
 * a grid refresh does not re-read every thumbnail).
 *
 * The result belongs to the cache — never revoke it. Callers that outlive the
 * cache (a lightbox that closes on demand) take `createMediaObjectUrl`.
 */
export async function resolveMediaSrc(url: string): Promise<string> {
  if (!needsBlobSrc(url)) return url;
  const hit = cache.get(url);
  if (hit) return hit;
  const pending = resolveFresh(url)
    .catch((err) => {
      // Do not memoize failures: a handler that is still warming up at startup
      // must not permanently blacken the tile.
      cache.delete(url);
      throw err;
    });
  cache.set(url, pending);
  evictOldest();
  return pending;
}

/**
 * Resolve to a NEW object URL owned by the caller, which must revoke it. Bypasses
 * the cache precisely so the caller can free a full-resolution image the moment
 * it is off screen instead of waiting for eviction. Returns null when `url` is
 * already displayable, i.e. there is nothing to own.
 */
export async function createMediaObjectUrl(url: string): Promise<string | null> {
  if (!needsBlobSrc(url)) return null;
  return resolveFresh(url);
}

const VIDEO_EXT = /\.(?:mp4|m4v|webm|mov|mkv)$/i;

/**
 * Ceiling for the byte transport on a clip. A `blob:` URL needs the whole file in
 * memory, which is the price of the only transport a media element accepts from
 * a custom scheme; past this size the caller is better served by an explicit
 * decode error than by an out-of-memory webview.
 */
export const MAX_VIDEO_BLOB_BYTES = 256 * 1024 * 1024;

/**
 * A `blob:` URL for a gallery clip, which the caller owns and must revoke.
 *
 * Deliberately not gated on the page origin: unlike `<img>`, a media element
 * cannot be fed from a custom URI scheme from any origin, so the byte transport
 * is the only way a clip paints — and it is also what makes the failure
 * speakable, since a rejected byte read is a rejected Promise here rather than a
 * video element that stays black without ever reporting anything.
 *
 * Returns null when `url` is not a custom-scheme clip (a `blob:` the caller
 * already holds, an http URL from browser mode): there is nothing to own.
 * Rejects when the clip is unreadable or larger than `maxBytes`.
 */
export async function createVideoObjectUrl(
  url: string,
  sizeHintBytes?: number,
  maxBytes = MAX_VIDEO_BLOB_BYTES,
): Promise<string | null> {
  const request = parseMediaUrl(url);
  if (!request || !VIDEO_EXT.test(request.filename)) return null;
  if (typeof sizeHintBytes === "number" && sizeHintBytes > maxBytes) {
    throw new Error(
      `clip is ${sizeHintBytes} bytes, over the ${maxBytes} byte byte-transport ceiling`,
    );
  }
  const blob = await fetchIpcBlob(request);
  if (!blob.size) throw new Error("empty clip body");
  // The size hint is what keeps an oversized clip from being copied at all; this
  // is the backstop for a caller that has no hint to pass, so an unbounded clip
  // is refused rather than handed to the webview as a retained blob.
  if (blob.size > maxBytes) {
    throw new Error(
      `clip is ${blob.size} bytes, over the ${maxBytes} byte byte-transport ceiling`,
    );
  }
  return URL.createObjectURL(blob);
}

/**
 * Like `createMediaObjectUrl`, but ignoring the origin gate. Used by the `error`
 * fallback below, which is exactly the case where the page origin looked able to
 * serve the scheme and turned out not to be.
 */
export async function forceMediaObjectUrl(url: string): Promise<string | null> {
  if (!isCustomSchemeMediaUrl(url)) return null;
  return resolveFresh(url);
}

/**
 * Watch an element that was handed a custom-scheme URL the native way: if that
 * load fails, this platform behaves like the cross-origin case after all, so
 * retry once through the byte transport. The listener is one-shot and goes inert
 * as soon as the element points elsewhere, because a recycled tile must never
 * re-resolve a URL it no longer displays.
 *
 * A load that already failed does not fire again for the same `src`, so a broken
 * element is detected up front rather than only on the next attempt.
 */
function armByteFallback(
  node: HTMLImageElement,
  url: string,
  adopt: (href: string) => void,
): void {
  if (!isCustomSchemeMediaUrl(url)) return;
  let retried = false;
  const retry = () => {
    if (retried || node.getAttribute("src") !== url) return;
    retried = true;
    void forceMediaObjectUrl(url).then(
      (href) => {
        if (href) adopt(href);
      },
      () => {
        /* nothing left to try; the caller's own error path has already run */
      },
    );
  };
  node.addEventListener("error", retry, { once: true });
  if (node.complete && node.naturalWidth === 0) retry();
}

/**
 * Svelte action for elements whose source is bound to state:
 * `<img use:mediaSrc={gallery.lightboxUrl}>`. The action is the only writer of
 * `src`, so a custom-scheme URL never even briefly points at a dead transport,
 * and browser-mode URLs still load unchanged.
 *
 * Ownership is strict: the blob it fetches is its own and is revoked on update
 * and destroy; a URL it did not create is left to whoever made it.
 */
export function mediaSrc(node: HTMLImageElement, url?: string | null) {
  let owned: string | null = null;
  let seq = 0;

  async function update(value?: string | null) {
    const current = ++seq;
    if (owned) {
      URL.revokeObjectURL(owned);
      owned = null;
    }
    if (!value) {
      node.removeAttribute("src");
      return;
    }
    let href = value;
    try {
      href = (await createMediaObjectUrl(value)) ?? value;
    } catch {
      // Unresolvable: let the element fire `error` on the raw URL so the
      // caller's placeholder / retry path still runs.
    }
    // Superseded while fetching: a newer update (or destroy) owns the element.
    if (current !== seq) {
      if (href !== value) URL.revokeObjectURL(href);
      return;
    }
    if (href !== value) {
      owned = href;
    } else {
      // Native URL: watch it, so a build whose engine refuses the scheme anyway
      // still paints instead of waiting for the next upstream fix.
      armByteFallback(node, value, (blobHref) => {
        owned = blobHref;
        node.src = blobHref;
      });
    }
    if (node.getAttribute("src") !== href) node.src = href;
  }

  void update(url);
  return {
    update,
    destroy() {
      seq++;
      if (owned) URL.revokeObjectURL(owned);
      owned = null;
    },
  };
}

// Per-element request generation, so a tile that is re-pointed (virtualised
// grid reusing the same element) never gets painted by an older response.
const nodeSeq = new WeakMap<HTMLImageElement, number>();

/** Fire-and-forget variant for callers that only need the element updated. */
export function applyMediaSrc(
  node: HTMLImageElement,
  url: string,
  onSettled?: (href: string) => void,
): void {
  const seq = (nodeSeq.get(node) ?? 0) + 1;
  nodeSeq.set(node, seq);
  const adopt = (blobHref: string) => {
    // Same generation rule: only the current request may paint this element.
    if (nodeSeq.get(node) !== seq) return;
    if (node.src !== blobHref) node.src = blobHref;
    onSettled?.(blobHref);
  };
  resolveMediaSrc(url).then(
    (href) => {
      if (nodeSeq.get(node) !== seq) return;
      // `href === url` means the native URL was kept (packaged build): watch it.
      if (href === url) armByteFallback(node, url, adopt);
      if (node.src !== href) node.src = href;
      onSettled?.(href);
    },
    () => {
      if (nodeSeq.get(node) !== seq) return;
      // Fall back to the raw URL: on builds without the bug it just works, and
      // it still lets the element fire `error` for the caller's retry path. The
      // byte transport has already failed here, so it is not armed again.
      if (node.src !== url) node.src = url;
    },
  );
}
