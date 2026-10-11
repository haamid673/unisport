-- H2: Harden SECURITY DEFINER function search paths.
-- All referenced application objects are explicitly schema-qualified.

ALTER FUNCTION public.handle_new_user()
  SET search_path = '';

ALTER FUNCTION public.prevent_role_escalation()
  SET search_path = '';

ALTER FUNCTION public.is_admin()
  SET search_path = '';

ALTER FUNCTION public.owns_facility(uuid)
  SET search_path = '';
