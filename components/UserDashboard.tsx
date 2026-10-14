import React, { useState, useEffect, useRef } from 'react';
import {
  facilityRepository,
  FacilityLoadError,
  AvailabilityLoadError
} from '../services/facilityRepository';
import {
  getLeaveControl,
  getSlotAction,
  getWaitlistAction,
  holdsSlot,
  showsOwnHold,
  AvailabilityView
} from '../services/slotAvailability';
import { clearFinishedFlow } from '../services/actionNotice';
import {
  cityKey,
  deriveCityOptions,
  filterByCity,
  inCity,
  labelForCity
} from '../services/cityFilter';
import {
  DEFAULT_CITY,
  loadCityPreference,
  resolveSelectedCity,
  saveCityPreference
} from '../services/cityPreference';
import { createSingleFlight } from '../services/singleFlight';
import {
  bookingRepository,
  BookingError,
  RESERVATIONS_ENABLED,
  effectiveStatus,
  toBookingError,
  UserBooking
} from '../services/bookingRepository';
import {
  waitlistRepository,
  toWaitlistError,
  effectiveWaitlistStatus,
  WaitlistEntry
} from '../services/waitlistRepository';
import { userService } from '../services/userService';
import { Facility, Slot, User, AIRecommendation, SelectedAmenity } from '../types';

interface UserDashboardProps {
  user: User;
}

