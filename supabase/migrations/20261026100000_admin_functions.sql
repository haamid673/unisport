-- ============================================================
-- UniSport — administrator functions
-- ============================================================
--
-- Three RPCs for the admin console. Every one starts with an
-- is_admin() check and is SECURITY DEFINER with an empty search_path.
-- EXECUTE goes to authenticated and service_role only (never PUBLIC or
-- anon); the check inside is what restricts them to administrators.
--
--   admin_set_facility_status(facility, status)
--       Approve, reject, suspend or reactivate a venue. Bookings that
--       already exist are not touched; the booking and waitlist
--       functions already refuse a venue that is not 'active'.
--
--   admin_find_user_by_email(email)
--       Exact, case-insensitive match of ONE account. There is no
--       listing, so it cannot be used to browse the user base.
--
--   admin_set_user_role(user, role)
--       Replaces the SQL procedure that disabled the role-protection
--       trigger. The profiles_prevent_role_escalation trigger stays
--       enabled and still fires: this function runs as the calling
--       administrator, so the trigger sees auth.uid() as an admin.
--       Rules:
--         * an administrator cannot change their OWN role (UB007);
--         * the last administrator can never be removed (UB008).
--       Role changes serialise on one advisory lock, so two
--       administrators demoting each other at the same moment cannot
--       both succeed and leave the platform with none.
--
-- Error codes: 28000 not signed in, 42501 not an administrator,
-- 22023 bad argument, P0002 unknown facility or user,
-- UB007 own role, UB008 last administrator.
-- ============================================================

CREATE FUNCTION public.admin_set_facility_status(
  p_facility_id uuid,
  p_status public.facility_status
)
RETURNS public.facility_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_current public.facility_status;
BEGIN

  v_user_id := (SELECT auth.uid());

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;

  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Administrator access required';
  END IF;

  IF p_facility_id IS NULL OR p_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Facility and status are required';
  END IF;

  SELECT f.status
  INTO v_current
  FROM public.facilities f
  WHERE f.id = p_facility_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Facility not found';
  END IF;

  IF v_current IS DISTINCT FROM p_status THEN
    UPDATE public.facilities f
    SET status = p_status
    WHERE f.id = p_facility_id;
  END IF;

  RETURN p_status;

END;
$$;


CREATE FUNCTION public.admin_find_user_by_email(p_email text)
RETURNS TABLE (
  user_id uuid,
  email text,
  full_name text,
  role public.user_role
)
LANGUAGE plpgsql
STABLE
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

  IF p_email IS NULL OR btrim(p_email) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Email is required';
  END IF;

  RETURN QUERY
  SELECT u.id, u.email::text, p.full_name, p.role
  FROM auth.users u
  JOIN public.profiles p ON p.id = u.id
  WHERE lower(u.email) = lower(btrim(p_email))
  LIMIT 1;

END;
$$;


CREATE FUNCTION public.admin_set_user_role(
  p_user_id uuid,
  p_role public.user_role
)
RETURNS public.user_role
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin_id uuid;
  v_current public.user_role;
BEGIN

  v_admin_id := (SELECT auth.uid());

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Authentication required';
  END IF;

  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Administrator access required';
  END IF;

  IF p_user_id IS NULL OR p_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'User and role are required';
  END IF;

  IF p_user_id = v_admin_id THEN
    RAISE EXCEPTION USING ERRCODE = 'UB007', MESSAGE = 'You cannot change your own role';
  END IF;

  -- One role change at a time, platform-wide.
  PERFORM pg_advisory_xact_lock(hashtextextended('admin-role-changes', 0));

  -- The caller may have been demoted while waiting for the lock.
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Administrator access required';
  END IF;

  SELECT p.role
  INTO v_current
  FROM public.profiles p
  WHERE p.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'User not found';
  END IF;

  IF v_current = p_role THEN
    RETURN v_current;
  END IF;

  IF v_current = 'admin' AND (
    SELECT count(*) FROM public.profiles a WHERE a.role = 'admin'
  ) <= 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'UB008', MESSAGE = 'The last administrator cannot be removed';
  END IF;

  UPDATE public.profiles p
  SET role = p_role
  WHERE p.id = p_user_id;

  RETURN p_role;

END;
$$;


REVOKE ALL ON FUNCTION public.admin_set_facility_status(uuid, public.facility_status) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_find_user_by_email(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_user_role(uuid, public.user_role) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.admin_set_facility_status(uuid, public.facility_status) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_find_user_by_email(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_user_role(uuid, public.user_role) TO authenticated, service_role;
