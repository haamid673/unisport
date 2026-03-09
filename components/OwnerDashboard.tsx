// import React, { useState, useEffect } from 'react';
// import { facilityService } from '../services/facilityService';
// import { getAllBookings } from '../services/bookingService';
// import { Facility, Slot, User, Booking } from '../types';

// interface OwnerDashboardProps {
//   user: User;
// }

// const OwnerDashboard: React.FC<OwnerDashboardProps> = ({ user }) => {
//   const [myFacilities, setMyFacilities] = useState<Facility[]>([]);
//   const [selectedFac, setSelectedFac] = useState<Facility | null>(null);
//   const [facSlots, setFacSlots] = useState<Slot[]>([]);
//   const [allBookings, setAllBookings] = useState<Booking[]>([]);

//   useEffect(() => {
//     refreshData();
//   }, [user.id]);

//   const refreshData = () => {
//     const facilities = facilityService
//       .getAllFacilities(true)
//       .filter(f => f.ownerId === user.id);

//     setMyFacilities(facilities);
//     setAllBookings(getAllBookings());

//     if (selectedFac) {
//       setFacSlots(
//         facilityService.getSlotsByFacility(selectedFac.id)
//       );
//     }
//   };

//   /* =====================================
//      DEMAND ANALYSIS
//   ====================================== */

//   const analyzeDemand = (slotId: string) => {
//     const confirmed = allBookings.filter(
//       b => b.slotId === slotId && b.status === "confirmed"
//     );

//     const uniqueDays = [
//       ...new Set(confirmed.map(b => b.bookingDate))
//     ].sort(
//       (a, b) => new Date(b).getTime() - new Date(a).getTime()
//     );

//     if (uniqueDays.length === 0) {
//       return {
//         demandScore: 0,
//         streak: 0,
//         reason: "No booking activity"
//       };
//     }

//     let streak = 1;

//     for (let i = 0; i < uniqueDays.length - 1; i++) {
//       const current = new Date(uniqueDays[i]);
//       const next = new Date(uniqueDays[i + 1]);

//       const diff =
//         (current.getTime() - next.getTime()) /
//         (1000 * 60 * 60 * 24);

//       if (diff === 1) streak++;
//       else break;
//     }

//     const demandScore = Math.min(100, streak * 20);

//     let reason = "Stable demand";
//     if (streak >= 5) reason = `${streak}-day booking streak`;
//     else if (streak >= 3) reason = `Rising trend (${streak} days)`;

//     return { demandScore, streak, reason };
//   };

//   /* =====================================
//      ADAPTIVE SURGE ENGINE
//   ====================================== */

//   const calculateSurgeMultiplier = (demandScore: number) => {
//     const baseSurge = 0.05;   // 5%
//     const surgeRange = 0.15;  // additional up to 15% (max 20%)
//     const surgePercent = baseSurge + (demandScore / 100) * surgeRange;
//     return 1 + surgePercent;
//   };

//   const enableSurge = (slot: Slot) => {
//     const demand = analyzeDemand(slot.id);
//     const multiplier = calculateSurgeMultiplier(demand.demandScore);

//     facilityService.updateSlot(slot.id, {
//       price: Math.round(slot.price * multiplier),
//       surgeEnabled: true,
//       surgeMultiplier: multiplier
//     });

//     refreshData();
//   };

//   const disableSurge = (slot: Slot) => {
//     const original =
//       Math.round(slot.price / (slot.surgeMultiplier || 1));

//     facilityService.updateSlot(slot.id, {
//       price: original,
//       surgeEnabled: false,
//       surgeMultiplier: 1
//     });

//     refreshData();
//   };

//   /* =====================================
//      REVENUE METRICS
//   ====================================== */

//   const facilitySlotIds = facSlots.map(s => s.id);

//   const confirmedBookings = allBookings.filter(
//     b =>
//       facilitySlotIds.includes(b.slotId) &&
//       b.status === "confirmed"
//   );

//   const totalRevenue = confirmedBookings.reduce((sum, b) => {
//     const slot = facSlots.find(s => s.id === b.slotId);
//     return sum + (slot?.price || 0);
//   }, 0);

//   /* =====================================
//      UI
//   ====================================== */

//   return (
//     <div className="max-w-7xl mx-auto px-4 py-8 font-sans">

//       <h2 className="text-5xl font-black uppercase italic mb-12">
//         Owner Dashboard
//       </h2>

//       <div className="grid grid-cols-4 gap-8">

//         {/* Sidebar */}
//         <div className="col-span-1 space-y-4">
//           {myFacilities.map(f => (
//             <div
//               key={f.id}
//               onClick={() => {
//                 setSelectedFac(f);
//                 setFacSlots(
//                   facilityService.getSlotsByFacility(f.id)
//                 );
//               }}
//               className={`p-4 rounded-lg border-2 cursor-pointer ${
//                 selectedFac?.id === f.id
//                   ? 'bg-neutral-900 text-white border-neutral-900'
//                   : 'bg-white border-neutral-200'
//               }`}
//             >
//               <p className="font-bold uppercase">{f.name}</p>
//               <p className="text-xs text-neutral-400">
//                 {f.sport} • {f.location}
//               </p>
//             </div>
//           ))}
//         </div>

