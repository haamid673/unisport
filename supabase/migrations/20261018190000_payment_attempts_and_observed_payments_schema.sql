-- ============================================================
-- UniSport — Payment architecture, slice 1a: schema and privileges
-- ============================================================
--
-- Schema, integrity rules and privileges ONLY. This migration adds
-- no settlement, observation, refund-sending or provider logic and
-- no callable payment function. Nothing here confirms a booking.
--
-- Model (see the payment design review)
--
--   payment_attempts   one row per intended provider order. Its id
--                      is the provider receipt. Persisted BEFORE any
--                      provider call, so an unknown outcome stays
--                      recoverable.
--   payments           (existing table, repurposed) one row per
--                      OBSERVED provider payment object. Many may
--                      belong to one order and to one attempt. The
--                      columns hold what the provider reported; they
--                      are observations, not local decisions.
--   refunds            (existing table) one row per refund
--                      operation, with an explicit reservation
--                      accounting rule (see below).
--   payment_events     durable inbox keyed by provider event id.
--   reconciliation_runs durable run record and watermark.
--   bookings           gains fulfilled_by_payment_id (write-once,
--                      unique, nullable) and confirmed_at.
--
-- Four separate facts are never folded into one field:
--
--   provider capture state   payments.provider_status (observed)
--   our local decision       payments.decision_recorded_at
--   booking fulfilment       bookings.fulfilled_by_payment_id
--   refund completion        refunds.state = 'processed'
--
-- The provider documents NO capture timestamp. Nothing in this
-- schema pretends to hold one: provider_created_at is the payment's
-- creation time, captured_observed_at is OUR clock.
--
-- Decisions implemented here (approved):
--   * the physical table name payments is kept;
--   * every paise amount is BIGINT (numeric(10,2) rupees up to
--     99,999,999.99 is 9,999,999,999 paise, above int4);
--   * a zero-price booking cannot have a payment attempt;
--   * provider_order_id on an attempt is write-once;
--   * bookings.fulfilled_by_payment_id is write-once, unique and
--     nullable; legacy confirmed/completed rows need no payment;
--   * booking identity columns are immutable;
--   * refund reservations are enforced by a BEFORE trigger that
--     locks the payment row first.
--
-- Lock order (compatible with create_booking / accept_waitlist_offer
-- / expiry; see the review): user advisory -> slot/date advisory ->
-- booking row -> attempt row -> payment row -> refund-key advisory
-- -> refund row. The refunds trigger locks the payment row BEFORE
-- the idempotency-key lock and before the refund row is written,
-- and no deferred trigger takes a lock at commit time. Every path
-- that touches both a payment and its refunds locks the PAYMENT
-- first; the fulfilment guard shares that lock (FOR SHARE) and the
-- refund trigger takes it FOR UPDATE, which is what makes
-- "refund obligation vs. first fulfilment" a strict either/or.
--
-- Integrity that is enforced by the database itself (so that a bug
-- in a later settlement function cannot silently violate it):
--
--   * a payment attached to an attempt agrees with that attempt on
--     booking, provider, provider order id, amount and currency
--     (one composite foreign key; every field involved is immutable
--     or write-once, so the relationship cannot drift);
--   * the FIRST assignment of a booking's fulfilling payment is
--     exactly the pending_payment -> confirmed transition (never a
--     cancelled, expired, completed or already-confirmed booking),
--     and the payment must be matched to an attempt, captured, not
--     refunded at all (observed), carry no refund obligation row
--     (any refund that is not failed), and equal the booking amount
--     (trigger, with the payment row share-locked, READ COMMITTED
--     only);
--   * the reserved refund total of a payment never exceeds its
--     amount, and that rule is only claimed under READ COMMITTED
--     (any other isolation level is rejected, SQLSTATE UB004);
--   * refund creation is idempotent per key: a replay of a stored
--     key is a no-op / unique violation, never a cap error, and a
--     key can never be silently reused for a different request.
--
-- Responsibilities left to the Slice 1b observation / settlement
-- functions (this migration contains no such function):
--
--   * MERGE observations; never write a raw event over the stored
--     row. The guard triggers below RAISE when an update would move
--     a fact backwards (stale event after capture or refund, lower
--     refunded total, changed amount or association). That is the
--     correct last line of defence, but an unguarded
--     UPDATE ... SET <all columns from the event> or
--     INSERT ... ON CONFLICT DO UPDATE with raw event values would
--     fail (and roll back the inbox write) on every stale delivery.
--     Compute the merged row (e.g. GREATEST of the refunded total,
--     keep the stored status when the event is older) and update
--     only what advanced.
--   * Provider conflicts (an order id owned by another attempt, an
--     amount that differs from the attempt) must be recorded as an
--     UNMATCHED payment (attempt_id and booking_id NULL) plus an
--     integrity exception; the composite foreign key below rejects
--     the association itself.
--   * BINDING CONTRACT for refund creation: INSERT ... ON CONFLICT
--     (idempotency_key) DO NOTHING, then SELECT the row by key and
--     verify payment_id and amount_paise. idempotency_key is the
--     ONLY supported conflict arbiter. retry_of is NOT: a replay
--     that arrives under a new key and targets the retry_of unique
--     index is evaluated as a NEW request first (reservation cap,
--     UB003) and may fail with UB003 at full cap before the
--     retry_of conflict is considered. Derive keys deterministically
--     per request so a retry always reuses its key.
--   * Supported call pattern for refund creation: ONE payment per
--     transaction (any number of its refunds, in any order), each
--     key used for exactly one request. The trigger takes locks in
--     the order payment row -> key advisory -> refund row, so
--     transactions on the same payment simply queue and cannot
--     deadlock with each other. A multi-row INSERT, or a transaction,
--     that touches SEVERAL payments locks them in row order and can
--     deadlock with another such transaction (PostgreSQL aborts one,
--     40P01, fail-safe, retry). Sort by payment_id, or keep one
--     payment per transaction. Reusing one key for two different
--     payments is a caller error that is reported as 23505 and, in a
--     multi-payment transaction, may also deadlock.
--
-- Safety: the guard below aborts when payments or refunds contain
-- rows. Both tables are empty in every known environment because
-- nothing has ever written to them; a populated table means someone
-- wrote to it out of band and must be reviewed by a human, not
-- migrated automatically. The guard and the transition are one
-- migration transaction.
--
-- Rollback (forward-only; reverse by hand if ever required):
--   drop the new triggers and functions, drop payment_attempts,
--   payment_events, reconciliation_runs, drop bookings.
--   fulfilled_by_payment_id / confirmed_at and the added payments /
--   refunds columns, re-create payments.status, payments.amount,
--   payments.paid_at, refunds.status, refunds.amount and the
--   payments_one_per_booking / payments_provider_order_id_unique
--   indexes. Only possible while the tables hold no data.
-- ============================================================


