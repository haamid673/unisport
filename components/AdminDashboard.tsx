import React, { useEffect, useRef, useState } from 'react';
import {
  adminRepository,
  toAdminError,
  USER_ROLES,
  type AdminEvent,
  type AdminFacility,
  type AdminGroup,
  type AdminUser,
  type ApprovalDecision,
  type UserRole
} from '../services/adminRepository';
import { describeFacilityStatus, type FacilityRecordStatus } from '../services/ownerFacilityRepository';
import { createSingleFlight } from '../services/singleFlight';
import type { User } from '../types';

/**
 * Governance Center: venue approvals and role management.
 *
 * Everything here goes through the admin_* functions (see
 * services/adminRepository.ts). The database refuses anyone who is not
 * an administrator; this page is not the security boundary. Each action
 * is confirmed, runs one at a time, and the lists are re-read from the
 * database afterwards. Nothing is shown from local or demo data.
 */

const inputClass =
  'w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors disabled:bg-neutral-100';
const labelClass = 'block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1';
const primaryButton =
  'px-6 py-3 bg-neutral-900 text-white text-xs font-black uppercase tracking-widest rounded-lg hover:bg-orange-600 transition-all disabled:bg-neutral-300 disabled:text-neutral-500 disabled:cursor-not-allowed';
const secondaryButton =
  'px-4 py-2 border-2 border-neutral-300 text-neutral-700 text-[10px] font-black uppercase tracking-widest rounded-md hover:border-neutral-900 transition-all disabled:opacity-50 disabled:cursor-not-allowed';
const dangerButton =
  'px-4 py-2 bg-red-600 text-white text-[10px] font-black uppercase tracking-widest rounded-md hover:bg-red-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed';

type Notice = { type: 'success' | 'error'; text: string } | null;

/** What each target status means for the confirm question and the success line. */
const ACTIONS: Record<FacilityRecordStatus, { button: string; ask: string; done: string; danger: boolean }> = {
  active: {
    button: 'Approve',
    ask: 'Make this venue visible and bookable for players?',
    done: 'is now live.',
    danger: false
  },
  rejected: {
    button: 'Reject',
    ask: 'Reject this venue? The owner will see it as rejected.',
    done: 'was rejected.',
    danger: true
  },
  suspended: {
    button: 'Suspend',
    ask: 'Suspend this venue? Players will no longer see or book it. Existing bookings are kept.',
    done: 'was suspended.',
    danger: true
  },
  pending: {
    button: 'Back to pending',
    ask: 'Move this venue back to pending approval?',
    done: 'is pending approval again.',
    danger: false
  }
};

/** The actions offered for a venue in each state. */
const OFFERED: Record<FacilityRecordStatus, FacilityRecordStatus[]> = {
  pending: ['active', 'rejected'],
  active: ['suspended'],
  suspended: ['active'],
  rejected: ['active']
};

const StatusBadge: React.FC<{ status: FacilityRecordStatus }> = ({ status }) => {
  const { label } = describeFacilityStatus(status);
  const color =
    status === 'active'
      ? 'bg-emerald-100 text-emerald-700'
      : status === 'pending'
      ? 'bg-yellow-100 text-yellow-800'
      : 'bg-red-100 text-red-700';
  return (
    <span className={`px-2 py-0.5 rounded-sm text-[9px] font-black uppercase tracking-wider ${color}`}>
      {label}
    </span>
  );
};

interface AdminDashboardProps {
  user: User;
}

