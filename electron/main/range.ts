/**
 * Result of parsing an HTTP Range header.
 *
 *   - `absent`        — header missing or empty; serve full content (200).
 *   - `ok`            — valid range; serve those bytes (206).
 *   - `unsatisfiable` — range syntactically valid but out of bounds; reply 416.
 *   - `invalid`       — header malformed; treat as if absent (per RFC 7233 §3.1).
 */
export type ParsedRange =
  | { kind: 'absent' }
  | { kind: 'ok'; start: number; end: number }
  | { kind: 'unsatisfiable' }
  | { kind: 'invalid' };

/**
 * Parse an HTTP Range header against a known content size.
 *
 * Honors the three forms `<audio>` and `<video>` elements emit:
 *   - `bytes=N-`    — from N through the end
 *   - `bytes=N-M`   — N through M inclusive
 *   - `bytes=-N`    — the last N bytes (suffix)
 *
 * Multi-range (`bytes=0-100,200-300`) is intentionally not supported —
 * media elements don't request it and supporting it would require
 * multipart/byteranges responses, which add complexity for no win.
 */
export const parseRange = (
  header: string | null | undefined,
  totalSize: number,
): ParsedRange => {
  if (!header) return { kind: 'absent' };

  const match = /^bytes=(\d+)?-(\d+)?$/.exec(header.trim());
  if (!match) return { kind: 'invalid' };

  const startStr = match[1];
  const endStr = match[2];

  // Suffix range: bytes=-N means "last N bytes."
  if (startStr === undefined) {
    if (endStr === undefined) return { kind: 'invalid' };
    const suffixLen = Number.parseInt(endStr, 10);
    if (suffixLen <= 0) return { kind: 'invalid' };
    if (totalSize === 0) return { kind: 'unsatisfiable' };
    const start = Math.max(0, totalSize - suffixLen);
    return { kind: 'ok', start, end: totalSize - 1 };
  }

  const start = Number.parseInt(startStr, 10);
  const end = endStr !== undefined ? Number.parseInt(endStr, 10) : totalSize - 1;

  if (start >= totalSize || start > end || end >= totalSize) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'ok', start, end };
};
