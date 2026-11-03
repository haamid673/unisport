-- ============================================================
-- UniSport — audit trail of administrator actions
-- ============================================================
--
-- Records who changed what: venue status, community and event status,
-- and account roles. Triggers on the source tables do the recording, so
-- every path is covered (the admin_* functions, or an administrator
-- writing a venue through its RLS policy) and those functions stay
-- unchanged.
--
-- A row is written only when the change was made by a signed-in
-- administrator. Automated changes have no auth.uid() and are not admin
-- actions, so they are not recorded here. The first-administrator
-- bootstrap deletes and re-inserts a profile, which is not a role UPDATE,
-- and is not recorded either.
--
-- The email and the target's name are copied at the time, so the history
-- stays readable after an account or a venue changes.
--
-- Access: closed to every client role. Administrators read it through
-- admin_list_actions(). No client can write, change or delete a row.
-- ============================================================

CREATE TABLE public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  admin_email text,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  target_label text,
  old_value text,
  new_value text,
  -- The real time, so two actions in one transaction keep their order.
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT admin_actions_target_type_valid
    CHECK (target_type IN ('facility', 'group', 'event', 'user'))
);

CREATE INDEX admin_actions_created_idx ON public.admin_actions (created_at DESC);

ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_actions FROM PUBLIC, anon, authenticated;


CREATE FUNCTION public.audit_admin_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin_id uuid := (SELECT auth.uid());
  v_type text;
  v_label text;
  v_old text;
  v_new text;
BEGIN

  IF v_admin_id IS NULL OR NOT (SELECT public.is_admin()) THEN
    RETURN NULL;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'facilities' THEN
      v_type := 'facility'; v_label := NEW.name;
      v_old := OLD.status::text; v_new := NEW.status::text;
    WHEN 'community_groups' THEN
      v_type := 'group'; v_label := NEW.name;
      v_old := OLD.status::text; v_new := NEW.status::text;
    WHEN 'community_events' THEN
      v_type := 'event'; v_label := NEW.title;
      v_old := OLD.status::text; v_new := NEW.status::text;
    WHEN 'profiles' THEN
      v_type := 'user';
      SELECT u.email::text INTO v_label FROM auth.users u WHERE u.id = NEW.id;
      v_old := OLD.role::text; v_new := NEW.role::text;
  END CASE;

  INSERT INTO public.admin_actions
    (admin_id, admin_email, target_type, target_id, target_label, old_value, new_value)
  SELECT v_admin_id, u.email::text, v_type, NEW.id, v_label, v_old, v_new
  FROM auth.users u
  WHERE u.id = v_admin_id;

  RETURN NULL;

END;
$$;

REVOKE ALL ON FUNCTION public.audit_admin_change() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER facilities_audit_status
AFTER UPDATE OF status ON public.facilities
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.audit_admin_change();

CREATE TRIGGER community_groups_audit_status
AFTER UPDATE OF status ON public.community_groups
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.audit_admin_change();

CREATE TRIGGER community_events_audit_status
AFTER UPDATE OF status ON public.community_events
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.audit_admin_change();

CREATE TRIGGER profiles_audit_role
AFTER UPDATE OF role ON public.profiles
FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role)
EXECUTE FUNCTION public.audit_admin_change();


CREATE FUNCTION public.admin_list_actions(p_limit integer DEFAULT 50)
RETURNS TABLE (
  id uuid,
  admin_email text,
  target_type text,
  target_label text,
  old_value text,
  new_value text,
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
  SELECT a.id, a.admin_email, a.target_type, a.target_label, a.old_value, a.new_value, a.created_at
  FROM public.admin_actions a
  ORDER BY a.created_at DESC, a.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);

END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_actions(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_actions(integer) TO authenticated, service_role;
