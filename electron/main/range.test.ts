import { describe, it, expect } from 'vitest';
import { parseRange } from './range';

describe('parseRange', () => {
  it('returns absent for null', () => {
    expect(parseRange(null, 1000)).toEqual({ kind: 'absent' });
  });

  it('returns absent for undefined', () => {
    expect(parseRange(undefined, 1000)).toEqual({ kind: 'absent' });
  });

  it('returns absent for empty string', () => {
    expect(parseRange('', 1000)).toEqual({ kind: 'absent' });
  });

  it('parses bytes=0-99', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ kind: 'ok', start: 0, end: 99 });
  });

  it('parses bytes=500- as open-ended through final byte', () => {
    expect(parseRange('bytes=500-', 1000)).toEqual({ kind: 'ok', start: 500, end: 999 });
  });

  it('parses suffix range bytes=-100 as last 100 bytes', () => {
    expect(parseRange('bytes=-100', 1000)).toEqual({ kind: 'ok', start: 900, end: 999 });
  });

  it('clamps suffix range that exceeds total size', () => {
    expect(parseRange('bytes=-2000', 1000)).toEqual({ kind: 'ok', start: 0, end: 999 });
  });

  it('handles whitespace around the header value', () => {
    expect(parseRange('  bytes=10-20  ', 1000)).toEqual({ kind: 'ok', start: 10, end: 20 });
  });

  it('returns unsatisfiable when start is at or past size', () => {
    expect(parseRange('bytes=1000-1500', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=2000-', 1000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('returns unsatisfiable when end is past size', () => {
    expect(parseRange('bytes=500-1500', 1000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('returns unsatisfiable when start > end', () => {
    expect(parseRange('bytes=900-100', 1000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('returns unsatisfiable for suffix range against zero-size content', () => {
    expect(parseRange('bytes=-100', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('returns invalid for the wrong unit', () => {
    expect(parseRange('items=0-100', 1000)).toEqual({ kind: 'invalid' });
  });

  it('returns invalid for a header that does not start with bytes=', () => {
    expect(parseRange('not-a-range', 1000)).toEqual({ kind: 'invalid' });
  });

  it('returns invalid for bytes=- (no numbers at all)', () => {
    expect(parseRange('bytes=-', 1000)).toEqual({ kind: 'invalid' });
  });

  it('returns invalid for a multi-range header (intentionally unsupported)', () => {
    expect(parseRange('bytes=0-100,200-300', 1000)).toEqual({ kind: 'invalid' });
  });

  it('returns invalid for a suffix range of zero length', () => {
    expect(parseRange('bytes=-0', 1000)).toEqual({ kind: 'invalid' });
  });
});