-- ============================================================
-- 0. Guard: take the locks, then check
-- ============================================================
--
-- The migration is wrapped in an EXPLICIT transaction. The Supabase
-- CLI applies a file's statements without a transaction block (a
-- bare LOCK TABLE is refused there), and without BEGIN a failure
-- half-way would leave a partially adapted schema. With it, the
-- guard, the locks and every schema change commit or roll back as
-- one unit.

BEGIN;

-- Transaction-local (SET LOCAL): not persisted, undone at COMMIT or
-- ROLLBACK. Later statements take ACCESS EXCLUSIVE on bookings; if
-- a long transaction holds that table the migration must fail
-- (atomically, retryable) instead of queueing and stalling every
-- booking request behind its lock request.
SET LOCAL lock_timeout = '10s';

LOCK TABLE public.payments, public.refunds IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  v_payments integer;
  v_refunds integer;
  v_legacy_status integer;
  v_legacy_confirmed integer;
BEGIN

  SELECT count(*) INTO v_payments FROM public.payments;
  SELECT count(*) INTO v_refunds FROM public.refunds;

  IF v_payments > 0 OR v_refunds > 0 THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '55000',
        MESSAGE = format(
          'Cannot adapt the payment schema: public.payments has %s row(s) and public.refunds has %s row(s).',
          v_payments, v_refunds
        ),
        DETAIL = 'These tables were never written by the application. Existing rows were created out of band and are not migrated automatically.',
        HINT = 'Review the rows, export them, and decide whether they are test data to delete or real money movements to port by a dedicated migration. Then re-run this migration.';
  END IF;

  -- Diagnostics only (never an abort): legacy bookings whose
  -- payment_status says more than "pending" although no payment
  -- record exists, which is true of every such row today.
  SELECT count(*) FILTER (WHERE payment_status <> 'pending'),
         count(*) FILTER (WHERE status IN ('confirmed', 'completed'))
  INTO v_legacy_status, v_legacy_confirmed
  FROM public.bookings;

  RAISE NOTICE
    'payment schema migration: % booking(s) have payment_status <> pending and % are confirmed/completed; none has a payment record. They are legacy rows and are left unchanged; fulfilled_by_payment_id stays NULL for them.',
    v_legacy_status, v_legacy_confirmed;

END
$$;


-- ============================================================
-- 1. Enumerations
-- ============================================================

CREATE TYPE public.payment_attempt_state AS ENUM (
  'creating',  -- intent persisted; provider order not (known to be) created
  'open',      -- provider order id known; payable
  'closed'     -- we no longer expect payment; a late capture is still recorded
);

CREATE TYPE public.provider_payment_status AS ENUM (
  'created',
  'authorized',
  'captured',
  'failed',
  'refunded'
);

CREATE TYPE public.refund_state AS ENUM (
  'requested',  -- intent persisted, nothing sent
  'in_doubt',   -- claimed for sending; outcome not yet known
  'submitted',  -- provider returned a refund id, provider status pending
  'processed',  -- provider reports the refund processed
  'failed'      -- definitive failure; the row is final
);

CREATE TYPE public.payment_unmatched_disposition AS ENUM (
  'foreign',               -- operator: not our payment, no action by us
  'manual_refund_issued'   -- operator: refunded outside the application
);


-- ============================================================
-- 2. payment_attempts
-- ============================================================

CREATE TABLE public.payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  booking_id uuid NOT NULL
    REFERENCES public.bookings(id)
    ON DELETE RESTRICT,

  provider public.payment_provider NOT NULL DEFAULT 'razorpay',

  -- Copied from bookings.amount (rupees, exact) at creation and
  -- verified by the guard trigger; never taken from a client.
  amount_paise bigint NOT NULL,
  currency text NOT NULL DEFAULT 'INR',

  state public.payment_attempt_state NOT NULL DEFAULT 'creating',

  -- Write-once: NULL may become a provider order id, nothing else.
  provider_order_id text,

  -- Lease so only one worker creates the provider order.
  order_lease_until timestamptz,

  closed_reason text,
  closed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Target of the composite foreign key from payments: a payment
  -- attached to an attempt agrees with it on booking, provider,
  -- provider order id, amount and currency. All of these are
  -- immutable on the attempt except provider_order_id, which is
  -- write-once (NULL -> value); a NULL order id can never be
  -- referenced (MATCH SIMPLE skips NULLs, and a payment with an
  -- attempt must carry an order id, see payments below).
  CONSTRAINT payment_attempts_consistency_key
    UNIQUE (id, booking_id, provider, provider_order_id, amount_paise, currency),

  CONSTRAINT payment_attempts_amount_positive
    CHECK (amount_paise > 0),

  CONSTRAINT payment_attempts_currency_inr
    CHECK (currency = 'INR'),

  CONSTRAINT payment_attempts_order_id_length
    CHECK (
      provider_order_id IS NULL
      OR char_length(provider_order_id) BETWEEN 1 AND 255
    ),

  CONSTRAINT payment_attempts_open_has_order
    CHECK (state <> 'open' OR provider_order_id IS NOT NULL),

  CONSTRAINT payment_attempts_closed_has_timestamp
    CHECK (state <> 'closed' OR closed_at IS NOT NULL),

  CONSTRAINT payment_attempts_closed_reason_length
    CHECK (
      closed_reason IS NULL
      OR char_length(closed_reason) BETWEEN 1 AND 100
    )
);

CREATE UNIQUE INDEX payment_attempts_provider_order_id_key
  ON public.payment_attempts (provider_order_id)
  WHERE provider_order_id IS NOT NULL;

-- At most one live (creating or open) attempt per booking.
CREATE UNIQUE INDEX payment_attempts_one_live_per_booking
  ON public.payment_attempts (booking_id)
  WHERE state IN ('creating', 'open');

CREATE INDEX payment_attempts_booking_id_idx
  ON public.payment_attempts (booking_id);

CREATE TRIGGER payment_attempts_set_updated_at
BEFORE UPDATE ON public.payment_attempts
FOR EACH ROW
EXECUTE FUNCTION public.handle_updated_at();


-- ============================================================
-- 3. payments: one row per observed provider payment object
-- ============================================================
--
-- Dropped: status (replaced by provider_status, a separate enum
-- of PROVIDER states), amount (rupees; replaced by amount_paise),
-- paid_at (it implied a capture time the provider does not
-- document), the one-payment-per-booking index and the unique
-- provider-order index (many payment objects may share an order).
-- The partial unique provider_payment_id index is replaced by a
-- plain UNIQUE (provider, provider_payment_id) constraint: the
-- column is NOT NULL now, and a partial index cannot be the target
-- of INSERT ... ON CONFLICT (provider_payment_id) without repeating
-- its predicate. Provider payment identity is unchanged (and now
-- scoped by provider, like payment_events).

ALTER TABLE public.payments
  DROP COLUMN status,
  DROP COLUMN amount,
  DROP COLUMN paid_at;

DROP INDEX public.payments_one_per_booking;
DROP INDEX public.payments_provider_order_id_unique;
DROP INDEX public.payments_provider_payment_id_unique;

