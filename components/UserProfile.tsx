import React, { useState, useEffect } from 'react';
import { User } from '../types';
import { userService } from '../services/userService';
import {
  bookingRepository,
  effectiveStatus,
  toBookingError,
  UserBooking
} from '../services/bookingRepository';
import { eventService } from '../services/eventService';

interface UserProfileProps {
  user: User;
  onUpdate: (user: User) => void;
}

const UserProfile: React.FC<UserProfileProps> = ({ user, onUpdate }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [bookingsView, setBookingsView] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; bookings: UserBooking[] }
  >({ phase: 'loading' });
  const [bookingsReloadKey, setBookingsReloadKey] = useState(0);
  const [userEvents, setUserEvents] = useState<any[]>([]);
  const [formData, setFormData] = useState({
    name: user.name || '',
    phone: user.phone || '',
    bio: user.bio || '',
    preferences: user.preferences?.join(', ') || ''
  });
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const openDirections = (location: string) => {
    const encoded = encodeURIComponent(location);
    const url = `https://www.google.com/maps/search/?api=1&query=${encoded}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const refreshData = () => {
    const allEvents = eventService.getAllEvents();
    const joinedEvents = allEvents.filter(e => e.participants.includes(user.id));
    setUserEvents(joinedEvents);
  };

  useEffect(() => {
    refreshData();
  }, [user.id]);

  // Real bookings from the database. Nothing is read from local storage.
  useEffect(() => {
    let cancelled = false;

    setBookingsView({ phase: 'loading' });

    bookingRepository
      .loadMyBookings()
      .then(bookings => {
        if (!cancelled) setBookingsView({ phase: 'ready', bookings });
      })
      .catch(err => {
        if (!cancelled) {
          setBookingsView({ phase: 'error', message: toBookingError(err).message });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [user.id, bookingsReloadKey]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const updatedUser = await userService.updateProfile({
        name: formData.name,
        phone: formData.phone,
        bio: formData.bio,
        preferences: formData.preferences
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
      });

      onUpdate(updatedUser);
      setIsEditing(false);
      setMessage({ type: 'success', text: 'Profile updated successfully!' });
      setTimeout(() => setMessage(null), 3000);
    } catch {
      setMessage({ type: 'error', text: 'Failed to update profile.' });
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-12 font-sans">
      <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden shadow-sm">
        <div className="h-44 bg-gradient-to-r from-neutral-950 via-neutral-900 to-orange-800 relative flex items-end">
          <div className="absolute inset-0 bg-black/30"></div>

          <div className="relative z-10 w-full px-8 pb-6 flex justify-between items-end">
            <div>
              <h1 className="text-4xl font-black text-white uppercase tracking-tight">
                {user.name}
              </h1>
              <p className="text-neutral-300 font-bold text-xs uppercase tracking-widest mt-2">
                {user.email}
              </p>
            </div>

            {!isEditing && (
              <button
                onClick={() => setIsEditing(true)}
                className="px-6 py-3 bg-white text-black rounded-md font-black uppercase tracking-wider hover:bg-orange-500 hover:text-white transition-all duration-200 shadow-lg"
              >
                Edit Profile
              </button>
            )}
          </div>
        </div>

        <div className="px-8 py-10">
          {message && (
            <div
              role={message.type === 'error' ? 'alert' : 'status'}
              className={`mb-6 p-3 rounded-md text-sm font-bold ${
                message.type === 'success'
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-red-50 text-red-700 border border-red-200'
              }`}
            >
              {message.text}
            </div>
          )}

          {isEditing ? (
            <form onSubmit={handleSubmit} className="space-y-6">
              <input
                name="name"
                aria-label="Name"
                autoComplete="name"
                value={formData.name}
                onChange={handleChange}
                className="w-full border border-neutral-200 rounded-md p-3 focus:outline-none focus:border-orange-500"
                placeholder="Name"
              />
              <input
                name="phone"
                aria-label="Phone"
                autoComplete="tel"
                value={formData.phone}
                onChange={handleChange}
                className="w-full border border-neutral-200 rounded-md p-3 focus:outline-none focus:border-orange-500"
                placeholder="Phone"
              />
              <textarea
                name="bio"
                aria-label="Bio"
                value={formData.bio}
                onChange={handleChange}
                className="w-full border border-neutral-200 rounded-md p-3 focus:outline-none focus:border-orange-500"
                placeholder="Bio"
              />
              <input
                name="preferences"
                aria-label="Preferences, comma separated"
                value={formData.preferences}
                onChange={handleChange}
                className="w-full border border-neutral-200 rounded-md p-3 focus:outline-none focus:border-orange-500"
                placeholder="Preferences (comma separated)"
              />

              <div className="flex gap-4">
                <button
                  type="submit"
                  className="px-6 py-2 bg-orange-600 text-white rounded-md font-bold uppercase tracking-wider hover:bg-orange-700 transition"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="px-6 py-2 bg-neutral-200 rounded-md font-bold uppercase tracking-wider hover:bg-neutral-300 transition"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <section>
              <h3 className="text-xs font-black text-neutral-400 uppercase tracking-widest mb-6">
                Booking History
              </h3>

              <div className="space-y-6" aria-live="polite">
                {bookingsView.phase === 'loading' && (
                  <div className="text-center py-10">
                    <p className="text-neutral-400 text-sm font-bold uppercase tracking-wide">
                      Loading your bookings…
                    </p>
                  </div>
                )}

                {bookingsView.phase === 'error' && (
                  <div role="alert" className="text-center py-10">
                    <p className="text-red-600 text-sm font-bold uppercase tracking-wide">
                      {bookingsView.message}
                    </p>
                    <button
                      onClick={() => setBookingsReloadKey(k => k + 1)}
                      className="mt-4 px-6 py-2 bg-black text-white rounded-md text-xs font-black uppercase tracking-widest hover:bg-orange-600 transition"
                    >
                      Retry
                    </button>
                  </div>
                )}

                {bookingsView.phase === 'ready' && bookingsView.bookings.length === 0 && (
                  <div className="text-center py-10">
                    <p className="text-neutral-400 text-sm font-bold uppercase tracking-wide">
                      You have no bookings yet.
                    </p>
                  </div>
                )}

                {bookingsView.phase === 'ready' &&
                  bookingsView.bookings.map((booking) => {
                    const status = effectiveStatus(booking);

                    const presentation: Record<string, { color: string; label: string }> = {
                      pending_payment: {
                        color: 'text-amber-700 bg-amber-100 border-amber-200',
                        label: booking.expiresAt
                          ? `Held until ${new Date(booking.expiresAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit'
                            })}`
                          : 'Held'
                      },
                      confirmed: {
                        color: 'text-emerald-700 bg-emerald-100 border-emerald-200',
                        label: 'Confirmed'
                      },
                      completed: {
                        color: 'text-neutral-700 bg-neutral-100 border-neutral-200',
                        label: 'Completed'
                      },
                      expired: {
                        color: 'text-neutral-500 bg-neutral-100 border-neutral-200',
                        label: 'Expired'
                      },
                      cancelled: {
                        color: 'text-red-700 bg-red-100 border-red-200',
                        label: 'Cancelled'
                      }
                    };
                    const { color, label } = presentation[status];

                    return (
                      <div
                        key={booking.id}
                        className="relative bg-white border border-neutral-200 rounded-xl p-6 transition-all hover:shadow-md hover:border-neutral-300 group"
                      >
                        <div className="flex justify-between items-start gap-4">
                          <div className="min-w-0">
                            <h3 className="text-xl font-black uppercase tracking-tight text-neutral-900 mb-1 break-words">
                              {booking.facilityName ?? 'Venue'}
                            </h3>

                            {booking.facilityLocation && (
                              <button
                                type="button"
                                onClick={() => openDirections(booking.facilityLocation as string)}
                                className="text-left text-xs uppercase tracking-widest text-neutral-400 mb-3 hover:text-orange-500 transition flex items-center gap-1"
                              >
                                <i className="fas fa-map-marker-alt text-[10px]" aria-hidden="true"></i>
                                {booking.facilityLocation}
                                <i className="fas fa-external-link-alt text-[9px] opacity-50" aria-hidden="true"></i>
                              </button>
                            )}

                            <p className="text-sm font-medium text-neutral-600">
                              <span className="text-orange-600 font-bold">
                                {booking.bookingDate}
                              </span>
                              <span className="mx-2">•</span>
                              {booking.timeLabel}
                              <span className="mx-2">•</span>
                              ₹{booking.amount}
                            </p>
                          </div>

                          <span
                            className={`shrink-0 text-[11px] font-black uppercase tracking-widest px-3 py-1 rounded-full border ${color}`}
                          >
                            {label}
                          </span>
                        </div>

                        <div className="absolute bottom-0 left-0 h-1 w-0 bg-orange-500 group-hover:w-full transition-all duration-300 rounded-b-xl"></div>
                      </div>
                    );
                  })}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};

export default UserProfile;