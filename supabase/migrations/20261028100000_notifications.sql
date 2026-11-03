-- ============================================================
-- UniSport — in-app notifications
-- ============================================================
--
-- One row per event per person. Events (producers), all written by the
-- database itself, never by a client:
--
--   offer_issued       a waitlist entry became 'offered'
--   offer_expiring     an offer has 5 minutes or less left (cron job)
--   hold_expired       an unpaid hold expired
--   booking_cancelled  a booking was cancelled
--   facility_approved / facility_rejected / facility_suspended
--                      the owner's venue changed to that status
--   group_approved / group_rejected, event_approved / event_rejected
--                      the creator's community item was decided
--
-- Triggers on the source tables do the producing, so the existing
-- booking, waitlist and admin functions are unchanged and every path
-- that changes a status (the sweeper, an admin, a direct fix) is
-- covered. Each trigger fires once per real status change.
-- (user_id, dedupe_key) is unique, so an event can never produce two
-- notifications: single-fire events use a fixed key; repeatable ones
-- (a venue suspended again later) use a fresh key per change.
--
-- Access: the table is closed to every client role. A person reads and
-- marks only their own through get_my_notifications() and
-- mark_notifications_read().
--
-- Not in this migration: email, SMS or push (out of the MVP).
-- ============================================================

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notifications_kind_valid CHECK (kind IN (
    'offer_issued', 'offer_expiring', 'hold_expired', 'booking_cancelled',
    'facility_approved', 'facility_rejected', 'facility_suspended',
    'group_approved', 'group_rejected', 'event_approved', 'event_rejected'
  )),
  CONSTRAINT notifications_dedupe_unique UNIQUE (user_id, dedupe_key)
);

CREATE INDEX notifications_user_created_idx
  ON public.notifications (user_id, created_at DESC);

CREATE INDEX notifications_user_unread_idx
  ON public.notifications (user_id) WHERE read_at IS NULL;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notifications FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- The only writer. No client role can execute it.
-- ------------------------------------------------------------