ALTER TABLE public.payments
  -- A payment whose order cannot be mapped yet has no booking.
  ALTER COLUMN booking_id DROP NOT NULL,
  ALTER COLUMN provider_payment_id SET NOT NULL,

  ADD COLUMN attempt_id uuid,

  -- What the provider reported (observations):
  ADD COLUMN provider_status public.provider_payment_status NOT NULL,
  ADD COLUMN amount_paise bigint NOT NULL,
  ADD COLUMN currency text NOT NULL DEFAULT 'INR',
  ADD COLUMN provider_created_at timestamptz,
  ADD COLUMN provider_amount_refunded_paise bigint NOT NULL DEFAULT 0,
  ADD COLUMN error_code text,
  ADD COLUMN error_description text,

  -- OUR clock, not the provider's:
  ADD COLUMN first_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN captured_observed_at timestamptz,

  -- Local decision (set exactly once, never for an unmatched payment):
  ADD COLUMN decision_recorded_at timestamptz,

  -- Unmatched-payment lifecycle:
  ADD COLUMN resolution_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN last_resolution_at timestamptz,
  ADD COLUMN unmatched_disposition public.payment_unmatched_disposition;

-- Composite-FK target: a booking may reference only a payment
-- that belongs to it.
ALTER TABLE public.payments
  ADD CONSTRAINT payments_provider_payment_id_key
    UNIQUE (provider, provider_payment_id),

  ADD CONSTRAINT payments_id_booking_id_key
    UNIQUE (id, booking_id),

  ADD CONSTRAINT payments_attempt_requires_booking
    CHECK (attempt_id IS NULL OR booking_id IS NOT NULL),

  -- An association with an attempt needs the provider order id: it
  -- is what makes the foreign key below compare orders. (A NULL
  -- would make MATCH SIMPLE skip the check.)
  ADD CONSTRAINT payments_attempt_requires_order
    CHECK (attempt_id IS NULL OR provider_order_id IS NOT NULL),

  -- The attempt a payment is attached to must agree with the
  -- payment on booking, provider, order id, amount and currency.
  -- Not checked while the payment is unmatched (attempt_id NULL);
  -- every referencing column is NOT NULL once attempt_id is set
  -- (see the two CHECK constraints above). The payment's own
  -- provider/amount/currency/order/attempt/booking are immutable or
  -- write-once (payments_guard_observation), the attempt's are
  -- immutable or write-once (payment_attempts_guard), and the
  -- foreign-key lock on the attempt row serialises the one change
  -- that can happen (NULL -> order id on the attempt) with an
  -- attaching payment, so no concurrent mutation can break it.
  ADD CONSTRAINT payments_attempt_consistency_fkey
    FOREIGN KEY (attempt_id, booking_id, provider, provider_order_id, amount_paise, currency)
    REFERENCES public.payment_attempts
      (id, booking_id, provider, provider_order_id, amount_paise, currency)
    ON DELETE RESTRICT,

  ADD CONSTRAINT payments_amount_paise_positive
    CHECK (amount_paise > 0),

  ADD CONSTRAINT payments_currency_length
    CHECK (char_length(currency) = 3),

  ADD CONSTRAINT payments_refunded_within_amount
    CHECK (
      provider_amount_refunded_paise >= 0
      AND provider_amount_refunded_paise <= amount_paise
    ),

  ADD CONSTRAINT payments_seen_order
    CHECK (last_seen_at >= first_seen_at),

  -- A decision is only ever recorded for a payment matched to an
  -- attempt, and only for a captured (or later refunded) payment.
  ADD CONSTRAINT payments_decision_requires_attempt
    CHECK (decision_recorded_at IS NULL OR attempt_id IS NOT NULL),

  ADD CONSTRAINT payments_decision_requires_capture
    CHECK (
      decision_recorded_at IS NULL
      OR provider_status IN ('captured', 'refunded')
    ),

  -- An operator disposition only makes sense while unmatched.
  ADD CONSTRAINT payments_disposition_requires_unmatched
    CHECK (unmatched_disposition IS NULL OR attempt_id IS NULL),

  ADD CONSTRAINT payments_resolution_attempts_non_negative
    CHECK (resolution_attempts >= 0),

  ADD CONSTRAINT payments_error_code_length
    CHECK (error_code IS NULL OR char_length(error_code) <= 255),

  ADD CONSTRAINT payments_error_description_length
    CHECK (error_description IS NULL OR char_length(error_description) <= 1000);

CREATE INDEX payments_provider_order_id_idx
  ON public.payments (provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE INDEX payments_attempt_id_idx
  ON public.payments (attempt_id)
  WHERE attempt_id IS NOT NULL;

-- Operational exception list: captured, unmatched, not dispositioned.
CREATE INDEX payments_unmatched_captured_idx
  ON public.payments (first_seen_at)
  WHERE attempt_id IS NULL
    AND provider_status = 'captured'
    AND unmatched_disposition IS NULL;

COMMENT ON COLUMN public.payments.provider_created_at IS
  'The provider''s created_at of the payment object. NOT a capture time: no capture timestamp is documented.';
COMMENT ON COLUMN public.payments.captured_observed_at IS
  'Our clock: when we first observed the payment as captured. Not the provider''s capture time.';
COMMENT ON COLUMN public.payments.decision_recorded_at IS
  'Our clock: when the fulfil-or-refund decision for this captured payment was durably recorded. NULL for unmatched payments. Not a payout/settlement time.';
COMMENT ON COLUMN public.payments.provider_amount_refunded_paise IS
  'Observed provider total refunded for this payment. Used to detect a refund that happened before or outside our decision.';


-- ============================================================
-- 4. refunds
-- ============================================================
--
-- Dropped: status (replaced by state with an explicit in-doubt
-- state) and amount (rupees; replaced by amount_paise).
-- Reservation rule: requested, in_doubt, submitted and processed
-- refunds reserve money; failed refunds do not. The reserved sum
-- of a payment never exceeds that payment's amount.

ALTER TABLE public.refunds
  DROP COLUMN status,
  DROP COLUMN amount;

ALTER TABLE public.refunds
  ADD COLUMN amount_paise bigint NOT NULL,
  ADD COLUMN state public.refund_state NOT NULL DEFAULT 'requested',
  ADD COLUMN idempotency_key text NOT NULL,
  ADD COLUMN reason_code text NOT NULL,
  ADD COLUMN failure_reason text,
  ADD COLUMN retry_of uuid,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN processed_observed_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.refunds
  ADD CONSTRAINT refunds_amount_paise_positive
    CHECK (amount_paise > 0),

  ADD CONSTRAINT refunds_idempotency_key_key
    UNIQUE (idempotency_key),

  -- At least 10 characters; letters, digits, hyphen, underscore.
  ADD CONSTRAINT refunds_idempotency_key_format
    CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{10,64}$'),

  ADD CONSTRAINT refunds_reason_code_format
    CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),

  ADD CONSTRAINT refunds_failure_reason_length
    CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 1000),

  ADD CONSTRAINT refunds_attempts_non_negative
    CHECK (attempts >= 0),

  -- submitted/processed mean the provider returned a refund id.
  ADD CONSTRAINT refunds_provider_id_when_submitted
    CHECK (
      state NOT IN ('submitted', 'processed')
      OR provider_refund_id IS NOT NULL
    ),

  ADD CONSTRAINT refunds_processed_observed_only_when_processed
    CHECK (processed_observed_at IS NULL OR state = 'processed'),

  -- A retry replaces a failed refund of the SAME payment, once.
  ADD CONSTRAINT refunds_id_payment_id_key
    UNIQUE (id, payment_id),

  ADD CONSTRAINT refunds_retry_of_fkey
    FOREIGN KEY (retry_of, payment_id)
    REFERENCES public.refunds (id, payment_id)
    ON DELETE RESTRICT,

  ADD CONSTRAINT refunds_retry_of_not_self
    CHECK (retry_of IS NULL OR retry_of <> id);

