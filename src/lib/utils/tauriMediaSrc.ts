/**
 * Media URLs for Tauri's custom URI schemes (asset/thumbnail/gallery) cannot be
 * painted by the webview on every platform. On the WebKitGTK build this project
 * runs on Linux, an `<img src="thumbnail://…">` load is never handed to the
 * registered scheme handler at all (the request does not leave the webview), and
 * a `fetch()` of the same URL reaches the handler but its response is rejected
 * client-side (`TypeError: Load failed`) — the thumbnail is generated on disk
 * and never displayed. IPC is the only transport that survives, so custom
 * scheme URLs are resolved to `blob:` URLs: direct fetch first (cheap and
 * browser-cached where the scheme works), then the Rust commands that return the
 * same bytes. Plain http(s)/data/blob URLs are returned untouched, so browser
 * mode and ComfyUI's own HTTP URLs keep their streaming behaviour.
 */

import { invoke } from "@tauri-apps/api/core";

const CUSTOM_SCHEME = /^(?:asset|thumbnail|gallery):\/\//;
const TAURI_HTTP_FORM = /^https?:\/\/(?:asset|thumbnail|gallery)\.localhost\//;

/** True when `url` must be resolved instead of being set as `src` directly. */
export function needsBlobSrc(url: string): boolean {
  return CUSTOM_SCHEME.test(url) || TAURI_HTTP_FORM.test(url);
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
    if (href !== value) owned = href;
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
  resolveMediaSrc(url).then(
    (href) => {
      // A newer request on this element wins; a stale blob must not stick.
      if (nodeSeq.get(node) !== seq) return;
      if (node.src !== href) node.src = href;
      onSettled?.(href);
    },
    () => {
      if (nodeSeq.get(node) !== seq) return;
      // Fall back to the raw URL: on builds without the bug it just works, and
      // it still lets the element fire `error` for the caller's retry path.
      if (node.src !== url) node.src = url;
    },
  );
}
