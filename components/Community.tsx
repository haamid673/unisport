import React, { useEffect, useRef, useState } from 'react';
import {
  communityRepository,
  toCommunityError,
  type CommunityGroupView
} from '../services/communityRepository';
import { createSingleFlight } from '../services/singleFlight';
import { User } from '../types';

interface CommunityProps {
  user: User;
  onSelectCommunity: (group: { id: string }) => void;
}

const inputClass =
  'w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors disabled:bg-neutral-100';
const labelClass = 'block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1';

const Community: React.FC<CommunityProps> = ({ user, onSelectCommunity }) => {
  const [view, setView] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; groups: CommunityGroupView[] }
  >({ phase: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', sport: '', city: user.city ?? '', description: '' });
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const guard = useRef(createSingleFlight());

  // Real groups from the database. Nothing is read from local storage.
  useEffect(() => {
    let cancelled = false;

    setView(prev => (prev.phase === 'ready' ? prev : { phase: 'loading' }));

    communityRepository
      .loadGroups()
      .then(groups => {
        if (!cancelled) setView({ phase: 'ready', groups });
      })
      .catch(err => {
        if (!cancelled) setView({ phase: 'error', message: toCommunityError(err).message });
      });

    return () => {
      cancelled = true;
    };
  }, [user.id, reloadKey]);

  const city = (user.city ?? '').trim().toLowerCase();
  const groups =
    view.phase === 'ready'
      ? view.groups.filter(
          g => !city || g.city.trim().toLowerCase() === city || g.createdBy === user.id
        )
      : [];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (guard.current.busy) return;

    void guard.current.run(async () => {
      setSubmitting(true);
      setNotice(null);
      try {
        await communityRepository.createGroup({
          name: form.name,
          sport: form.sport,
          city: form.city,
          description: form.description
        });
        setNotice({
          type: 'success',
          text: 'Community submitted. Everyone can see it once an administrator approves it; until then only you can.'
        });
        setForm(f => ({ ...f, name: '', sport: '', description: '' }));
        setCreating(false);
      } catch (err) {
        setNotice({ type: 'error', text: toCommunityError(err).message });
      } finally {
        setSubmitting(false);
        setReloadKey(k => k + 1);
      }
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-10 font-sans">
      <div className="mb-12 border-b-2 border-neutral-900 pb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h2 className="text-5xl font-black uppercase tracking-tighter italic">
            Communities
          </h2>
          <p className="text-neutral-500 font-medium mt-2 tracking-wide uppercase text-xs">
            {user.city
              ? `Find like-minded players in ${user.city}`
              : 'Find like-minded players near you'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(c => !c)}
          aria-expanded={creating}
          className="px-6 py-3 bg-neutral-900 text-white text-xs font-black uppercase tracking-widest rounded-lg hover:bg-orange-600 transition-all"
        >
          {creating ? 'Close' : 'Start a community'}
        </button>
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

      {creating && (
        <form onSubmit={submit} className="mb-10 p-6 border-2 border-neutral-100 rounded-xl space-y-4 max-w-2xl">
          <div>
            <label htmlFor="group-name" className={labelClass}>Name</label>
            <input id="group-name" className={inputClass} value={form.name} maxLength={100} required
              onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="group-sport" className={labelClass}>Sport</label>
              <input id="group-sport" className={inputClass} value={form.sport} maxLength={50} required
                onChange={e => setForm({ ...form, sport: e.target.value })} />
            </div>
            <div>
              <label htmlFor="group-city" className={labelClass}>City</label>
              <input id="group-city" className={inputClass} value={form.city} maxLength={100} required
                onChange={e => setForm({ ...form, city: e.target.value })} />
            </div>
          </div>
          <div>
            <label htmlFor="group-description" className={labelClass}>About (optional)</label>
            <textarea id="group-description" className={inputClass} value={form.description} maxLength={2000} rows={3}
              onChange={e => setForm({ ...form, description: e.target.value })} />
          </div>
          <p className="text-[11px] text-neutral-400">
            New communities are reviewed by an administrator before other players can see them.
          </p>
          <button type="submit" disabled={submitting}
            className="px-6 py-3 bg-neutral-900 text-white text-xs font-black uppercase tracking-widest rounded-lg hover:bg-orange-600 transition-all disabled:bg-neutral-300 disabled:cursor-not-allowed">
            {submitting ? 'Submitting…' : 'Submit for approval'}
          </button>
        </form>
      )}

      {view.phase === 'loading' && (
        <p className="text-neutral-400 text-xs font-bold uppercase tracking-widest">Loading communities…</p>
      )}

      {view.phase === 'error' && (
        <div role="alert" className="mb-8 p-4 bg-red-50 border border-red-200 max-w-xl">
          <p className="text-xs font-bold text-red-700">{view.message}</p>
          <button
            onClick={() => setReloadKey(k => k + 1)}
            className="mt-3 px-4 py-2 border-2 border-neutral-300 text-neutral-700 text-[10px] font-black uppercase tracking-widest rounded-md hover:border-neutral-900 transition-all"
          >
            Retry
          </button>
        </div>
      )}

      {view.phase === 'ready' && groups.length === 0 && (
        <div className="py-16 text-center border-2 border-dashed border-neutral-200 rounded-lg">
          <p className="text-neutral-400 font-bold uppercase tracking-widest">
            No communities yet.
          </p>
          <p className="text-neutral-400 text-xs font-medium mt-2 normal-case tracking-normal">
            Be the first: start a community for your sport and city.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {groups.map(group => (
          <div
            key={group.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelectCommunity(group)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectCommunity(group);
              }
            }}
            className="cursor-pointer rounded-xl overflow-hidden border-2 border-neutral-200 hover:border-black transition group bg-white"
          >
            <div className="relative h-48 overflow-hidden bg-neutral-900">
              <div className="absolute inset-0 bg-black/40"></div>

              <div className="absolute bottom-4 left-4 text-white">
                <h3 className="font-black text-2xl uppercase italic tracking-tight leading-none">
                  {group.name}
                </h3>
                <p className="text-xs uppercase tracking-widest opacity-80 mt-1">
                  {group.sport}
                </p>
              </div>
            </div>

            <div className="p-5 bg-white flex items-center justify-between gap-2">
              <p className="text-xs text-neutral-500 font-bold uppercase tracking-widest">
                {group.memberCount} {group.memberCount === 1 ? 'Member' : 'Members'}
              </p>
              {group.status !== 'approved' && (
                <span className="px-2 py-0.5 rounded-sm text-[9px] font-black uppercase tracking-wider bg-yellow-100 text-yellow-800">
                  {group.status === 'pending' ? 'Awaiting approval' : 'Rejected'}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Community;