CREATE UNIQUE INDEX refunds_retry_of_key
  ON public.refunds (retry_of)
  WHERE retry_of IS NOT NULL;

CREATE INDEX refunds_state_idx
  ON public.refunds (state);

CREATE TRIGGER refunds_set_updated_at
BEFORE UPDATE ON public.refunds
FOR EACH ROW
EXECUTE FUNCTION public.handle_updated_at();


-- ============================================================
-- 5. bookings: fulfilment pointer and identity immutability
-- ============================================================

ALTER TABLE public.bookings
  ADD COLUMN fulfilled_by_payment_id uuid,
  ADD COLUMN confirmed_at timestamptz;

ALTER TABLE public.bookings
  -- A payment fulfils at most one booking. NULLs are not equal.
  ADD CONSTRAINT bookings_fulfilled_by_payment_id_key
    UNIQUE (fulfilled_by_payment_id),

  -- Only a payment that belongs to this very booking can fulfil it.
  -- MATCH SIMPLE: skipped while the pointer is NULL, so every
  -- legacy confirmed/completed row (which has no payment) is valid.
  ADD CONSTRAINT bookings_fulfilled_payment_fkey
    FOREIGN KEY (fulfilled_by_payment_id, id)
    REFERENCES public.payments (id, booking_id)
    ON DELETE RESTRICT,

  -- A fulfilled booking may later be completed or cancelled, so
  -- those states are allowed WITH a pointer. The FIRST assignment is
  -- restricted more tightly (pending_payment -> confirmed only) by
  -- bookings_guard_fulfilment_eligibility.
  ADD CONSTRAINT bookings_fulfilment_status_valid
    CHECK (
      fulfilled_by_payment_id IS NULL
      OR status IN ('confirmed', 'completed', 'cancelled')
    );

COMMENT ON COLUMN public.bookings.fulfilled_by_payment_id IS
  'The provider payment that fulfilled this booking. Write-once, unique, nullable. NULL for every legacy confirmed/completed booking.';
COMMENT ON COLUMN public.bookings.confirmed_at IS
  'Our clock: when the booking was confirmed by a fulfilling payment.';


-- ============================================================
-- 6. payment_events and reconciliation_runs
-- ============================================================

CREATE TABLE public.payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  provider public.payment_provider NOT NULL DEFAULT 'razorpay',

  -- The provider's event id; for polled data a deterministic
  -- synthetic id chosen by the caller.
  provider_event_id text NOT NULL,

  source text NOT NULL,
  event_type text NOT NULL,

  -- Correlation fields, so a payment or order can find its events
  -- without parsing the payload.
  provider_payment_id text,
  provider_order_id text,

  payload jsonb NOT NULL,

  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  process_result text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,

  CONSTRAINT payment_events_provider_event_id_key
    UNIQUE (provider, provider_event_id),

  CONSTRAINT payment_events_event_id_length
    CHECK (char_length(provider_event_id) BETWEEN 1 AND 255),

  CONSTRAINT payment_events_source_valid
    CHECK (source IN ('webhook', 'verify', 'reconcile')),

  CONSTRAINT payment_events_event_type_length
    CHECK (char_length(event_type) BETWEEN 1 AND 100),

  CONSTRAINT payment_events_correlation_length
    CHECK (
      (provider_payment_id IS NULL OR char_length(provider_payment_id) <= 255)
      AND (provider_order_id IS NULL OR char_length(provider_order_id) <= 255)
    ),

  CONSTRAINT payment_events_process_result_length
    CHECK (process_result IS NULL OR char_length(process_result) <= 100),

  CONSTRAINT payment_events_last_error_length
    CHECK (last_error IS NULL OR char_length(last_error) <= 2000),

  CONSTRAINT payment_events_attempts_non_negative
    CHECK (attempts >= 0)
);

