/** The brand mark renders twice on a page (nav, footer): every copy must reference only its own defs. */
import { Fragment, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Mark } from '@/components/icons';

describe('Mark', () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, createElement(Mark), createElement(Mark)));
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
  const refs = [...html.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]!);

  it('gives each copy its own gradient, pattern and mask ids, safe inside url(#…)', () => {
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('every url(#…) points at an id of the same copy', () => {
    expect(refs).toHaveLength(6);
    const [first, second] = html.split('</svg>');
    for (const part of [first!, second!]) {
      const own = [...part.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      for (const r of [...part.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1])) expect(own).toContain(r);
    }
  });

  it('is the Curtain V in the brand gradient, not the old circle and not currentColor', () => {
    expect(html).toContain('d="M12 12 L32 52 L52 12"');
    expect(html).toContain('stop-color="#C2B8FF"');
    expect(html).not.toContain('currentColor');
    expect(html).not.toContain('M2.4 12.6h19.2');
  });
});
