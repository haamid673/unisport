import React, { useEffect, useId, useReducer, useRef, useState } from 'react';
import { User } from '../types';
import {
  ownerFacilityRepository,
  toOwnerError,
  describeFacilityStatus,
  OwnerError,
  OwnerFacility,
  OwnerSlot,
  FacilityInput,
  SlotInput,
  FACILITY_LIMITS
} from '../services/ownerFacilityRepository';
import { effectiveStatus, UserBooking } from '../services/bookingRepository';
import { createSingleFlight } from '../services/singleFlight';
import { createActionSequence } from '../services/actionNotice';
import {
  DayState,
  HoursDraft,
  hoursReducer,
  isDirty,
  saveDay
} from '../services/operatingHoursDraft';

/**
 * Owner console. Everything here is read from, and written to, the
 * database through ownerFacilityRepository. Row Level Security is the
 * authorization authority: this component only decides what to show.
 *
 * Deliberately not offered (the database or platform does not support
 * it for owners yet): approving or changing a venue's status, deleting
 * a venue or a slot, reassigning ownership, and photo uploads (there is
 * no storage bucket).
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const inputClass =
  'w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors disabled:bg-neutral-100';
const labelClass =
  'block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1';
const primaryButton =
  'px-6 py-3 bg-neutral-900 text-white text-xs font-black uppercase tracking-widest rounded-lg hover:bg-orange-600 transition-all disabled:bg-neutral-300 disabled:text-neutral-500 disabled:cursor-not-allowed';
const secondaryButton =
  'px-4 py-2 border-2 border-neutral-300 text-neutral-700 text-[10px] font-black uppercase tracking-widest rounded-md hover:border-neutral-900 transition-all disabled:opacity-50 disabled:cursor-not-allowed';

type Notice = { type: 'success' | 'error'; text: string } | null;

const NoticeBox: React.FC<{ notice: Notice }> = ({ notice }) => (
  <div aria-live="polite">
    {notice && (
      <div
        role={notice.type === 'error' ? 'alert' : 'status'}
        className={`mb-4 p-3 border text-xs font-bold ${
          notice.type === 'error'
            ? 'bg-red-50 border-red-200 text-red-700'
            : 'bg-emerald-50 border-emerald-200 text-emerald-700'
        }`}
      >
        {notice.text}
      </div>
    )}
  </div>
);

const Field: React.FC<{
  label: string;
  error?: string;
  hint?: string;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => React.ReactNode;
}> = ({ label, error, hint, children }) => {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined
      })}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs font-bold text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-[11px] text-neutral-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
};

const RetryBox: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <div role="alert" className="p-4 bg-red-50 border border-red-200">
    <p className="text-xs font-bold text-red-700">{message}</p>
    <button onClick={onRetry} className={`${secondaryButton} mt-3`}>
      Retry
    </button>
  </div>
);

const StatusBadge: React.FC<{ status: OwnerFacility['status'] }> = ({ status }) => {
  const { label } = describeFacilityStatus(status);
  const color =
    status === 'active'
      ? 'bg-emerald-100 text-emerald-700'
      : status === 'pending'
      ? 'bg-yellow-100 text-yellow-800'
      : 'bg-red-100 text-red-700';

  return (
    <span
      className={`px-2 py-0.5 rounded-sm text-[9px] font-black uppercase tracking-wider ${color}`}
    >
      {label}
    </span>
  );
};

// -- Facility form (create and edit) -------------------------------------

const emptyInput: FacilityInput = {
  name: '',
  description: '',
  sport: '',
  address: '',
  city: '',
  capacity: '',
  basePrice: ''
};

const toInput = (f: OwnerFacility): FacilityInput => ({
  name: f.name,
  description: f.description ?? '',
  sport: f.sport,
  address: f.address,
  city: f.city,
  capacity: f.capacity === null ? '' : String(f.capacity),
  basePrice: String(f.basePrice)
});

const FacilityForm: React.FC<{
  initial: FacilityInput;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (input: FacilityInput) => Promise<void>;
  onCancel?: () => void;
}> = ({ initial, submitLabel, busyLabel, onSubmit, onCancel }) => {
  const [values, setValues] = useState<FacilityInput>(initial);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>(null);
  const guard = useRef(createSingleFlight());
  const [busy, setBusy] = useState(false);

  const set = (key: keyof FacilityInput) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => setValues(v => ({ ...v, [key]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (guard.current.busy) return;

    await guard.current.run(async () => {
      setBusy(true);
      setNotice(null);
      setFieldErrors({});

      try {
        await onSubmit(values);
      } catch (err) {
        const failure = err instanceof OwnerError ? err : toOwnerError(err);
        setFieldErrors(failure.fields);
        setNotice({ type: 'error', text: failure.message });
      } finally {
        setBusy(false);
      }
    });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <NoticeBox notice={notice} />

      <Field label="Venue name" error={fieldErrors.name}>
        {p => (
          <input {...p} className={inputClass} value={values.name} onChange={set('name')}
            maxLength={FACILITY_LIMITS.name.max} autoComplete="off" disabled={busy} />
        )}
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Sport" error={fieldErrors.sport}>
          {p => (
            <input {...p} className={inputClass} value={values.sport} onChange={set('sport')}
              maxLength={FACILITY_LIMITS.sport.max} placeholder="e.g. Padel" disabled={busy} />
          )}
        </Field>
        <Field label="City" error={fieldErrors.city}>
          {p => (
            <input {...p} className={inputClass} value={values.city} onChange={set('city')}
              maxLength={FACILITY_LIMITS.city.max} autoComplete="address-level2" disabled={busy} />
          )}
        </Field>
      </div>

      <Field label="Address" error={fieldErrors.address}>
        {p => (
          <input {...p} className={inputClass} value={values.address} onChange={set('address')}
            maxLength={FACILITY_LIMITS.address.max} autoComplete="street-address" disabled={busy} />
        )}
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field
          label="Base price (₹)"
          error={fieldErrors.basePrice}
          hint="Default price for the venue. Each slot has its own price."
        >
          {p => (
            <input {...p} className={inputClass} value={values.basePrice} onChange={set('basePrice')}
              inputMode="decimal" disabled={busy} />
          )}
        </Field>
        <Field label="Capacity (optional)" error={fieldErrors.capacity}>
          {p => (
            <input {...p} className={inputClass} value={values.capacity} onChange={set('capacity')}
              inputMode="numeric" disabled={busy} />
          )}
        </Field>
      </div>

      <Field label="Description (optional)" error={fieldErrors.description}>
        {p => (
          <textarea {...p} rows={4} className={inputClass} value={values.description}
            onChange={set('description')} maxLength={FACILITY_LIMITS.description.max} disabled={busy} />
        )}
      </Field>

      <div className="flex flex-wrap gap-3 pt-2">
        <button type="submit" disabled={busy} aria-busy={busy} className={primaryButton}>
          {busy ? busyLabel : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy} className={secondaryButton}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
};

// -- Operating hours ------------------------------------------------------

const HoursPanel: React.FC<{ facilityId: string }> = ({ facilityId }) => {
  const [load, setLoad] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready' }
  >({ phase: 'loading' });
  // Saved baseline and drafts for all seven days (see
  // services/operatingHoursDraft). A save moves only its own day's
  // baseline; it never reloads the week or touches another draft.
  const [hours, dispatch] = useReducer(hoursReducer, { days: [], savingDay: null });
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const guard = useRef(createSingleFlight());
  // A response that arrives after the owner has moved to another venue
  // must not be applied to that venue's form.
  const activeFacility = useRef(facilityId);

  useEffect(() => {
    let cancelled = false;
    activeFacility.current = facilityId;
    setLoad({ phase: 'loading' });
    setNotice(null);

    ownerFacilityRepository
      .loadOperatingHours(facilityId)
      .then(week => {
        if (cancelled) return;
        dispatch({ type: 'loaded', week });
        setLoad({ phase: 'ready' });
      })
      .catch(err => {
        if (!cancelled) setLoad({ phase: 'error', message: toOwnerError(err).message });
      });

    return () => {
      cancelled = true;
    };
  }, [facilityId, reloadKey]);

  const save = (dayOfWeek: number) =>
    saveDay({
      state: hours,
      dayOfWeek,
      guard: guard.current,
      dispatch,
      persist: (day, rowId) =>
        ownerFacilityRepository.saveOperatingDay(facilityId, day, rowId),
      describeError: err => toOwnerError(err).message,
      isActive: () => activeFacility.current === facilityId,
      onStarted: () => setNotice(null),
      onSaved: () =>
        setNotice({ type: 'success', text: `${DAYS[dayOfWeek]} hours saved.` })
    });

  if (load.phase === 'loading') {
    return <p className="text-xs font-bold uppercase text-neutral-400">Loading hours…</p>;
  }
  if (load.phase === 'error') {
    return <RetryBox message={load.message} onRetry={() => setReloadKey(k => k + 1)} />;
  }

  return (
    <div>
      <p className="text-xs text-neutral-500 mb-4">
        Players can only book slots that fall inside a day's opening hours. A day with no hours set
        cannot be booked.
      </p>
      <NoticeBox notice={notice} />
      <ul className="space-y-3">
        {hours.days.map(day => (
          <HoursRow
            key={day.saved.dayOfWeek}
            day={day}
            saving={hours.savingDay === day.saved.dayOfWeek}
            busy={hours.savingDay !== null}
            onEdit={patch =>
              dispatch({ type: 'edit', day: day.saved.dayOfWeek, patch })
            }
            onSave={() => save(day.saved.dayOfWeek)}
          />
        ))}
      </ul>
    </div>
  );
};

const HoursRow: React.FC<{
  day: DayState;
  saving: boolean;
  /** Some day's request is in flight: no second save may start. */
  busy: boolean;
  onEdit: (patch: Partial<HoursDraft>) => void;
  onSave: () => void;
}> = ({ day, saving, busy, onEdit, onSave }) => {
  const baseId = useId();
  const name = DAYS[day.saved.dayOfWeek];
  const { draft, error } = day;
  const errorId = `${baseId}-error`;
  const describedBy = error ? errorId : undefined;

  return (
    <li className="p-4 bg-neutral-50 border-2 border-neutral-100 rounded-lg">
      <div className="flex flex-wrap items-end gap-4">
        <div className="w-28">
          <p className="text-xs font-black uppercase tracking-tight text-neutral-900">{name}</p>
          <p className="text-[10px] font-bold uppercase text-neutral-400">
            {isDirty(day) ? 'Unsaved changes' : day.saved.configured ? 'Saved' : 'Not set'}
          </p>
        </div>

        <label className="flex items-center gap-2 text-xs font-bold text-neutral-600">
          <input
            type="checkbox"
            checked={draft.isClosed}
            onChange={e => onEdit({ isClosed: e.target.checked })}
            aria-describedby={describedBy}
          />
          Closed
        </label>

        <div>
          <label htmlFor={`${baseId}-open`} className={labelClass}>Opens</label>
          <input id={`${baseId}-open`} type="time" className={inputClass} value={draft.opensAt}
            onChange={e => onEdit({ opensAt: e.target.value })} disabled={draft.isClosed}
            aria-invalid={error && !draft.isClosed ? true : undefined}
            aria-describedby={describedBy} />
        </div>
        <div>
          <label htmlFor={`${baseId}-close`} className={labelClass}>Closes</label>
          <input id={`${baseId}-close`} type="time" className={inputClass} value={draft.closesAt}
            onChange={e => onEdit({ closesAt: e.target.value })} disabled={draft.isClosed}
            aria-invalid={error && !draft.isClosed ? true : undefined}
            aria-describedby={describedBy} />
        </div>

        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          aria-busy={saving}
          aria-label={`Save ${name} hours`}
          className={secondaryButton}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-2 text-[11px] font-bold text-red-600">
          {name}: {error}
        </p>
      )}
    </li>
  );
};

