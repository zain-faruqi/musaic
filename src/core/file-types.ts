/**
 * Audio file extensions supported by HTML5 audio on macOS in v1.
 */
export const LOCAL_AUDIO_EXTENSIONS = [
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.wav',
  '.ogg',
  '.opus',
] as const;

/**
 * Video file extensions supported by HTML5 video on macOS in v1.
 * `.mkv` and `.avi` need transcoding paths and are intentionally out of
 * scope until post-v1.
 */
export const LOCAL_VIDEO_EXTENSIONS = [
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
] as const;

/**
 * Extract the lowercase extension (including the dot) from a path.
 * Pure string work — no node:path dependency, so this runs in the
 * renderer too. Handles both / and \\ separators.
 */
const lowerExt = (path: string): string => {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const base = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
};

export const isAudioFile = (path: string): boolean =>
  (LOCAL_AUDIO_EXTENSIONS as readonly string[]).includes(lowerExt(path));

export const isVideoFile = (path: string): boolean =>
  (LOCAL_VIDEO_EXTENSIONS as readonly string[]).includes(lowerExt(path));

export const isPlayableLocalFile = (path: string): boolean =>
  isAudioFile(path) || isVideoFile(path);