//         {/* Main */}
//         <div className="col-span-3 space-y-8">

//           {selectedFac && (
//             <>
//               <div className="bg-white p-6 rounded-lg border-2">
//                 <p className="text-xs text-neutral-400 uppercase">
//                   Estimated Revenue
//                 </p>
//                 <p className="text-3xl font-black">
//                   ₹{totalRevenue.toFixed(2)}
//                 </p>
//               </div>

//               <div className="bg-white p-6 rounded-lg border-2">
//                 <h4 className="font-black uppercase mb-6">
//                   Adaptive Surge Pricing
//                 </h4>

//                 <div className="grid grid-cols-2 gap-4">

//                   {facSlots.map(slot => {
//                     const demand = analyzeDemand(slot.id);
//                     const projectedMultiplier =
//                       calculateSurgeMultiplier(demand.demandScore);

//                     const projectedPercent =
//                       Math.round((projectedMultiplier - 1) * 100);

//                     return (
//                       <div
//                         key={slot.id}
//                         className="p-4 rounded-lg border-2 bg-neutral-50"
//                       >
//                         <p className="font-black uppercase">
//                           {slot.time}
//                         </p>

//                         <p className="text-lg mt-1">
//                           ₹{slot.price}
//                         </p>

//                         <p className="text-[9px] mt-2 uppercase font-bold text-neutral-400">
//                           Demand Score: {demand.demandScore}%
//                         </p>

//                         <p className="text-[9px] text-neutral-500">
//                           {demand.reason}
//                         </p>

//                         {!slot.surgeEnabled && (
//                           <>
//                             <p className="text-[10px] text-orange-600 font-black uppercase mt-3">
//                               Suggested Surge: +{projectedPercent}%
//                             </p>

//                             <button
//                               onClick={() => enableSurge(slot)}
//                               className="mt-3 px-5 py-2 rounded-xl bg-neutral-900 text-white text-[10px] font-black uppercase tracking-widest
//                                          border-2 border-neutral-900
//                                          hover:bg-orange-600 hover:border-orange-700
//                                          transition-all duration-150 active:scale-95"
//                             >
//                               Enable Surge
//                             </button>
//                           </>
//                         )}

//                         {slot.surgeEnabled && (
//                           <button
//                             onClick={() => disableSurge(slot)}
//                             className="mt-3 px-5 py-2 rounded-xl bg-white text-red-600 text-[10px] font-black uppercase tracking-widest
//                                        border-2 border-red-600
//                                        hover:bg-red-600 hover:text-white
//                                        transition-all duration-150 active:scale-95"
//                           >
//                             Disable Surge
//                           </button>
//                         )}
//                       </div>
//                     );
//                   })}

//                 </div>
//               </div>
//             </>
//           )}

//         </div>
//       </div>
//     </div>
//   );
// };

// export default OwnerDashboard;



import React, { useState, useEffect } from 'react';
import { facilityService } from '../services/facilityService';
import { getAllBookings } from '../services/bookingService';
import { Facility, Slot, User, Booking } from '../types';

interface OwnerDashboardProps {
  user: User;
}

