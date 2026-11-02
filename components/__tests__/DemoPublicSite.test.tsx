import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AboutDemo from '../AboutDemo';

const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(path(rel), 'utf8');

describe('about page', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <AboutDemo />
    </MemoryRouter>
  );

  it('says plainly this is a demo, with no real money, and to use made-up details', () => {
    expect(html).toContain('Not a real business');
    expect(html).toContain('No real money');
    expect(html).toContain('Razorpay test mode');
    expect(html).toContain('Never enter a real card');
    expect(html).toContain('made-up details');
    expect(html).toContain('reset or removed');
  });

  it('is linked from the sign-in screen and the footer, and readable signed out', () => {
    expect(read('../Auth.tsx')).toMatch(/<Link to=\{ROUTES\.about\}/);
    const app = read('../../App.tsx');
    expect(app).toMatch(/<Link to=\{ROUTES\.about\}/);
    expect(app.indexOf('return <AboutDemo />')).toBeLessThan(app.indexOf('if (!user) return <Auth'));
  });
});

describe('host configuration', () => {
  const headers = read('../../public/_headers');
  const csp = /Content-Security-Policy: (.*)/.exec(headers)?.[1] ?? '';
  const directive = (name: string) => csp.split(';').map(d => d.trim()).find(d => d.startsWith(`${name} `)) ?? '';

  it('allows scripts only from this site and Razorpay Checkout, never inline or eval', () => {
    expect(directive('script-src')).toBe("script-src 'self' https://checkout.razorpay.com");
    expect(csp).not.toContain('unsafe-eval');
  });

  it('limits connections to the Supabase project and Razorpay', () => {
    expect(directive('connect-src')).toBe("connect-src 'self' https://vnusbfswqtagrcvkbauf.supabase.co https://*.razorpay.com");
  });

  it('refuses framing and plugins', () => {
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(headers).toContain('X-Frame-Options: DENY');
  });

  it('names no third-party CDN', () => {
    expect(csp).not.toMatch(/cdnjs|jsdelivr|unpkg|googleapis|gstatic|tailwindcss|unsplash/);
  });

  it('has no 404.html or redirect rule, so Cloudflare Pages applies its SPA fallback', () => {
    expect(existsSync(path('../../public/404.html'))).toBe(false);
    expect(existsSync(path('../../public/_redirects'))).toBe(false);
  });

  it('caches only hashed assets forever', () => {
    expect(headers).toMatch(/\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/);
  });
});

describe('sign-up password rule', () => {
  it('asks for the same minimum as a reset, and the local config matches', () => {
    expect(read('../Auth.tsx')).toMatch(/password\.length < MIN_PASSWORD_LENGTH/);
    expect(read('../../supabase/config.toml')).toMatch(/^minimum_password_length = 8$/m);
  });
});
