import React, { useState } from 'react';
import {
  TEST_CARD_NUMBER,
  TEST_MODE_HEADLINE,
  TEST_MODE_STEPS,
  testCardDigits
} from '../services/demoPayments';

/**
 * Tells the visitor, wherever payment is offered, that this is a demo in
 * Razorpay test mode and how to pay. Rendered only when payments are
 * enabled (a test key id is configured), so it never appears on a build
 * without payment.
 */
const TestModeNotice: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(testCardDigits());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the number is on screen to copy by hand.
      setCopied(false);
    }
  };

  return (
    <div role="note" className="p-3 border border-amber-300 bg-amber-50 rounded-lg">
      <p className="text-[10px] font-black uppercase tracking-wide text-amber-900">{TEST_MODE_HEADLINE}</p>
      {!compact && <p className="mt-1 text-xs text-amber-900">{TEST_MODE_STEPS}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="px-2 py-1 bg-white border border-amber-200 rounded text-xs font-bold tracking-wider text-neutral-900">
          {TEST_CARD_NUMBER}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className="px-3 py-1 border-2 border-amber-300 text-amber-900 text-[10px] font-black uppercase tracking-widest rounded-md hover:border-amber-900 transition-all"
        >
          {copied ? 'Copied' : 'Copy card'}
        </button>
      </div>
    </div>
  );
};

export default TestModeNotice;