CREATE FUNCTION public.notify_user(
  p_user_id uuid,
  p_kind text,
  p_payload jsonb,
  p_dedupe_key text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.notifications (user_id, kind, payload, dedupe_key)
  VALUES (p_user_id, p_kind, COALESCE(p_payload, '{}'::jsonb), p_dedupe_key)
  ON CONFLICT (user_id, dedupe_key) DO NOTHING;
$$;

REVOKE ALL ON FUNCTION public.notify_user(uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;


-- ------------------------------------------------------------
-- Producers (trigger functions)
-- ------------------------------------------------------------

CREATE FUNCTION public.notify_on_waitlist_offer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'offered' THEN
    PERFORM public.notify_user(
      NEW.user_id,
      'offer_issued',
      (SELECT jsonb_build_object(
          'entry_id', NEW.id,
          'facility_id', NEW.facility_id,
          'facility_name', f.name,
          'booking_date', NEW.booking_date,
          'start_time', to_char(s.start_time, 'HH24:MI'),
          'offer_expires_at', NEW.offer_expires_at)
       FROM public.facilities f
       JOIN public.facility_slots s ON s.id = NEW.slot_id
       WHERE f.id = NEW.facility_id),
      'offer_issued:' || NEW.id::text
    );
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER waitlist_entries_notify_offer
AFTER UPDATE OF status ON public.waitlist_entries
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.notify_on_waitlist_offer();


CREATE FUNCTION public.notify_on_booking_end()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_kind text;
BEGIN
  IF NEW.status = 'expired' AND OLD.status = 'pending_payment' THEN
    v_kind := 'hold_expired';
  ELSIF NEW.status = 'cancelled' THEN
    v_kind := 'booking_cancelled';
  ELSE
    RETURN NULL;
  END IF;

  PERFORM public.notify_user(
    NEW.user_id,
    v_kind,
    (SELECT jsonb_build_object(
        'booking_id', NEW.id,
        'facility_id', NEW.facility_id,
        'facility_name', f.name,
        'booking_date', NEW.booking_date,
        'start_time', to_char(NEW.start_time, 'HH24:MI'))
     FROM public.facilities f
     WHERE f.id = NEW.facility_id),
    v_kind || ':' || NEW.id::text
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER bookings_notify_end
AFTER UPDATE OF status ON public.bookings
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.notify_on_booking_end();


CREATE FUNCTION public.notify_on_facility_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_kind text;
BEGIN
  v_kind := CASE NEW.status
    WHEN 'active' THEN 'facility_approved'
    WHEN 'rejected' THEN 'facility_rejected'
    WHEN 'suspended' THEN 'facility_suspended'
    ELSE NULL
  END;

  IF v_kind IS NOT NULL THEN
    PERFORM public.notify_user(
      NEW.owner_id,
      v_kind,
      jsonb_build_object('facility_id', NEW.id, 'facility_name', NEW.name),
      v_kind || ':' || gen_random_uuid()::text
    );
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER facilities_notify_decision
AFTER UPDATE OF status ON public.facilities
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.notify_on_facility_decision();


CREATE FUNCTION public.notify_on_group_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_kind text;
BEGIN
  v_kind := CASE NEW.status
    WHEN 'approved' THEN 'group_approved'
    WHEN 'rejected' THEN 'group_rejected'
    ELSE NULL
  END;

  IF v_kind IS NOT NULL THEN
    PERFORM public.notify_user(
      NEW.created_by,
      v_kind,
      jsonb_build_object('group_id', NEW.id, 'group_name', NEW.name),
      v_kind || ':' || gen_random_uuid()::text
    );
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER community_groups_notify_decision
AFTER UPDATE OF status ON public.community_groups
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.notify_on_group_decision();


CREATE FUNCTION public.notify_on_event_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_kind text;
BEGIN
  v_kind := CASE NEW.status
    WHEN 'approved' THEN 'event_approved'
    WHEN 'rejected' THEN 'event_rejected'
    ELSE NULL
  END;

  IF v_kind IS NOT NULL THEN
    PERFORM public.notify_user(
      NEW.created_by,
      v_kind,
      jsonb_build_object('event_id', NEW.id, 'event_title', NEW.title, 'group_id', NEW.group_id),
      v_kind || ':' || gen_random_uuid()::text
    );
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER community_events_notify_decision
AFTER UPDATE OF status ON public.community_events
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.notify_on_event_decision();

REVOKE ALL ON FUNCTION public.notify_on_waitlist_offer() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.notify_on_booking_end() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.notify_on_facility_decision() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.notify_on_group_decision() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.notify_on_event_decision() FROM PUBLIC, anon, authenticated, service_role;


-- ------------------------------------------------------------
-- "Offer about to lapse": a time-based event, so a job produces it.
-- ------------------------------------------------------------

CREATE FUNCTION public.notify_expiring_offers()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows integer;
BEGIN
  WITH due AS (
    SELECT w.id, w.user_id, w.facility_id, w.booking_date, w.offer_expires_at, f.name AS facility_name, s.start_time
    FROM public.waitlist_entries w
    JOIN public.facilities f ON f.id = w.facility_id
    JOIN public.facility_slots s ON s.id = w.slot_id
    WHERE w.status = 'offered'
      AND w.offer_expires_at > now()
      AND w.offer_expires_at <= now() + interval '5 minutes'
  ), ins AS (
    INSERT INTO public.notifications (user_id, kind, payload, dedupe_key)
    SELECT d.user_id, 'offer_expiring',
           jsonb_build_object(
             'entry_id', d.id, 'facility_id', d.facility_id, 'facility_name', d.facility_name,
             'booking_date', d.booking_date, 'start_time', to_char(d.start_time, 'HH24:MI'),
             'offer_expires_at', d.offer_expires_at),
           'offer_expiring:' || d.id::text
    FROM due d
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_rows FROM ins;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_expiring_offers() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_expiring_offers() TO service_role;

-- Scheduled like process_waitlist(): only if pg_cron is usable here;
-- otherwise a warning, and nothing else is affected.
DO $$
DECLARE
  v_job_name constant text := 'notify-expiring-offers';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE WARNING 'pg_cron is not available; % was NOT scheduled. Run public.notify_expiring_offers() from another scheduler.', v_job_name;
    RETURN;
  END IF;

  IF current_setting('cron.database_name', true) IS DISTINCT FROM current_database() THEN
    RAISE WARNING 'pg_cron is not loaded for database "%"; % was NOT scheduled.', current_database(), v_job_name;
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS pg_cron;

  PERFORM cron.schedule(v_job_name, '* * * * *', 'select public.notify_expiring_offers()');
END;
$$;


-- ------------------------------------------------------------
-- Reads and marking, for the signed-in person only
-- ------------------------------------------------------------

CREATE FUNCTION public.get_my_notifications(p_limit integer DEFAULT 30)
RETURNS TABLE (
  id uuid,
  kind text,
  payload jsonb,
  read_at timestamptz,
  created_at timestamptz,
  unread_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_unread integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;

  SELECT count(*)::integer INTO v_unread
  FROM public.notifications n
  WHERE n.user_id = v_user_id AND n.read_at IS NULL;

  RETURN QUERY
  SELECT n.id, n.kind, n.payload, n.read_at, n.created_at, v_unread
  FROM public.notifications n
  WHERE n.user_id = v_user_id
  ORDER BY n.created_at DESC, n.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
END;
$$;


CREATE FUNCTION public.mark_notifications_read(p_ids uuid[] DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_rows integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;

  -- NULL marks everything of the caller's as read; ids of other people
  -- match nothing.
  UPDATE public.notifications n
  SET read_at = now()
  WHERE n.user_id = v_user_id
    AND n.read_at IS NULL
    AND (p_ids IS NULL OR n.id = ANY (p_ids));

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_notifications(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_notifications_read(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_notifications(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_notifications_read(uuid[]) TO authenticated, service_role;
