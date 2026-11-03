/**
 * What a visitor needs to know to pay in the demo. Payment runs against
 * Razorpay's TEST mode: Razorpay simulates the payment and no money is ever
 * charged. Wallet was the method that completed against Razorpay's real
 * test API with this account; test cards stopped at the bank step or were
 * refused (international cards are not enabled), so no card is advertised.
 */

export const TEST_MODE_HEADLINE = 'Demo: payments run in Razorpay test mode. No money is charged.';

export const TEST_MODE_STEPS =
  'In the Razorpay window enter any valid-looking mobile number and email, choose Wallet, pick any wallet and choose Success on the test page. Test cards may be refused.';