const OwnerDashboard: React.FC<OwnerDashboardProps> = ({ user }) => {
  const [myFacilities, setMyFacilities] = useState<Facility[]>([]);
  const [selectedFac, setSelectedFac] = useState<Facility | null>(null);
  const [facSlots, setFacSlots] = useState<Slot[]>([]);
  const [allBookings, setAllBookings] = useState<Booking[]>([]);

  const [showAddSlotModal, setShowAddSlotModal] = useState(false);
  const [showNewVenueModal, setShowNewVenueModal] = useState(false);
  const [showEditSlotModal, setShowEditSlotModal] = useState(false);
  const [editingSlot, setEditingSlot] = useState<Slot | null>(null);

  const [slotForm, setSlotForm] = useState({
    startTime: '06:00 AM',
    endTime: '07:00 AM',
    price: ''
  });

  const [venueForm, setVenueForm] = useState({
    name: '',
    sport: 'Football',
    location: '',
    basePrice: '',
    imageUrl: ''
  });

  useEffect(() => {
    refreshData();
  }, [user.id]);

  const refreshData = () => {
    const facilities = facilityService
      .getAllFacilities(true)
      .filter(f => f.ownerId === user.id);

    const bookings = getAllBookings();

    setMyFacilities(facilities);
    setAllBookings(bookings);

    const activeFacility =
      selectedFac
        ? facilities.find(f => f.id === selectedFac.id) || facilities[0]
        : facilities[0];

    if (activeFacility) {
      setSelectedFac(activeFacility);
      setFacSlots(facilityService.getSlotsByFacility(activeFacility.id));
    } else {
      setSelectedFac(null);
      setFacSlots([]);
    }
  };

  const handleSelectFacility = (facility: Facility) => {
    setSelectedFac(facility);
    setFacSlots(facilityService.getSlotsByFacility(facility.id));
  };

  const resetSlotForm = () => {
    setSlotForm({
      startTime: '06:00 AM',
      endTime: '07:00 AM',
      price: ''
    });
  };

  const resetVenueForm = () => {
    setVenueForm({
      name: '',
      sport: 'Football',
      location: '',
      basePrice: '',
      imageUrl: ''
    });
  };

  const getDefaultSportImage = (sport: string) => {
    switch (sport.toLowerCase()) {
      case 'badminton':
        return 'images/stephan-rothe-VePgmkq3hHI-unsplash.jpg';
      case 'football':
        return 'https://images.unsplash.com/photo-1579952363873-27f3bade9f55?q=80&w=800&auto=format&fit=crop';
      case 'basketball':
        return 'https://images.unsplash.com/photo-1546519638-68e109498ffc?q=80&w=800&auto=format&fit=crop';
      case 'cricket':
        return 'https://images.unsplash.com/photo-1531415074968-036ba1b575da?q=80&w=800&auto=format&fit=crop';
      case 'tennis':
        return 'https://images.unsplash.com/photo-1622279457486-62dcc4a431d6?q=80&w=800&auto=format&fit=crop';
      case 'padel':
        return 'https://images.unsplash.com/photo-1554068865-24cecd4e34b8?q=80&w=800&auto=format&fit=crop';
      case 'swimming':
        return 'https://images.unsplash.com/photo-1530549387789-4c1017266635?q=80&w=800&auto=format&fit=crop';
      case 'gym':
        return 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?q=80&w=800&auto=format&fit=crop';
      case 'yoga':
        return 'images/ginny-rose-stewart-UxkcSzRWM2s-unsplash.jpg';
      case 'table tennis':
        return 'images/inkiipow-7h9wGq4IUdE-unsplash.jpg';
      default:
        return 'https://images.unsplash.com/photo-1517649763962-0c623066013b?q=80&w=800&auto=format&fit=crop';
    }
  };

  const handleAddSlot = (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedFac) return;

    const priceValue = Number(slotForm.price);

    if (!slotForm.startTime || !slotForm.endTime || !priceValue) {
      alert('Please fill all slot fields.');
      return;
    }

    const time = `${slotForm.startTime} - ${slotForm.endTime}`;

    const duplicate = facSlots.some(
      slot => slot.time.trim().toLowerCase() === time.trim().toLowerCase()
    );

    if (duplicate) {
      alert('A slot with the same time already exists for this facility.');
      return;
    }

    facilityService.addSlot({
      facilityId: selectedFac.id,
      time,
      price: priceValue,
      surgeEnabled: false,
      surgeMultiplier: 1
    });

    refreshData();
    resetSlotForm();
    setShowAddSlotModal(false);
  };

  const handleAddVenue = (e: React.FormEvent) => {
    e.preventDefault();

    const basePrice = Number(venueForm.basePrice);

    if (!venueForm.name || !venueForm.sport || !venueForm.location || !basePrice) {
      alert('Please fill all venue fields.');
      return;
    }

    const allFacilities = facilityService.getAllFacilities(true);

    const duplicate = allFacilities.some(
      f =>
        f.name.trim().toLowerCase() === venueForm.name.trim().toLowerCase() &&
        f.location.trim().toLowerCase() === venueForm.location.trim().toLowerCase()
    );

    if (duplicate) {
      alert('A venue with the same name and location already exists.');
      return;
    }

    const newFacility: Facility = {
      id: `owner_fac_${Date.now()}`,
      name: venueForm.name.trim(),
      sport: venueForm.sport,
      location: venueForm.location.trim(),
      basePrice,
      ownerId: user.id,
      imageUrl: venueForm.imageUrl.trim() || getDefaultSportImage(venueForm.sport),
      rating: 4.5,
      status: 'approved'
    };

    const updatedFacilities = [...allFacilities, newFacility];
    localStorage.setItem('unisport_facilities_v5', JSON.stringify(updatedFacilities));

    refreshData();
    setSelectedFac(newFacility);
    setFacSlots([]);
    resetVenueForm();
    setShowNewVenueModal(false);
  };

  const facilitySlotIds = facSlots.map(s => s.id);

  const confirmedBookings = allBookings.filter(
    b => facilitySlotIds.includes(b.slotId) && b.status === 'confirmed'
  );

  const totalRevenue = confirmedBookings.reduce((sum, booking) => {
    const slot = facSlots.find(s => s.id === booking.slotId);
    return sum + (slot?.price || 0);
  }, 0);

  const recentBookings = [...confirmedBookings]
    .sort(
      (a, b) =>
        new Date(b.createdAt || b.bookingDate).getTime() -
        new Date(a.createdAt || a.bookingDate).getTime()
    )
    .slice(0, 6);

  const getSlotBookingCount = (slotId: string) => {
    return allBookings.filter(
      b => b.slotId === slotId && b.status === 'confirmed'
    ).length;
  };

  const analyzeDemand = (slotId: string) => {
    const confirmed = allBookings.filter(
      b => b.slotId === slotId && b.status === 'confirmed'
    );

    const uniqueDays = [...new Set(confirmed.map(b => b.bookingDate))].sort(
      (a, b) => new Date(b).getTime() - new Date(a).getTime()
    );

    if (uniqueDays.length === 0) {
      return {
        demandScore: 0,
        streak: 0,
        reason: 'No booking activity'
      };
    }

    let streak = 1;

    for (let i = 0; i < uniqueDays.length - 1; i++) {
      const current = new Date(uniqueDays[i]);
      const next = new Date(uniqueDays[i + 1]);
      const diff =
        (current.getTime() - next.getTime()) / (1000 * 60 * 60 * 24);

      if (diff === 1) streak++;
      else break;
    }

    const demandScore = Math.min(100, streak * 20);

    let reason = 'Stable demand';
    if (streak >= 5) reason = `${streak}-day booking streak`;
    else if (streak >= 3) reason = `Rising trend (${streak} days)`;

    return { demandScore, streak, reason };
  };

  const calculateSurgeMultiplier = (demandScore: number) => {
    const baseSurge = 0.05;
    const surgeRange = 0.15;
    const surgePercent = baseSurge + (demandScore / 100) * surgeRange;
    return 1 + surgePercent;
  };

  const enableSurge = (slot: Slot) => {
    if (slot.surgeEnabled) return;

    const demand = analyzeDemand(slot.id);
    const multiplier = calculateSurgeMultiplier(demand.demandScore);

    facilityService.updateSlot(slot.id, {
      price: Math.round(slot.price * multiplier),
      surgeEnabled: true,
      surgeMultiplier: multiplier
    });

    refreshData();
  };

  const disableSurge = (slot: Slot) => {
    const original = Math.round(slot.price / (slot.surgeMultiplier || 1));

    facilityService.updateSlot(slot.id, {
      price: original,
      surgeEnabled: false,
      surgeMultiplier: 1
    });

    refreshData();
  };

  const getSlotIntelligence = (slot: Slot) => {
    const bookingCount = getSlotBookingCount(slot.id);
    const demand = analyzeDemand(slot.id);

    if (bookingCount === 0) {
      return {
        status: 'Underperforming',
        statusClass: 'bg-red-900/50 text-red-300 border border-red-800',
        suggestion: 'Run 15% promo to increase occupancy',
        impact: '+15% revenue impact'
      };
    }

    if (bookingCount === 1) {
      return {
        status: 'Needs Push',
        statusClass: 'bg-yellow-900/50 text-yellow-300 border border-yellow-800',
        suggestion: 'Run 10% promo to attract first-time bookings',
        impact: '+8% revenue impact'
      };
    }

    if (demand.demandScore >= 60) {
      return {
        status: 'High Performing',
        statusClass: 'bg-emerald-900/50 text-emerald-300 border border-emerald-800',
        suggestion: 'Enable surge to maximize peak-hour yield',
        impact: '+12% revenue impact'
      };
    }

    return {
      status: 'Stable',
      statusClass: 'bg-neutral-800 text-neutral-300 border border-neutral-700',
      suggestion: 'Maintain pricing and monitor booking trend',
      impact: '+4% revenue impact'
    };
  };

  const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const getWeekdayFromDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const jsDay = date.getDay();
    return jsDay === 0 ? 6 : jsDay - 1;
  };

  const getHeatmapValue = (slotId: string, weekdayIndex: number) => {
    return allBookings.filter(b => {
      if (b.slotId !== slotId || b.status !== 'confirmed') return false;
      return getWeekdayFromDate(b.bookingDate) === weekdayIndex;
    }).length;
  };

  const getHeatmapCellClass = (value: number) => {
    if (value >= 3) return 'bg-neutral-950';
    if (value === 2) return 'bg-neutral-700';
    if (value === 1) return 'bg-neutral-300';
    return 'bg-neutral-100';
  };


  const handleEditSlot = (slot: Slot) => {
  setEditingSlot(slot);

  const parts = slot.time.split(" - ");

  setSlotForm({
    startTime: parts[0],
    endTime: parts[1],
    price: String(slot.price)
  });

  setShowEditSlotModal(true);
};

