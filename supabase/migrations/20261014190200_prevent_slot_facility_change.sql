-- ============================================================
-- UniSport — A slot never changes facility
-- ============================================================
--
-- bookings.facility_id and waitlist_entries.facility_id are plain
-- columns. Nothing ties them to facility_slots.facility_id after the
-- row is created (create_booking and join_waitlist only check it at
-- creation time), so moving a slot to another facility left existing
-- bookings and waitlist entries pointing at the old facility and
-- stranded live waitlist offers (accept failed with "Slot does not
-- belong to the selected facility").
--
-- There is no product need to move a slot. facility_id is therefore
-- immutable after creation, for every role, including admins,
-- service_role and postgres: triggers run regardless of RLS. A
-- genuine correction needs a database owner to disable the trigger,
-- exactly like profiles_prevent_role_escalation.
--
-- The function reads nothing, so it is SECURITY INVOKER with an
-- empty search_path, and (as in 20261012190000) not executable by
-- client roles. PostgreSQL does not check EXECUTE when a trigger
-- fires, so the trigger keeps working.
--
-- Updates to every other column, and a no-op "facility_id =
-- facility_id", remain possible: the WHEN clause only matches a real
-- change.
--
-- Rollback:
--   DROP TRIGGER facility_slots_facility_id_immutable
--     ON public.facility_slots;
--   DROP FUNCTION public.prevent_slot_facility_change();
-- ============================================================

CREATE FUNCTION public.prevent_slot_facility_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION
    USING
      ERRCODE = '23514',
      MESSAGE = 'facility_slots.facility_id cannot be changed after the slot is created',
      HINT = 'Create a new slot at the other facility and deactivate this one.';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_slot_facility_change()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER facility_slots_facility_id_immutable
BEFORE UPDATE OF facility_id ON public.facility_slots
FOR EACH ROW
WHEN (OLD.facility_id IS DISTINCT FROM NEW.facility_id)
EXECUTE FUNCTION public.prevent_slot_facility_change();
