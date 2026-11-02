-- ============================================================
-- UniSport — community groups and events
-- ============================================================
--
-- Replaces the browser-only prototype (localStorage) with database
-- tables. Product rules (docs/COMPLETION_PLAN.md, decision D4):
--
--   * Anyone signed in can create a group or an event. Created by an
--     administrator it is approved at once; otherwise it starts
--     'pending' and is invisible to everyone but its creator and the
--     administrators until an administrator approves it.
--   * Members of an APPROVED group can create events in it and join
--     them. An event needs an active venue in the group's city.
--   * Capacity is enforced by the database, safely under concurrent
--     joins.
--   * A person who leaves a group also leaves that group's events, so
--     an event participant is always a member of the group.
--
-- Access model: the four tables are closed to every client role (RLS
-- on, no policies, no grants). Everything goes through the SECURITY
-- DEFINER functions below, which check the caller themselves. That lets
-- a person see member and participant COUNTS without being able to list
-- who the members are.
--
-- Lock order (everything that touches membership):
--   group row  ->  event row  ->  membership / participation rows
-- join_event and create_event take the group row FOR SHARE and
-- leave_group takes it FOR UPDATE, so a member leaving while joining an
-- event cannot leave a participant behind.
--
-- Error codes: 28000 not signed in, 42501 not an administrator,
-- 22023 invalid argument, 22007 date in the past, P0002 not found
-- (or not visible), UC001 not a member of the group, UC002 event full,
-- UC003 not open for this (group/event not approved, or date passed),
-- UC004 too many items awaiting approval, UC005 a group with that name
-- already exists in the city.
-- ============================================================

CREATE TYPE public.approval_status AS ENUM ('pending', 'approved', 'rejected');


-- ------------------------------------------------------------
-- Tables
-- ------------------------------------------------------------

CREATE TABLE public.community_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  sport text NOT NULL,
  city text NOT NULL,
  description text,
  status public.approval_status NOT NULL DEFAULT 'pending',
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT community_groups_name_length CHECK (char_length(btrim(name)) BETWEEN 2 AND 100),
  CONSTRAINT community_groups_sport_length CHECK (char_length(btrim(sport)) BETWEEN 2 AND 50),
  CONSTRAINT community_groups_city_length CHECK (char_length(btrim(city)) BETWEEN 2 AND 100),
  CONSTRAINT community_groups_description_length
    CHECK (description IS NULL OR char_length(description) <= 2000)
);

-- One live group per name and city. A rejected group frees its name.
CREATE UNIQUE INDEX community_groups_name_city_unique
  ON public.community_groups (lower(btrim(name)), lower(btrim(city)))
  WHERE status <> 'rejected';

CREATE INDEX community_groups_status_idx ON public.community_groups (status);
CREATE INDEX community_groups_created_by_idx ON public.community_groups (created_by);

CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.community_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX group_members_user_idx ON public.group_members (user_id);

CREATE TABLE public.community_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.community_groups(id) ON DELETE CASCADE,
  title text NOT NULL,
  event_date date NOT NULL,
  event_time time NOT NULL,
  facility_id uuid NOT NULL REFERENCES public.facilities(id) ON DELETE RESTRICT,
  capacity integer,
  status public.approval_status NOT NULL DEFAULT 'pending',
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT community_events_title_length CHECK (char_length(btrim(title)) BETWEEN 2 AND 150),
  CONSTRAINT community_events_capacity_range CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 500)
);

CREATE INDEX community_events_group_idx ON public.community_events (group_id);
CREATE INDEX community_events_status_idx ON public.community_events (status);

