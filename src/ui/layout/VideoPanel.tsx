import { useEffect, useRef, type ReactElement } from 'react';
import { setVideoPanelContainer } from './video-panel-registry';
import { usePlayerStore } from '@renderer/state/player-store';
import { getPlayerManager } from '@renderer/state/player-store';
import styles from './VideoPanel.module.css';

/**
 * Always-mounted slot for adapter-supplied visual elements.
 *
 * Two responsibilities:
 *
 * 1. Register/unregister the inner container with the module-level
 *    registry, so the YouTube adapter can find a mount target during
 *    `load()`. The container is a stable DOM node — React never
 *    re-renders it once AppShell is up, which is the property the
 *    adapter relies on (reparenting a live `<iframe>` triggers a
 *    Chromium reload of its content).
 *
 * 2. For sources where the adapter wants to surface a node that *isn't*
 *    inside the registered container (LocalAdapter's `<video>` element,
 *    created in renderer JS, not in the panel), we still need to host
 *    it. The effect below appendChild's the adapter's `getVisualElement()`
 *    into the container on each track change, and cleans up before the
 *    next swap. YouTube's iframe is already inside the container
 *    (the adapter mounted into it directly during `load()`), so for
 *    YouTube tracks this effect is effectively a no-op.
 *
 * The panel collapses (block-size: 0) when the current adapter has no
 * visual element. CSS-driven, not unmount — keeping the DOM stable is
 * the iframe-reparenting protection.
 */
export const VideoPanel = (): ReactElement => {
  const containerRef = useRef<HTMLDivElement>(null);
  const currentId = usePlayerStore((s) => s.current?.id ?? null);

  // Register the container exactly once on mount. The ref callback
  // pattern (rather than an effect) would also work, but a plain
  // useEffect with [] deps is just as stable: AppShell mounts once
  // per renderer lifetime.
  useEffect(() => {
    setVideoPanelContainer(containerRef.current);
    return () => {
      setVideoPanelContainer(null);
    };
  }, []);

  // When the current track changes, swap in (or out) the adapter's
  // visual element. This is for adapters that don't mount themselves
  // into the container during load() — concretely, LocalAdapter, which
  // creates a `<video>` element in JS and hands it back via
  // `getVisualElement()`. YouTubeAdapter mounts directly into the
  // container during load(), so its element is already inside
  // containerRef.current and this effect is harmlessly a no-op.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const visual = getPlayerManager().getVisualElement();
    if (!visual) return;
    // YouTube case: the adapter has already appended its mount node
    // (or YT's resulting iframe) into the container. Don't re-append
    // — that would detach and re-attach the iframe, triggering the
    // exact reload we're trying to avoid.
    if (visual.parentNode === container) return;

    // Local-video case: the `<video>` element was created in
    // LocalAdapter's load() via document.createElement, not attached
    // anywhere. Attach it now.
    container.appendChild(visual);

    return () => {
      // Detach on track change. The adapter's unload() will drop its
      // own reference; we just clean up the DOM so the next adapter's
      // visual element has a clean container to land in.
      if (visual.parentNode === container) {
        container.removeChild(visual);
      }
    };
  }, [currentId]);

  // `hasVisual` drives the collapse. We compute it from a sample of
  // the current adapter rather than from the track shape — the track
  // is the *source* of truth for "does this track have a video", but
  // the adapter is the *runtime* truth. For audio-only sources both
  // agree; for sources that surface visuals (YT always, local for
  // video extensions), agreement is also clean.
  const hasVisual = currentId !== null && getPlayerManager().getVisualElement() !== null;

  return (
    <section
      className={`${styles.panel} ${hasVisual ? styles.expanded : styles.collapsed}`}
      aria-hidden={!hasVisual}
    >
      <div ref={containerRef} className={styles.container} />
    </section>
  );
};