const UserDashboard: React.FC<UserDashboardProps> = ({ user }) => {
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [selectedFacility, setSelectedFacility] = useState<Facility | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [allSlots, setAllSlots] = useState<Slot[]>([]);

  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [selectedSport, setSelectedSport] = useState<string>('All');
  // The chosen city's display name. Matching always goes through the
  // normalised key (see services/cityFilter), so every spelling of a
  // city selects the same venues.
  // Starts from the city this customer last chose, if any; it is checked
  // against the catalog when that loads.
  const [selectedCityName, setSelectedCityName] = useState<string>(
    () => loadCityPreference(user.id) ?? DEFAULT_CITY
  );
  const selectedCity = cityKey(selectedCityName);
  // The signed-in user's real bookings, read from the database.
  const [bookingsView, setBookingsView] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; bookings: UserBooking[] }
  >({ phase: 'loading' });
  const [bookingsReloadKey, setBookingsReloadKey] = useState(0);

  // Reservation request state. The single-flight guard is the
  // synchronous lock that stops a double click or double tap from
  // sending two requests before React has re-rendered the disabled
  // button.
  const reservationGuard = useRef(createSingleFlight());
  const [bookingFlow, setBookingFlow] = useState<
    | { phase: 'idle' }
    | { phase: 'submitting'; slotId: string }
    | {
        phase: 'success';
        facilityName: string;
        date: string;
        time: string;
        amount: number;
        expiresAt: string;
      }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' });

  // The signed-in user's real waitlist entries, read from the database.
  const [waitlistView, setWaitlistView] = useState<
    | { phase: 'loading' }
    | { phase: 'error'; message: string }
    | { phase: 'ready'; entries: WaitlistEntry[] }
  >({ phase: 'loading' });
  const [waitlistReloadKey, setWaitlistReloadKey] = useState(0);

  // One waitlist mutation (join, leave or accept) at a time, enforced
  // synchronously so a double click cannot send it twice.
  const waitlistGuard = useRef(createSingleFlight());
  const [waitlistFlow, setWaitlistFlow] = useState<
    | { phase: 'idle' }
    | { phase: 'submitting'; target: string }
    | { phase: 'success'; message: string }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' });

  // Re-render clock so offers and holds visibly lapse without a reload.
  const [clock, setClock] = useState(() => Date.now());
  const [recommendations, setRecommendations] = useState<AIRecommendation[]>([]);
  const [loadingRecs, setLoadingRecs] = useState(false);

  // Facility/slot catalog loaded from Supabase (no mock fallback).
  const [catalogStatus, setCatalogStatus] =
    useState<'loading' | 'ready' | 'error'>('loading');
  const [catalogError, setCatalogError] = useState<string>('');
  const [reloadKey, setReloadKey] = useState(0);

  // Slot availability for the open facility and selected date, decided
  // by the database (get_slot_availability). A snapshot, not a
  // reservation. Never derived from mock bookings, never defaulted to
  // "available" when it cannot be read.
  //
  // The stored answer carries the facility/date/retry it was read for.
  // Any other combination is treated as "loading", so for the moment
  // between a date change and the next read the previous date's
  // statuses are never shown (or acted on) for the new one.
  const [availabilityReloadKey, setAvailabilityReloadKey] = useState(0);
  const [availabilityState, setAvailabilityState] = useState<{
    key: string;
    view: AvailabilityView;
  }>({ key: '', view: { phase: 'idle' } });

  const availabilityKey = selectedFacility
    ? `${selectedFacility.id}|${selectedDate}|${availabilityReloadKey}`
    : '';

  const availability: AvailabilityView = !selectedFacility
    ? { phase: 'idle' }
    : availabilityState.key === availabilityKey
    ? availabilityState.view
    : { phase: 'loading' };

  // Selector options come from the real catalog, so a venue in any city
  // an owner entered can be found. The current selection is always
  // included so the control never shows a value it cannot hold.
  const cityOptions = deriveCityOptions(facilities, selectedCityName);
  const selectedCityLabel = labelForCity(cityOptions, selectedCity);

  const openDirections = (location: string) => {
    const encoded = encodeURIComponent(location);
    const url = `https://www.google.com/maps/search/?api=1&query=${encoded}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  /* for geolocation mapping */
  const cityCoordinates: Record<string, { latitude: number; longitude: number }> = {
  Chennai: { latitude: 13.0827, longitude: 80.2707 },
  Mumbai: { latitude: 19.0760, longitude: 72.8777 },
  Delhi: { latitude: 28.6139, longitude: 77.2090 },
  Kolkata: { latitude: 22.5726, longitude: 88.3639 },
  Jaipur: { latitude: 26.9124, longitude: 75.7873 },
  Bangalore: { latitude: 12.9716, longitude: 77.5946 },
  Hyderabad: { latitude: 17.3850, longitude: 78.4867 },
  Trivandrum: { latitude: 8.5241, longitude: 76.9366 }
};

const calculateDistanceKm = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
) => {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const R = 6371;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};


 // Real facilities and slots. A failure is shown with a Retry action;
 // it is never replaced with mock data.
 useEffect(() => {
  let cancelled = false;

  setCatalogStatus('loading');
  setCatalogError('');

  facilityRepository
    .loadCustomerCatalog()
    .then(catalog => {
      if (cancelled) return;
      setFacilities(catalog.facilities);
      setAllSlots(catalog.slots);
      // A remembered city the catalog no longer has falls back to an
      // available one; an empty catalog leaves the selection alone.
      setSelectedCityName(current =>
        resolveSelectedCity(deriveCityOptions(catalog.facilities), current)
      );
      setCatalogStatus('ready');
    })
    .catch(err => {
      if (cancelled) return;
      setFacilities([]);
      setAllSlots([]);
      setCatalogError(
        err instanceof FacilityLoadError
          ? err.message
          : 'Could not load facilities. Please try again.'
      );
      setCatalogStatus('error');
    });

  return () => {
    cancelled = true;
  };
}, [user.id, reloadKey]);

 // Availability of the open facility's slots on the selected date.
 // Re-read whenever the facility or the date changes, and on Retry.
 useEffect(() => {
  if (!selectedFacility) return;

  let cancelled = false;
  const key = availabilityKey;

  facilityRepository
    .loadSlotAvailability(selectedFacility.id, selectedDate)
    .then(byId => {
      if (cancelled) return;
      setAvailabilityState({ key, view: { phase: 'ready', byId } });
    })
    .catch(err => {
      if (cancelled) return;
      setAvailabilityState({
        key,
        view: {
          phase: 'error',
          message:
            err instanceof AvailabilityLoadError
              ? err.message
              : 'Could not check slot availability. Please try again.'
        }
      });
    });

  return () => {
    cancelled = true;
  };
}, [user.id, selectedFacility?.id, selectedDate, availabilityReloadKey]);

  // Real bookings, read through the repository. Reloaded after every
  // reservation attempt and on Retry.
  useEffect(() => {
    let cancelled = false;

    // Keep the last answer while it is refreshed. Dropping to "loading"
    // would briefly forget which slots the user already holds, and the
    // slot rows would flicker back to offering the waitlist.
    setBookingsView(prev => (prev.phase === 'ready' ? prev : { phase: 'loading' }));

    bookingRepository
      .loadMyBookings()
      .then(bookings => {
        if (cancelled) return;
        setBookingsView({ phase: 'ready', bookings });
      })
      .catch(err => {
        if (cancelled) return;
        setBookingsView({ phase: 'error', message: toBookingError(err).message });
      });

    return () => {
      cancelled = true;
    };
  }, [user.id, bookingsReloadKey]);

  // Real waitlist entries, through the repository. Refreshed after every
  // mutation, on Retry and once a minute, because offers are issued by
  // a scheduled job and appear asynchronously.
  useEffect(() => {
    let cancelled = false;

    setWaitlistView(prev => (prev.phase === 'ready' ? prev : { phase: 'loading' }));

    waitlistRepository
      .loadMyWaitlist()
      .then(entries => {
        if (cancelled) return;
        setWaitlistView({ phase: 'ready', entries });
      })
      .catch(err => {
        if (cancelled) return;
        setWaitlistView({
          phase: 'error',
          message: toWaitlistError(err, 'join').message
        });
      });

    return () => {
      cancelled = true;
    };
  }, [user.id, waitlistReloadKey]);

  useEffect(() => {
    const poll = setInterval(() => setWaitlistReloadKey(k => k + 1), 60_000);
    const tick = setInterval(() => setClock(Date.now()), 15_000);

    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  // Deterministic recommendations from the user's real booking history.
  useEffect(() => {
    if (bookingsView.phase !== 'ready') {
      setRecommendations([]);
      return;
    }

    const counted = bookingsView.bookings.filter(b => {
      const status = effectiveStatus(b);
      return status === 'confirmed' || status === 'completed';
    });

    if (counted.length === 0) {
      setRecommendations([]);
      return;
    }

    const sportFrequency: Record<string, number> = {};

    counted.forEach(b => {
      const sport =
        b.sport ?? facilities.find(f => f.id === b.facilityId)?.sport;
      if (sport) sportFrequency[sport] = (sportFrequency[sport] || 0) + 1;
    });

    const favoriteSport = Object.entries(sportFrequency)
      .sort((a, b) => b[1] - a[1])[0]?.[0];

    if (!favoriteSport) {
      setRecommendations([]);
      return;
    }

    setRecommendations(
      facilities
        .filter(f => f.sport === favoriteSport && inCity(f, selectedCity))
        .slice(0, 3)
        .map(f => ({
          facilityId: f.id,
          score: 80,
          basis: ['Past Bookings'],
          reasoning: `You frequently book ${favoriteSport}.`,
          confidence: 'High' as const
        }))
    );
  }, [bookingsView, selectedCity, facilities]);

  // Number of live holds the user has on the open facility and date,
  // judged by the clock. Null while the bookings are not known.
  const liveHoldCount: number | null =
    selectedFacility && bookingsView.phase === 'ready'
      ? bookingsView.bookings.filter(
          b =>
            b.facilityId === selectedFacility.id &&
            holdsSlot([b], b.slotId, selectedDate, new Date(clock))
        ).length
      : null;

  // When a hold lapses the slot becomes free on the server, but the
  // availability snapshot still says "booked". Re-read it so the row
  // returns to "Book" instead of waiting for the next manual refresh.
  const holdScope = useRef({ scope: '', count: 0 });
  useEffect(() => {
    if (liveHoldCount === null) return;

    const scope = `${selectedFacility?.id ?? ''}|${selectedDate}`;
    if (holdScope.current.scope === scope && liveHoldCount < holdScope.current.count) {
      setAvailabilityReloadKey(k => k + 1);
    }
    holdScope.current = { scope, count: liveHoldCount };
  }, [liveHoldCount, selectedFacility?.id, selectedDate]);

  // A finished notice belongs to the context it was produced in. Clear
  // finished booking and waitlist notices when that context changes
  // (another facility or date, or the picker closing). A request still
  // in flight is left alone and reports its own result.
  const clearFinishedNotices = () => {
    setBookingFlow(prev => clearFinishedFlow(prev, { phase: 'idle' }));
    setWaitlistFlow(prev => clearFinishedFlow(prev, { phase: 'idle' }));
  };

  const handleSelectFacility = (facility: Facility) => {
  clearFinishedNotices();
  setSelectedFacility(facility);

  const facilitySlots = allSlots.filter(s => s.facilityId === facility.id);
  setSlots(facilitySlots);
};

  

const handleBook = async (slot: Slot) => {
  if (reservationGuard.current.busy) return;
  if (!RESERVATIONS_ENABLED) return;
  if (!selectedFacility) return;
  if (slot.isActive === false) return;
  if (!getSlotAction(slot, availability, RESERVATIONS_ENABLED).bookable) return;

  const facility = selectedFacility;
  const date = selectedDate;

  await reservationGuard.current.run(async () => {
    // Starting a reservation makes any earlier waitlist result obsolete.
    setWaitlistFlow(prev => clearFinishedFlow(prev, { phase: 'idle' }));
    setBookingFlow({ phase: 'submitting', slotId: slot.id });

    try {
      // The database decides. The amount, status and hold window in the
      // result come from create_booking(), never from this component.
      const created = await bookingRepository.createBooking({
        facilityId: facility.id,
        slotId: slot.id,
        bookingDate: date
      });

      setBookingFlow({
        phase: 'success',
        facilityName: facility.name,
        date,
        time: slot.time,
        amount: created.amount,
        expiresAt: created.expiresAt
      });
    } catch (err) {
      const failure =
        err instanceof BookingError ? err : toBookingError(err);

      setBookingFlow({ phase: 'error', message: failure.message });
    } finally {
      // Whatever happened, show what the database says now: a slot
      // someone else just took, or the hold that was just created.
      setAvailabilityReloadKey(k => k + 1);
      setBookingsReloadKey(k => k + 1);
    }
  });
};

// Runs one waitlist mutation under the guard. The database decides the
// outcome; the UI reports success only after it answered, and re-reads
// the waitlist, availability and bookings afterwards.
const runWaitlistAction = async (
  target: string,
  operation: 'join' | 'leave' | 'accept',
  action: () => Promise<string>
) => {
  if (waitlistGuard.current.busy) return;

  await waitlistGuard.current.run(async () => {
    // Starting a waitlist action makes any earlier reservation result
    // obsolete.
    setBookingFlow(prev => clearFinishedFlow(prev, { phase: 'idle' }));
    setWaitlistFlow({ phase: 'submitting', target });

    try {
      const message = await action();
      setWaitlistFlow({ phase: 'success', message });
    } catch (err) {
      setWaitlistFlow({
        phase: 'error',
        message: toWaitlistError(err, operation).message
      });
    } finally {
      setWaitlistReloadKey(k => k + 1);
      setAvailabilityReloadKey(k => k + 1);
      setBookingsReloadKey(k => k + 1);
    }
  });
};

const handleJoinWaitlist = (slot: Slot) => {
  if (!selectedFacility) return;
  if (waitlistGuard.current.busy) return;
  if (!getWaitlistAction(slot, availability, false).joinable) return;

  const facilityId = selectedFacility.id;
  const date = selectedDate;

  void runWaitlistAction(`join:${slot.id}`, 'join', async () => {
    const joined = await waitlistRepository.joinWaitlist({
      facilityId,
      slotId: slot.id,
      bookingDate: date
    });

    return joined.entriesAhead === 0
      ? "You're on the waitlist. You will be offered this slot here if it becomes free."
      : `You're on the waitlist with ${joined.entriesAhead} ahead of you. You will be offered this slot here if it becomes free.`;
  });
};

