# Booking lifecycle

A booking is created, held, and then either paid, cancelled or expired. Every
transition is decided by the database; the UI shows the result.

## States

```
              create_booking()                 payment (optional, simulator in the demo)
 (nothing) ───────────────────► pending_payment ───────────────────────► confirmed ─► completed
                                   │      │
                  cancel_booking() │      │ hold runs out (10 min)
                                   ▼      ▼
                               cancelled  expired
```

`pending_payment` is a **10-minute unpaid hold**. The slot is taken for that
time (the exclusion constraint guarantees nobody else can hold it). The
hold's end is by the database clock: a hold whose time has passed counts as
expired even before the per-minute sweeper updates the row, and the UI shows
it that way too.

## Rules

| Rule | Where |
|---|---|
| Amount, status and expiry come from the database; the client sends only facility, slot and date | `create_booking(facility, slot, date)` |
| The facility must be `active`, the slot active, the date open (weekday hours) and within today … 30 days | same |
| At most 3 live holds per user; a person holding a live waitlist offer for this exact slot is exempt | UB001 |
| A slot held for someone else's waitlist offer cannot be booked by others | `create_booking` refuses with a "held for another player" message |
| A holder of a live offer who books converts the offer into `accepted` | `create_booking` |
| Cancel only your **own unpaid** hold that is still running; paid or finished bookings are refused (a refund decision does not exist yet) | `cancel_booking()` UB005 |
| A hold with a payment attempt still `creating` or `open` cannot be cancelled | UB006 |
| Cancelling frees the slot at once and offers it to the next person waiting | `cancel_booking` → `offer_next_waitlist_entry` |
| Cancelling an already cancelled or expired booking is a no-op | idempotent |

## Availability

`get_slot_availability(facility, date)` returns one status per slot:
`available`, `booked`, `offer_held`, `inactive` or `closed`, and nothing about
who booked. It is a snapshot, not a reservation: `create_booking` remains the
authority, and a lost race surfaces as "that slot was just taken". The slot
picker re-reads it about once a minute while open, and on returning to the
tab, without flashing "loading"; a failed background read keeps the last
answer.

## Waitlist

When a slot is full, a player can join its waitlist (queue order is a database
identity column). When the slot frees (cancel, expiry, a lapsed offer) the
next waiting person is **offered** it for 15 minutes; the offer is exclusive
(one live offer per slot and date) and shown on the slot row as "Accept offer"
with its deadline. Accepting creates a normal 10-minute hold linked to the
entry. An offer that lapses moves on to the next person. Decisions are made
by `process_waitlist()` every minute and immediately after a cancel, using
try-locks so workers never wait on each other.

## What players see

- **Your Schedule:** upcoming holds and confirmed bookings. A hold shows
  "Held until HH:MM", a Cancel reservation button (asks to confirm), and, when
  payments are on, Pay now / Check payment.
- **Booking history (Profile):** every booking with its truthful state
  (Confirmed, Completed, Expired, Cancelled, Awaiting payment). An expired
  hold is never shown as payable or confirmed.
- **Notifications:** an offer for you, an offer about to lapse, a hold that
  expired, a booking cancelled.

Without payments (the default, and the demo), a reservation is an unpaid hold
that expires on its own; the UI says so.