CREATE INDEX payment_events_provider_payment_id_idx
  ON public.payment_events (provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE INDEX payment_events_provider_order_id_idx
  ON public.payment_events (provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE INDEX payment_events_unprocessed_idx
  ON public.payment_events (received_at)
  WHERE processed_at IS NULL;


CREATE TABLE public.reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  kind text NOT NULL,

  -- The provider-time window examined by this run. The watermark
  -- of a kind is the latest window_to of a succeeded run.
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,

  status text NOT NULL DEFAULT 'running',

  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,

  items_examined integer NOT NULL DEFAULT 0,
  items_changed integer NOT NULL DEFAULT 0,
  error text,

  CONSTRAINT reconciliation_runs_kind_valid
    CHECK (kind IN ('orders', 'payments', 'refunds')),

  CONSTRAINT reconciliation_runs_status_valid
    CHECK (status IN ('running', 'succeeded', 'failed')),

  CONSTRAINT reconciliation_runs_window_valid
    CHECK (window_from <= window_to),

  CONSTRAINT reconciliation_runs_finished_when_done
    CHECK (status = 'running' OR finished_at IS NOT NULL),

  CONSTRAINT reconciliation_runs_counts_non_negative
    CHECK (items_examined >= 0 AND items_changed >= 0),

  CONSTRAINT reconciliation_runs_error_length
    CHECK (error IS NULL OR char_length(error) <= 2000)
);

CREATE INDEX reconciliation_runs_watermark_idx
  ON public.reconciliation_runs (kind, window_to DESC)
  WHERE status = 'succeeded';


-- ============================================================
-- 7. Trigger functions
-- ============================================================
--
-- All set an empty search_path and are not executable by client
-- roles. PostgreSQL does not check EXECUTE when a trigger fires,
-- so the triggers keep working (see 20261012190000).

-- 7.1 payment_attempts: amount integrity, immutability, state order

CREATE FUNCTION public.payment_attempts_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_amount numeric(10, 2);
  v_old_rank integer;
  v_new_rank integer;
BEGIN

  IF TG_OP = 'INSERT' THEN

    SELECT b.amount
    INTO v_amount
    FROM public.bookings b
    WHERE b.id = NEW.booking_id;

    -- A missing booking is reported by the foreign key.
    IF FOUND THEN

      IF v_amount = 0 THEN
        RAISE EXCEPTION
          USING
            ERRCODE = '23514',
            MESSAGE = 'a zero-amount booking cannot have a payment attempt',
            HINT = 'Free bookings are not payable; they are handled without a payment record.';
      END IF;

      -- Exact numeric arithmetic: rupees * 100, never floating point.
      IF NEW.amount_paise <> round(v_amount * 100)::bigint THEN
        RAISE EXCEPTION
          USING
            ERRCODE = '23514',
            MESSAGE = 'payment attempt amount must equal the booking amount',
            DETAIL = format(
              'booking amount %s INR is %s paise; attempt has %s paise.',
              v_amount, round(v_amount * 100)::bigint, NEW.amount_paise
            );
      END IF;

    END IF;

    RETURN NEW;

  END IF;

  -- UPDATE
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.amount_paise IS DISTINCT FROM OLD.amount_paise
     OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = 'payment_attempts id, booking_id, provider, amount_paise and currency cannot be changed';
  END IF;

  -- Write-once: NULL may become an id; an id never changes or clears.
  IF OLD.provider_order_id IS NOT NULL
     AND NEW.provider_order_id IS DISTINCT FROM OLD.provider_order_id THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = 'payment_attempts.provider_order_id is write-once and cannot be changed or cleared',
        DETAIL = format('attempt %s already has provider order %s.', OLD.id, OLD.provider_order_id);
  END IF;

  -- creating -> open -> closed, never backwards.
  v_old_rank := CASE OLD.state WHEN 'creating' THEN 0 WHEN 'open' THEN 1 ELSE 2 END;
  v_new_rank := CASE NEW.state WHEN 'creating' THEN 0 WHEN 'open' THEN 1 ELSE 2 END;

  IF v_new_rank < v_old_rank THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = format('payment attempt state cannot move from %s back to %s', OLD.state, NEW.state);
  END IF;

  RETURN NEW;

END;
$$;

REVOKE EXECUTE ON FUNCTION public.payment_attempts_guard()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER payment_attempts_guard
BEFORE INSERT OR UPDATE ON public.payment_attempts
FOR EACH ROW
EXECUTE FUNCTION public.payment_attempts_guard();


-- 7.2 payments: provider identity is fixed, observations only grow
--
-- The ACTUAL provider-status state machine enforced here:
--
--   * captured and refunded never go back below captured, and
--     refunded never returns to captured;
--   * created, authorized and failed are NOT ordered among
--     themselves or with respect to each other (the provider
--     documents failed as non-terminal and events arrive out of
--     order), so any of them may overwrite any other, and any of
--     them may advance to captured or refunded;
--   * a partial refund keeps provider_status = captured and only
--     raises provider_amount_refunded_paise; refunded means the
--     provider reports the payment fully refunded.
--
-- captured_observed_at is OUR clock for the first capture
-- observation. It is deliberately NOT constrained against
-- provider_status: a payment first seen already refunded has no
-- capture observation, and requiring one would force the
-- observation function to invent a timestamp.
--
-- This trigger RAISES on a regression. It is a backstop, not a
-- merge: see "Responsibilities left to the Slice 1b ..." in the
-- header.

CREATE FUNCTION public.payments_guard_observation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN

  IF NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.amount_paise IS DISTINCT FROM OLD.amount_paise
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = 'a provider payment''s id, provider, amount and currency are fixed once recorded',
        DETAIL = format('payment %s (%s)', OLD.id, OLD.provider_payment_id);
  END IF;

  -- Association and provider order id: NULL may be filled once.
  IF (OLD.provider_order_id IS NOT NULL
      AND NEW.provider_order_id IS DISTINCT FROM OLD.provider_order_id)
     OR (OLD.attempt_id IS NOT NULL
         AND NEW.attempt_id IS DISTINCT FROM OLD.attempt_id)
     OR (OLD.booking_id IS NOT NULL
         AND NEW.booking_id IS DISTINCT FROM OLD.booking_id) THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = 'a provider payment''s order, attempt and booking association is write-once',
        DETAIL = format('payment %s (%s)', OLD.id, OLD.provider_payment_id);
  END IF;

  -- Observed provider status never leaves the captured/refunded
  -- side: a stale or out-of-order event cannot downgrade it.
  IF OLD.provider_status IN ('captured', 'refunded')
     AND NEW.provider_status NOT IN ('captured', 'refunded') THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = format('provider status cannot move from %s to %s', OLD.provider_status, NEW.provider_status);
  END IF;

  IF OLD.provider_status = 'refunded'
     AND NEW.provider_status <> 'refunded' THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = 'a refunded payment cannot move back to captured';
  END IF;

  IF NEW.provider_amount_refunded_paise < OLD.provider_amount_refunded_paise THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = 'the observed refunded amount of a payment cannot decrease';
  END IF;

  -- Local-decision and observation markers are write-once.
  IF (OLD.decision_recorded_at IS NOT NULL
      AND NEW.decision_recorded_at IS DISTINCT FROM OLD.decision_recorded_at)
     OR (OLD.captured_observed_at IS NOT NULL
         AND NEW.captured_observed_at IS DISTINCT FROM OLD.captured_observed_at)
     OR (OLD.provider_created_at IS NOT NULL
         AND NEW.provider_created_at IS DISTINCT FROM OLD.provider_created_at) THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = 'decision_recorded_at, captured_observed_at and provider_created_at are write-once';
  END IF;

  RETURN NEW;

END;
$$;

REVOKE EXECUTE ON FUNCTION public.payments_guard_observation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER payments_guard_observation
BEFORE UPDATE ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.payments_guard_observation();


-- 7.3 refunds: state order, reservation cap, idempotent creation
--
-- SECURITY DEFINER: the reserved total must see every refund of the
-- payment regardless of the caller's row visibility.
--
-- INSERT path, in this order:
--
--   1. Isolation. The cap is only sound under READ COMMITTED: the
--      payment-row lock serialises creators, and each statement of
--      this function then takes a FRESH snapshot that sees what the
--      previous creator committed. Under REPEATABLE READ or
--      SERIALIZABLE the aggregate would run on the transaction's
--      old snapshot (the row lock alone does not fail the waiter,
--      because a concurrent refund insert only locks the payment
--      row), so every other level is rejected with SQLSTATE UB004
--      before anything is locked or written.
--   2. Payment row, FOR UPDATE, before anything else is locked and
--      before the refund row is written. Every creator for one
--      payment queues here, so the key lock below is never
--      contended between creators of the SAME payment.
--   3. Key lock. A transaction-scoped advisory lock on the
--      idempotency key, taken AFTER the payment row. It orders
--      creators of one key that name DIFFERENT payments (their
--      payment locks differ, so nothing else would): the second
--      waits here for the first to finish, then sees the committed
--      row at step 4 and fails loudly. Taking it after the payment
--      lock keeps one global order (payment, then key) so that
--      transactions on the same payment cannot deadlock through
--      the key lock.
--   4. Existing key. BEFORE ROW triggers run BEFORE ON CONFLICT
--      arbitration, so without this step a replay of a stored
--      request (INSERT ... ON CONFLICT (idempotency_key) DO
--      NOTHING) would be charged against the cap a second time and
--      fail with UB003, or fail the payment-status check after the
--      payment moved on. When the key exists:
--        * same payment, amount and retry_of: it IS a replay. The
--          row is returned UNCHANGED to the unique index, which
--          turns a plain INSERT into 23505 and DO NOTHING into a
--          no-op. No cap or status check runs, nothing is counted
--          again, nothing is modified. (ON CONFLICT DO UPDATE would
--          run the UPDATE guard, which rejects any change to
--          payment, amount, retry_of or key.)
--        * anything else: the key is being reused for a DIFFERENT
--          request. This raises 23505 explicitly so that
--          DO NOTHING cannot report a misleading success.
--   5. Missing payment (reported by the foreign key), payment must
--      be captured/refunded, retry_of must reference a failed
--      refund, then the reservation cap (UB003).
--
-- UPDATE path: payment, amount, retry_of and key are immutable, so
-- an UPDATE can never raise a payment's reserved total (failed
-- and processed are final; the only change of reservation is
-- non-failed -> failed, which releases) and no two payment rows
-- are ever locked by one UPDATE.
--
-- Reservations: requested, in_doubt, submitted, processed.
-- failed does not reserve.

