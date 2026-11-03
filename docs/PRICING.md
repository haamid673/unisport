# Pricing

Pricing is intentionally simple.

- Each slot has a `base_price` (`facility_slots.base_price`), set by the venue
  owner; the venue also carries a `base_price` shown as "starting at".
- `create_booking()` reads that price **from the database** under the slot's
  lock and stores it as the booking's `amount`. The client never sends an
  amount, so it cannot be tampered with. A later price change does not alter
  an existing booking.
- The currency is INR (₹) throughout; amounts are `numeric(10,2)`.
- Payment, when enabled, charges exactly the booking's stored amount; the
  Edge Function ignores any amount in a request body.

## Not implemented

There is **no dynamic or demand-based pricing**, no weekend or peak
multipliers, no discounts or coupons, and no tax or fee calculation. (An
earlier prototype of demand-based pricing was removed from the codebase.)
