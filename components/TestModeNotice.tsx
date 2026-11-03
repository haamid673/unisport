import React from 'react';
import { TEST_MODE_HEADLINE, TEST_MODE_STEPS } from '../services/demoPayments';

/**
 * Tells the visitor, wherever payment is offered, that this is a demo in
 * Razorpay test mode and how to pay. Rendered only when payments are
 * enabled (a test key id is configured), so it never appears on a build
 * without payment.
 */
const TestModeNotice: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  return (
    <div role="note" className="p-3 border border-amber-300 bg-amber-50 rounded-lg">
      <p className="text-[10px] font-black uppercase tracking-wide text-amber-900">{TEST_MODE_HEADLINE}</p>
      {!compact && <p className="mt-1 text-xs text-amber-900">{TEST_MODE_STEPS}</p>}
    </div>
  );
};

export default TestModeNotice;