const handleLeaveWaitlist = (entry: WaitlistEntry) => {
  void runWaitlistAction(`leave:${entry.id}`, 'leave', async () => {
    await waitlistRepository.leaveWaitlist(entry.id);
    return 'You have left the waitlist.';
  });
};

const handleAcceptOffer = (entry: WaitlistEntry) => {
  void runWaitlistAction(`accept:${entry.id}`, 'accept', async () => {
    const accepted = await waitlistRepository.acceptOffer(entry.id);
    const until = new Date(accepted.expiresAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });

    return `Offer accepted. The slot is held until ${until} for ₹${accepted.amount}. Payment is not available yet, so the hold expires automatically.`;
  });
};

// Entries the user can still act on, judged by the clock.
const activeWaitlist: WaitlistEntry[] =
  waitlistView.phase === 'ready'
    ? waitlistView.entries.filter(e => {
        const status = effectiveWaitlistStatus(e, new Date(clock));
        return status === 'waiting' || status === 'offered';
      })
    : [];

const listedKeys = new Set(
  activeWaitlist.map(e => `${e.slotId}|${e.bookingDate}`)
);

const waitlistBusy = waitlistFlow.phase === 'submitting';

const waitlistNotice = (
  <div aria-live="polite">
    {waitlistFlow.phase === 'success' && (
      <div role="status" className="mb-4 p-3 bg-emerald-50 border border-emerald-200">
        <p className="text-[10px] font-bold uppercase tracking-wide text-emerald-800">
          {waitlistFlow.message}
        </p>
      </div>
    )}
    {waitlistFlow.phase === 'error' && (
      <div role="alert" className="mb-4 p-3 bg-red-50 border border-red-200">
        <p className="text-[10px] font-bold uppercase tracking-wide text-red-700">
          {waitlistFlow.message}
        </p>
      </div>
    )}
  </div>
);

  // Upcoming bookings, from the database. A live unpaid hold or a
  // confirmed booking on or after today counts; expired and cancelled
  // ones do not. Unpaid holds are judged by the clock, not by status.
  const todayKey = new Date().toISOString().split('T')[0];

  const scheduleBookings: UserBooking[] =
    bookingsView.phase === 'ready'
      ? bookingsView.bookings
          .filter(b => {
            const status = effectiveStatus(b);
            return (
              (status === 'pending_payment' || status === 'confirmed') &&
              b.bookingDate >= todayKey
            );
          })
          .sort((a, b) =>
            `${a.bookingDate} ${a.startTime}`.localeCompare(`${b.bookingDate} ${b.startTime}`)
          )
      : [];

  const upcomingBooking = scheduleBookings.find(
    b => effectiveStatus(b) === 'confirmed'
  );

  const cityFacilities = filterByCity<Facility>(facilities, selectedCity);
  const uniqueSports = ['All', ...Array.from(new Set(cityFacilities.map(f => f.sport)))];
  
