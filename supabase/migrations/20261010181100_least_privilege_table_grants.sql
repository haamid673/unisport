-- ============================================================
-- UniSport — Migration 020: Least-privilege table grants
-- ============================================================


-- ============================================================
-- Problem
--
-- Supabase's default privileges gave anon and authenticated
-- full table privileges on every table created in public
-- (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES,
-- TRIGGER and, on PostgreSQL 17, MAINTAIN). Row Level Security
-- limits which ROWS a role can read or write, but it is the
-- only thing standing between a client and the table:
--
--   * TRUNCATE is not subject to RLS at all. Any authenticated
--     user holding the TRUNCATE privilege could empty bookings,
--     payments, refunds or facilities in one request.
--   * TRIGGER and REFERENCES are never needed by an API client.
--   * Direct INSERT / UPDATE / DELETE on bookings, payments,
--     refunds and waitlist_entries is not an intended workflow.
--     Those tables are written only by the SECURITY DEFINER
--     RPCs and the maintenance functions. Only the absence of
--     INSERT / UPDATE / DELETE policies protected them.
--   * anon holds privileges on every table although every
--     existing policy is TO authenticated.
--
-- Fix
--
-- For each existing application table, every table-level
-- privilege is revoked from PUBLIC, anon and authenticated, and
-- only what an existing policy or intended workflow needs is
-- granted back to authenticated. RLS policies are the second
-- layer, exactly as before.
--
--   table                      authenticated keeps
--   -------------------------  ---------------------------------
--   profiles                   SELECT; UPDATE (full_name, phone,
--                              city, avatar_url) only (F3)
--   facilities                 SELECT, INSERT, UPDATE, DELETE
--   facility_images            SELECT, INSERT, UPDATE, DELETE
--   facility_operating_hours   SELECT, INSERT, UPDATE, DELETE
--   facility_slots             SELECT, INSERT, UPDATE, DELETE
--   bookings                   SELECT
--   payments                   SELECT
--   refunds                    SELECT
--   waitlist_entries           SELECT
--
--   anon                       nothing on any table
--
-- Facility management keeps all four operations because the
-- existing owner/admin policies for those tables are written
-- for them; RLS still decides who may INSERT, UPDATE or DELETE
-- which row (for example only admins may delete a facility).
--
-- Unchanged on purpose
--
--   * service_role and postgres privileges.
--   * RLS policies, triggers, table definitions and data.
--   * Function definitions and EXECUTE grants. The booking and
--     waitlist RPCs are SECURITY DEFINER and run as the table
--     owner, so they do not depend on the privileges removed
--     here.
--   * Sequences, and the default privileges that apply to
--     tables created in the future (see Known limitation).
--
-- Column-level privileges on profiles
--
-- Revoking a table-level privilege also removes the matching
-- column-level grants, so the F3 grant
-- "UPDATE (full_name, phone, city, avatar_url)" is removed by
-- the REVOKE below and then granted again explicitly. The
-- final state is identical to F3. Table-level UPDATE is not
-- restored.
--
-- Known limitation
--
-- Default privileges in this database still grant broad
-- privileges on tables created in the future. A new table in
-- public needs its own explicit REVOKE/GRANT block (the
-- accompanying pgTAP test fails if a public table keeps broad
-- privileges). Changing the defaults is a separate decision.
-- ============================================================


-- ------------------------------------------------------------
-- 1. profiles
--
-- Own-row SELECT (RLS) and the four column-level UPDATE grants
-- from F3. No INSERT (rows come from the signup trigger) and no
-- DELETE (removal cascades from auth.users).
-- ------------------------------------------------------------

revoke all on table public.profiles from public, anon, authenticated;

grant select on table public.profiles to authenticated;

grant update (full_name, phone, city, avatar_url)
on table public.profiles
to authenticated;


-- ------------------------------------------------------------
-- 2. Facility management tables
--
-- Owners and admins manage these directly; RLS constrains
-- every INSERT, UPDATE and DELETE.
-- ------------------------------------------------------------

revoke all on table public.facilities from public, anon, authenticated;

grant select, insert, update, delete
on table public.facilities
to authenticated;


revoke all on table public.facility_images from public, anon, authenticated;

grant select, insert, update, delete
on table public.facility_images
to authenticated;


revoke all on table public.facility_operating_hours from public, anon, authenticated;

grant select, insert, update, delete
on table public.facility_operating_hours
to authenticated;


revoke all on table public.facility_slots from public, anon, authenticated;

grant select, insert, update, delete
on table public.facility_slots
to authenticated;


-- ------------------------------------------------------------
-- 3. Read-only for clients
--
-- Written only by SECURITY DEFINER functions (create_booking,
-- the waitlist RPCs, the maintenance jobs) and by service_role.
-- ------------------------------------------------------------

revoke all on table public.bookings from public, anon, authenticated;

grant select on table public.bookings to authenticated;


revoke all on table public.payments from public, anon, authenticated;

grant select on table public.payments to authenticated;


revoke all on table public.refunds from public, anon, authenticated;

grant select on table public.refunds to authenticated;


-- Already restricted this way by the waitlist migration;
-- restated so this migration describes the complete model.
revoke all on table public.waitlist_entries from public, anon, authenticated;

grant select on table public.waitlist_entries to authenticated;
