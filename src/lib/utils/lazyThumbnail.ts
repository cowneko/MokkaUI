import type { OutputImage } from "../types/index.js";
import { applyMediaSrc } from "./tauriMediaSrc.js";

export interface LazyThumbnailOpts {
  image: OutputImage;
  size?: number;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Svelte action that lazily applies an image src when the element scrolls into view.
 * Uses thumbnailUrl (protocol-served WebP) for persisted images, or url for session images.
 * Retries on error (e.g. protocol handler not ready during startup).
 * Usage: <img use:lazyThumbnail={{ image, size: 480 }} />
 */
export function lazyThumbnail(node: HTMLImageElement, opts: LazyThumbnailOpts) {
  let current = opts;
  let retryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let hasEnteredView = false;

  function getSrc(): string | undefined {
    const img = current.image;
    // Prefer thumbnail protocol (smaller WebP) over full-res blob URL
    if (img.thumbnailUrl) {
      const size = current.size ?? 384;
      const sep = img.thumbnailUrl.includes("?") ? "&" : "?";
      const src = `${img.thumbnailUrl}${sep}size=${size}`;
      // A retry must bypass whatever the loader may have cached, so the attempt
      // number rides along instead of re-pointing the element at the same URL.
      return retryCount > 0 ? `${src}${sep}_retry=${retryCount}` : src;
    }
    if (img.url) return img.url;
    return undefined;
  }

  function applySrc() {
    const src = getSrc();
    if (!src) return;
    // Custom-scheme URLs (thumbnail://…) are never painted by the webview on
    // the Linux build, which left every tile blank; resolve through fetch/IPC
    // and hand the element a blob: URL. Other URLs pass straight through.
    applyMediaSrc(node, src);
  }

  function onError() {
    if (retryCount < MAX_RETRIES) {
      retryCount++;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        // Retry through the same resolver (busts the cache via getSrc()).
        applySrc();
      }, RETRY_DELAY_MS * retryCount);
    }
  }

  node.addEventListener("error", onError);

  // Only sets src once the element actually scrolls into view (or already is,
  // which IntersectionObserver reports on the first callback) — a grid full of
  // off-screen thumbnails must not all start downloading on mount.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          hasEnteredView = true;
          applySrc();
          observer.unobserve(node);
        }
      }
    },
    { rootMargin: "100px" },
  );

  observer.observe(node);

  return {
    update(newOpts: LazyThumbnailOpts) {
      current = newOpts;
      retryCount = 0;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      // Off-screen elements stay unloaded until the observer reports intersection.
      if (hasEnteredView) applySrc();
    },
    destroy() {
      observer.disconnect();
      node.removeEventListener("error", onError);
      if (retryTimer) clearTimeout(retryTimer);
    },
  };
}
