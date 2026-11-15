import { useId, type CSSProperties, type JSX, type ReactNode } from 'react';

function Ic({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
      {children}
    </svg>
  );
}

export type IconName = keyof typeof I;

export const I = {
  lock: () => (
    <Ic>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </Ic>
  ),
  eye: () => (
    <Ic>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Ic>
  ),
  eyeOff: () => (
    <Ic>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.9 9.9 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </Ic>
  ),
  check: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  ),
  search: () => (
    <Ic>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </Ic>
  ),
  flip: () => (
    <Ic>
      <path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" />
    </Ic>
  ),
  chev: () => (
    <Ic>
      <path d="M9 5l7 7-7 7" />
    </Ic>
  ),
  copy: () => (
    <Ic>
      <rect x="8" y="8" width="12" height="12" rx="2.5" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </Ic>
  ),
  x: () => (
    <Ic>
      <path d="M6 6l12 12M18 6L6 18" />
    </Ic>
  ),
  wallet: () => (
    <Ic>
      <rect x="3" y="6" width="18" height="13" rx="3" />
      <path d="M3 10h18" />
      <circle cx="16.5" cy="14.5" r="1" fill="currentColor" />
    </Ic>
  ),
  qr: () => (
    <Ic>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18v2M18 14h2" />
    </Ic>
  ),
  key: () => (
    <Ic>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M17 6l3 3M14 9l2 2" />
    </Ic>
  ),
  shieldIn: () => (
    <Ic>
      <path d="M12 3l7 3v5c0 5-3.2 8.4-7 10-3.8-1.6-7-5-7-10V6l7-3Z" />
      <path d="M12 8v7M9 12l3 3 3-3" />
    </Ic>
  ),
  shieldOut: () => (
    <Ic>
      <path d="M12 3l7 3v5c0 5-3.2 8.4-7 10-3.8-1.6-7-5-7-10V6l7-3Z" />
      <path d="M12 15V8M9 11l3-3 3 3" />
    </Ic>
  ),
  send: () => (
    <Ic>
      <path d="M4 12l16-8-6 16-2.5-6.5L4 12Z" />
    </Ic>
  ),
  trade: () => (
    <Ic>
      <path d="M4 17l5-5 4 4 7-8" />
      <path d="M15 8h5v5" />
    </Ic>
  ),
  swapI: () => (
    <Ic>
      <path d="M8 4v16M8 4 4.5 7.5M8 4l3.5 3.5M16 20V4M16 20l-3.5-3.5M16 20l3.5-3.5" />
    </Ic>
  ),
  drop: () => (
    <Ic>
      <path d="M12 3s6.5 6.6 6.5 11.3A6.5 6.5 0 0 1 5.5 14.3C5.5 9.6 12 3 12 3Z" />
    </Ic>
  ),
  offer: () => (
    <Ic>
      <path d="M4 7h16M4 12h10M4 17h7" />
    </Ic>
  ),
  info: ({ warn }: { warn?: boolean } = {}) => (
    <Ic style={warn ? { color: 'var(--down)' } : undefined}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </Ic>
  ),
};

export function Icon({ name }: { name: IconName }) {
  const C = I[name] as () => JSX.Element;
  return <C />;
}

/**
 * Velum mark "Curtain": a V whose lower half dissolves into horizontal scan lines, in the brand
 * gradient (not currentColor). Drawn on the 64-unit grid of the brand source; the viewBox is cropped
 * to the V (6..58) so it fills the 22 px box (.brand svg) the way the previous mark did. It renders
 * more than once per page (nav, footer), so its gradient, pattern and mask ids are unique per
 * instance (useId, reduced to characters that are safe inside url(#…)). The favicon (app/icon.svg)
 * is a cut with fewer, pixel-aligned lines for 16 px.
 */
export function Mark() {
  const uid = 'vm' + useId().replace(/[^A-Za-z0-9_-]/g, '');
  const veil = `${uid}-veil`;
  const scan = `${uid}-scan`;
  const mask = `${uid}-mask`;
  return (
    <svg viewBox="6 6 52 52" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={veil} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#C2B8FF" />
          <stop offset=".55" stopColor="#8F96FF" />
          <stop offset="1" stopColor="#6E79F3" />
        </linearGradient>
        <pattern id={scan} width="64" height="4" patternUnits="userSpaceOnUse">
          <rect width="64" height="2" fill="#fff" />
        </pattern>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect x="0" y="0" width="64" height="35" fill="#fff" />
          <rect x="0" y="35" width="64" height="29" fill={`url(#${scan})`} />
        </mask>
      </defs>
      <path d="M12 12 L32 52 L52 12" fill="none" stroke={`url(#${veil})`} strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" mask={`url(#${mask})`} />
    </svg>
  );
}