const handleSaveSlotEdit = (e: React.FormEvent) => {
  e.preventDefault();

  if (!editingSlot) return;

  const time = `${slotForm.startTime} - ${slotForm.endTime}`;
  const price = Number(slotForm.price);

  facilityService.updateSlot(editingSlot.id, {
    time,
    price
  });

  refreshData();

  setShowEditSlotModal(false);
  setEditingSlot(null);
  resetSlotForm();
};

const deleteSlot = (slot: Slot) => {
  if (!confirm("Delete this slot?")) return;

  const slots = facilityService.getSlotsByFacility(selectedFac!.id);

  const updated = slots.filter(s => s.id !== slot.id);

  localStorage.setItem(
    "unisport_slots_v5",
    JSON.stringify(updated)
  );

  refreshData();
};


  return (
    <div className="max-w-7xl mx-auto px-4 py-8 font-sans">
      <div className="flex items-end justify-between gap-6 mb-10 border-b-2 border-neutral-900 pb-5">
        <div>
          <h2 className="text-5xl font-black uppercase italic tracking-tighter">
            Owner Dashboard
          </h2>
          <p className="text-neutral-500 font-bold uppercase tracking-widest text-xs mt-2">
            Manage your facilities and pricing.
          </p>
        </div>

        <button
          onClick={() => setShowNewVenueModal(true)}
          className="px-5 py-3 bg-neutral-900 text-white rounded-md text-xs font-black uppercase tracking-widest hover:bg-orange-600 transition-colors"
        >
          + New Venue
        </button>
      </div>

      <div className="grid grid-cols-4 gap-8">
        <div className="col-span-1">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-[10px] font-black uppercase tracking-widest text-neutral-400">
              Inventory
            </p>
            <span className="px-2 py-1 rounded-sm bg-neutral-100 text-neutral-500 text-[9px] font-black uppercase tracking-wider">
              {myFacilities.length} total
            </span>
          </div>

          <div className="mb-4">
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-sm bg-emerald-50 text-emerald-700 text-[10px] font-black uppercase tracking-wider border border-emerald-200">
              <i className="fas fa-shield-alt"></i>
              Verified Ownership
            </span>
          </div>

          <div className="space-y-3">
            {myFacilities.map(f => (
              <div
                key={f.id}
                onClick={() => handleSelectFacility(f)}
                className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${
                  selectedFac?.id === f.id
                    ? 'bg-neutral-900 text-white border-neutral-900'
                    : 'bg-white border-neutral-200 hover:border-neutral-400'
                }`}
              >
                <div className="flex justify-between items-start gap-3">
                  <div className="min-w-0">
                    <p className="font-black uppercase truncate">{f.name}</p>
                    <p
                      className={`text-[10px] uppercase tracking-wide mt-1 ${
                        selectedFac?.id === f.id
                          ? 'text-neutral-300'
                          : 'text-neutral-400'
                      }`}
                    >
                      {f.sport} • {f.location}
                    </p>
                  </div>

                  <i
                    className={`fas fa-chevron-right text-xs mt-1 ${
                      selectedFac?.id === f.id
                        ? 'text-orange-500'
                        : 'text-neutral-300'
                    }`}
                  ></i>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="col-span-3 space-y-6">
          {selectedFac ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white p-5 rounded-lg border-2 border-neutral-200">
                  <p className="text-[10px] font-black uppercase tracking-widest text-neutral-400">
                    Estimated Revenue
                  </p>
                  <p className="text-4xl font-black text-neutral-900 mt-2">
                    ₹{totalRevenue.toFixed(2)}
                  </p>
                </div>

                <div className="bg-white p-5 rounded-lg border-2 border-neutral-200">
                  <p className="text-[10px] font-black uppercase tracking-widest text-neutral-400">
                    Active Slots
                  </p>
                  <p className="text-4xl font-black text-neutral-900 mt-2">
                    {facSlots.length}
                  </p>
                </div>

                <div className="bg-white p-5 rounded-lg border-2 border-neutral-200">
                  <p className="text-[10px] font-black uppercase tracking-widest text-neutral-400">
                    Total Bookings
                  </p>
                  <p className="text-4xl font-black text-orange-600 mt-2">
                    {confirmedBookings.length}
                  </p>
                </div>
              </div>

              <div className="bg-neutral-950 text-white p-6 rounded-lg border border-neutral-800">
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-8 h-8 bg-orange-600 rounded-sm flex items-center justify-center">
                    <i className="fas fa-brain text-white text-sm"></i>
                  </div>
                  <div>
                    <h4 className="font-black uppercase italic tracking-tight">
                      AI Revenue Intelligence
                    </h4>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-400">
                      Real-time optimization suggestions
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {facSlots.map(slot => {
                    const intel = getSlotIntelligence(slot);
                    return (
                      <div
                        key={slot.id}
                        className="bg-neutral-900 border border-neutral-700 rounded-md p-4"
                      >
                        <div className="flex justify-between items-start gap-3 mb-3">
                          <p className="text-[10px] font-black uppercase tracking-widest text-neutral-400">
                            {slot.time}
                          </p>
                          <span
                            className={`text-[8px] px-2 py-1 rounded-sm font-black uppercase tracking-wider ${intel.statusClass}`}
                          >
                            {intel.status}
                          </span>
                        </div>

                        <p className="text-sm font-black uppercase leading-snug">
                          {intel.suggestion}
                        </p>

                        <p className="text-[10px] font-black uppercase tracking-wider text-emerald-400 mt-3">
                          ↗ {intel.impact}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="bg-white p-6 rounded-lg border-2 border-neutral-200">
                <h4 className="font-black uppercase text-sm mb-5">
                  Weekly Occupancy Heatmap
                </h4>

                {facSlots.length > 0 ? (
                  <div className="overflow-x-auto">
                    <div className="min-w-[560px]">
                      <div
                        className="grid gap-2 mb-3"
                        style={{
                          gridTemplateColumns: `80px repeat(${facSlots.length}, minmax(120px, 1fr))`
                        }}
                      >
                        <div></div>
                        {facSlots.map(slot => (
                          <div
                            key={slot.id}
                            className="text-[10px] font-black uppercase tracking-widest text-neutral-300 text-center"
                          >
                            {slot.time.split(' - ')[0]}
                          </div>
                        ))}
                      </div>

                      {weekdayLabels.map((day, weekdayIndex) => (
                        <div
                          key={day}
                          className="grid gap-2 mb-2"
                          style={{
                            gridTemplateColumns: `80px repeat(${facSlots.length}, minmax(120px, 1fr))`
                          }}
                        >
                          <div className="text-[10px] font-black uppercase tracking-widest text-neutral-400 flex items-center">
                            {day}
                          </div>

                          {facSlots.map(slot => {
                            const value = getHeatmapValue(slot.id, weekdayIndex);
                            return (
                              <div
                                key={`${day}-${slot.id}`}
                                className={`h-8 rounded-sm ${getHeatmapCellClass(value)}`}
                                title={`${day} • ${slot.time} • ${value} bookings`}
                              ></div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-neutral-400 font-bold uppercase tracking-wide">
                    No slots configured yet.
                  </p>
                )}
              </div>

              <div className="bg-white p-6 rounded-lg border-2 border-neutral-200">
                <div className="flex justify-between items-center mb-5">
                  <h4 className="font-black uppercase text-sm">
                    Slot Configuration
                  </h4>

                  <button
                    onClick={() => setShowAddSlotModal(true)}
                    className="px-4 py-2 bg-neutral-900 text-white rounded-md text-[10px] font-black uppercase tracking-widest hover:bg-orange-600 transition-colors"
                  >
                    + Add Slot
                  </button>
                </div>

                {facSlots.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {facSlots.map(slot => {
                      const demand = analyzeDemand(slot.id);
                      const bookingCount = getSlotBookingCount(slot.id);
                      const projectedMultiplier = calculateSurgeMultiplier(
                        demand.demandScore
                      );
                      const projectedPercent = Math.round(
                        (projectedMultiplier - 1) * 100
                      );

                      return (
                        <div
                          key={slot.id}
                          className="p-4 rounded-lg border border-neutral-200 bg-neutral-50"
                        >
                          <div className="flex justify-between items-start gap-4">
                            <div>
                              <p className="font-black uppercase text-sm">
                                {slot.time}
                              </p>
                              <p className="text-[10px] text-neutral-500 font-black uppercase tracking-wide mt-1">
                                Base Price: ₹{slot.price}
                              </p>
                              <p className="text-[10px] text-neutral-400 font-bold uppercase tracking-wide mt-2">
                                Bookings: {bookingCount} • Demand: {demand.demandScore}%
                              </p>
                            </div>

                            <div className="flex gap-2">

<button
  onClick={() => handleEditSlot(slot)}
  className="px-3 py-2 rounded-md bg-neutral-200 text-neutral-800 text-[10px] font-black uppercase tracking-widest hover:bg-neutral-300"
>
Edit
</button>

<button
  onClick={() => deleteSlot(slot)}
  className="px-3 py-2 rounded-md bg-red-600 text-white text-[10px] font-black uppercase tracking-widest hover:bg-red-700"
>
Delete
</button>

{!slot.surgeEnabled ? (
  <button
    onClick={() => enableSurge(slot)}
    className="px-3 py-2 rounded-md bg-neutral-900 text-white text-[10px] font-black uppercase tracking-widest hover:bg-orange-600"
  >
    Surge
  </button>
) : (
  <button
    onClick={() => disableSurge(slot)}
    className="px-3 py-2 rounded-md bg-white text-red-600 border border-red-600 text-[10px] font-black uppercase tracking-widest hover:bg-red-600 hover:text-white"
  >
    Disable
  </button>
)}

</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-neutral-400 font-bold uppercase tracking-wide">
                    No slots configured yet.
                  </p>
                )}
              </div>

              <div className="bg-white rounded-lg border-2 border-neutral-200 overflow-hidden">
                <div className="px-6 py-5 border-b border-neutral-100 flex justify-between items-center">
                  <h4 className="font-black uppercase text-sm">
                    Customer Bookings Audit
                  </h4>
                  <span className="text-[9px] font-mono text-neutral-300 uppercase tracking-widest">
                    DB_RELATION • {selectedFac.id.toUpperCase()}
                  </span>
                </div>

                {recentBookings.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead className="bg-neutral-50">
                        <tr>
                          <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-neutral-400">
                            Date
                          </th>
                          <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-neutral-400">
                            Time Slot
                          </th>
                          <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-neutral-400">
                            User Reference
                          </th>
                          <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-neutral-400">
                            Status
                          </th>
                        </tr>
                      </thead>

                      <tbody>
                        {recentBookings.map(booking => {
                          const slot = facSlots.find(s => s.id === booking.slotId);

                          return (
                            <tr
                              key={booking.id}
                              className="border-t border-neutral-100"
                            >
                              <td className="px-6 py-4 text-sm font-black text-neutral-900">
                                {booking.bookingDate}
                              </td>
                              <td className="px-6 py-4 text-sm text-neutral-500">
                                {slot?.time || 'Unknown Slot'}
                              </td>
                              <td className="px-6 py-4 text-xs text-neutral-400 font-mono">
                                {booking.userId}
                              </td>
                              <td className="px-6 py-4">
                                <span className="text-[10px] font-black uppercase tracking-wider text-emerald-600">
                                  ● {booking.status}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="px-6 py-10">
                    <p className="text-sm text-neutral-400 font-bold uppercase tracking-wide">
                      No recent bookings for this facility.
                    </p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="bg-white p-10 rounded-lg border-2 border-neutral-200 text-center">
              <p className="text-neutral-400 font-bold uppercase tracking-wide">
                No facilities found for this owner.
              </p>
            </div>
          )}
        </div>
      </div>

      {showAddSlotModal && selectedFac && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-neutral-900/80 backdrop-blur-sm"
            onClick={() => {
              setShowAddSlotModal(false);
              resetSlotForm();
            }}
          ></div>

          <div className="relative w-full max-w-md bg-white rounded-xl border-2 border-neutral-200 shadow-2xl p-6">
            <div className="flex justify-between items-start gap-4 mb-6">
              <div>
                <h3 className="text-2xl font-black uppercase italic tracking-tight">
                  Add New Slot
                </h3>
                <p className="text-xs text-neutral-500 font-bold uppercase tracking-widest mt-2">
                  {selectedFac.name}
                </p>
              </div>

              <button
                onClick={() => {
                  setShowAddSlotModal(false);
                  resetSlotForm();
                }}
                className="w-9 h-9 rounded-full bg-neutral-900 text-white hover:bg-orange-600 transition-colors flex items-center justify-center"
              >
                <i className="fas fa-times text-xs"></i>
              </button>
            </div>

            <form onSubmit={handleAddSlot} className="space-y-5">
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-neutral-400 mb-2">
                  Start Time
                </label>
                <select
                  value={slotForm.startTime}
                  onChange={(e) =>
                    setSlotForm(prev => ({ ...prev, startTime: e.target.value }))
                  }
                  className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 bg-white"
                >
                  <option>06:00 AM</option>
                  <option>07:00 AM</option>
                  <option>08:00 AM</option>
                  <option>09:00 AM</option>
                  <option>05:00 PM</option>
                  <option>06:00 PM</option>
                  <option>07:00 PM</option>
                  <option>08:00 PM</option>
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-neutral-400 mb-2">
                  End Time
                </label>
                <select
                  value={slotForm.endTime}
                  onChange={(e) =>
                    setSlotForm(prev => ({ ...prev, endTime: e.target.value }))
                  }
                  className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 bg-white"
                >
                  <option>07:00 AM</option>
                  <option>08:00 AM</option>
                  <option>09:00 AM</option>
                  <option>10:00 AM</option>
                  <option>06:00 PM</option>
                  <option>07:00 PM</option>
                  <option>08:00 PM</option>
                  <option>09:00 PM</option>
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-neutral-400 mb-2">
                  Base Price
                </label>
                <input
                  type="number"
                  min="1"
                  value={slotForm.price}
                  onChange={(e) =>
                    setSlotForm(prev => ({ ...prev, price: e.target.value }))
                  }
                  placeholder="Enter slot price"
                  className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowAddSlotModal(false);
                    resetSlotForm();
                  }}
                  className="flex-1 px-4 py-3 rounded-lg bg-neutral-100 text-neutral-700 font-black uppercase tracking-widest text-xs hover:bg-neutral-200 transition-colors"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="flex-1 px-4 py-3 rounded-lg bg-neutral-900 text-white font-black uppercase tracking-widest text-xs hover:bg-orange-600 transition-colors"
                >
                  Save Slot
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showNewVenueModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-neutral-900/80 backdrop-blur-sm"
            onClick={() => {
              setShowNewVenueModal(false);
              resetVenueForm();
            }}
          ></div>

          <div className="relative w-full max-w-lg bg-white rounded-xl border-2 border-neutral-200 shadow-2xl p-6">
            <div className="flex justify-between items-start gap-4 mb-6">
              <div>
                <h3 className="text-2xl font-black uppercase italic tracking-tight">
                  Add New Venue
                </h3>
                <p className="text-xs text-neutral-500 font-bold uppercase tracking-widest mt-2">
                  Register a new facility under your ownership
                </p>
              </div>

              <button
                onClick={() => {
                  setShowNewVenueModal(false);
                  resetVenueForm();
                }}
                className="w-9 h-9 rounded-full bg-neutral-900 text-white hover:bg-orange-600 transition-colors flex items-center justify-center"
              >
                <i className="fas fa-times text-xs"></i>
              </button>
            </div>

            <form onSubmit={handleAddVenue} className="space-y-5">
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-neutral-400 mb-2">
                  Venue Name
                </label>
                <input
                  type="text"
                  value={venueForm.name}
                  onChange={(e) =>
                    setVenueForm(prev => ({ ...prev, name: e.target.value }))
                  }
                  placeholder="Enter facility name"
                  className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-neutral-400 mb-2">
                    Sport
                  </label>
                  <select
                    value={venueForm.sport}
                    onChange={(e) =>
                      setVenueForm(prev => ({ ...prev, sport: e.target.value }))
                    }
                    className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 bg-white"
                  >
                    <option>Football</option>
                    <option>Badminton</option>
                    <option>Cricket</option>
                    <option>Tennis</option>
                    <option>Basketball</option>
                    <option>Swimming</option>
                    <option>Gym</option>
                    <option>Yoga</option>
                    <option>Padel</option>
                    <option>Table Tennis</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-neutral-400 mb-2">
                    Base Price
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={venueForm.basePrice}
                    onChange={(e) =>
                      setVenueForm(prev => ({ ...prev, basePrice: e.target.value }))
                    }
                    placeholder="₹"
                    className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-neutral-400 mb-2">
                  Location
                </label>
                <input
                  type="text"
                  value={venueForm.location}
                  onChange={(e) =>
                    setVenueForm(prev => ({ ...prev, location: e.target.value }))
                  }
                  placeholder="Eg. Kowdiar, Trivandrum"
                  className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500"
                />
              </div>

              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-neutral-400 mb-2">
                  Image URL (optional)
                </label>
                <input
                  type="text"
                  value={venueForm.imageUrl}
                  onChange={(e) =>
                    setVenueForm(prev => ({ ...prev, imageUrl: e.target.value }))
                  }
                  placeholder="Paste image URL or leave empty"
                  className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowNewVenueModal(false);
                    resetVenueForm();
                  }}
                  className="flex-1 px-4 py-3 rounded-lg bg-neutral-100 text-neutral-700 font-black uppercase tracking-widest text-xs hover:bg-neutral-200 transition-colors"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="flex-1 px-4 py-3 rounded-lg bg-neutral-900 text-white font-black uppercase tracking-widest text-xs hover:bg-orange-600 transition-colors"
                >
                  Save Venue
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showEditSlotModal && editingSlot && (
  <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
    
    <div
      className="absolute inset-0 bg-neutral-900/80"
      onClick={() => setShowEditSlotModal(false)}
    ></div>

    <div className="relative w-full max-w-md bg-white rounded-xl border-2 p-6">

      <h3 className="text-2xl font-black uppercase italic mb-6">
        Edit Slot
      </h3>

      <form onSubmit={handleSaveSlotEdit} className="space-y-5">

        <div>
          <label className="text-xs font-black uppercase">
            Start Time
          </label>
          <input
            value={slotForm.startTime}
            onChange={e =>
              setSlotForm(prev => ({
                ...prev,
                startTime: e.target.value
              }))
            }
            className="w-full border p-3 rounded"
          />
        </div>

        <div>
          <label className="text-xs font-black uppercase">
            End Time
          </label>
          <input
            value={slotForm.endTime}
            onChange={e =>
              setSlotForm(prev => ({
                ...prev,
                endTime: e.target.value
              }))
            }
            className="w-full border p-3 rounded"
          />
        </div>

        <div>
          <label className="text-xs font-black uppercase">
            Price
          </label>
          <input
            type="number"
            value={slotForm.price}
            onChange={e =>
              setSlotForm(prev => ({
                ...prev,
                price: e.target.value
              }))
            }
            className="w-full border p-3 rounded"
          />
        </div>

        <button
          type="submit"
          className="w-full bg-neutral-900 text-white py-3 rounded font-black uppercase hover:bg-orange-600"
        >
          Save Changes
        </button>

      </form>
    </div>
  </div>
)}
    </div>
  );
};

export default OwnerDashboard;