CREATE FUNCTION public.refunds_guard_state_and_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment_amount bigint;
  v_payment_status public.provider_payment_status;
  v_payment_found boolean;
  v_reserved bigint;
  v_old_rank integer;
  v_new_rank integer;
  v_retry_state public.refund_state;
  v_existing_payment_id uuid;
  v_existing_amount bigint;
  v_existing_retry_of uuid;
  v_existing_found boolean;
BEGIN

  IF TG_OP = 'UPDATE' THEN

    IF NEW.payment_id IS DISTINCT FROM OLD.payment_id
       OR NEW.amount_paise IS DISTINCT FROM OLD.amount_paise
       OR NEW.retry_of IS DISTINCT FROM OLD.retry_of
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
      RAISE EXCEPTION
        USING
          ERRCODE = '23514',
          MESSAGE = 'a refund''s payment, amount, retry_of and idempotency key are fixed once created';
    END IF;

    IF OLD.provider_refund_id IS NOT NULL
       AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id THEN
      RAISE EXCEPTION
        USING
          ERRCODE = '23514',
          MESSAGE = 'refunds.provider_refund_id is write-once';
    END IF;

    -- failed and processed are final; otherwise only forward.
    IF NEW.state IS DISTINCT FROM OLD.state THEN

      IF OLD.state IN ('failed', 'processed') THEN
        RAISE EXCEPTION
          USING
            ERRCODE = '23514',
            MESSAGE = format('a %s refund is final and cannot become %s', OLD.state, NEW.state),
            HINT = 'A failed refund is replaced by a NEW row with retry_of set, never revived.';
      END IF;

      v_old_rank := CASE OLD.state
        WHEN 'requested' THEN 0 WHEN 'in_doubt' THEN 1 ELSE 2 END;
      v_new_rank := CASE NEW.state
        WHEN 'requested' THEN 0 WHEN 'in_doubt' THEN 1 WHEN 'submitted' THEN 2 ELSE 3 END;

      IF NEW.state <> 'failed' AND v_new_rank < v_old_rank THEN
        RAISE EXCEPTION
          USING
            ERRCODE = '23514',
            MESSAGE = format('refund state cannot move from %s back to %s', OLD.state, NEW.state);
      END IF;

    END IF;

    -- Nothing that could raise the reserved total changed.
    RETURN NEW;

  END IF;

  -- INSERT, step 1: isolation level (before anything is locked)
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION
      USING
        ERRCODE = 'UB004',
        MESSAGE = format(
          'refund reservations require READ COMMITTED isolation (this transaction is %s)',
          current_setting('transaction_isolation')
        ),
        HINT = 'Create refunds in a READ COMMITTED transaction (the default). The reservation cap relies on a fresh snapshot after the payment row lock.';
  END IF;

  -- step 2: lock the payment row first
  SELECT p.amount_paise, p.provider_status
  INTO v_payment_amount, v_payment_status
  FROM public.payments p
  WHERE p.id = NEW.payment_id
  FOR UPDATE;

  v_payment_found := FOUND;

  -- step 3: one creator per idempotency key at a time (after the
  -- payment row; see the order described above)
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('refunds.idempotency_key:' || NEW.idempotency_key, 0)
  );

  -- step 4: a stored request with this key
  SELECT r.payment_id, r.amount_paise, r.retry_of
  INTO v_existing_payment_id, v_existing_amount, v_existing_retry_of
  FROM public.refunds r
  WHERE r.idempotency_key = NEW.idempotency_key;

  v_existing_found := FOUND;

  IF v_existing_found THEN

    IF v_existing_payment_id = NEW.payment_id
       AND v_existing_amount = NEW.amount_paise
       AND v_existing_retry_of IS NOT DISTINCT FROM NEW.retry_of THEN
      -- A replay. The unique index decides the outcome; the stored
      -- row is not touched and is not counted a second time.
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      USING
        ERRCODE = '23505',
        MESSAGE = 'refund idempotency key already belongs to a different refund request',
        DETAIL = format(
          'key %s is stored for payment %s, %s paise; this insert is for payment %s, %s paise.',
          NEW.idempotency_key, v_existing_payment_id, v_existing_amount,
          NEW.payment_id, NEW.amount_paise
        ),
        HINT = 'An idempotency key identifies exactly one refund request. Use a new key for a different payment or amount.';

  END IF;

  -- step 5: a missing payment is reported by the foreign key.
  IF NOT v_payment_found THEN
    RETURN NEW;
  END IF;

  IF v_payment_status NOT IN ('captured', 'refunded') THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = format('a refund can only be recorded for a captured payment (payment is %s)', v_payment_status);
  END IF;

  IF NEW.retry_of IS NOT NULL THEN
    -- failed is final (see the UPDATE path), so an unlocked read of
    -- the retried row cannot go stale.
    SELECT r.state
    INTO v_retry_state
    FROM public.refunds r
    WHERE r.id = NEW.retry_of;

    IF v_retry_state IS DISTINCT FROM 'failed' THEN
      RAISE EXCEPTION
        USING
          ERRCODE = '23514',
          MESSAGE = 'a refund can only retry a refund that definitively failed',
          DETAIL = format('refund %s is %s.', NEW.retry_of, coalesce(v_retry_state::text, 'missing'));
    END IF;
  END IF;

  IF NEW.state <> 'failed' THEN

    SELECT coalesce(sum(r.amount_paise), 0)
    INTO v_reserved
    FROM public.refunds r
    WHERE r.payment_id = NEW.payment_id
      AND r.state <> 'failed';

    IF v_reserved + NEW.amount_paise > v_payment_amount THEN
      RAISE EXCEPTION
        USING
          ERRCODE = 'UB003',
          MESSAGE = 'refund reservations would exceed the captured payment amount',
          DETAIL = format(
            'payment %s: amount %s paise, already reserved %s, requested %s.',
            NEW.payment_id, v_payment_amount, v_reserved, NEW.amount_paise
          ),
          HINT = 'An external refund larger than the remaining capacity is an integrity exception to resolve by a human; no other refund row is altered automatically.';
    END IF;

  END IF;

  RETURN NEW;

