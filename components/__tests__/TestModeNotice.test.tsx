import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import TestModeNotice from '../TestModeNotice';
import { TEST_CARD_NUMBER, TEST_MODE_HEADLINE, testCardDigits } from '../../services/demoPayments';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('test-mode notice', () => {
  it('says plainly that no money is charged and shows the test card', () => {
    const html = renderToStaticMarkup(<TestModeNotice />);
    expect(html).toContain('Razorpay test mode');
    expect(html).toContain('No money is charged');
    expect(html).toContain(TEST_CARD_NUMBER);
    expect(html).toContain('Copy card');
    expect(html).toContain('role="note"');
  });

  it('the compact form drops the instructions but keeps the warning and the card', () => {
    const html = renderToStaticMarkup(<TestModeNotice compact />);
    expect(html).toContain(TEST_MODE_HEADLINE);
    expect(html).not.toContain('any 3-digit CVV');
    expect(html).toContain(TEST_CARD_NUMBER);
  });

  it('copies the digits without spaces', () => {
    expect(testCardDigits()).toBe('4111111111111111');
  });

  it('is shown only when payments are enabled: in the schedule and the footer', () => {
    const dash = read('../UserDashboard.tsx');
    const app = read('../../App.tsx');
    expect(dash).toMatch(/\{PAYMENTS_AVAILABLE && \(\s*<div className="mb-4">\s*<TestModeNotice \/>/);
    expect(app).toMatch(/\{PAYMENTS_AVAILABLE && \(\s*<p[^>]*>\{TEST_MODE_HEADLINE\}/);
  });

  it('only ever shows a card number, never a key or secret', () => {
    const src = read('../../services/demoPayments.ts');
    expect(src).not.toMatch(/rzp_|secret|key_id/i);
  });
});
