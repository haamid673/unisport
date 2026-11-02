import React, { useEffect, useRef, useState } from 'react';
import {
  communityRepository,
  hasPlace,
  toCommunityError,
  type CommunityEventView,
  type CommunityGroupView
} from '../services/communityRepository';
import { facilityRepository } from '../services/facilityRepository';
import { UUID_PATTERN } from '../services/bookingRepository';
import { createSingleFlight } from '../services/singleFlight';
import { defaultBookingDate } from '../services/bookingDate';
import NotFound from './NotFound';
import { Facility, User } from '../types';

interface Props {
  user: User;
  groupId: string;
  onBack: () => void;
  homeHref: string;
}

const inputClass =
  'w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors disabled:bg-neutral-100';
const labelClass = 'block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1';

type Notice = { type: 'success' | 'error'; text: string } | null;

const CommunityDetail: React.FC<Props> = ({ user, groupId, onBack, homeHref }) => {
  const [view, setView] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; group: CommunityGroupView | null; events: CommunityEventView[] }
  >({ phase: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const guard = useRef(createSingleFlight());

  const [creating, setCreating] = useState(false);
  const [venues, setVenues] = useState<Facility[]>([]);
  const [form, setForm] = useState({ title: '', date: defaultBookingDate(), time: '18:00', facilityId: '', capacity: '' });

  // The group and its events, from the database.
  useEffect(() => {
    let cancelled = false;

    // An address that is not a group id cannot name a group.
    if (!UUID_PATTERN.test(groupId)) {
      setView({ phase: 'ready', group: null, events: [] });
      return;
    }

    setView(prev => (prev.phase === 'ready' ? prev : { phase: 'loading' }));

    Promise.all([communityRepository.loadGroups(), communityRepository.loadEvents({ groupId })])
      .then(([groups, events]) => {
        if (cancelled) return;
        setView({ phase: 'ready', group: groups.find(g => g.id === groupId) ?? null, events });
      })
      .catch(err => {
        if (!cancelled) setView({ phase: 'error', message: toCommunityError(err).message });
      });

    return () => {
      cancelled = true;
    };
  }, [user.id, groupId, reloadKey]);

  const group = view.phase === 'ready' ? view.group : null;
  const canCreateEvent = Boolean(group && group.isMember && group.status === 'approved');

  // Venues for the create form: live venues in the group's city.
  useEffect(() => {
    if (!creating || !group) return;
    let cancelled = false;

    facilityRepository
      .loadCustomerCatalog()
      .then(({ facilities }) => {
        if (cancelled) return;
        const city = group.city.trim().toLowerCase();
        setVenues(facilities.filter(f => f.city.trim().toLowerCase() === city));
      })
      .catch(() => {
        if (!cancelled) setVenues([]);
      });

    return () => {
      cancelled = true;
    };
  }, [creating, group?.id, group?.city]);

  // One mutation at a time; success is reported only from the database's
  // answer, and the group and events are re-read whatever happened.
  const run = (key: string, action: () => Promise<string | null>) => {
    if (guard.current.busy) return;

    void guard.current.run(async () => {
      setBusy(key);
      setNotice(null);
      try {
        const text = await action();
        if (text) setNotice({ type: 'success', text });
      } catch (err) {
        setNotice({ type: 'error', text: toCommunityError(err).message });
      } finally {
        setBusy(null);
        setReloadKey(k => k + 1);
      }
    });
  };

  const submitEvent = (e: React.FormEvent) => {
    e.preventDefault();
    if (!group) return;

    run('create-event', async () => {
      await communityRepository.createEvent({
        groupId: group.id,
        title: form.title,
        date: form.date,
        time: form.time,
        facilityId: form.facilityId,
        capacity: form.capacity.trim() === '' ? null : Number(form.capacity)
      });
      setCreating(false);
      setForm(f => ({ ...f, title: '', capacity: '' }));
      return 'Event submitted. Other members see it once an administrator approves it; until then only you can.';
    });
  };

  if (view.phase === 'loading') {
    return (
      <div className="max-w-6xl mx-auto px-6 py-10 font-sans">
        <p className="text-neutral-400 text-xs font-bold uppercase tracking-widest">Loading community…</p>
      </div>
    );
  }

  if (view.phase === 'error') {
    return (
      <div className="max-w-6xl mx-auto px-6 py-10 font-sans">
        <div role="alert" className="p-4 bg-red-50 border border-red-200 max-w-xl">
          <p className="text-xs font-bold text-red-700">{view.message}</p>
          <button
            onClick={() => setReloadKey(k => k + 1)}
            className="mt-3 px-4 py-2 border-2 border-neutral-300 text-neutral-700 text-[10px] font-black uppercase tracking-widest rounded-md hover:border-neutral-900 transition-all"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!group) {
    return (
      <NotFound
        homeHref={homeHref}
        title="Group not found"
        message="That community group does not exist or is not available."
      />
    );
  }

  const today = defaultBookingDate();

  return (
    <div className="max-w-6xl mx-auto px-6 py-10 font-sans">

      <button
        onClick={onBack}
        className="mb-6 text-xs font-black uppercase tracking-widest text-neutral-500 hover:text-black transition"
      >
        ← Back to Communities
      </button>

      {/* Banner */}
      <div className="relative h-72 rounded-xl overflow-hidden mb-10 bg-neutral-900">
        <div className="absolute inset-0 bg-black/50"></div>

        <div className="absolute bottom-6 left-6 text-white">
          <h1 className="text-4xl font-black uppercase italic tracking-tight">
            {group.name}
          </h1>
          <p className="mt-2 text-xs uppercase tracking-widest opacity-90">
            {group.sport} • {group.city}
          </p>
          <p className="text-xs mt-2 opacity-80">
            {group.memberCount} {group.memberCount === 1 ? 'Member' : 'Members'}
          </p>
        </div>
      </div>

      {group.description && (
        <p className="mb-8 text-sm text-neutral-600 max-w-3xl whitespace-pre-line">{group.description}</p>
      )}

      <div aria-live="polite">
        {group.status !== 'approved' && (
          <div role="status" className="mb-6 p-3 border bg-yellow-50 border-yellow-200 text-xs font-bold text-yellow-800">
            {group.status === 'pending'
              ? 'This community is waiting for administrator approval. Only you can see it until then.'
              : 'This community was not approved.'}
          </div>
        )}
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

      <div className="mb-12 flex flex-wrap items-center gap-4">
        {group.isMember ? (
          <button
            disabled={busy !== null}
            onClick={() => run('leave-group', async () => {
              await communityRepository.leaveGroup(group.id);
              return 'You left the community and its events.';
            })}
            className="px-6 py-3 bg-neutral-200 rounded-full font-black uppercase tracking-widest text-xs hover:bg-neutral-300 transition disabled:opacity-50"
          >
            {busy === 'leave-group' ? 'Leaving…' : 'Leave Community'}
          </button>
        ) : (
          <button
            disabled={busy !== null || group.status !== 'approved'}
            onClick={() => run('join-group', async () => {
              await communityRepository.joinGroup(group.id);
              return 'You joined the community.';
            })}
            className="px-6 py-3 bg-orange-600 text-white rounded-full font-black uppercase tracking-widest text-xs hover:bg-orange-700 transition shadow-lg disabled:opacity-50"
          >
            {busy === 'join-group' ? 'Joining…' : 'Join Community'}
          </button>
        )}

        {canCreateEvent && (
          <button
            type="button"
            onClick={() => setCreating(c => !c)}
            aria-expanded={creating}
            className="px-6 py-3 bg-neutral-900 text-white text-xs font-black uppercase tracking-widest rounded-full hover:bg-orange-600 transition-all"
          >
            {creating ? 'Close' : 'Create an event'}
          </button>
        )}
      </div>

      {creating && canCreateEvent && (
        <form onSubmit={submitEvent} className="mb-12 p-6 border-2 border-neutral-100 rounded-xl space-y-4 max-w-2xl">
          <div>
            <label htmlFor="event-title" className={labelClass}>Title</label>
            <input id="event-title" className={inputClass} value={form.title} maxLength={150} required
              onChange={e => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="event-date" className={labelClass}>Date</label>
              <input id="event-date" type="date" className={inputClass} value={form.date} min={today} required
                onChange={e => setForm({ ...form, date: e.target.value })} />
            </div>
            <div>
              <label htmlFor="event-time" className={labelClass}>Time</label>
              <input id="event-time" type="time" className={inputClass} value={form.time} required
                onChange={e => setForm({ ...form, time: e.target.value })} />
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="event-venue" className={labelClass}>Venue</label>
              <select id="event-venue" className={inputClass} value={form.facilityId} required
                onChange={e => setForm({ ...form, facilityId: e.target.value })}>
                <option value="">Choose a venue</option>
                {venues.map(v => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              {venues.length === 0 && (
                <p className="mt-1 text-[11px] text-neutral-400">No live venues in {group.city} yet.</p>
              )}
            </div>
            <div>
              <label htmlFor="event-capacity" className={labelClass}>Places (optional)</label>
              <input id="event-capacity" type="number" min={1} max={500} className={inputClass} value={form.capacity}
                onChange={e => setForm({ ...form, capacity: e.target.value })} />
            </div>
          </div>
          <p className="text-[11px] text-neutral-400">
            New events are reviewed by an administrator before other members can see them.
          </p>
          <button type="submit" disabled={busy !== null || form.facilityId === ''}
            className="px-6 py-3 bg-neutral-900 text-white text-xs font-black uppercase tracking-widest rounded-lg hover:bg-orange-600 transition-all disabled:bg-neutral-300 disabled:cursor-not-allowed">
            {busy === 'create-event' ? 'Submitting…' : 'Submit for approval'}
          </button>
        </form>
      )}

      {/* Events */}
      <h2 className="text-3xl font-black uppercase italic tracking-tight mb-6">
        Community Events
      </h2>

      {view.events.length === 0 && (
        <p className="text-neutral-400 uppercase text-xs font-bold tracking-widest">
          No events yet in this community.
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {view.events.map(event => {
          const isFull = !hasPlace(event);
          const ended = event.date < today;
          const approved = event.status === 'approved';
          const canAct = group.isMember && approved && group.status === 'approved';
          const key = `event:${event.id}`;

          return (
            <div
              key={event.id}
              className="border rounded-lg p-6 bg-white flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-black uppercase italic text-lg">
                    {event.title}
                  </h3>
                  {!approved && (
                    <span className="shrink-0 px-2 py-0.5 rounded-sm text-[9px] font-black uppercase tracking-wider bg-yellow-100 text-yellow-800">
                      {event.status === 'pending' ? 'Awaiting approval' : 'Rejected'}
                    </span>
                  )}
                </div>
                <p className="text-xs text-neutral-500 mt-2 uppercase tracking-wide">
                  {event.date} • {event.time}
                </p>
                <p className="text-xs text-neutral-400 mt-1 uppercase tracking-wide">
                  {event.facilityName}
                </p>
                <p className="text-xs text-neutral-400 mt-1 uppercase tracking-wide">
                  {event.participantCount}
                  {event.capacity ? ` / ${event.capacity}` : ''} Players
                </p>
              </div>

              {canAct ? (
                <button
                  onClick={() => run(key, async () => {
                    if (event.isParticipant) {
                      await communityRepository.leaveEvent(event.id);
                      return 'You left the event.';
                    }
                    await communityRepository.joinEvent(event.id);
                    return 'You are in. See you there.';
                  })}
                  disabled={busy !== null || (!event.isParticipant && (isFull || ended))}
                  aria-busy={busy === key}
                  className={`mt-6 py-3 rounded-md font-black uppercase tracking-widest text-xs transition-all ${
                    event.isParticipant
                      ? 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300'
                      : isFull || ended
                      ? 'bg-neutral-200 text-neutral-500 cursor-not-allowed'
                      : 'bg-neutral-900 text-white hover:bg-orange-600'
                  }`}
                >
                  {busy === key
                    ? 'Working…'
                    : event.isParticipant
                    ? 'Leave Event'
                    : ended
                    ? 'Ended'
                    : isFull
                    ? 'Full'
                    : 'Join Event'}
                </button>
              ) : (
                !group.isMember &&
                approved && (
                  <p className="mt-6 text-[10px] font-bold uppercase tracking-wide text-neutral-400">
                    Join the community to join this event.
                  </p>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default CommunityDetail;
