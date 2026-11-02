/**
 * What a visitor needs to know to pay in the demo. Payment runs against
 * Razorpay's TEST mode: Razorpay simulates the payment and no money is ever
 * charged. These are Razorpay's published test values, not real card data.
 */
export const TEST_CARD_NUMBER = '4111 1111 1111 1111';

export const TEST_MODE_HEADLINE = 'Demo: payments run in Razorpay test mode. No money is charged.';

export const TEST_MODE_STEPS =
  'Pay with the test card below, any future expiry date and any 3-digit CVV. If a test page asks you to choose an outcome, pick Success.';

/** The card number without spaces, as typed into a field. */
export const testCardDigits = (): string => TEST_CARD_NUMBER.replace(/\s/g, '');
