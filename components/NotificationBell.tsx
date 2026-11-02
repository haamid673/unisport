import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  notificationRepository,
  toNotificationError,
  type AppNotification
} from '../services/notificationRepository';
import { describeNotification, notificationTarget } from '../services/notificationText';

/** Re-read about once a minute while the page is visible, like the waitlist. */
export const NOTIFICATION_POLL_MS = 60_000;

/**
 * The navigation renders one bell for wide screens and one for narrow
 * ones. Marking something read in either tells both to re-read, so they
 * never disagree.
 */
export const NOTIFICATIONS_CHANGED = 'unisport:notifications-changed';

const timeAgo = (iso: string, now: number): string => {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

/**
 * The bell: unread count, a list of the person's notifications, mark as
 * read. Everything comes from the database; nothing is stored locally.
 */
const NotificationBell: React.FC<{ userId: string }> = ({ userId }) => {
  const navigate = useNavigate();
  const [state, setState] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; items: AppNotification[]; unread: number }
  >({ phase: 'loading' });
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement>(null);
  const cancelled = useRef(false);

  const refresh = useCallback(() => {
    notificationRepository
      .load()
      .then(({ items, unreadCount }) => {
        if (!cancelled.current) {
          setNow(Date.now());
          setState({ phase: 'ready', items, unread: unreadCount });
        }
      })
      .catch(err => {
        // Keep what is already shown; only a first load reports a failure.
        if (!cancelled.current) {
          setState(prev =>
            prev.phase === 'ready'
              ? prev
              : { phase: 'error', message: toNotificationError(err, 'Could not load notifications.').message }
          );
        }
      });
  }, []);

  useEffect(() => {
    cancelled.current = false;
    refresh();

    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh();
    }, NOTIFICATION_POLL_MS);

    return () => {
      cancelled.current = true;
      clearInterval(timer);
    };
  }, [userId, refresh]);

  useEffect(() => {
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
  }, [refresh]);

  const afterMark = () => {
    window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
  };

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const unread = state.phase === 'ready' ? state.unread : 0;

  const markAll = () => {
    void notificationRepository.markRead().then(afterMark, afterMark);
  };

  const openItem = (n: AppNotification) => {
    if (n.readAt === null) {
      void notificationRepository.markRead([n.id]).then(afterMark, afterMark);
    }
    const target = notificationTarget(n);
    setOpen(false);
    if (target) navigate(target);
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen(o => !o);
          if (!open) refresh();
        }}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="true"
        className="relative p-2 text-neutral-900 hover:text-orange-600 transition-colors"
      >
        <i className="fas fa-bell text-lg" aria-hidden="true"></i>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-orange-600 text-white text-[10px] font-black flex items-center justify-center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="region"
          aria-label="Notifications"
          className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] bg-white border-2 border-neutral-900 shadow-xl z-50"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200">
            <p className="text-xs font-black uppercase tracking-widest text-neutral-900">Notifications</p>
            <button
              type="button"
              onClick={markAll}
              disabled={unread === 0}
              className="text-[10px] font-black uppercase tracking-widest text-neutral-500 hover:text-orange-600 disabled:opacity-40 disabled:hover:text-neutral-500"
            >
              Mark all read
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto" aria-live="polite">
            {state.phase === 'loading' && (
              <p className="px-4 py-6 text-xs font-bold uppercase tracking-widest text-neutral-400">Loading…</p>
            )}
            {state.phase === 'error' && (
              <div role="alert" className="px-4 py-4">
                <p className="text-xs font-bold text-red-700">{state.message}</p>
                <button
                  type="button"
                  onClick={refresh}
                  className="mt-2 px-3 py-1 border-2 border-neutral-300 text-[10px] font-black uppercase tracking-widest rounded-md hover:border-neutral-900"
                >
                  Retry
                </button>
              </div>
            )}
            {state.phase === 'ready' && state.items.length === 0 && (
              <p className="px-4 py-6 text-xs font-bold uppercase tracking-widest text-neutral-400">
                You have no notifications yet.
              </p>
            )}
            {state.phase === 'ready' && (
              <ul>
                {state.items.map(n => {
                  const { title, detail } = describeNotification(n);
                  return (
                    <li key={n.id} className="border-b border-neutral-100 last:border-b-0">
                      <button
                        type="button"
                        onClick={() => openItem(n)}
                        className={`w-full text-left px-4 py-3 hover:bg-neutral-50 transition-colors ${
                          n.readAt === null ? 'bg-orange-50' : ''
                        }`}
                      >
                        <span className="flex items-start gap-2">
                          {n.readAt === null && (
                            <span className="mt-1.5 w-2 h-2 shrink-0 rounded-full bg-orange-600" aria-label="Unread"></span>
                          )}
                          <span className="min-w-0">
                            <span className="block text-xs font-black uppercase tracking-wide text-neutral-900">{title}</span>
                            <span className="block mt-1 text-xs text-neutral-600">{detail}</span>
                            <span className="block mt-1 text-[10px] font-bold uppercase tracking-widest text-neutral-400">
                              {timeAgo(n.createdAt, now)}
                            </span>
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default NotificationBell;
