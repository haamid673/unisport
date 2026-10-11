-- ============================================================
-- UniSport — Migration 016: Facilities start as pending
-- ============================================================


-- ============================================================
-- Problem
--
-- A new facility is supposed to be approved by an admin before
-- it is visible to customers and bookable (status 'pending' ->
-- 'active'). The UPDATE policy already stops an owner promoting
-- their own facility, but the INSERT policy only constrained
-- owner_id and role:
--
--   with check (
--     (owner_id = auth.uid() and caller is an owner)
--     or public.is_admin()
--   )
--
-- Nothing constrained "status", so an owner could simply
-- INSERT a facility with status = 'active' (or any other
-- value) and skip moderation entirely.
--
-- Fix
--
-- The owner branch of the INSERT check now also requires
-- status = 'pending'. The column default is 'pending', and the
-- default is applied to the row before the check runs, so an
-- INSERT that omits status still succeeds and is stored as
-- 'pending'. Any explicit 'active', 'suspended' or 'rejected'
-- is refused with an RLS violation (42501).
--
-- Unchanged on purpose
--
--   * The admin branch (public.is_admin()) is untouched:
--     admins may create a facility in any status, exactly as
--     before.
--   * owner_id = auth.uid() and the owner-role requirement are
--     kept exactly as they were.
--   * The UPDATE and DELETE policies are not modified. They
--     already prevent an owner from changing status or
--     ownership, and only admins can delete.
--   * INSERT ... ON CONFLICT DO UPDATE cannot be used to get
--     around this: the proposed row must satisfy this INSERT
--     check, and the DO UPDATE branch is governed by the
--     UPDATE policy.
--
-- ALTER POLICY replaces only the WITH CHECK expression in
-- place, so the policy keeps its name and role list and there
-- is no moment without a policy.
-- ============================================================

alter policy "Owners can create their own facilities"
on public.facilities
with check (
  (
    owner_id = auth.uid()
    and status = 'pending'
    and exists (
      select 1
      from public.profiles
      where id = auth.uid()
        and role = 'owner'
    )
  )
  or public.is_admin()
);
