-- H3: Prevent direct client execution of trigger-only functions.
-- PostgreSQL triggers continue invoking these functions normally.

REVOKE EXECUTE ON FUNCTION public.handle_new_user()
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.prevent_role_escalation()
  FROM PUBLIC, anon, authenticated;