CREATE TABLE public.event_participants (
  event_id uuid NOT NULL REFERENCES public.community_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX event_participants_user_idx ON public.event_participants (user_id);

CREATE TRIGGER community_groups_set_updated_at
BEFORE UPDATE ON public.community_groups
FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER community_events_set_updated_at
BEFORE UPDATE ON public.community_events
FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.community_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_participants ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.community_groups FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.group_members FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.community_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.event_participants FROM PUBLIC, anon, authenticated;


-- ------------------------------------------------------------
-- create_group
-- ------------------------------------------------------------

CREATE FUNCTION public.create_group(
  p_name text,
  p_sport text,
  p_city text,
  p_description text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_id uuid;
  v_status public.approval_status;
BEGIN

  v_user_id := (SELECT auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;

  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 2 AND 100
     OR p_sport IS NULL OR char_length(btrim(p_sport)) NOT BETWEEN 2 AND 50
     OR p_city IS NULL OR char_length(btrim(p_city)) NOT BETWEEN 2 AND 100
     OR (p_description IS NOT NULL AND char_length(p_description) > 2000) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Group details are not valid';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('community-actions:' || v_user_id::text, 0));

  v_status := CASE WHEN (SELECT public.is_admin()) THEN 'approved' ELSE 'pending' END;

  IF v_status = 'pending' AND (
    SELECT count(*) FROM public.community_groups g
    WHERE g.created_by = v_user_id AND g.status = 'pending'
  ) >= 5 THEN
    RAISE EXCEPTION USING ERRCODE = 'UC004',
      MESSAGE = 'Too many groups are already waiting for approval';
  END IF;

  BEGIN
    INSERT INTO public.community_groups (name, sport, city, description, status, created_by)
    VALUES (btrim(p_name), btrim(p_sport), btrim(p_city), NULLIF(btrim(p_description), ''), v_status, v_user_id)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'UC005',
      MESSAGE = 'A group with that name already exists in this city';
  END;

  INSERT INTO public.group_members (group_id, user_id) VALUES (v_id, v_user_id);

  RETURN v_id;

END;
$$;


-- ------------------------------------------------------------
-- join_group / leave_group
-- ------------------------------------------------------------

CREATE FUNCTION public.join_group(p_group_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_rows integer;
BEGIN

  v_user_id := (SELECT auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;

  IF p_group_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Group is required';
  END IF;

  -- Only an approved group can be joined; anything else looks absent.
  PERFORM 1
  FROM public.community_groups g
  WHERE g.id = p_group_id AND g.status = 'approved'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Group not found';
  END IF;

  INSERT INTO public.group_members (group_id, user_id)
  VALUES (p_group_id, v_user_id)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;

END;
$$;


CREATE FUNCTION public.leave_group(p_group_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_rows integer;
BEGIN

  v_user_id := (SELECT auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;

  IF p_group_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Group is required';
  END IF;

  -- Exclusive on the group so a concurrent join_event finishes first.
  PERFORM 1 FROM public.community_groups g WHERE g.id = p_group_id FOR UPDATE;

  DELETE FROM public.event_participants ep
  USING public.community_events e
  WHERE ep.event_id = e.id
    AND e.group_id = p_group_id
    AND ep.user_id = v_user_id;

  DELETE FROM public.group_members m
  WHERE m.group_id = p_group_id AND m.user_id = v_user_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;

END;
$$;


-- ------------------------------------------------------------
-- create_event
-- ------------------------------------------------------------

CREATE FUNCTION public.create_event(
  p_group_id uuid,
  p_title text,
  p_event_date date,
  p_event_time time,
  p_facility_id uuid,
  p_capacity integer DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_group public.community_groups%ROWTYPE;
  v_status public.approval_status;
  v_id uuid;
BEGIN

  v_user_id := (SELECT auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;

  IF p_group_id IS NULL OR p_event_time IS NULL OR p_facility_id IS NULL
     OR p_title IS NULL OR char_length(btrim(p_title)) NOT BETWEEN 2 AND 150
     OR (p_capacity IS NOT NULL AND p_capacity NOT BETWEEN 1 AND 500) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Event details are not valid';
  END IF;

  IF p_event_date IS NULL OR p_event_date < current_date THEN
    RAISE EXCEPTION USING ERRCODE = '22007', MESSAGE = 'The event date has already passed';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('community-actions:' || v_user_id::text, 0));

  SELECT g.* INTO v_group
  FROM public.community_groups g
  WHERE g.id = p_group_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Group not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.group_members m
    WHERE m.group_id = p_group_id AND m.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'UC001', MESSAGE = 'Join the group before creating an event in it';
  END IF;

  IF v_group.status <> 'approved' THEN
    RAISE EXCEPTION USING ERRCODE = 'UC003', MESSAGE = 'The group is not approved yet';
  END IF;

  -- The venue must be live and in the group's city.
  IF NOT EXISTS (
    SELECT 1 FROM public.facilities f
    WHERE f.id = p_facility_id
      AND f.status = 'active'
      AND lower(btrim(f.city)) = lower(btrim(v_group.city))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'The venue must be an active venue in the group''s city';
  END IF;

  v_status := CASE WHEN (SELECT public.is_admin()) THEN 'approved' ELSE 'pending' END;

  IF v_status = 'pending' AND (
    SELECT count(*) FROM public.community_events e
    WHERE e.created_by = v_user_id AND e.status = 'pending'
  ) >= 5 THEN
    RAISE EXCEPTION USING ERRCODE = 'UC004',
      MESSAGE = 'Too many events are already waiting for approval';
  END IF;

  INSERT INTO public.community_events
    (group_id, title, event_date, event_time, facility_id, capacity, status, created_by)
  VALUES
    (p_group_id, btrim(p_title), p_event_date, p_event_time, p_facility_id, p_capacity, v_status, v_user_id)
  RETURNING id INTO v_id;

  INSERT INTO public.event_participants (event_id, user_id) VALUES (v_id, v_user_id);

  RETURN v_id;

END;
$$;


-- ------------------------------------------------------------
-- join_event / leave_event
-- ------------------------------------------------------------

CREATE FUNCTION public.join_event(p_event_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_group_id uuid;
  v_event public.community_events%ROWTYPE;
  v_group_status public.approval_status;
BEGIN

  v_user_id := (SELECT auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;

  IF p_event_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Event is required';
  END IF;

  SELECT e.group_id INTO v_group_id FROM public.community_events e WHERE e.id = p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Event not found';
  END IF;

  -- group (shared) -> event (exclusive): the documented order.
  SELECT g.status INTO v_group_status
  FROM public.community_groups g
  WHERE g.id = v_group_id
  FOR SHARE;

  SELECT e.* INTO v_event
  FROM public.community_events e
  WHERE e.id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Event not found';
  END IF;

  IF v_event.status <> 'approved' OR v_group_status <> 'approved' THEN
    -- An unapproved event looks absent to everyone but its creator,
    -- who is told it is not open yet.
    IF v_event.created_by <> v_user_id THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Event not found';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'UC003', MESSAGE = 'This event is not open for joining';
  END IF;

  IF v_event.event_date < current_date THEN
    RAISE EXCEPTION USING ERRCODE = 'UC003', MESSAGE = 'This event is not open for joining';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.group_members m
    WHERE m.group_id = v_group_id AND m.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'UC001', MESSAGE = 'Join the community before joining this event';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.event_participants p
    WHERE p.event_id = p_event_id AND p.user_id = v_user_id
  ) THEN
    RETURN false;
  END IF;

  IF v_event.capacity IS NOT NULL AND (
    SELECT count(*) FROM public.event_participants p WHERE p.event_id = p_event_id
  ) >= v_event.capacity THEN
    RAISE EXCEPTION USING ERRCODE = 'UC002', MESSAGE = 'This event is full';
  END IF;

  INSERT INTO public.event_participants (event_id, user_id) VALUES (p_event_id, v_user_id);

  RETURN true;

END;
$$;


CREATE FUNCTION public.leave_event(p_event_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_rows integer;
BEGIN

  v_user_id := (SELECT auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;

  IF p_event_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Event is required';
  END IF;

  DELETE FROM public.event_participants p
  WHERE p.event_id = p_event_id AND p.user_id = v_user_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;

END;
$$;


-- ------------------------------------------------------------
-- Reads
--
-- A group is visible when it is approved or the caller created it. An
-- event is visible when it and its group are approved, or the caller
-- created it. Counts are exposed; member and participant lists are not.
-- ------------------------------------------------------------

CREATE FUNCTION public.get_community_groups()
RETURNS TABLE (
  id uuid,
  name text,
  sport text,
  city text,
  description text,
  status public.approval_status,
  created_by uuid,
  member_count integer,
  is_member boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user_id uuid := (SELECT auth.uid());
BEGIN

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;

  RETURN QUERY
  SELECT
    g.id, g.name, g.sport, g.city, g.description, g.status, g.created_by,
    (SELECT count(*)::integer FROM public.group_members m WHERE m.group_id = g.id),
    EXISTS (SELECT 1 FROM public.group_members m WHERE m.group_id = g.id AND m.user_id = v_user_id),
    g.created_at
  FROM public.community_groups g
  WHERE g.status = 'approved' OR g.created_by = v_user_id
  ORDER BY g.created_at DESC, g.id
  LIMIT 200;

END;
$$;


CREATE FUNCTION public.get_community_events(
  p_group_id uuid DEFAULT NULL,
  p_only_mine boolean DEFAULT false
)
RETURNS TABLE (
  id uuid,
  group_id uuid,
  group_name text,
  title text,
  event_date date,
  event_time time,
  facility_id uuid,
  facility_name text,
  city text,
  capacity integer,
  status public.approval_status,
  created_by uuid,
  participant_count integer,
  is_participant boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_user_id uuid := (SELECT auth.uid());
BEGIN

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;

  RETURN QUERY
  SELECT
    e.id, e.group_id, g.name, e.title, e.event_date, e.event_time,
    e.facility_id, f.name, g.city, e.capacity, e.status, e.created_by,
    (SELECT count(*)::integer FROM public.event_participants p WHERE p.event_id = e.id),
    EXISTS (SELECT 1 FROM public.event_participants p WHERE p.event_id = e.id AND p.user_id = v_user_id),
    e.created_at
  FROM public.community_events e
  JOIN public.community_groups g ON g.id = e.group_id
  JOIN public.facilities f ON f.id = e.facility_id
  WHERE (p_group_id IS NULL OR e.group_id = p_group_id)
    AND (
      (e.status = 'approved' AND g.status = 'approved')
      OR e.created_by = v_user_id
    )
    AND (
      NOT COALESCE(p_only_mine, false)
      OR EXISTS (SELECT 1 FROM public.event_participants p WHERE p.event_id = e.id AND p.user_id = v_user_id)
    )
  ORDER BY e.event_date, e.event_time, e.id
  LIMIT 200;

END;
$$;


-- ------------------------------------------------------------
-- Administrators: review queue and decisions
-- ------------------------------------------------------------

CREATE FUNCTION public.admin_list_community_groups(p_status public.approval_status DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  name text,
  sport text,
  city text,
  description text,
  status public.approval_status,
  created_by_email text,
  member_count integer,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN

  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Administrator access required';
  END IF;

  RETURN QUERY
  SELECT
    g.id, g.name, g.sport, g.city, g.description, g.status, u.email::text,
    (SELECT count(*)::integer FROM public.group_members m WHERE m.group_id = g.id),
    g.created_at
  FROM public.community_groups g
  LEFT JOIN auth.users u ON u.id = g.created_by
  WHERE p_status IS NULL OR g.status = p_status
  ORDER BY g.created_at DESC, g.id
  LIMIT 200;

END;
$$;


CREATE FUNCTION public.admin_list_community_events(p_status public.approval_status DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  group_name text,
  group_status public.approval_status,
  title text,
  event_date date,
  event_time time,
  facility_name text,
  capacity integer,
  status public.approval_status,
  created_by_email text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN

  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Administrator access required';
  END IF;

  RETURN QUERY
  SELECT
    e.id, g.name, g.status, e.title, e.event_date, e.event_time, f.name,
    e.capacity, e.status, u.email::text, e.created_at
  FROM public.community_events e
  JOIN public.community_groups g ON g.id = e.group_id
  JOIN public.facilities f ON f.id = e.facility_id
  LEFT JOIN auth.users u ON u.id = e.created_by
  WHERE p_status IS NULL OR e.status = p_status
  ORDER BY e.created_at DESC, e.id
  LIMIT 200;

END;
$$;


CREATE FUNCTION public.admin_set_group_status(p_group_id uuid, p_status public.approval_status)
RETURNS public.approval_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN

  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Administrator access required';
  END IF;
  IF p_group_id IS NULL OR p_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Group and status are required';
  END IF;

  PERFORM 1 FROM public.community_groups g WHERE g.id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Group not found';
  END IF;

  BEGIN
    UPDATE public.community_groups g SET status = p_status
    WHERE g.id = p_group_id AND g.status IS DISTINCT FROM p_status;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'UC005',
      MESSAGE = 'A group with that name already exists in this city';
  END;

  RETURN p_status;

END;
$$;


CREATE FUNCTION public.admin_set_event_status(p_event_id uuid, p_status public.approval_status)
RETURNS public.approval_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN

  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Administrator access required';
  END IF;
  IF p_event_id IS NULL OR p_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Event and status are required';
  END IF;

  PERFORM 1 FROM public.community_events e WHERE e.id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Event not found';
  END IF;

  UPDATE public.community_events e SET status = p_status
  WHERE e.id = p_event_id AND e.status IS DISTINCT FROM p_status;

  RETURN p_status;

END;
$$;


-- ------------------------------------------------------------
-- Privileges: signed-in clients and the service role only.
-- ------------------------------------------------------------

REVOKE ALL ON FUNCTION public.create_group(text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.join_group(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leave_group(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_event(uuid, text, date, time, uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.join_event(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leave_event(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_community_groups() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_community_events(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_list_community_groups(public.approval_status) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_list_community_events(public.approval_status) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_group_status(uuid, public.approval_status) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_event_status(uuid, public.approval_status) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_group(text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.join_group(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.leave_group(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_event(uuid, text, date, time, uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.join_event(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.leave_event(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_community_groups() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_community_events(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_community_groups(public.approval_status) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_community_events(public.approval_status) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_group_status(uuid, public.approval_status) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_event_status(uuid, public.approval_status) TO authenticated, service_role;
