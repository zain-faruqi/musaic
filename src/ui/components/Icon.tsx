import type { ReactElement, SVGProps } from 'react';

/**
 * Stroke-first SVG icons. All use `currentColor` so they inherit text
 * color from the surrounding element — set color in CSS, not on the icon.
 * Sizes default to the conventions the layout components expect (24 for
 * top-bar nav, 16 for transport).
 */

type IconProps = SVGProps<SVGSVGElement>;

const NavIcon = ({ children, ...rest }: IconProps & { children: ReactElement | ReactElement[] }): ReactElement => (
  <svg
    width={24}
    height={24}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    {...rest}
  >
    {children}
  </svg>
);

const TransportIcon = ({ children, ...rest }: IconProps & { children: ReactElement | ReactElement[] }): ReactElement => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    {...rest}
  >
    {children}
  </svg>
);

export const LibraryIcon = (props: IconProps): ReactElement => (
  <NavIcon {...props}>
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="17" x2="20" y2="17" />
  </NavIcon>
);

export const NowPlayingIcon = (props: IconProps): ReactElement => (
  <NavIcon {...props} strokeWidth={2}>
    <line x1="6" y1="14" x2="6" y2="18" />
    <line x1="10" y1="10" x2="10" y2="18" />
    <line x1="14" y1="6" x2="14" y2="18" />
    <line x1="18" y1="12" x2="18" y2="18" />
  </NavIcon>
);

export const ProfileIcon = (props: IconProps): ReactElement => (
  <NavIcon {...props}>
    <circle cx="12" cy="9" r="3.5" />
    <path d="M5 19c0-3.5 3-6 7-6s7 2.5 7 6" />
  </NavIcon>
);

export const PlayIcon = (props: IconProps): ReactElement => (
  <TransportIcon {...props}>
    <polygon points="4,3 13,8 4,13" />
  </TransportIcon>
);

export const PauseIcon = (props: IconProps): ReactElement => (
  <TransportIcon {...props}>
    <line x1="5" y1="3" x2="5" y2="13" />
    <line x1="11" y1="3" x2="11" y2="13" />
  </TransportIcon>
);

export const PrevIcon = (props: IconProps): ReactElement => (
  <TransportIcon {...props}>
    <polygon points="12,3 5,8 12,13" />
    <line x1="3" y1="3" x2="3" y2="13" />
  </TransportIcon>
);

export const NextIcon = (props: IconProps): ReactElement => (
  <TransportIcon {...props}>
    <polygon points="4,3 11,8 4,13" />
    <line x1="13" y1="3" x2="13" y2="13" />
  </TransportIcon>
);

/**
 * Shuffle glyph — two arrows that cross, one running up-right and one
 * down-right, both ending in an arrowhead at the right edge. The
 * canonical shuffle mark. Uses the `NavIcon` wrapper (24×24, 1.5px
 * stroke, round caps) like the other nav-scale icons; call sites pass
 * an explicit `width`/`height` when they need it sized down.
 */
export const ShuffleIcon = (props: IconProps): ReactElement => (
  <NavIcon {...props}>
    <path d="M3 7h4l10 10h4" />
    <polyline points="18,14 21,17 18,20" />
    <path d="M3 17h4l10-10h4" />
    <polyline points="18,4 21,7 18,10" />
  </NavIcon>
);

/**
 * Drag handle for the playlist tile's reorder affordance.
 * Two columns of three dots — the canonical "grip" pattern. Uses
 * `fill="currentColor"` rather than the stroke convention because
 * the strokeLinecap='round' style on a 1.5px stroke renders dots as
 * fuzzy blobs at this scale; small filled circles read cleaner.
 *
 * Size matches the transport icons so it visually balances against
 * the × character used as the remove button — both anchor in the
 * tile's top corners.
 */
export const DragHandleIcon = (props: IconProps): ReactElement => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 16 16"
    fill="currentColor"
    stroke="none"
    aria-hidden
    {...props}
  >
    <circle cx="5" cy="3" r="1.25" />
    <circle cx="5" cy="8" r="1.25" />
    <circle cx="5" cy="13" r="1.25" />
    <circle cx="11" cy="3" r="1.25" />
    <circle cx="11" cy="8" r="1.25" />
    <circle cx="11" cy="13" r="1.25" />
  </svg>
);