const filteredFacilitiesBase =
  selectedSport === 'All'
    ? cityFacilities
    : cityFacilities.filter(f => f.sport === selectedSport);

const currentCityCoords = Object.entries(cityCoordinates).find(
  ([name]) => cityKey(name) === cityKey(selectedCity)
)?.[1];

const filteredFacilities = [...filteredFacilitiesBase].sort((a, b) => {
  if (
    !currentCityCoords ||
    a.latitude == null ||
    a.longitude == null ||
    b.latitude == null ||
    b.longitude == null
  ) {
    return 0;
  }

  const distanceA = calculateDistanceKm(
    currentCityCoords.latitude,
    currentCityCoords.longitude,
    a.latitude,
    a.longitude
  );

  const distanceB = calculateDistanceKm(
    currentCityCoords.latitude,
    currentCityCoords.longitude,
    b.latitude,
    b.longitude
  );

  return distanceA - distanceB;
});

//
const formatDateInput = (date: Date) => {
  return date.toISOString().split('T')[0];
};

const today = new Date();
const maxBookingDate = new Date();
maxBookingDate.setDate(today.getDate() + 30);

const minDate = formatDateInput(today);
const maxDate = formatDateInput(maxBookingDate);

//amenity
const [selectedAmenities, setSelectedAmenities] = useState<SelectedAmenity[]>([]);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 font-sans">
      {/* Header & Location Banner */}
      <div className="flex flex-col md:flex-row justify-between items-end mb-12 gap-6 border-b-2 border-neutral-900 pb-6">
        <div>
           <h2 className="text-5xl font-black text-neutral-900 uppercase tracking-tighter italic">Find Your Court</h2>
           <p className="text-neutral-500 font-medium mt-2 tracking-wide uppercase text-xs">Book elite sports facilities near you.</p>
        </div>
        
        <div className="flex flex-wrap items-center gap-4">
          {/* Location Badge */}
          <div className="bg-neutral-900 text-white px-4 py-2 rounded-lg flex items-center gap-3">
            <i className="fas fa-map-marker-alt text-orange-500"></i>
            <div>
              <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest">Location</p>
              <select 
                aria-label="City"
                value={selectedCity}
                onChange={(e) => {
                  const name =
                    cityOptions.find(o => o.key === e.target.value)?.label ?? e.target.value;
                  setSelectedCityName(name);
                  saveCityPreference(user.id, name);
                }}
                className="bg-transparent text-sm font-bold uppercase tracking-wider outline-none cursor-pointer text-white appearance-none pr-4"
                style={{ backgroundImage: 'none' }}
              >
                {cityOptions.map(option => (
                  <option key={option.key} value={option.key} className="text-black">{option.label}</option>
                ))}
              </select>
            </div>
            <i className="fas fa-chevron-down text-xs text-neutral-500"></i>
          </div>

          <div className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg border-2 border-neutral-200 focus-within:border-orange-500 transition-colors">
             <i className="fas fa-calendar text-neutral-400"></i>
                <input
                  type="date"
                  aria-label="Booking date"
                  className="outline-none text-neutral-900 font-bold uppercase text-sm bg-transparent"
                  value={selectedDate}
                  min={minDate}
                  max={maxDate}
                  onChange={(e) => {
                    setSelectedDate(e.target.value);
                    clearFinishedNotices();
                  }}
                />
          </div>
        </div>
      </div>

      {/* Upcoming Booking Widget */}
      {upcomingBooking && (() => {
  const facility = facilities.find(f => f.id === upcomingBooking.facilityId);
  const facilityName = upcomingBooking.facilityName ?? facility?.name ?? 'Venue';
  const facilityLocation = upcomingBooking.facilityLocation ?? facility?.location;

  return (
    <div className="mb-12 bg-neutral-900 text-white rounded-xl p-8 flex flex-col md:flex-row justify-between items-start md:items-center relative overflow-hidden group gap-6">
      <div className="absolute top-0 right-0 w-64 h-64 bg-orange-500 rounded-full blur-3xl opacity-10 -mr-16 -mt-16 group-hover:opacity-20 transition-opacity"></div>

      <div className="relative z-10 w-full md:w-auto">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-2 h-2 bg-orange-500 rounded-full animate-pulse"></span>
          <p className="text-xs font-bold uppercase tracking-widest text-neutral-400">
            Next Session
          </p>
        </div>

        <h3 className="text-3xl font-black uppercase italic tracking-tighter break-words">
          {facilityName}
        </h3>

        <p className="text-lg font-medium mt-1 text-neutral-300">
          <span className="text-orange-500 font-bold">
            {upcomingBooking.bookingDate}
          </span>
          <span className="mx-2">•</span>
          {upcomingBooking.timeLabel}
        </p>
        {facilityLocation && (
          <button
            onClick={() => openDirections(facilityLocation)}
            className="mt-4 text-xs uppercase tracking-widest text-orange-500 hover:text-orange-400 transition"
          >
            Get Directions →
          </button>
        )}
      </div>

      <div className="relative z-10 bg-neutral-800 p-4 rounded-lg border border-neutral-700 self-end md:self-center">
        <i className="fas fa-ticket-alt text-3xl text-white"></i>
      </div>
    </div>
  );
})()}

      {/* AI Recommendations */}
      {recommendations.length > 0 && (
        <div className="mb-12">
          <div className="flex items-center gap-2 mb-6">
            <i className="fas fa-bolt text-orange-500"></i>
            <h3 className="font-black text-neutral-900 uppercase tracking-tight text-xl">Top Picks For You</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {recommendations.map(rec => {
              const facility = facilities.find(f => f.id === rec.facilityId);
              if (!facility) return null;
              return (
                <div key={rec.facilityId} onClick={() => handleSelectFacility(facility)} className="bg-neutral-50 p-5 rounded-lg border border-neutral-200 cursor-pointer hover:border-orange-500 hover:bg-white transition-all group">
                  <div className="flex justify-between items-start mb-3">
                    <h4 className="font-bold text-neutral-900 uppercase tracking-tight group-hover:text-orange-600 transition-colors">{facility.name}</h4>
                  </div>
                  <p className="text-xs text-neutral-500 mb-4 font-medium uppercase tracking-wide line-clamp-2">{rec.reasoning}</p>
                  <div className="flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-wider">
                    <span className={`px-2 py-1 rounded-sm ${rec.confidence === 'High' ? 'bg-emerald-100 text-emerald-800' : 'bg-neutral-200 text-neutral-600'}`}>
                      {rec.confidence} Match
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Modal for Facility Details & Booking */}
      {selectedFacility && (
  <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
    <div
      className="absolute inset-0 bg-neutral-900/90 backdrop-blur-sm"
      onClick={() => {
        setSelectedFacility(null);
        setSelectedAmenities([]);
        clearFinishedNotices();
  }}
    ></div>

    <div className="relative bg-white w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col md:flex-row shadow-2xl animate-in zoom-in-95 duration-200 rounded-xl">

      {/* Close Button */}
      <button
        aria-label="Close facility details"
        onClick={() => {
          setSelectedFacility(null);
          clearFinishedNotices();
        }}
        className="absolute -top-5 -right-5 z-30 bg-black text-white w-11 h-11 flex items-center justify-center rounded-full hover:bg-orange-600 transition-all duration-200 shadow-xl border-2 border-white"
      >
        <i className="fas fa-times text-sm"></i>
      </button>

            {/* Left Side: Image & Info */}
            <div className="md:w-5/12 bg-black relative">
              <div className="h-64 md:h-full opacity-80">
                <img 
                  src={selectedFacility.imageUrl} 
                  alt={selectedFacility.name} 
                  onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                  className="w-full h-full object-cover grayscale hover:grayscale-0 transition-all duration-700"
                />
              </div>
              <div className="absolute bottom-0 left-0 p-8 w-full bg-gradient-to-t from-black via-black/80 to-transparent">
                <span className="bg-orange-600 text-white text-xs font-black uppercase px-2 py-1 mb-3 inline-block tracking-widest">
                    {selectedFacility.sport}
                </span>
                <h3 className="text-4xl font-black text-white uppercase italic tracking-tighter leading-none mb-2">{selectedFacility.name}</h3>
                <p
                  onClick={() => openDirections(selectedFacility.location)}
                  className="text-neutral-400 font-medium uppercase tracking-wide text-xs flex items-center gap-2 cursor-pointer hover:text-orange-500 transition"
                >
                  <i className="fas fa-map-marker-alt"></i>
                  {selectedFacility.location}
                  <i className="fas fa-external-link-alt text-[9px] opacity-60"></i>
                </p>
              </div>
            </div>

            {/* Right Side: Content */}
            <div className="md:w-7/12 bg-white flex flex-col h-[90vh] max-h-[90vh]">
              <div className="p-8 border-b border-neutral-100">
                <div className="flex items-center justify-between mb-6">
                   <h4 className="font-black text-2xl text-neutral-900 uppercase tracking-tighter">Select Time Slot</h4>
                   <div className="text-right">
                      <p className="text-xs font-bold text-neutral-400 uppercase tracking-widest">Date</p>
                      <p className="font-bold text-neutral-900">{selectedDate}</p>
                   </div>
                </div>

        </div>

              {/* Slots List */}
              {/* Slots List + Amenities */}
              <div className="flex-1 overflow-y-auto p-8 pt-4 min-h-0">
                <div className="mb-4 p-3 bg-neutral-50 border border-neutral-200 text-[10px] font-bold uppercase tracking-wide text-neutral-500">
                  Reserving holds a slot for 10 minutes. Online payment is not
                  available yet, so an unpaid reservation expires automatically.
                </div>
                <div aria-live="polite">
                  {bookingFlow.phase === 'success' && (
                    <div
                      role="status"
                      className="mb-4 p-4 bg-emerald-50 border border-emerald-200"
                    >
                      <p className="text-xs font-black uppercase tracking-wide text-emerald-800">
                        Slot reserved
                      </p>
                      <p className="text-xs font-bold text-emerald-700 mt-1">
                        {bookingFlow.facilityName} · {bookingFlow.date} · {bookingFlow.time}
                      </p>
                      <p className="text-[10px] font-bold uppercase tracking-wide text-emerald-700 mt-2">
                        Held until{' '}
                        {new Date(bookingFlow.expiresAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit'
                        })}{' '}
                        · ₹{bookingFlow.amount} · payment is not available yet
                      </p>
                    </div>
                  )}
                  {bookingFlow.phase === 'error' && (
                    <div
                      role="alert"
                      className="mb-4 p-3 bg-red-50 border border-red-200"
                    >
                      <p className="text-[10px] font-bold uppercase tracking-wide text-red-700">
                        {bookingFlow.message}
                      </p>
                    </div>
                  )}
                </div>
                {waitlistNotice}
                {availability.phase === 'error' && (
                  <div className="mb-4 p-3 bg-red-50 border border-red-200 flex items-center justify-between gap-4">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-red-700">
                      {availability.message}
                    </p>
                    <button
                      onClick={() => setAvailabilityReloadKey(k => k + 1)}
                      className="px-4 py-2 bg-black text-white text-[10px] font-black uppercase tracking-widest rounded-md hover:bg-orange-600 transition-all"
                    >
                      Retry
                    </button>
                  </div>
                )}
                <div className="space-y-3">
                  {slots.length > 0 ? (
                    slots.map(s => {
                      const action = getSlotAction(
                        s,
                        availability,
                        RESERVATIONS_ENABLED
                      );
                      const booked = action.muted;
                      const isSubmitting = bookingFlow.phase === 'submitting';
                      const isThisSlot =
                        bookingFlow.phase === 'submitting' && bookingFlow.slotId === s.id;
                      const canBook = action.bookable && !isSubmitting;
                      // The user's own bookings decide whether the waitlist
                      // makes sense. While they are still loading the control
                      // stays hidden; the database refuses a join regardless.
                      const ownHold =
                        bookingsView.phase === 'ready' &&
                        holdsSlot(bookingsView.bookings, s.id, selectedDate, new Date(clock));
                      const waitlistAction = getWaitlistAction(
                        s,
                        availability,
                        listedKeys.has(`${s.id}|${selectedDate}`),
                        ownHold || bookingsView.phase === 'loading'
                      );
                      const ownHoldLabel = showsOwnHold(s, availability, ownHold);
                      const joining =
                        waitlistFlow.phase === 'submitting' &&
                        waitlistFlow.target === `join:${s.id}`;
                      const canJoin = waitlistAction.joinable && !waitlistBusy;
                      // Leave from the row itself: the open modal covers the
                      // "Your waitlist" list, which holds the other Leave.
                      const leaveControl = getLeaveControl(
                        s,
                        activeWaitlist,
                        selectedDate,
                        waitlistFlow.phase === 'submitting' ? waitlistFlow.target : null
                      );

                      return (
                        <div
                          key={s.id}
                          className={`group p-4 rounded-lg border-2 transition-all flex items-center justify-between ${
                            booked
                              ? 'bg-neutral-100 border-transparent opacity-50'
                              : 'bg-white border-neutral-100 hover:border-black'
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-3">
                              <span className="text-lg font-black text-neutral-900">
                                {s.time}
                              </span>
                            </div>
                          </div>

                          <div className="text-right flex items-center gap-4">
                            <div>
                              <p className="font-black text-xl text-neutral-900">
                                ₹{s.price}
                              </p>
                            </div>

                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleBook(s);
                              }}
                              disabled={!canBook}
                              aria-busy={isThisSlot}
                              aria-label={
                                action.bookable
                                  ? `Reserve ${s.time}`
                                  : `${s.time}: ${action.label}`
                              }
                              className={`px-6 py-2 rounded-md text-xs font-black uppercase tracking-widest transition-all ${
                                canBook
                                  ? 'bg-black text-white group-hover:bg-orange-600'
                                  : 'bg-neutral-300 text-neutral-500 cursor-not-allowed'
                              }`}
                            >
                              {isThisSlot ? 'Reserving…' : action.label}
                            </button>

                            {ownHoldLabel && (
                              <span className="px-4 py-2 text-[10px] font-black uppercase tracking-widest text-neutral-500">
                                Your reservation
                              </span>
                            )}

                            {waitlistAction.visible && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleJoinWaitlist(s);
                                }}
                                disabled={!canJoin}
                                aria-busy={joining}
                                aria-label={`${s.time}: ${waitlistAction.label}`}
                                className={`px-4 py-2 rounded-md text-[10px] font-black uppercase tracking-widest border-2 transition-all ${
                                  canJoin
                                    ? 'border-black text-black hover:bg-black hover:text-white'
                                    : 'border-neutral-300 text-neutral-400 cursor-not-allowed'
                                }`}
                              >
                                {joining ? 'Joining…' : waitlistAction.label}
                              </button>
                            )}

                            {leaveControl.visible && leaveControl.entry && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (leaveControl.entry) handleLeaveWaitlist(leaveControl.entry);
                                }}
                                disabled={leaveControl.disabled}
                                aria-busy={leaveControl.busy}
                                aria-label={leaveControl.ariaLabel}
                                className={`px-4 py-2 rounded-md text-[10px] font-black uppercase tracking-widest border-2 transition-all ${
                                  leaveControl.disabled
                                    ? 'border-neutral-300 text-neutral-400 cursor-not-allowed'
                                    : 'border-neutral-300 text-neutral-600 hover:border-red-500 hover:text-red-600'
                                }`}
                              >
                                {leaveControl.label}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-center py-12 border-2 border-dashed border-neutral-200 rounded-lg">
                      <p className="text-neutral-400 font-bold uppercase text-xs tracking-widest">
                        No slots available
                      </p>
                    </div>
                  )}
                </div>

                {/* Amenities Section */}
                {selectedFacility?.amenityOptions &&
                  selectedFacility.amenityOptions.filter(a => a.available !== false).length > 0 && (
                    <div className="mt-8 border-t-2 border-neutral-100 pt-6">
                      <div className="flex items-center justify-between mb-4">
                        <h4 className="font-black text-lg text-neutral-900 uppercase tracking-tight">
                          Add Amenities
                        </h4>
                        <span className="text-[10px] font-black uppercase tracking-widest text-neutral-400">
                          Optional add-ons
                        </span>
                      </div>

                      <div className="space-y-3">
                        {selectedFacility.amenityOptions
                          .filter(a => a.available !== false)
                          .map(amenity => {
                            const existing = selectedAmenities.find(
                              a => a.amenityId === amenity.id
                            );
                            const quantity = existing?.quantity || 0;

                            return (
                              <div
                                key={amenity.id}
                                className="flex items-center justify-between p-4 rounded-lg border border-neutral-200 bg-neutral-50"
                              >
                                <div>
                                  <p className="font-black text-xs uppercase tracking-wide text-neutral-900">
                                    {amenity.name}
                                  </p>
                                  <p className="text-[10px] text-neutral-500 font-bold uppercase tracking-wide mt-1">
                                    {amenity.type} • ₹{amenity.price}
                                    {amenity.unit ? ` / ${amenity.unit}` : ''}
                                  </p>
                                </div>

                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedAmenities(prev =>
                                        prev
                                          .map(item =>
                                            item.amenityId === amenity.id
                                              ? { ...item, quantity: item.quantity - 1 }
                                              : item
                                          )
                                          .filter(item => item.quantity > 0)
                                      );
                                    }}
                                    className="w-8 h-8 rounded-md bg-white border border-neutral-200 text-neutral-700 font-black hover:border-neutral-400"
                                  >
                                    -
                                  </button>

                                  <span className="w-8 text-center font-black text-sm text-neutral-900">
                                    {quantity}
                                  </span>

                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedAmenities(prev => {
                                        const existingItem = prev.find(
                                          item => item.amenityId === amenity.id
                                        );

                                        if (existingItem) {
                                          return prev.map(item =>
                                            item.amenityId === amenity.id
                                              ? {
                                                  ...item,
                                                  quantity: item.quantity + 1
                                                }
                                              : item
                                          );
                                        }

                                        return [
                                          ...prev,
                                          {
                                            amenityId: amenity.id,
                                            name: amenity.name,
                                            price: amenity.price,
                                            quantity: 1
                                          }
                                        ];
                                      });
                                    }}
                                    className="w-8 h-8 rounded-md bg-neutral-900 text-white font-black hover:bg-orange-600"
                                  >
                                    +
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                      </div>

                      {/* Amenities Summary */}
                      <div className="mt-5 p-4 rounded-lg bg-neutral-900 text-white">
                        <div className="flex justify-between items-center">
                          <span className="text-[10px] font-black uppercase tracking-widest text-neutral-400">
                            Amenities Total
                          </span>
                          <span className="text-lg font-black">
                            ₹
                            {selectedAmenities.reduce(
                              (sum, item) => sum + item.price * item.quantity,
                              0
                            )}
                          </span>
                        </div>

                        {selectedAmenities.length > 0 && (
                          <div className="mt-3 space-y-1">
                            {selectedAmenities.map(item => (
                              <div
                                key={item.amenityId}
                                className="flex justify-between text-xs"
                              >
                                <span>
                                  {item.name} × {item.quantity}
                                </span>
                                <span>₹{item.price * item.quantity}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      
                    </div>
                  )}
              </div>

            </div>
          </div>
        </div>
)}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Facilities List */}
        <div className="lg:col-span-2 space-y-6">
          {/* Sport Filters */}
          <div className="flex overflow-x-auto pb-2 gap-2 scrollbar-hide">
            {uniqueSports.map(sport => (
              <button
                key={sport}
                onClick={() => setSelectedSport(sport)}
                className={`px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider whitespace-nowrap transition-all border-2 ${
                  selectedSport === sport
                    ? 'bg-neutral-900 text-white border-neutral-900'
                    : 'bg-white text-neutral-500 border-neutral-200 hover:border-neutral-900 hover:text-neutral-900'
                }`}
              >
                {sport}
              </button>
            ))}
          </div>

          {catalogStatus === 'loading' && (
            <div className="text-center py-16 border-2 border-dashed border-neutral-200 rounded-xl">
              <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-neutral-900 mx-auto mb-4"></div>
              <p className="text-neutral-400 font-bold uppercase text-xs tracking-widest">
                Loading facilities...
              </p>
            </div>
          )}

          {catalogStatus === 'error' && (
            <div className="text-center py-12 px-6 border-2 border-dashed border-red-200 bg-red-50 rounded-xl">
              <p className="text-red-600 font-bold uppercase text-xs tracking-widest mb-4">
                <i className="fas fa-exclamation-circle mr-2"></i>
                {catalogError}
              </p>
              <button
                onClick={() => setReloadKey(k => k + 1)}
                className="px-6 py-2 rounded-md text-xs font-black uppercase tracking-widest bg-black text-white hover:bg-orange-600 transition-all"
              >
                Retry
              </button>
            </div>
          )}

          {catalogStatus === 'ready' && filteredFacilities.length === 0 && (
            <div className="text-center py-16 border-2 border-dashed border-neutral-200 rounded-xl">
              <p className="text-neutral-400 font-bold uppercase text-xs tracking-widest">
                {facilities.length === 0
                  ? 'No facilities are available yet'
                  : `No facilities found in ${selectedCityLabel}`}
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {catalogStatus === 'ready' && filteredFacilities.map((f) => (
              <div 
                key={f.id} 
                onClick={() => handleSelectFacility(f)}
                className="group bg-white rounded-xl overflow-hidden border-2 border-transparent hover:border-black transition-all cursor-pointer shadow-sm hover:shadow-none"
              >
                <div className="h-56 overflow-hidden relative">
                  <img src={f.imageUrl} alt={f.name} loading="lazy" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition-all duration-500" />
                  <div className="absolute top-4 left-4">
                    <span className="bg-black text-white text-[10px] font-black uppercase px-3 py-1 tracking-widest">
                      {f.sport}
                    </span>
                  </div>
                </div>
                <div className="p-6">
                  <div className="flex justify-between items-start mb-4">
                     <div>
                       <h3 className="font-black text-xl text-neutral-900 uppercase italic tracking-tighter leading-none mb-1">{f.name}</h3>
                       <p className="text-neutral-500 text-xs font-bold uppercase tracking-wide flex items-center gap-1">
                         <i className="fas fa-map-marker-alt text-neutral-300"></i> {f.location}
                       </p>
                       
                       {currentCityCoords && f.latitude != null && f.longitude != null && (
        <p className="text-[10px] text-neutral-400 font-bold uppercase tracking-wide mt-2">
          {calculateDistanceKm(
            currentCityCoords.latitude,
            currentCityCoords.longitude,
            f.latitude,
            f.longitude
          ).toFixed(1)} km away
        </p>
      )}
                     </div>
                  </div>
                  
                  <div className="flex justify-between items-end border-t-2 border-neutral-100 pt-4">
                    <div>
                      <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest mb-0.5">Starting at</p>
                      <span className="font-black text-2xl text-neutral-900">₹{f.basePrice}</span>
                    </div>
                    <span className="text-neutral-900 text-xs font-black uppercase tracking-widest border-b-2 border-black pb-0.5 group-hover:text-orange-600 group-hover:border-orange-600 transition-all">
                      Book Now
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Sidebar: My Bookings Only */}
        {/* Sidebar Schedule */}
        <div>
          <div className="bg-white p-6 rounded-xl border-2 border-neutral-100 sticky top-8">
            <h4 className="font-black uppercase text-lg mb-6">Your Schedule</h4>

            <div className="space-y-4" aria-live="polite">
              {bookingsView.phase === 'loading' && (
                <p className="text-neutral-400 text-xs font-bold uppercase">
                  Loading your bookings…
                </p>
              )}

              {bookingsView.phase === 'error' && (
                <div role="alert" className="p-3 bg-red-50 border border-red-200">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-red-700">
                    {bookingsView.message}
                  </p>
                  <button
                    onClick={() => setBookingsReloadKey(k => k + 1)}
                    className="mt-3 px-4 py-2 bg-black text-white text-[10px] font-black uppercase tracking-widest rounded-md hover:bg-orange-600 transition-all"
                  >
                    Retry
                  </button>
                </div>
              )}

              {bookingsView.phase === 'ready' && scheduleBookings.length === 0 && (
                <p className="text-neutral-400 text-xs font-bold uppercase">
                  No upcoming bookings
                </p>
              )}

              {bookingsView.phase === 'ready' &&
                scheduleBookings.map(b => {
                  const held = effectiveStatus(b) === 'pending_payment';

                  return (
                    <div
                      key={b.id}
                      className="p-4 bg-neutral-50 border border-neutral-200 rounded-lg"
                    >
                      <p className="text-xs font-black text-orange-600 uppercase">
                        {b.bookingDate}
                      </p>

                      <p className="text-sm font-black uppercase italic mt-1">
                        {b.facilityName ?? 'Venue'}
                      </p>

                      <p className="text-xs text-neutral-500 uppercase">
                        {b.timeLabel}
                      </p>

                      <p
                        className={`mt-2 inline-block px-2 py-0.5 rounded-sm text-[9px] font-black uppercase tracking-wider ${
                          held
                            ? 'bg-orange-100 text-orange-700'
                            : 'bg-emerald-100 text-emerald-700'
                        }`}
                      >
                        {held && b.expiresAt
                          ? `Held until ${new Date(b.expiresAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit'
                            })}`
                          : 'Confirmed'}
                      </p>
                    </div>
                  );
                })}
            </div>

            <div className="mt-8 pt-6 border-t-2 border-neutral-100">
              <h4 className="font-black uppercase text-lg mb-6">Your Waitlist</h4>

              {!selectedFacility && waitlistNotice}

              <div className="space-y-4" aria-live="polite">
                {waitlistView.phase === 'loading' && (
                  <p className="text-neutral-400 text-xs font-bold uppercase">
                    Loading your waitlist…
                  </p>
                )}

                {waitlistView.phase === 'error' && (
                  <div role="alert" className="p-3 bg-red-50 border border-red-200">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-red-700">
                      {waitlistView.message}
                    </p>
                    <button
                      onClick={() => setWaitlistReloadKey(k => k + 1)}
                      className="mt-3 px-4 py-2 bg-black text-white text-[10px] font-black uppercase tracking-widest rounded-md hover:bg-orange-600 transition-all"
                    >
                      Retry
                    </button>
                  </div>
                )}

                {waitlistView.phase === 'ready' && activeWaitlist.length === 0 && (
                  <p className="text-neutral-400 text-xs font-bold uppercase">
                    You are not on any waitlist
                  </p>
                )}

                {waitlistView.phase === 'ready' &&
                  activeWaitlist.map(entry => {
                    const offered =
                      effectiveWaitlistStatus(entry, new Date(clock)) === 'offered';
                    const accepting =
                      waitlistFlow.phase === 'submitting' &&
                      waitlistFlow.target === `accept:${entry.id}`;
                    const leaving =
                      waitlistFlow.phase === 'submitting' &&
                      waitlistFlow.target === `leave:${entry.id}`;

                    return (
                      <div
                        key={entry.id}
                        className={`p-4 rounded-lg border ${
                          offered
                            ? 'bg-orange-50 border-orange-200'
                            : 'bg-neutral-50 border-neutral-200'
                        }`}
                      >
                        <p className="text-xs font-black text-orange-600 uppercase">
                          {entry.bookingDate}
                        </p>
                        <p className="text-sm font-black uppercase italic mt-1">
                          {entry.facilityName ?? 'Venue'}
                        </p>
                        {entry.timeLabel && (
                          <p className="text-xs text-neutral-500 uppercase">
                            {entry.timeLabel}
                          </p>
                        )}

                        <p
                          className={`mt-2 inline-block px-2 py-0.5 rounded-sm text-[9px] font-black uppercase tracking-wider ${
                            offered
                              ? 'bg-orange-100 text-orange-700'
                              : 'bg-neutral-200 text-neutral-600'
                          }`}
                        >
                          {offered && entry.offerExpiresAt
                            ? `Offer open until ${new Date(entry.offerExpiresAt).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit'
                              })}`
                            : 'Waiting'}
                        </p>

                        {offered && (
                          <p className="mt-2 text-[10px] font-bold uppercase tracking-wide text-neutral-500">
                            Accepting holds the slot for 10 minutes. Payment is
                            not available yet.
                          </p>
                        )}

                        <div className="mt-3 flex gap-2">
                          {offered && (
                            <button
                              onClick={() => handleAcceptOffer(entry)}
                              disabled={waitlistBusy}
                              aria-busy={accepting}
                              className={`px-4 py-2 rounded-md text-[10px] font-black uppercase tracking-widest transition-all ${
                                waitlistBusy
                                  ? 'bg-neutral-300 text-neutral-500 cursor-not-allowed'
                                  : 'bg-black text-white hover:bg-orange-600'
                              }`}
                            >
                              {accepting ? 'Accepting…' : 'Accept offer'}
                            </button>
                          )}
                          <button
                            onClick={() => handleLeaveWaitlist(entry)}
                            disabled={waitlistBusy}
                            aria-busy={leaving}
                            className={`px-4 py-2 rounded-md text-[10px] font-black uppercase tracking-widest border-2 transition-all ${
                              waitlistBusy
                                ? 'border-neutral-300 text-neutral-400 cursor-not-allowed'
                                : 'border-neutral-300 text-neutral-600 hover:border-red-500 hover:text-red-600'
                            }`}
                          >
                            {leaving ? 'Leaving…' : 'Leave'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};

export default UserDashboard;