END;
$$;

REVOKE EXECUTE ON FUNCTION public.refunds_guard_state_and_reservation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER refunds_guard_state_and_reservation
BEFORE INSERT OR UPDATE ON public.refunds
FOR EACH ROW
EXECUTE FUNCTION public.refunds_guard_state_and_reservation();


-- 7.4 bookings: identity/amount immutability, fulfilment rules
--
-- amount is part of the immutable set: the column comment of
-- bookings.amount already says it is never recalculated, a payment
-- attempt copies it and a fulfilling payment must equal it. No
-- existing function or fixture updates it.

CREATE FUNCTION public.bookings_guard_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN

  RAISE EXCEPTION
    USING
      ERRCODE = '23514',
      MESSAGE = 'a booking''s user, facility, slot, date, times and amount cannot be changed after it is created',
      HINT = 'Cancel the booking and create a new one. Status, expiry and payment fields remain updatable.';

END;
$$;

REVOKE EXECUTE ON FUNCTION public.bookings_guard_identity()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER bookings_guard_identity
BEFORE UPDATE OF user_id, facility_id, slot_id, booking_date, start_time, end_time, amount
ON public.bookings
FOR EACH ROW
WHEN (
  OLD.user_id IS DISTINCT FROM NEW.user_id
  OR OLD.facility_id IS DISTINCT FROM NEW.facility_id
  OR OLD.slot_id IS DISTINCT FROM NEW.slot_id
  OR OLD.booking_date IS DISTINCT FROM NEW.booking_date
  OR OLD.start_time IS DISTINCT FROM NEW.start_time
  OR OLD.end_time IS DISTINCT FROM NEW.end_time
  OR OLD.amount IS DISTINCT FROM NEW.amount
)
EXECUTE FUNCTION public.bookings_guard_identity();


CREATE FUNCTION public.bookings_guard_fulfilment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN

  RAISE EXCEPTION
    USING
      ERRCODE = '23514',
      MESSAGE = 'bookings.fulfilled_by_payment_id is write-once and cannot be changed or cleared',
      DETAIL = format('booking %s is already fulfilled by payment %s.', OLD.id, OLD.fulfilled_by_payment_id);

END;
$$;

REVOKE EXECUTE ON FUNCTION public.bookings_guard_fulfilment()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER bookings_guard_fulfilment
BEFORE UPDATE OF fulfilled_by_payment_id
ON public.bookings
FOR EACH ROW
WHEN (
  OLD.fulfilled_by_payment_id IS NOT NULL
  AND NEW.fulfilled_by_payment_id IS DISTINCT FROM OLD.fulfilled_by_payment_id
)
EXECUTE FUNCTION public.bookings_guard_fulfilment();


-- First assignment of the fulfilment pointer.
--
-- The composite foreign key already guarantees the payment belongs
-- to THIS booking, and (through payments_attempt_consistency_fkey)
-- that a payment with an attempt agrees with it on provider, order,
-- amount and currency. What a foreign key cannot say is about the
-- payment's MUTABLE observed state, so it is checked here:
--
--   * lifecycle: the booking is moving from pending_payment to
--     confirmed in this very UPDATE. A cancelled, expired,
--     completed or already-confirmed booking (legacy rows have a
--     NULL pointer and stay valid, but are never retro-fitted with
--     one) cannot receive its first fulfilling payment;
--   * matched to an attempt (a payment linked to a booking alone,
--     or unmatched, can never fulfil);
--   * provider_status = captured;
--   * provider_amount_refunded_paise = 0 (a payment reported as
--     partly or fully refunded is never treated as ordinary fully
--     captured money);
--   * no refund obligation: no refunds row of the payment whose
--     state is anything but failed. This covers a refund that is
--     already recorded (requested / in_doubt / submitted /
--     processed) but not yet visible in
--     provider_amount_refunded_paise;
--   * amount equals the booking's amount in paise and is INR.
--
-- Locking protocol (why no refund can slip in between this check
-- and the pointer assignment):
--
--   * this trigger takes the payment row FOR SHARE and keeps it
--     until the transaction ends;
--   * the refunds trigger takes the same row FOR UPDATE BEFORE it
--     inserts a refund row (FOR UPDATE conflicts with FOR SHARE);
--   * a refund INSERT that is in flight therefore holds the row, so
--     this FOR SHARE waits for it; when that insert commits, the
--     refund-obligation query below (a fresh READ COMMITTED
--     statement snapshot) sees it and the fulfilment is refused;
--   * a refund INSERT that starts after this FOR SHARE waits until
--     this transaction commits, and is then a legitimate refund of
--     an already fulfilled booking.
--
-- A concurrent observation update of the payment (capture/refund
-- event) behaves the same: it either committed before this check
-- and is seen, or waits until this transaction ends. A refund
-- observed AFTER fulfilment is a legitimate later fact and is not
-- blocked.
--
-- The refund-obligation query reads another table, so, like the
-- refund cap, it is only sound with a fresh statement snapshot
-- after the lock: every isolation level other than READ COMMITTED
-- is rejected (UB004) before anything is read.
--
-- Lock order: callers take the booking row first (SELECT ... FOR
-- UPDATE), then this trigger takes the payment row, which matches
-- the documented booking -> attempt -> payment order.
--
-- SECURITY DEFINER: FOR SHARE needs UPDATE privilege on payments,
-- which the invoking role need not hold. A payment that does not
-- exist, or belongs to another booking, falls through so the
-- foreign key reports it (23503).

CREATE FUNCTION public.bookings_guard_fulfilment_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_booking_id uuid;
  v_attempt_id uuid;
  v_status public.provider_payment_status;
  v_refunded bigint;
  v_amount bigint;
  v_currency text;
  v_found boolean;
