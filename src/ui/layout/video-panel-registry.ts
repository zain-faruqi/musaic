/**
 * Module-level registry for the video panel's container element.
 *
 * Why this exists: the YouTube IFrame Player API wants a DOM element to
 * mount into when its `new YT.Player(...)` is called. The natural React
 * approach — pass a ref through props — fails here because the adapter
 * lives below the UI tree, in `PlayerManager` orchestration, and
 * shouldn't know about React refs at all.
 *
 * The registry is the seam:
 *   - `VideoPanel` mounts; its container ref calls `setContainer(el)`.
 *   - `YouTubeAdapter.load(track)` reads `getContainer()` to find the
 *     mount target.
 *   - `VideoPanel` unmounts (effectively never, in this app — it lives
 *     for the lifetime of `AppShell`); the ref clears the container
 *     to null on the way out.
 *
 * This pattern is intentionally tiny — a single global slot — because
 * there's only ever one video panel in the app. If we ever needed
 * multiple (PiP, fullscreen detach), this surface would grow, but for
 * now the single slot is enough and the simplicity is a feature.
 *
 * DOM stability is the other constraint that pushed this here.
 * Reparenting a live `<iframe>` triggers a Chromium reload of its
 * content, which the IFrame Player API doesn't recover from cleanly.
 * The panel's container must stay rooted at the same DOM node from the
 * moment AppShell mounts; React reconciliation can't be allowed to
 * recreate it. Mounting *into* an adapter-supplied node (rather than
 * having React render the node) gives us that guarantee.
 */

let container: HTMLElement | null = null;

/**
 * Called by `VideoPanel` on mount (and on unmount with `null`). Replaces
 * any prior registration silently — the panel is a singleton, so a
 * re-registration is either a hot-reload or a programmer error; either
 * way the new container is the one we should use going forward.
 */
export const setVideoPanelContainer = (el: HTMLElement | null): void => {
  container = el;
};

/**
 * Read the current container. Returns null if no panel is mounted —
 * the YouTube adapter throws a clear error in that case rather than
 * silently failing to render.
 */
export const getVideoPanelContainer = (): HTMLElement | null => container;