const AdminDashboard: React.FC<AdminDashboardProps> = ({ user }) => {
  const [facilitiesView, setFacilitiesView] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; facilities: AdminFacility[] }
  >({ phase: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  const [communityView, setCommunityView] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; groups: AdminGroup[]; events: AdminEvent[] }
  >({ phase: 'loading' });

  const [notice, setNotice] = useState<Notice>(null);
  // At most one confirmation open at a time, and one action in flight.
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const guard = useRef(createSingleFlight());

  const [email, setEmail] = useState('');
  const [lookup, setLookup] = useState<
    | { phase: 'idle' }
    | { phase: 'searching' }
    | { phase: 'none'; email: string }
    | { phase: 'found'; account: AdminUser }
  >({ phase: 'idle' });
  const [chosenRole, setChosenRole] = useState<UserRole>('user');

  useEffect(() => {
    let cancelled = false;

    // Keep the last answer while it is re-read.
    setFacilitiesView(prev => (prev.phase === 'ready' ? prev : { phase: 'loading' }));

    adminRepository
      .loadFacilities()
      .then(facilities => {
        if (!cancelled) setFacilitiesView({ phase: 'ready', facilities });
      })
      .catch(err => {
        if (!cancelled) setFacilitiesView({ phase: 'error', message: toAdminError(err).message });
      });

    return () => {
      cancelled = true;
    };
  }, [user.id, reloadKey]);

  // Communities and events awaiting a decision.
  useEffect(() => {
    let cancelled = false;

    setCommunityView(prev => (prev.phase === 'ready' ? prev : { phase: 'loading' }));

    Promise.all([adminRepository.loadCommunityGroups('pending'), adminRepository.loadCommunityEvents('pending')])
      .then(([groups, events]) => {
        if (!cancelled) setCommunityView({ phase: 'ready', groups, events });
      })
      .catch(err => {
        if (!cancelled) setCommunityView({ phase: 'error', message: toAdminError(err).message });
      });

    return () => {
      cancelled = true;
    };
  }, [user.id, reloadKey]);

  // One administrative action at a time. Success is reported only from
  // the database's answer, and the lists are re-read whatever happened.
  const run = (key: string, action: () => Promise<string>) => {
    if (guard.current.busy) return;

    void guard.current.run(async () => {
      setConfirmKey(null);
      setBusyKey(key);
      setNotice(null);
      try {
        setNotice({ type: 'success', text: await action() });
      } catch (err) {
        setNotice({ type: 'error', text: toAdminError(err).message });
      } finally {
        setBusyKey(null);
        setReloadKey(k => k + 1);
      }
    });
  };

  const changeFacility = (facility: AdminFacility, status: FacilityRecordStatus) =>
    run(`fac:${facility.id}:${status}`, async () => {
      await adminRepository.setFacilityStatus(facility.id, status);
      return `${facility.name} ${ACTIONS[status].done}`;
    });

  const decideGroup = (group: AdminGroup, status: ApprovalDecision) =>
    run(`grp:${group.id}:${status}`, async () => {
      await adminRepository.setGroupStatus(group.id, status);
      return `${group.name} was ${status === 'approved' ? 'approved' : 'rejected'}.`;
    });

  const decideEvent = (event: AdminEvent, status: ApprovalDecision) =>
    run(`evt:${event.id}:${status}`, async () => {
      await adminRepository.setEventStatus(event.id, status);
      return `${event.title} was ${status === 'approved' ? 'approved' : 'rejected'}.`;
    });

  const search = async () => {
    if (guard.current.busy) return;

    await guard.current.run(async () => {
      setNotice(null);
      setConfirmKey(null);
      setLookup({ phase: 'searching' });
      try {
        const account = await adminRepository.findUserByEmail(email);
        if (account) {
          setChosenRole(account.role);
          setLookup({ phase: 'found', account });
        } else {
          setLookup({ phase: 'none', email: email.trim() });
        }
      } catch (err) {
        setLookup({ phase: 'idle' });
        setNotice({ type: 'error', text: toAdminError(err, 'user').message });
      }
    });
  };

  const changeRole = (account: AdminUser, role: UserRole) => {
    if (guard.current.busy) return;

    void guard.current.run(async () => {
      setConfirmKey(null);
      setBusyKey(`role:${account.id}`);
      setNotice(null);
      try {
        const stored = await adminRepository.setUserRole(account.id, role);
        setLookup({ phase: 'found', account: { ...account, role: stored } });
        setChosenRole(stored);
        setNotice({ type: 'success', text: `${account.email} is now ${stored}.` });
      } catch (err) {
        setNotice({ type: 'error', text: toAdminError(err, 'user').message });
      } finally {
        setBusyKey(null);
      }
    });
  };

  const busy = busyKey !== null || lookup.phase === 'searching';

  const facilities = facilitiesView.phase === 'ready' ? facilitiesView.facilities : [];
  const pending = facilities.filter(f => f.status === 'pending');
  const others = facilities.filter(f => f.status !== 'pending');

  const renderVenue = (f: AdminFacility) => (
    <li key={f.id} className="p-4 bg-neutral-50 border border-neutral-200 rounded-lg">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-black uppercase italic">{f.name}</p>
          <p className="text-xs text-neutral-500 uppercase">
            {f.sport} · {f.address}, {f.city} · ₹{f.basePrice}
          </p>
        </div>
        <StatusBadge status={f.status} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {OFFERED[f.status].map(status => {
          const key = `fac:${f.id}:${status}`;
          const meta = ACTIONS[status];

          return confirmKey === key ? (
            <React.Fragment key={key}>
              <p className="w-full text-[10px] font-bold uppercase tracking-wide text-neutral-600">
                {meta.ask}
              </p>
              <button type="button" disabled={busy} onClick={() => changeFacility(f, status)} className={meta.danger ? dangerButton : primaryButton + ' !py-2 !px-4 !text-[10px]'}>
                Yes, {meta.button.toLowerCase()}
              </button>
              <button type="button" onClick={() => setConfirmKey(null)} className={secondaryButton}>
                Keep as is
              </button>
            </React.Fragment>
          ) : confirmKey?.startsWith(`fac:${f.id}:`) ? null : (
            <button
              key={key}
              type="button"
              disabled={busy}
              aria-busy={busyKey === key}
              onClick={() => setConfirmKey(key)}
              className={secondaryButton}
            >
              {busyKey === key ? 'Working…' : meta.button}
            </button>
          );
        })}
      </div>
    </li>
  );

  // Approve / Reject with a confirm step, for a community or an event.
  const renderDecision = (
    prefix: string,
    noun: 'community' | 'event',
    decide: (status: ApprovalDecision) => void
  ) => (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {(['approved', 'rejected'] as const).map(status => {
        const key = `${prefix}:${status}`;
        const approve = status === 'approved';

        return confirmKey === key ? (
          <React.Fragment key={key}>
            <p className="w-full text-[10px] font-bold uppercase tracking-wide text-neutral-600">
              {approve
                ? `Approve this ${noun}? It becomes visible to players.`
                : `Reject this ${noun}? Its creator will see it as rejected.`}
            </p>
            <button type="button" disabled={busy} onClick={() => decide(status)} className={approve ? primaryButton + ' !py-2 !px-4 !text-[10px]' : dangerButton}>
              {approve ? 'Yes, approve' : 'Yes, reject'}
            </button>
            <button type="button" onClick={() => setConfirmKey(null)} className={secondaryButton}>
              Keep as is
            </button>
          </React.Fragment>
        ) : confirmKey?.startsWith(`${prefix}:`) ? null : (
          <button key={key} type="button" disabled={busy} aria-busy={busyKey === key} onClick={() => setConfirmKey(key)} className={secondaryButton}>
            {busyKey === key ? 'Working…' : approve ? 'Approve' : 'Reject'}
          </button>
        );
      })}
    </div>
  );

  const found = lookup.phase === 'found' ? lookup.account : null;
  const isSelf = found?.id === user.id;
  const roleKey = found ? `role:${found.id}` : '';

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 font-sans">
      <div className="flex items-center gap-3 mb-8">
        <div
          className="w-12 h-12 bg-neutral-900 transform -skew-x-12 flex items-center justify-center text-white"
          aria-hidden="true"
        >
          <i className="fas fa-user-shield"></i>
        </div>
        <div>
          <h2 className="text-3xl sm:text-4xl font-black text-neutral-900 uppercase italic tracking-tighter">
            Governance Center
          </h2>
          <p className="text-neutral-500 text-xs font-bold uppercase tracking-widest">
            Venue approvals and role management.
          </p>
        </div>
      </div>

      <div aria-live="polite">
        {notice && (
          <div
            role={notice.type === 'error' ? 'alert' : 'status'}
            className={`mb-6 p-3 border text-xs font-bold ${
              notice.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-red-50 border-red-200 text-red-700'
            }`}
          >
            {notice.text}
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          <section className="bg-white p-6 rounded-xl border-2 border-neutral-100" aria-labelledby="queue-heading">
            <h3 id="queue-heading" className="font-black uppercase text-lg mb-4">
              Awaiting approval
            </h3>

            {facilitiesView.phase === 'loading' && (
              <p className="text-neutral-400 text-xs font-bold uppercase">Loading venues…</p>
            )}

            {facilitiesView.phase === 'error' && (
              <div role="alert" className="p-4 bg-red-50 border border-red-200">
                <p className="text-xs font-bold text-red-700">{facilitiesView.message}</p>
                <button onClick={() => setReloadKey(k => k + 1)} className={`${secondaryButton} mt-3`}>
                  Retry
                </button>
              </div>
            )}

            {facilitiesView.phase === 'ready' && pending.length === 0 && (
              <p className="text-neutral-400 text-xs font-bold uppercase">No venues are waiting for approval.</p>
            )}

            {pending.length > 0 && <ul className="space-y-3">{pending.map(renderVenue)}</ul>}
          </section>

          <section className="bg-white p-6 rounded-xl border-2 border-neutral-100" aria-labelledby="venues-heading">
            <h3 id="venues-heading" className="font-black uppercase text-lg mb-4">
              All other venues
            </h3>

            {facilitiesView.phase === 'ready' && others.length === 0 && (
              <p className="text-neutral-400 text-xs font-bold uppercase">No other venues yet.</p>
            )}

            {others.length > 0 && <ul className="space-y-3">{others.map(renderVenue)}</ul>}
          </section>
        </div>

        <section className="lg:col-span-2 bg-white p-6 rounded-xl border-2 border-neutral-100" aria-labelledby="community-heading">
          <h3 id="community-heading" className="font-black uppercase text-lg mb-4">
            Community requests
          </h3>

          {communityView.phase === 'loading' && (
            <p className="text-neutral-400 text-xs font-bold uppercase">Loading requests…</p>
          )}

          {communityView.phase === 'error' && (
            <div role="alert" className="p-4 bg-red-50 border border-red-200">
              <p className="text-xs font-bold text-red-700">{communityView.message}</p>
              <button onClick={() => setReloadKey(k => k + 1)} className={`${secondaryButton} mt-3`}>
                Retry
              </button>
            </div>
          )}

          {communityView.phase === 'ready' && communityView.groups.length === 0 && communityView.events.length === 0 && (
            <p className="text-neutral-400 text-xs font-bold uppercase">No communities or events are waiting for approval.</p>
          )}

          {communityView.phase === 'ready' && communityView.groups.length > 0 && (
            <>
              <p className={labelClass}>Communities</p>
              <ul className="space-y-3 mb-6">
                {communityView.groups.map(g => (
                  <li key={g.id} className="p-4 bg-neutral-50 border border-neutral-200 rounded-lg">
                    <p className="text-sm font-black uppercase italic">{g.name}</p>
                    <p className="text-xs text-neutral-500 uppercase">
                      {g.sport} · {g.city} · by {g.createdByEmail ?? 'unknown'}
                    </p>
                    {g.description && <p className="mt-1 text-xs text-neutral-600">{g.description}</p>}
                    {renderDecision(`grp:${g.id}`, 'community', status => decideGroup(g, status))}
                  </li>
                ))}
              </ul>
            </>
          )}

          {communityView.phase === 'ready' && communityView.events.length > 0 && (
            <>
              <p className={labelClass}>Events</p>
              <ul className="space-y-3">
                {communityView.events.map(ev => (
                  <li key={ev.id} className="p-4 bg-neutral-50 border border-neutral-200 rounded-lg">
                    <p className="text-sm font-black uppercase italic">{ev.title}</p>
                    <p className="text-xs text-neutral-500 uppercase">
                      {ev.groupName} · {ev.facilityName} · {ev.date} {ev.time}
                      {ev.capacity ? ` · ${ev.capacity} places` : ''} · by {ev.createdByEmail ?? 'unknown'}
                    </p>
                    {ev.groupStatus !== 'approved' && (
                      <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-amber-700">
                        Its community is not approved yet, so players will not see this event until it is.
                      </p>
                    )}
                    {renderDecision(`evt:${ev.id}`, 'event', status => decideEvent(ev, status))}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section
          className="bg-white p-6 rounded-xl border-2 border-neutral-100 h-fit"
          aria-labelledby="accounts-heading"
        >
          <h3 id="accounts-heading" className="font-black uppercase text-lg mb-4">
            Accounts and roles
          </h3>

          <form
            onSubmit={e => {
              e.preventDefault();
              void search();
            }}
            className="space-y-3"
          >
            <div>
              <label htmlFor="admin-email" className={labelClass}>
                Account email
              </label>
              <input
                id="admin-email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className={inputClass}
                placeholder="owner@example.com"
              />
              <p className="mt-1 text-[11px] text-neutral-400">
                Enter the full address. Accounts cannot be browsed.
              </p>
            </div>
            <button type="submit" disabled={busy || email.trim() === ''} className={primaryButton}>
              {lookup.phase === 'searching' ? 'Searching…' : 'Find account'}
            </button>
          </form>

          <div className="mt-5" aria-live="polite">
            {lookup.phase === 'none' && (
              <p className="text-neutral-400 text-xs font-bold uppercase">
                No account with the email {lookup.email}.
              </p>
            )}

            {found && (
              <div className="p-4 bg-neutral-50 border border-neutral-200 rounded-lg">
                <p className="text-sm font-black uppercase italic">{found.fullName ?? 'No name set'}</p>
                <p className="text-xs text-neutral-500 break-all">{found.email}</p>
                <p className="mt-2 text-[10px] font-black uppercase tracking-wider text-neutral-500">
                  Current role: {found.role}
                </p>

                {isSelf ? (
                  <p className="mt-3 text-[10px] font-bold uppercase tracking-wide text-amber-700">
                    This is your own account. Ask another administrator to change your role.
                  </p>
                ) : (
                  <div className="mt-3 space-y-2">
                    <label htmlFor="admin-role" className={labelClass}>
                      New role
                    </label>
                    <select
                      id="admin-role"
                      value={chosenRole}
                      disabled={busy}
                      onChange={e => {
                        setChosenRole(e.target.value as UserRole);
                        setConfirmKey(null);
                      }}
                      className={inputClass}
                    >
                      {USER_ROLES.map(role => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>

                    {confirmKey === roleKey ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="w-full text-[10px] font-bold uppercase tracking-wide text-neutral-600">
                          Change this account to {chosenRole}?
                        </p>
                        <button type="button" disabled={busy} onClick={() => changeRole(found, chosenRole)} className={dangerButton}>
                          Yes, change role
                        </button>
                        <button type="button" onClick={() => setConfirmKey(null)} className={secondaryButton}>
                          Keep as is
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={busy || chosenRole === found.role}
                        aria-busy={busyKey === roleKey}
                        onClick={() => setConfirmKey(roleKey)}
                        className={secondaryButton}
                      >
                        {busyKey === roleKey ? 'Working…' : 'Change role'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

export default AdminDashboard;
