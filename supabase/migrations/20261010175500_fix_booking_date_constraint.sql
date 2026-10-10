-- ============================================================
-- UniSport — Migration 006: Remove time-dependent booking date CHECK
-- ============================================================


-- ============================================================
-- Problem
--
-- bookings_date_valid was defined as:
--
--   check (booking_date >= current_date)
--
-- A CHECK constraint must describe a property of the row
-- itself. This one depends on the wall clock, so a row that
-- was valid when inserted becomes "invalid" simply because a
-- day passes. PostgreSQL re-evaluates CHECK constraints on
-- every UPDATE of the row, so this had real consequences:
--
--   * Any UPDATE to a booking whose date has passed fails:
--     completing it, cancelling it, or expiring it.
--     That includes a pending booking for late evening that
--     expires after midnight.
--
--   * A single failing row aborts the whole statement, so
--     one such booking would block expire_pending_bookings()
--     for every other booking in the batch.
--
--   * pg_dump / restore re-checks the constraint while
--     loading historical rows and fails.
--
-- Fix
--
-- Drop the constraint. "A new booking cannot be in the past"
-- is a rule about the act of creating a booking, not about
-- stored data, and it is already enforced by
-- public.create_booking(), which is the only supported way
-- for clients to create bookings (there is no INSERT policy
-- on public.bookings).
-- ============================================================

alter table public.bookings
  drop constraint if exists bookings_date_valid;
