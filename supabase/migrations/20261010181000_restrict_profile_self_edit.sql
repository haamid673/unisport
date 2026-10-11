-- ============================================================
-- UniSport — Migration 019: Restrict profile self-edit
-- ============================================================


-- ============================================================
-- Problem
--
-- public.profiles had Supabase's default broad grants: every
-- column was UPDATE-able by authenticated (and, with no matching
-- policy, nominally by anon). The UPDATE policy limits WHICH ROW
-- a user may change (auth.uid() = id) but RLS has no column
-- granularity, so a user could rewrite any column of their own
-- row. The role column was protected only by the
-- profiles_prevent_role_escalation trigger. Everything else was
-- open:
--
--   * created_at could be rewritten (audit/account-age integrity)
--   * avatar_url accepted any string: javascript: and data: URLs,
--     multi-megabyte values
--
-- Fix
--
--   1. Privilege layer. Clients may UPDATE exactly the four
--      profile fields the application edits:
--
--        full_name, phone, city, avatar_url
--
--      Everything else (id, role, created_at, updated_at, and any
--      column added later) is not updatable by anon or
--      authenticated at all. The role trigger stays as the last
--      line of defence for any role that can reach the column.
--
--      updated_at keeps working: it is set by the
--      handle_updated_at() trigger, which changes NEW directly and
--      needs no column privilege.
--
--   2. Data layer. avatar_url must be NULL or an https:// URL of
--      at most 2048 characters with no whitespace or control
--      characters. This is a FORMAT rule, not a host allow-list.
--      The CHECK also binds service_role and the table owner.
--
-- Unchanged on purpose
--
--   * SELECT privileges and the SELECT/UPDATE policies.
--   * The absence of INSERT and DELETE policies, and no INSERT or
--     DELETE grants are added.
--   * service_role, postgres and the table owner keep their
--     privileges (for example for a created_at backfill).
--   * profiles_prevent_role_escalation, handle_new_user and
--     handle_updated_at are not touched.
--
-- Behaviour changes worth knowing
--
--   * A client statement that merely NAMES a protected column in
--     SET (even "role = role") now fails with 42501 permission
--     denied instead of being accepted. Clients must send only the
--     columns they intend to change.
--   * A role change attempted by a client is now refused at the
--     privilege layer (42501) before the trigger is reached.
--   * Any column added to profiles later is NOT client-updatable
--     until a migration grants UPDATE on it explicitly.
--
-- Existing data
--
-- The CHECK is added NOT VALID and then validated. If any existing
-- profile has a non-conforming avatar_url, VALIDATE fails and the
-- migration aborts (nothing is changed), which is deliberate: such
-- rows must be corrected by a person, for example
--
--   update public.profiles set avatar_url = null
--   where avatar_url is not null
--     and (avatar_url !~* '^https://'
--          or char_length(avatar_url) > 2048
--          or avatar_url ~ '[[:space:][:cntrl:]]');
-- ============================================================


-- ------------------------------------------------------------
-- 1. Privileges
--
-- Revoking the table-level privilege also removes any
-- column-level UPDATE grants, so the order matters: revoke
-- first, then grant the four columns.
-- ------------------------------------------------------------

revoke update on public.profiles from anon, authenticated;

grant update (full_name, phone, city, avatar_url)
on public.profiles
to authenticated;


-- ------------------------------------------------------------
-- 2. avatar_url format
-- ------------------------------------------------------------

alter table public.profiles
add constraint profiles_avatar_url_https
check (
  avatar_url is null
  or (
    char_length(avatar_url) <= 2048
    and avatar_url ~* '^https://'
    and avatar_url !~ '[[:space:][:cntrl:]]'
  )
)
not valid;

alter table public.profiles
validate constraint profiles_avatar_url_https;
