BEGIN;

SELECT plan(12);

-- ============================================================
-- H3: Function EXECUTE privilege model
-- ============================================================

-- 1. Trigger functions cannot be invoked directly by clients.

SELECT ok(
  NOT has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE'),
  'clients cannot directly execute handle_new_user()'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.prevent_role_escalation()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.prevent_role_escalation()', 'EXECUTE'),
  'clients cannot directly execute prevent_role_escalation()'
);

-- 2. Both triggers remain attached and enabled.

SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_trigger
    WHERE tgrelid = 'auth.users'::regclass
      AND tgname = 'on_auth_user_created'
      AND NOT tgisinternal
      AND tgenabled = 'O'
      AND tgfoid = 'public.handle_new_user()'::regprocedure
  ),
  1,
  'signup trigger remains enabled and attached to handle_new_user()'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_trigger
    WHERE tgrelid = 'public.profiles'::regclass
      AND tgname = 'profiles_prevent_role_escalation'
      AND NOT tgisinternal
      AND tgenabled = 'O'
      AND tgfoid = 'public.prevent_role_escalation()'::regprocedure
  ),
  1,
  'role-escalation trigger remains enabled and attached to prevent_role_escalation()'
);

-- 3. Authorization helper permissions remain unchanged.

SELECT ok(
  has_function_privilege('anon', 'public.is_admin()', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.is_admin()', 'EXECUTE'),
  'is_admin() retains existing client execution permissions'
);

SELECT ok(
  has_function_privilege('anon', 'public.owns_facility(uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.owns_facility(uuid)', 'EXECUTE'),
  'owns_facility(uuid) retains existing client execution permissions'
);

-- 4. Booking and waitlist RPC permissions remain unchanged.

SELECT ok(
  NOT has_function_privilege('anon', 'public.create_booking(uuid, uuid, date)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.create_booking(uuid, uuid, date)', 'EXECUTE'),
  'create_booking() remains authenticated-only for clients'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.accept_waitlist_offer(uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.accept_waitlist_offer(uuid)', 'EXECUTE'),
  'accept_waitlist_offer() remains authenticated-only for clients'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.expire_pending_bookings()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.expire_pending_bookings()', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.expire_pending_bookings()', 'EXECUTE'),
  'expire_pending_bookings() remains restricted to privileged execution'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.expire_waitlist_offers()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.expire_waitlist_offers()', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.expire_waitlist_offers()', 'EXECUTE'),
  'expire_waitlist_offers() remains restricted to privileged execution'
);

-- 5. PUBLIC must not retain an explicit EXECUTE grant on either
-- trigger-only function.

SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(p.proacl) a
    WHERE p.oid IN (
      'public.handle_new_user()'::regprocedure,
      'public.prevent_role_escalation()'::regprocedure
    )
      AND a.grantee = 0
      AND a.privilege_type = 'EXECUTE'
  ),
  0,
  'neither trigger-only function grants EXECUTE to PUBLIC'
);

-- 6. The functions remain SECURITY DEFINER and search-path hardened.

SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_proc p
    WHERE p.oid IN (
      'public.handle_new_user()'::regprocedure,
      'public.prevent_role_escalation()'::regprocedure
    )
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=""']
  ),
  2,
  'both trigger functions retain SECURITY DEFINER and an empty search_path'
);

SELECT * FROM finish();

ROLLBACK;