// -- Slots ----------------------------------------------------------------

const SlotsPanel: React.FC<{ facilityId: string }> = ({ facilityId }) => {
  const [view, setView] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; slots: OwnerSlot[] }
  >({ phase: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [form, setForm] = useState<SlotInput>({ startTime: '', endTime: '', basePrice: '' });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  const guard = useRef(createSingleFlight());

  useEffect(() => {
    let cancelled = false;
    setView(prev => (prev.phase === 'ready' ? prev : { phase: 'loading' }));

    ownerFacilityRepository
      .loadSlots(facilityId)
      .then(slots => !cancelled && setView({ phase: 'ready', slots }))
      .catch(
        err => !cancelled && setView({ phase: 'error', message: toOwnerError(err).message })
      );

    return () => {
      cancelled = true;
    };
  }, [facilityId, reloadKey]);

  const existing = view.phase === 'ready' ? view.slots : [];

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (guard.current.busy) return;

    await guard.current.run(async () => {
      setBusyTarget('add');
      setNotice(null);
      setFieldErrors({});

      try {
        await ownerFacilityRepository.createSlot(facilityId, form, existing);
        setForm({ startTime: '', endTime: '', basePrice: '' });
        setNotice({ type: 'success', text: 'Slot added.' });
      } catch (err) {
        const failure = toOwnerError(err);
        setFieldErrors(failure.fields);
        setNotice({ type: 'error', text: failure.message });
      } finally {
        setBusyTarget(null);
        setReloadKey(k => k + 1);
      }
    });
  };

  const toggle = async (slot: OwnerSlot) => {
    if (guard.current.busy) return;

    await guard.current.run(async () => {
      setBusyTarget(`toggle:${slot.id}`);
      setNotice(null);

      try {
        await ownerFacilityRepository.setSlotActive(slot.id, !slot.isActive);
        setNotice({
          type: 'success',
          text: slot.isActive ? 'Slot deactivated.' : 'Slot activated.'
        });
      } catch (err) {
        setNotice({ type: 'error', text: toOwnerError(err).message });
      } finally {
        setBusyTarget(null);
        setReloadKey(k => k + 1);
      }
    });
  };

  const busy = busyTarget !== null;

  return (
    <div className="space-y-8">
      <NoticeBox notice={notice} />

      <form onSubmit={add} noValidate className="p-4 bg-neutral-50 border-2 border-neutral-100 rounded-lg">
        <h4 className="font-black uppercase text-sm mb-4">Add a slot</h4>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Start time" error={fieldErrors.startTime}>
            {p => (
              <input {...p} type="time" className={inputClass} value={form.startTime}
                onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))} disabled={busy} />
            )}
          </Field>
          <Field label="End time" error={fieldErrors.endTime}>
            {p => (
              <input {...p} type="time" className={inputClass} value={form.endTime}
                onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))} disabled={busy} />
            )}
          </Field>
          <Field label="Price (₹)" error={fieldErrors.basePrice}>
            {p => (
              <input {...p} inputMode="decimal" className={inputClass} value={form.basePrice}
                onChange={e => setForm(f => ({ ...f, basePrice: e.target.value }))} disabled={busy} />
            )}
          </Field>
        </div>
        <button type="submit" disabled={busy} aria-busy={busyTarget === 'add'} className={`${primaryButton} mt-4`}>
          {busyTarget === 'add' ? 'Adding…' : 'Add slot'}
        </button>
      </form>

      {view.phase === 'loading' && (
        <p className="text-xs font-bold uppercase text-neutral-400">Loading slots…</p>
      )}
      {view.phase === 'error' && (
        <RetryBox message={view.message} onRetry={() => setReloadKey(k => k + 1)} />
      )}
      {view.phase === 'ready' && view.slots.length === 0 && (
        <p className="text-xs font-bold uppercase text-neutral-400">
          No slots yet. Add one above so players can book this venue.
        </p>
      )}
      {view.phase === 'ready' && view.slots.length > 0 && (
        <ul className="space-y-3">
          {view.slots.map(slot => (
            <li
              key={slot.id}
              className="flex flex-wrap items-center justify-between gap-4 p-4 bg-white border-2 border-neutral-100 rounded-lg"
            >
              <div>
                <p className="text-sm font-black text-neutral-900">{slot.timeLabel}</p>
                <p className="text-xs text-neutral-500">
                  {slot.durationMin} min · ₹{slot.basePrice}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`px-2 py-0.5 rounded-sm text-[9px] font-black uppercase tracking-wider ${
                    slot.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-neutral-200 text-neutral-600'
                  }`}
                >
                  {slot.isActive ? 'Active' : 'Inactive'}
                </span>
                <button
                  onClick={() => toggle(slot)}
                  disabled={busy}
                  aria-busy={busyTarget === `toggle:${slot.id}`}
                  className={secondaryButton}
                >
                  {busyTarget === `toggle:${slot.id}`
                    ? 'Saving…'
                    : slot.isActive
                    ? 'Deactivate'
                    : 'Activate'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-neutral-400">
        Slots with bookings or waitlist entries cannot be deleted, so they are switched off instead.
      </p>
    </div>
  );
};

// -- Bookings -------------------------------------------------------------

const BookingsPanel: React.FC<{ facilityId: string }> = ({ facilityId }) => {
  const [view, setView] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; bookings: UserBooking[] }
  >({ phase: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setView({ phase: 'loading' });

    ownerFacilityRepository
      .loadFacilityBookings(facilityId)
      .then(bookings => !cancelled && setView({ phase: 'ready', bookings }))
      .catch(
        err => !cancelled && setView({ phase: 'error', message: toOwnerError(err).message })
      );

    return () => {
      cancelled = true;
    };
  }, [facilityId, reloadKey]);

  if (view.phase === 'loading') {
    return <p className="text-xs font-bold uppercase text-neutral-400">Loading bookings…</p>;
  }
  if (view.phase === 'error') {
    return <RetryBox message={view.message} onRetry={() => setReloadKey(k => k + 1)} />;
  }
  if (view.bookings.length === 0) {
    return <p className="text-xs font-bold uppercase text-neutral-400">No bookings for this venue yet.</p>;
  }

  const label: Record<string, string> = {
    pending_payment: 'Unpaid hold',
    confirmed: 'Confirmed',
    completed: 'Completed',
    cancelled: 'Cancelled',
    expired: 'Expired'
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Bookings for this venue</caption>
        <thead className="bg-neutral-50 text-neutral-400 font-black uppercase text-[10px] tracking-widest">
          <tr>
            <th scope="col" className="px-4 py-3">Date</th>
            <th scope="col" className="px-4 py-3">Time</th>
            <th scope="col" className="px-4 py-3">Amount</th>
            <th scope="col" className="px-4 py-3">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {view.bookings.map(b => (
            <tr key={b.id}>
              <td className="px-4 py-3 font-bold">{b.bookingDate}</td>
              <td className="px-4 py-3">{b.timeLabel}</td>
              <td className="px-4 py-3">₹{b.amount}</td>
              <td className="px-4 py-3 text-xs font-black uppercase">{label[effectiveStatus(b)]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-[11px] text-neutral-400">
        Read-only. Players are not identified here.
      </p>
    </div>
  );
};

// -- Dashboard ------------------------------------------------------------

type DetailTab = 'details' | 'hours' | 'slots' | 'bookings';

interface OwnerDashboardProps {
  user: User;
}

const OwnerDashboard: React.FC<OwnerDashboardProps> = ({ user }) => {
  const isOwner = user.role === 'owner';

  const [view, setView] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; facilities: OwnerFacility[] }
  >({ phase: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<DetailTab>('details');
  const [notice, setNotice] = useState<Notice>(null);
  // Latest action wins: see services/actionNotice.
  const noticeSequence = useRef(createActionSequence());

  useEffect(() => {
    // The database enforces who is an owner. This only avoids useless
    // requests for accounts that are not.
    if (!isOwner) return;

    let cancelled = false;
    setView(prev => (prev.phase === 'ready' ? prev : { phase: 'loading' }));

    ownerFacilityRepository
      .loadMyFacilities()
      .then(facilities => {
        if (cancelled) return;
        setView({ phase: 'ready', facilities });
        setSelectedId(current =>
          current && facilities.some(f => f.id === current) ? current : facilities[0]?.id ?? null
        );
      })
      .catch(err => {
        if (!cancelled) setView({ phase: 'error', message: toOwnerError(err).message });
      });

    return () => {
      cancelled = true;
    };
  }, [user.id, isOwner, reloadKey]);

  const header = (
    <div className="flex items-center gap-3 mb-8">
      <div
        className="w-12 h-12 bg-neutral-900 transform -skew-x-12 flex items-center justify-center text-white"
        aria-hidden="true"
      >
        <i className="fas fa-store"></i>
      </div>
      <div>
        <h2 className="text-3xl sm:text-4xl font-black text-neutral-900 uppercase italic tracking-tighter">
          Owner Portal
        </h2>
        <p className="text-neutral-500 text-xs font-bold uppercase tracking-widest">
          {user.name ? `Signed in as ${user.name}` : 'Venue management'}
        </p>
      </div>
    </div>
  );

  if (!isOwner) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8 font-sans">
        {header}
        <div role="status" className="bg-white rounded-lg border-2 border-neutral-100 p-6">
          <p className="text-sm font-bold text-neutral-700">
            Venue management is available to venue owner accounts only.
          </p>
        </div>
      </div>
    );
  }

  const facilities = view.phase === 'ready' ? view.facilities : [];
  const selected = facilities.find(f => f.id === selectedId) ?? null;

  // A finished notice is obsolete the moment the next action starts, so it
  // is cleared here, before the request. If this request then fails, the
  // form shows its own error alone instead of beside the previous success.
  // The result of a request is published only while no newer action has
  // started, so a slow older request cannot overwrite a newer notice.
  const handleCreate = async (input: FacilityInput) => {
    const token = noticeSequence.current.begin();
    setNotice(null);

    const created = await ownerFacilityRepository.createFacility(input);
    setCreating(false);
    setSelectedId(created.id);
    setTab('details');
    if (noticeSequence.current.isCurrent(token)) {
      setNotice({
        type: 'success',
        text: 'Venue created. It is pending approval and is not visible to players yet.'
      });
    }
    setReloadKey(k => k + 1);
  };

  const handleUpdate = async (input: FacilityInput) => {
    if (!selected) return;

    const token = noticeSequence.current.begin();
    setNotice(null);

    await ownerFacilityRepository.updateFacility(selected.id, input);
    if (noticeSequence.current.isCurrent(token)) {
      setNotice({ type: 'success', text: 'Venue details saved.' });
    }
    setReloadKey(k => k + 1);
  };

  const tabs: Array<{ id: DetailTab; label: string }> = [
    { id: 'details', label: 'Details' },
    { id: 'hours', label: 'Hours' },
    { id: 'slots', label: 'Slots' },
    { id: 'bookings', label: 'Bookings' }
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 font-sans">
      {header}

      {view.phase === 'loading' && (
        <p className="text-xs font-bold uppercase text-neutral-400">Loading your venues…</p>
      )}

      {view.phase === 'error' && (
        <RetryBox message={view.message} onRetry={() => setReloadKey(k => k + 1)} />
      )}

      {view.phase === 'ready' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <aside className="lg:col-span-1">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-black uppercase text-lg">Your venues</h3>
              <button
                onClick={() => {
                  setCreating(true);
                  setNotice(null);
                }}
                className={secondaryButton}
              >
                Add venue
              </button>
            </div>

            {facilities.length === 0 && !creating && (
              <div className="p-6 border-2 border-dashed border-neutral-200 rounded-lg text-center">
                <p className="text-xs font-bold uppercase text-neutral-400">
                  You have no venues yet.
                </p>
                <button onClick={() => setCreating(true)} className={`${primaryButton} mt-4`}>
                  Add your first venue
                </button>
              </div>
            )}

            <ul className="space-y-3">
              {facilities.map(f => (
                <li key={f.id}>
                  <button
                    onClick={() => {
                      setSelectedId(f.id);
                      setCreating(false);
                      setNotice(null);
                    }}
                    aria-current={!creating && f.id === selectedId ? 'true' : undefined}
                    className={`w-full text-left p-4 rounded-lg border-2 transition-all ${
                      !creating && f.id === selectedId
                        ? 'border-orange-500 bg-orange-50'
                        : 'border-neutral-100 bg-white hover:border-neutral-300'
                    }`}
                  >
                    <p className="font-black uppercase tracking-tight text-neutral-900 break-words">
                      {f.name}
                    </p>
                    <p className="text-xs text-neutral-500 mt-1">
                      {f.sport} · {f.city}
                    </p>
                    <div className="mt-2">
                      <StatusBadge status={f.status} />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <section className="lg:col-span-2" aria-label="Venue details">
            <NoticeBox notice={notice} />

            {creating && (
              <div className="bg-white rounded-lg border-2 border-neutral-100 p-6">
                <h3 className="font-black uppercase text-lg mb-1">New venue</h3>
                <p className="text-xs text-neutral-500 mb-6">
                  New venues start as pending and become visible to players once an administrator
                  approves them.
                </p>
                <FacilityForm
                  initial={emptyInput}
                  submitLabel="Create venue"
                  busyLabel="Creating…"
                  onSubmit={handleCreate}
                  onCancel={() => setCreating(false)}
                />
              </div>
            )}

            {!creating && selected && (
              <div className="bg-white rounded-lg border-2 border-neutral-100">
                <div className="p-6 border-b-2 border-neutral-100">
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className="font-black uppercase text-2xl tracking-tight break-words">
                      {selected.name}
                    </h3>
                    <StatusBadge status={selected.status} />
                  </div>
                  <p className="text-xs text-neutral-500 mt-2">
                    {describeFacilityStatus(selected.status).explanation}
                  </p>
                </div>

                <div role="tablist" aria-label="Venue sections" className="flex border-b-2 border-neutral-100 bg-neutral-50 overflow-x-auto">
                  {tabs.map(t => (
                    <button
                      key={t.id}
                      role="tab"
                      aria-selected={tab === t.id}
                      onClick={() => {
                        setTab(t.id);
                        setNotice(null);
                      }}
                      className={`px-5 py-3 text-[11px] font-black uppercase tracking-widest whitespace-nowrap ${
                        tab === t.id
                          ? 'bg-white text-orange-600 border-b-2 border-orange-600'
                          : 'text-neutral-400 hover:text-neutral-700'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                <div role="tabpanel" className="p-6">
                  {tab === 'details' && (
                    <FacilityForm
                      key={selected.id}
                      initial={toInput(selected)}
                      submitLabel="Save changes"
                      busyLabel="Saving…"
                      onSubmit={handleUpdate}
                    />
                  )}
                  {tab === 'hours' && <HoursPanel key={selected.id} facilityId={selected.id} />}
                  {tab === 'slots' && <SlotsPanel key={selected.id} facilityId={selected.id} />}
                  {tab === 'bookings' && <BookingsPanel key={selected.id} facilityId={selected.id} />}
                </div>
              </div>
            )}

            {!creating && !selected && facilities.length > 0 && (
              <p className="text-xs font-bold uppercase text-neutral-400">
                Select a venue to manage it.
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
};

export default OwnerDashboard;