BEGIN

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION
      USING
        ERRCODE = 'UB004',
        MESSAGE = format(
          'fulfilling a booking requires READ COMMITTED isolation (this transaction is %s)',
          current_setting('transaction_isolation')
        ),
        HINT = 'Run the fulfilment in a READ COMMITTED transaction (the default). The refund-obligation check relies on a fresh snapshot after the payment row lock.';
  END IF;

  SELECT p.booking_id, p.attempt_id, p.provider_status,
         p.provider_amount_refunded_paise, p.amount_paise, p.currency
  INTO v_booking_id, v_attempt_id, v_status, v_refunded, v_amount, v_currency
  FROM public.payments p
  WHERE p.id = NEW.fulfilled_by_payment_id
  FOR SHARE;

  v_found := FOUND;

  IF NOT v_found OR v_booking_id IS DISTINCT FROM NEW.id THEN
    RETURN NEW;
  END IF;

  IF OLD.status IS DISTINCT FROM 'pending_payment'
     OR NEW.status IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = format(
          'a booking can only be fulfilled by moving it from pending_payment to confirmed (booking is %s, this update sets %s)',
          OLD.status, NEW.status
        ),
        DETAIL = format('booking %s, payment %s.', NEW.id, NEW.fulfilled_by_payment_id);
  END IF;

  IF v_attempt_id IS NULL THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = 'a booking can only be fulfilled by a payment matched to a payment attempt',
        DETAIL = format('payment %s has no attempt.', NEW.fulfilled_by_payment_id);
  END IF;

  IF v_status IS DISTINCT FROM 'captured' THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = format('a booking can only be fulfilled by a captured payment (payment is %s)', v_status),
        DETAIL = format('payment %s.', NEW.fulfilled_by_payment_id);
  END IF;

  IF v_refunded <> 0 THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = 'a booking cannot be fulfilled by a payment the provider reports as (partly) refunded',
        DETAIL = format('payment %s: %s paise already refunded.', NEW.fulfilled_by_payment_id, v_refunded);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.refunds r
    WHERE r.payment_id = NEW.fulfilled_by_payment_id
      AND r.state <> 'failed'
  ) THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = 'a booking cannot be fulfilled by a payment that already has a refund obligation',
        DETAIL = format('payment %s has a refund that is not failed.', NEW.fulfilled_by_payment_id),
        HINT = 'A requested, in_doubt, submitted or processed refund reserves the payment. Only a payment whose refunds all failed (or that has none) can fulfil a booking.';
  END IF;

  IF v_currency <> 'INR' OR v_amount <> round(NEW.amount * 100)::bigint THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '23514',
        MESSAGE = 'a fulfilling payment must equal the booking amount',
        DETAIL = format(
          'booking %s is %s INR; payment %s is %s %s paise.',
          NEW.id, NEW.amount, NEW.fulfilled_by_payment_id, v_amount, v_currency
        );
  END IF;

  RETURN NEW;

END;
$$;

REVOKE EXECUTE ON FUNCTION public.bookings_guard_fulfilment_eligibility()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER bookings_guard_fulfilment_eligibility
BEFORE UPDATE OF fulfilled_by_payment_id
ON public.bookings
FOR EACH ROW
WHEN (
  OLD.fulfilled_by_payment_id IS NULL
  AND NEW.fulfilled_by_payment_id IS NOT NULL
)
EXECUTE FUNCTION public.bookings_guard_fulfilment_eligibility();


-- 7.5 handle_updated_at() is a trigger function that earlier
-- hardening migrations missed: it remained executable by anon and
-- authenticated (through PUBLIC). Removing EXECUTE does not affect
-- the triggers that use it.

REVOKE EXECUTE ON FUNCTION public.handle_updated_at()
  FROM PUBLIC, anon, authenticated;


-- ============================================================
-- 8. Row Level Security and privileges
-- ============================================================
--
-- Supabase's default privileges grant anon and authenticated full
-- table privileges (including TRUNCATE) on every NEW table in
-- public (see 20261010181100). Every new table therefore gets an
-- explicit REVOKE first; only what a policy needs is granted back.
-- Existing grants on payments, refunds and bookings are unchanged
-- (SELECT only for authenticated).

ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.payment_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.payment_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.reconciliation_runs FROM PUBLIC, anon, authenticated;

-- A customer may read the attempts of their own bookings (and an
-- admin all of them). Facility owners do not see attempts.
GRANT SELECT ON TABLE public.payment_attempts TO authenticated;

CREATE POLICY "Users can view their own payment attempts"
ON public.payment_attempts
FOR SELECT
TO authenticated
USING (
  public.is_admin()
  OR EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.id = payment_attempts.booking_id
      AND b.user_id = auth.uid()
  )
);

-- payment_events and reconciliation_runs: no client policy and no
-- client privilege. Only the service role (which bypasses RLS) and
-- the table owner reach them.


-- service_role (the trusted server credential of the Edge
-- Functions) is NOT given destructive or schema-changing rights on
-- the payment tables. TRUNCATE fires no trigger, so with it the
-- reservation cap, write-once rules and state machine would all be
-- bypassable (and TRUNCATE ... CASCADE would also reach
-- bookings); DELETE would erase processed money movements;
-- TRIGGER and REFERENCES allow attaching triggers and constraints.
-- What the payment architecture genuinely needs remains:
--
--   payments, refunds, payment_attempts,
--   payment_events, reconciliation_runs     SELECT, INSERT, UPDATE
--
-- Intentional exceptions: none. payment_events is an append-and-
-- mark inbox; pruning old events, if ever required, is a reviewed
-- migration or a dedicated SECURITY DEFINER function, not a
-- standing DELETE privilege. MAINTAIN (PostgreSQL 17, VACUUM /
-- ANALYZE / LOCK TABLE) is left alone: it cannot alter data.
-- bookings keeps its existing privileges (existing functions and
-- tests rely on them; TRUNCATE of a referenced table already
-- requires CASCADE, which now fails on the payment tables).
-- The table owner is unaffected, as are the SECURITY DEFINER
-- functions.
REVOKE TRUNCATE, DELETE, TRIGGER, REFERENCES
  ON TABLE public.payments,
           public.refunds,
           public.payment_attempts,
           public.payment_events,
           public.reconciliation_runs
  FROM service_role;


-- Sequences. 20261010181100 revoked table privileges only; the
-- identity/serial sequence behind waitlist_entries.queue_position
-- stayed usable by anon and authenticated through the default
-- privileges. Clients never insert into that table (the
-- SECURITY DEFINER waitlist functions do, as the owner), so the
-- revoke changes no behaviour. The catalog test fails on any
-- public sequence a client can use.
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;


-- Payments: a customer sees every payment object of their own
-- bookings; a facility owner only the payment that fulfilled one of
-- their bookings; an admin everything, including unmatched rows.
-- An unmatched payment (booking_id NULL) matches no booking, so it
-- is invisible to customers and owners.

DROP POLICY "Users can view relevant payments" ON public.payments;

CREATE POLICY "Users can view relevant payments"
ON public.payments
FOR SELECT
TO authenticated
USING (
  public.is_admin()
  OR EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.id = payments.booking_id
      AND (
        b.user_id = auth.uid()
        OR (
          b.fulfilled_by_payment_id = payments.id
          AND public.owns_facility(b.facility_id)
        )
      )
  )
);

DROP POLICY "Users can view relevant refunds" ON public.refunds;

CREATE POLICY "Users can view relevant refunds"
ON public.refunds
FOR SELECT
TO authenticated
USING (
  public.is_admin()
  OR EXISTS (
    SELECT 1
    FROM public.payments p
    JOIN public.bookings b
      ON b.id = p.booking_id
    WHERE p.id = refunds.payment_id
      AND (
        b.user_id = auth.uid()
        OR (
          b.fulfilled_by_payment_id = p.id
          AND public.owns_facility(b.facility_id)
        )
      )
  )
);

COMMIT;
