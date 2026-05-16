import { describe, it, expect } from 'vitest';
import { isAudioFile, isVideoFile, isPlayableLocalFile } from './file-types';

describe('isAudioFile', () => {
  it('accepts common audio extensions', () => {
    expect(isAudioFile('song.mp3')).toBe(true);
    expect(isAudioFile('song.flac')).toBe(true);
    expect(isAudioFile('song.m4a')).toBe(true);
    expect(isAudioFile('song.opus')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAudioFile('SONG.MP3')).toBe(true);
    expect(isAudioFile('song.Flac')).toBe(true);
  });

  it('handles full posix paths', () => {
    expect(isAudioFile('/Users/zain/Music/song.mp3')).toBe(true);
  });

  it('handles paths with backslashes', () => {
    expect(isAudioFile('C:\\Music\\song.mp3')).toBe(true);
  });

  it('rejects unknown extensions', () => {
    expect(isAudioFile('song.txt')).toBe(false);
    expect(isAudioFile('readme.md')).toBe(false);
  });

  it('rejects video files', () => {
    expect(isAudioFile('movie.mp4')).toBe(false);
  });

  it('rejects extensionless paths', () => {
    expect(isAudioFile('LICENSE')).toBe(false);
    expect(isAudioFile('')).toBe(false);
  });
});

describe('isVideoFile', () => {
  it('accepts common video extensions', () => {
    expect(isVideoFile('clip.mp4')).toBe(true);
    expect(isVideoFile('clip.mov')).toBe(true);
    expect(isVideoFile('clip.webm')).toBe(true);
    expect(isVideoFile('clip.m4v')).toBe(true);
  });

  it('rejects v1-out-of-scope extensions', () => {
    expect(isVideoFile('rip.mkv')).toBe(false);
    expect(isVideoFile('old.avi')).toBe(false);
  });

  it('rejects audio files', () => {
    expect(isVideoFile('song.mp3')).toBe(false);
  });
});

describe('isPlayableLocalFile', () => {
  it('accepts both audio and video', () => {
    expect(isPlayableLocalFile('song.mp3')).toBe(true);
    expect(isPlayableLocalFile('clip.mp4')).toBe(true);
  });

  it('rejects non-media files', () => {
    expect(isPlayableLocalFile('cover.jpg')).toBe(false);
    expect(isPlayableLocalFile('readme.txt')).toBe(false);
  });
});
