
// import React, { useState, useEffect } from 'react';
// import { facilityService } from '../services/facilityService';
// import {
//   createBookingTransactional,
//   checkSlotAvailability,
//   getBookingsByUser
// } from "../services/bookingService";
// import { aiEngine } from '../services/aiEngine';
// import { userService } from '../services/userService';
// import { Facility, Slot, User, Booking, SlotDemandPrediction, AIRecommendation } from '../types';
// import { getAllBookings } from "../services/bookingService";
// import { useNavigate } from "react-router-dom";

// interface UserDashboardProps {
//   user: User;
//   onStartPayment?: (data: {
//     slotId: string;
//     facilityId: string | undefined;
//     date: string;
//     price: number;
//   }) => void;
// }

// const UserDashboard: React.FC<UserDashboardProps> = ({ user, onStartPayment }) => {
//   const [facilities, setFacilities] = useState<Facility[]>([]);
//   const [selectedFacility, setSelectedFacility] = useState<Facility | null>(null);
//   const [slots, setSlots] = useState<Slot[]>([]);
//   const [allSlots, setAllSlots] = useState<Slot[]>([]);


//   const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split('T')[0]);
//   const [selectedSport, setSelectedSport] = useState<string>('All');
//   const [selectedCity, setSelectedCity] = useState<string>('Chennai');
//   const [selectedSlotInsight, setSelectedSlotInsight] =
//   useState<SlotDemandPrediction | null>(null);
//   const [slotPredictions, setSlotPredictions] = useState<SlotDemandPrediction[]>([]);
//   const [loadingPrediction, setLoadingPrediction] = useState(false);
//   const [myBookings, setMyBookings] = useState<Booking[]>([]);
//   const [recommendations, setRecommendations] = useState<AIRecommendation[]>([]);
//   const [loadingRecs, setLoadingRecs] = useState(false);

//   const cities = ['Chennai', 'Mumbai', 'Delhi', 'Kolkata', 'Jaipur', 'Bangalore', 'Hyderabad'];

//   const openDirections = (location: string) => {
//     const encoded = encodeURIComponent(location);
//     const url = `https://www.google.com/maps/search/?api=1&query=${encoded}`;
//     window.open(url, '_blank');
//   };

//  useEffect(() => {
//   const facilitiesData = facilityService.getAllFacilities();
//   const slotsData = facilityService.getAllSlots();
//   const userBookings = getBookingsByUser(user.id)
//     .filter(b => b.status === 'confirmed');

//   setFacilities(facilitiesData);
//   setAllSlots(slotsData);
//   setMyBookings(userBookings);

//   // -------- Deterministic Recommendation Engine --------

//   if (userBookings.length === 0) {
//     setRecommendations([]);
//     return;
//   }

//   // Count sport frequency from booking history
//   const sportFrequency: Record<string, number> = {};

//   userBookings.forEach(b => {
//     const slot = slotsData.find(s => s.id === b.slotId);
//     const facility = facilitiesData.find(f => f.id === slot?.facilityId);

//     if (facility) {
//       sportFrequency[facility.sport] =
//         (sportFrequency[facility.sport] || 0) + 1;
//     }
//   });

//   const favoriteSport =
//     Object.entries(sportFrequency)
//       .sort((a, b) => b[1] - a[1])[0]?.[0];

//   if (!favoriteSport) {
//     setRecommendations([]);
//     return;
//   }

//   // Recommend same-sport facilities in selected city
//   const recommendedFacilities = facilitiesData
//     .filter(f =>
//       f.sport === favoriteSport &&
//       f.location.includes(selectedCity)
//     )
//     .slice(0, 3);

//   setRecommendations(
//     recommendedFacilities.map(f => ({
//       facilityId: f.id,
//       reasoning: `You frequently book ${favoriteSport}.`,
//       confidence: 'High'
//     }))
//   );

// }, [user.id, selectedCity]);

//   const handleSelectFacility = async (facility: Facility) => {
//   setSelectedFacility(facility);

//   const facilitySlots = facilityService.getSlotsByFacility(facility.id);
//   setSlots(facilitySlots);

//   setLoadingPrediction(true);

//   // Get all bookings from system
//   const allSystemBookings = getAllBookings();

//   // Only confirmed bookings for this facility
//   const facilityBookings = allSystemBookings.filter(
//     b =>
//       b.status === "confirmed" &&
//       facilitySlots.some(s => s.id === b.slotId)
//   );

//   const history = facilityBookings.map(b => ({
//     slotId: b.slotId
//   }));

//   const predictions = await aiEngine.analyzeSlotDemand(
//     facility.name,
//     facility.sport,
//     facilitySlots.map(s => ({
//       id: s.id,
//       time: s.time,
//       basePrice: s.price
//     })),
//     history
//   );

//   setSlotPredictions(predictions);
//   setLoadingPrediction(false);
// };

  

// const navigate = useNavigate();

// const handleBook = (slot: Slot) => {
//   if (!onStartPayment) return;

//   onStartPayment({
//     slotId: slot.id,
//     facilityId: selectedFacility?.id,
//     date: selectedDate,
//     price: slot.price
//   });
// };

//   const getSlotPrediction = (slotId: string) => {
//     return slotPredictions.find(p => p.slotId === slotId);
//   };

//   // Upcoming Booking Widget Logic
//   const today = new Date();
// today.setHours(0, 0, 0, 0);

// const upcomingBooking = myBookings
//   .filter(b => {
//     const bookingDate = new Date(b.bookingDate);
//     bookingDate.setHours(0, 0, 0, 0);
//     return bookingDate >= today && b.status === 'confirmed';
//   })
//   .sort(
//     (a, b) =>
//       new Date(a.bookingDate).getTime() - new Date(b.bookingDate).getTime()
//   )[0];

//   const cityFacilities = facilities.filter(f => f.location.includes(selectedCity));
//   const uniqueSports = ['All', ...Array.from(new Set(cityFacilities.map(f => f.sport)))];
  
//   const filteredFacilities = selectedSport === 'All' 
//     ? cityFacilities 
//     : cityFacilities.filter(f => f.sport === selectedSport);

//   return (
//     <div className="max-w-7xl mx-auto px-4 py-8 font-sans">
//       {/* Header & Location Banner */}
//       <div className="flex flex-col md:flex-row justify-between items-end mb-12 gap-6 border-b-2 border-neutral-900 pb-6">
//         <div>
//            <h2 className="text-5xl font-black text-neutral-900 uppercase tracking-tighter italic">Find Your Court</h2>
//            <p className="text-neutral-500 font-medium mt-2 tracking-wide uppercase text-xs">Book elite sports facilities near you.</p>
//         </div>
        
//         <div className="flex flex-wrap items-center gap-4">
//           {/* Location Badge */}
//           <div className="bg-neutral-900 text-white px-4 py-2 rounded-lg flex items-center gap-3">
//             <i className="fas fa-map-marker-alt text-orange-500"></i>
//             <div>
//               <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest">Location</p>
//               <select 
//                 value={selectedCity}
//                 onChange={(e) => setSelectedCity(e.target.value)}
//                 className="bg-transparent text-sm font-bold uppercase tracking-wider outline-none cursor-pointer text-white appearance-none pr-4"
//                 style={{ backgroundImage: 'none' }}
//               >
//                 {cities.map(city => (
//                   <option key={city} value={city} className="text-black">{city}, IN</option>
//                 ))}
//               </select>
//             </div>
//             <i className="fas fa-chevron-down text-xs text-neutral-500"></i>
//           </div>

//           <div className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg border-2 border-neutral-200 focus-within:border-orange-500 transition-colors">
//              <i className="fas fa-calendar text-neutral-400"></i>
//              <input 
//                type="date" 
//                className="outline-none text-neutral-900 font-bold uppercase text-sm bg-transparent"
//                value={selectedDate}
//                onChange={(e) => setSelectedDate(e.target.value)}
//              />
//           </div>
//         </div>
//       </div>


//       {/* Upcoming Booking Widget */}
//       {upcomingBooking && (() => {
//   const slot = facilityService
//     .getAllSlots()
//     .find(s => s.id === upcomingBooking.slotId);

//   const facility = facilityService
//     .getAllFacilities()
//     .find(f => f.id === slot?.facilityId);

//   return (
//     <div className="mb-12 bg-neutral-900 text-white rounded-xl p-8 flex flex-col md:flex-row justify-between items-start md:items-center relative overflow-hidden group gap-6">
//       <div className="absolute top-0 right-0 w-64 h-64 bg-orange-500 rounded-full blur-3xl opacity-10 -mr-16 -mt-16 group-hover:opacity-20 transition-opacity"></div>

//       <div className="relative z-10 w-full md:w-auto">
//         <div className="flex items-center gap-2 mb-2">
//           <span className="w-2 h-2 bg-orange-500 rounded-full animate-pulse"></span>
//           <p className="text-xs font-bold uppercase tracking-widest text-neutral-400">
//             Next Session
//           </p>
//         </div>

//         <h3 className="text-3xl font-black uppercase italic tracking-tighter break-words">
//           {facility?.name || 'Unknown Facility'}
//         </h3>

//         <p className="text-lg font-medium mt-1 text-neutral-300">
//           <span className="text-orange-500 font-bold">
//             {upcomingBooking.bookingDate}
//           </span>
//           <span className="mx-2">•</span>
//           {slot?.time}
//         </p>
//         {facility && (
//           <button
//             onClick={() => openDirections(facility.location)}
//             className="mt-4 text-xs uppercase tracking-widest text-orange-500 hover:text-orange-400 transition"
//           >
//             Get Directions →
//           </button>
//         )}
//       </div>

//       <div className="relative z-10 bg-neutral-800 p-4 rounded-lg border border-neutral-700 self-end md:self-center">
//         <i className="fas fa-ticket-alt text-3xl text-white"></i>
//       </div>
//     </div>
//   );
// })()}

//       {/* AI Recommendations */}
// {/* AI Recommendations */}
// {recommendations.length > 0 && (
//   <div className="mb-12">
//     <div className="flex items-center gap-2 mb-6">
//       <i className="fas fa-bolt text-orange-500"></i>
//       <h3 className="font-black text-neutral-900 uppercase tracking-tight text-xl">
//         Top Picks For You
//       </h3>
//     </div>

//     <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
//       {recommendations.map((rec) => {
//         const facility = facilities.find((f) => f.id === rec.facilityId);
//         if (!facility) return null;

//         return (
//           <div
//             key={rec.facilityId}
//             onClick={() => handleSelectFacility(facility)}
//             className="bg-neutral-50 p-5 rounded-lg border border-neutral-200 cursor-pointer hover:border-orange-500 hover:bg-white transition-all group"
//           >
//             <div className="flex justify-between items-start mb-3">
//               <h4 className="font-bold text-neutral-900 uppercase tracking-tight group-hover:text-orange-600 transition-colors">
//                 {facility.name}
//               </h4>
//             </div>

//             <p className="text-xs text-neutral-500 mb-4 font-medium uppercase tracking-wide line-clamp-2">
//               {rec.reasoning}
//             </p>

//             <div className="flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-wider">
//               <span
//                 className={`px-2 py-1 rounded-sm ${
//                   rec.confidence === "High"
//                     ? "bg-emerald-100 text-emerald-800"
//                     : rec.confidence === "Medium"
//                     ? "bg-yellow-100 text-yellow-800"
//                     : "bg-neutral-200 text-neutral-600"
//                 }`}
//               >
//                 {rec.confidence} Match
//               </span>
//             </div>
//           </div>
//         );
//       })}
//     </div>
//   </div>
// )}

//       {/* Modal for Facility Details & Booking */}
//       {selectedFacility && (
//   <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
//     <div
//       className="absolute inset-0 bg-neutral-900/90 backdrop-blur-sm"
//       onClick={() => {
//         setSelectedFacility(null);
//         setSelectedSlotInsight(null);
//       }}
//     ></div>

//     <div className="relative bg-white w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col md:flex-row shadow-2xl animate-in zoom-in-95 duration-200 rounded-xl">

//       {/* Close Button */}
//       <button
//         onClick={() => {
//           setSelectedFacility(null);
//           setSelectedSlotInsight(null);
//         }}
//         className="absolute -top-5 -right-5 z-30 bg-black text-white w-11 h-11 flex items-center justify-center rounded-full hover:bg-orange-600 transition-all duration-200 shadow-xl border-2 border-white"
//       >
//         <i className="fas fa-times text-sm"></i>
//       </button>

//             {/* Left Side: Image & Info */}
//             <div className="md:w-5/12 bg-black relative">
//               <div className="h-64 md:h-full opacity-80">
//                 <img 
//                   src={selectedFacility.imageUrl} 
//                   alt={selectedFacility.name} 
//                   className="w-full h-full object-cover grayscale hover:grayscale-0 transition-all duration-700"
//                 />
//               </div>
//               <div className="absolute bottom-0 left-0 p-8 w-full bg-gradient-to-t from-black via-black/80 to-transparent">
//                 <span className="bg-orange-600 text-white text-xs font-black uppercase px-2 py-1 mb-3 inline-block tracking-widest">
//                     {selectedFacility.sport}
//                 </span>
//                 <h3 className="text-4xl font-black text-white uppercase italic tracking-tighter leading-none mb-2">{selectedFacility.name}</h3>
//                 <p
//                   onClick={() => openDirections(selectedFacility.location)}
//                   className="text-neutral-400 font-medium uppercase tracking-wide text-xs flex items-center gap-2 cursor-pointer hover:text-orange-500 transition"
//                 >
//                   <i className="fas fa-map-marker-alt"></i>
//                   {selectedFacility.location}
//                   <i className="fas fa-external-link-alt text-[9px] opacity-60"></i>
//                 </p>
//               </div>
//             </div>

//             {/* Right Side: Content */}
//             <div className="md:w-7/12 bg-white flex flex-col h-full">
//               <div className="p-8 border-b border-neutral-100">
//                 <div className="flex items-center justify-between mb-6">
//                    <h4 className="font-black text-2xl text-neutral-900 uppercase tracking-tighter">Select Time Slot</h4>
//                    <div className="text-right">
//                       <p className="text-xs font-bold text-neutral-400 uppercase tracking-widest">Date</p>
//                       <p className="font-bold text-neutral-900">{selectedDate}</p>
//                    </div>
//                 </div>

//                 {/* AI Demand Insights Card */}
//                 <div className="bg-neutral-50 border border-neutral-200 p-4 rounded-lg">
//             <div className="mb-2">
//               <div className="flex items-center gap-2">
//                 <i className="fas fa-chart-line text-orange-500"></i>
//                 <h4 className="font-bold text-xs uppercase tracking-widest text-neutral-900">
//                   Demand Analysis
//                 </h4>
//               </div>

//               <p className="text-[9px] text-neutral-400 font-medium uppercase tracking-widest mt-1">
//                 Pricing powered by predictive intelligence
//               </p>
//             </div>

//             {loadingPrediction ? (
//               <p className="text-xs text-neutral-400 italic">
//                 Analyzing market data...
//               </p>
//             ) : selectedSlotInsight ? (
//               <div className="flex items-center justify-between">
//                 <p className="text-xs text-neutral-600 font-medium">
//                   {selectedSlotInsight.demandLevel === 'High'
//                     ? 'High demand detected for this slot.'
//                     : 'Normal demand for this slot.'}
//                 </p>

//                 {selectedSlotInsight.isSurge ? (
//                   <span className="text-[10px] bg-orange-100 text-orange-700 border border-orange-200 px-2 py-1 rounded font-black uppercase tracking-wider">
//                     Surge Rates
//                   </span>
//                 ) : (
//                   <span className="text-[10px] bg-emerald-100 text-emerald-700 border border-emerald-200 px-2 py-1 rounded font-black uppercase tracking-wider">
//                     Normal Rates
//                   </span>
//                 )}
//               </div>
//             ) : (
//               <p className="text-xs text-neutral-400 italic">
//                 Select a time slot to view demand insight.
//               </p>
//             )}
//           </div>
//         </div>

//               {/* Slots List */}
//               <div className="flex-1 overflow-y-auto p-8 pt-4">
//           <div className="space-y-3">
//             {slots.length > 0 ? (
//               slots.map(s => {
//                 const pred = getSlotPrediction(s.id);
//                 const isHigh = pred?.demandLevel === 'High';
//                 const isAvailable = checkSlotAvailability(s.id, selectedDate);
//                 const booked = !isAvailable;

//                 return (
//                   <div
//                     key={s.id}
//                     onClick={() => setSelectedSlotInsight(pred || null)}
//                     className={`group cursor-pointer p-4 rounded-lg border-2 transition-all flex items-center justify-between ${
//                       selectedSlotInsight?.slotId === s.id
//                         ? 'border-orange-500 bg-orange-50'
//                         : booked
//                         ? 'bg-neutral-100 border-transparent opacity-50'
//                         : isHigh
//                         ? 'bg-white border-orange-100 hover:border-orange-500'
//                         : 'bg-white border-neutral-100 hover:border-black'
//                     }`}
//                   >
//                     <div>
//                       <div className="flex items-center gap-3">
//                         <span className="text-lg font-black text-neutral-900">
//                           {s.time}
//                         </span>

//                         {isHigh && !booked && (
//                           <span className="text-[9px] font-black text-white uppercase tracking-wider bg-orange-500 px-1.5 py-0.5 rounded-sm">
//                             Hot
//                           </span>
//                         )}
//                       </div>

//                       {pred?.reasoning && isHigh && !booked && (
//                         <p className="text-[10px] text-orange-600 font-bold uppercase tracking-wide mt-1">
//                           {pred.reasoning}
//                         </p>
//                       )}
//                     </div>

//                     <div className="text-right flex items-center gap-4">
//                       <div>
//                         <p className="font-black text-xl text-neutral-900">
//                           ₹{s.price}
//                         </p>

//                         {pred?.isSurge && !booked && (
//                           <p className="text-[8px] text-orange-500 font-black uppercase tracking-widest">
//                             Surge
//                           </p>
//                         )}
//                       </div>

//                       <button
//                         onClick={(e) => {
//                           e.stopPropagation();
//                           handleBook(s);
//                         }}
//                         disabled={!isAvailable}
//                         className={`px-6 py-2 rounded-md text-xs font-black uppercase tracking-widest transition-all ${
//                           isAvailable
//                             ? 'bg-black text-white group-hover:bg-orange-600'
//                             : 'bg-neutral-300 text-neutral-500 cursor-not-allowed'
//                         }`}
//                       >
//                         {isAvailable ? 'Book' : 'Full'}
//                       </button>
//                     </div>
//                   </div>
//                 );
//               })
//             ) : (
//               <div className="text-center py-12 border-2 border-dashed border-neutral-200 rounded-lg">
//                 <p className="text-neutral-400 font-bold uppercase text-xs tracking-widest">
//                   No slots available
//                 </p>
//               </div>
//             )}
//           </div>
//         </div>

//       </div>
//     </div>
//   </div>
// )}

//       <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
//         {/* Facilities List */}
//         <div className="lg:col-span-2 space-y-6">
//           {/* Sport Filters */}
//           <div className="flex overflow-x-auto pb-2 gap-2 scrollbar-hide">
//             {uniqueSports.map(sport => (
//               <button
//                 key={sport}
//                 onClick={() => setSelectedSport(sport)}
//                 className={`px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider whitespace-nowrap transition-all border-2 ${
//                   selectedSport === sport
//                     ? 'bg-neutral-900 text-white border-neutral-900'
//                     : 'bg-white text-neutral-500 border-neutral-200 hover:border-neutral-900 hover:text-neutral-900'
//                 }`}
//               >
//                 {sport}
//               </button>
//             ))}
//           </div>

//           <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
//             {filteredFacilities.map((f) => (
//               <div 
//                 key={f.id} 
//                 onClick={() => handleSelectFacility(f)}
//                 className="group bg-white rounded-xl overflow-hidden border-2 border-transparent hover:border-black transition-all cursor-pointer shadow-sm hover:shadow-none"
//               >
//                 <div className="h-56 overflow-hidden relative">
//                   <img src={f.imageUrl} alt={f.name} className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition-all duration-500" />
//                   <div className="absolute top-4 left-4">
//                     <span className="bg-black text-white text-[10px] font-black uppercase px-3 py-1 tracking-widest">
//                       {f.sport}
//                     </span>
//                   </div>
//                 </div>
//                 <div className="p-6">
//                   <div className="flex justify-between items-start mb-4">
//                      <div>
//                        <h3 className="font-black text-xl text-neutral-900 uppercase italic tracking-tighter leading-none mb-1">{f.name}</h3>
//                        <p className="text-neutral-500 text-xs font-bold uppercase tracking-wide flex items-center gap-1">
//                          <i className="fas fa-map-marker-alt text-neutral-300"></i> {f.location}
//                        </p>
//                      </div>
//                   </div>
                  
//                   <div className="flex justify-between items-end border-t-2 border-neutral-100 pt-4">
//                     <div>
//                       <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest mb-0.5">Starting at</p>
//                       <span className="font-black text-2xl text-neutral-900">₹{f.basePrice}</span>
//                     </div>
//                     <span className="text-neutral-900 text-xs font-black uppercase tracking-widest border-b-2 border-black pb-0.5 group-hover:text-orange-600 group-hover:border-orange-600 transition-all">
//                       Book Now
//                     </span>
//                   </div>
//                 </div>
//               </div>
//             ))}
//           </div>
//         </div>

//         {/* Sidebar: My Bookings Only */}
//         {/* Sidebar Schedule */}
//         <div>
//           <div className="bg-white p-6 rounded-xl border-2 border-neutral-100 sticky top-8">
//             <h4 className="font-black uppercase text-lg mb-6">Your Schedule</h4>

//             <div className="space-y-4">
//               {myBookings.filter(b => b.status === 'confirmed').length > 0 ? (
//                 myBookings
//                   .filter(b => b.status === 'confirmed')
//                   .map(b => {
//                     const slot = allSlots.find(s => s.id === b.slotId);
//                     const facility = facilities.find(f => f.id === slot?.facilityId);

//                     return (
//                       <div
//                         key={b.id}
//                         className="p-4 bg-neutral-50 border border-neutral-200 rounded-lg"
//                       >
//                         <p className="text-xs font-black text-orange-600 uppercase">
//                           {b.bookingDate}
//                         </p>

//                         <p className="text-sm font-black uppercase italic mt-1">
//                           {facility?.name || 'Unknown Facility'}
//                         </p>

//                         <p className="text-xs text-neutral-500 uppercase">
//                           {slot?.time}
//                         </p>
//                       </div>
//                     );
//                   })
//               ) : (
//                 <p className="text-neutral-400 text-xs font-bold uppercase">
//                   No active bookings
//                 </p>
//               )}
//             </div>
//           </div>
//         </div>

//       </div>
//     </div>
//   );
// };

// export default UserDashboard;


import React, { useState, useEffect } from 'react';
import { facilityService } from '../services/facilityService';
import {
  createBookingTransactional,
  checkSlotAvailability,
  getBookingsByUser
} from "../services/bookingService";
import { aiEngine } from '../services/aiEngine';
import { userService } from '../services/userService';
import { Facility, Slot, User, Booking, SlotDemandPrediction, AIRecommendation, SelectedAmenity } from '../types';
import { getAllBookings } from "../services/bookingService";
import { useNavigate } from "react-router-dom";

interface UserDashboardProps {
  user: User;
  onStartPayment?: (data: {
    slotId: string;
    facilityId: string | undefined;
    date: string;
    slotPrice: number;
    price: number;
    selectedAmenities?: SelectedAmenity[];
  }) => void;
}

const UserDashboard: React.FC<UserDashboardProps> = ({ user, onStartPayment }) => {
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [selectedFacility, setSelectedFacility] = useState<Facility | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [allSlots, setAllSlots] = useState<Slot[]>([]);

  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [selectedSport, setSelectedSport] = useState<string>('All');
  const [selectedCity, setSelectedCity] = useState<string>('Trivandrum');
  const [selectedSlotInsight, setSelectedSlotInsight] =
  useState<SlotDemandPrediction | null>(null);
  const [slotPredictions, setSlotPredictions] = useState<SlotDemandPrediction[]>([]);
  const [loadingPrediction, setLoadingPrediction] = useState(false);
  const [myBookings, setMyBookings] = useState<Booking[]>([]);
  const [recommendations, setRecommendations] = useState<AIRecommendation[]>([]);
  const [loadingRecs, setLoadingRecs] = useState(false);

  const cities = ['Chennai', 'Mumbai', 'Delhi', 'Kolkata', 'Jaipur', 'Bangalore', 'Hyderabad', 'Trivandrum'];

  const openDirections = (location: string) => {
    const encoded = encodeURIComponent(location);
    const url = `https://www.google.com/maps/search/?api=1&query=${encoded}`;
    window.open(url, '_blank');
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


 useEffect(() => {
  const facilitiesData = facilityService.getAllFacilities();
  const slotsData = facilityService.getAllSlots();
  const userBookings = getBookingsByUser(user.id)
    .filter(b => b.status === 'confirmed');

  setFacilities(facilitiesData);
  setAllSlots(slotsData);
  setMyBookings(userBookings);

  // -------- Deterministic Recommendation Engine --------

  if (userBookings.length === 0) {
    setRecommendations([]);
    return;
  }

  // Count sport frequency from booking history
  const sportFrequency: Record<string, number> = {};

  userBookings.forEach(b => {
    const slot = slotsData.find(s => s.id === b.slotId);
    const facility = facilitiesData.find(f => f.id === slot?.facilityId);

    if (facility) {
      sportFrequency[facility.sport] =
        (sportFrequency[facility.sport] || 0) + 1;
    }
  });

  const favoriteSport =
    Object.entries(sportFrequency)
      .sort((a, b) => b[1] - a[1])[0]?.[0];

  if (!favoriteSport) {
    setRecommendations([]);
    return;
  }

  // Recommend same-sport facilities in selected city
  const recommendedFacilities = facilitiesData
    .filter(f =>
      f.sport === favoriteSport &&
      f.location.includes(selectedCity)
    )
    .slice(0, 3);

  setRecommendations(
    recommendedFacilities.map(f => ({
      facilityId: f.id,
      reasoning: `You frequently book ${favoriteSport}.`,
      confidence: 'High'
    }))
  );

}, [user.id, selectedCity]);

  const handleSelectFacility = async (facility: Facility) => {
  setSelectedFacility(facility);

  const facilitySlots = facilityService.getSlotsByFacility(facility.id);
  setSlots(facilitySlots);

  setLoadingPrediction(true);

  // Get all bookings from system
  const allSystemBookings = getAllBookings();

  // Only confirmed bookings for this facility
  const facilityBookings = allSystemBookings.filter(
    b =>
      b.status === "confirmed" &&
      facilitySlots.some(s => s.id === b.slotId)
  );

  const history = facilityBookings.map(b => ({
    slotId: b.slotId
  }));

  const predictions = await aiEngine.analyzeSlotDemand(
    facility.name,
    facility.sport,
    facilitySlots.map(s => ({
      id: s.id,
      time: s.time,
      basePrice: s.price
    })),
    history
  );

  setSlotPredictions(predictions);
  setLoadingPrediction(false);
};

  

const navigate = useNavigate();

const handleBook = (slot: Slot) => {
  if (!onStartPayment) return;

  const selected = new Date(selectedDate);
  const todayCheck = new Date();
  todayCheck.setHours(0, 0, 0, 0);

  const maxCheck = new Date();
  maxCheck.setHours(0, 0, 0, 0);
  maxCheck.setDate(maxCheck.getDate() + 30);

  selected.setHours(0, 0, 0, 0);

  if (selected < todayCheck || selected > maxCheck) {
    alert('Bookings are only allowed from today up to 30 days in advance.');
    return;
  }

  const amenitiesTotal = selectedAmenities.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );

  onStartPayment({
    slotId: slot.id,
    facilityId: selectedFacility?.id,
    date: selectedDate,
    slotPrice: slot.price,
    price: slot.price + amenitiesTotal,
    selectedAmenities
  });
};

  const getSlotPrediction = (slotId: string) => {
    return slotPredictions.find(p => p.slotId === slotId);
  };

  // Upcoming Booking Widget Logic
  const upcomingBooking = myBookings
    .filter(b => new Date(b.bookingDate) >= new Date() && b.status === 'confirmed')
    .sort((a, b) => new Date(a.bookingDate).getTime() - new Date(b.bookingDate).getTime())[0];

  const cityFacilities = facilities.filter(f => f.location.includes(selectedCity));
  const uniqueSports = ['All', ...Array.from(new Set(cityFacilities.map(f => f.sport)))];
  
const filteredFacilitiesBase =
  selectedSport === 'All'
    ? cityFacilities
    : cityFacilities.filter(f => f.sport === selectedSport);

const currentCityCoords = cityCoordinates[selectedCity];

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
const amenitiesTotal = selectedAmenities.reduce(
  (sum, item) => sum + item.price * item.quantity,
  0
);

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
                value={selectedCity}
                onChange={(e) => setSelectedCity(e.target.value)}
                className="bg-transparent text-sm font-bold uppercase tracking-wider outline-none cursor-pointer text-white appearance-none pr-4"
                style={{ backgroundImage: 'none' }}
              >
                {cities.map(city => (
                  <option key={city} value={city} className="text-black">{city}, IN</option>
                ))}
              </select>
            </div>
            <i className="fas fa-chevron-down text-xs text-neutral-500"></i>
          </div>

          <div className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg border-2 border-neutral-200 focus-within:border-orange-500 transition-colors">
             <i className="fas fa-calendar text-neutral-400"></i>
                <input
                  type="date"
                  className="outline-none text-neutral-900 font-bold uppercase text-sm bg-transparent"
                  value={selectedDate}
                  min={minDate}
                  max={maxDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                />
          </div>
        </div>
      </div>

      {/* Upcoming Booking Widget */}
      {upcomingBooking && (() => {
  const slot = facilityService
    .getAllSlots()
    .find(s => s.id === upcomingBooking.slotId);

  const facility = facilityService
    .getAllFacilities()
    .find(f => f.id === slot?.facilityId);

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
          {facility?.name || 'Unknown Facility'}
        </h3>

        <p className="text-lg font-medium mt-1 text-neutral-300">
          <span className="text-orange-500 font-bold">
            {upcomingBooking.bookingDate}
          </span>
          <span className="mx-2">•</span>
          {slot?.time}
        </p>
        {facility && (
          <button
            onClick={() => openDirections(facility.location)}
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
        setSelectedSlotInsight(null);
      }}
    ></div>

    <div className="relative bg-white w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col md:flex-row shadow-2xl animate-in zoom-in-95 duration-200 rounded-xl">

      {/* Close Button */}
      <button
        onClick={() => {
          setSelectedFacility(null);
          setSelectedSlotInsight(null);
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

                {/* AI Demand Insights Card */}
                <div className="bg-neutral-50 border border-neutral-200 p-4 rounded-lg">
            <div className="mb-2">
              <div className="flex items-center gap-2">
                <i className="fas fa-chart-line text-orange-500"></i>
                <h4 className="font-bold text-xs uppercase tracking-widest text-neutral-900">
                  Demand Analysis
                </h4>
              </div>

              <p className="text-[9px] text-neutral-400 font-medium uppercase tracking-widest mt-1">
                Pricing powered by predictive intelligence
              </p>
            </div>

            {loadingPrediction ? (
              <p className="text-xs text-neutral-400 italic">
                Analyzing market data...
              </p>
            ) : selectedSlotInsight ? (
              <div className="flex items-center justify-between">
                <p className="text-xs text-neutral-600 font-medium">
                  {selectedSlotInsight.demandLevel === 'High'
                    ? 'High demand detected for this slot.'
                    : 'Normal demand for this slot.'}
                </p>

                {selectedSlotInsight.isSurge ? (
                  <span className="text-[10px] bg-orange-100 text-orange-700 border border-orange-200 px-2 py-1 rounded font-black uppercase tracking-wider">
                    Surge Rates
                  </span>
                ) : (
                  <span className="text-[10px] bg-emerald-100 text-emerald-700 border border-emerald-200 px-2 py-1 rounded font-black uppercase tracking-wider">
                    Normal Rates
                  </span>
                )}
              </div>
            ) : (
              <p className="text-xs text-neutral-400 italic">
                Select a time slot to view demand insight.
              </p>
            )}
          </div>
        </div>

              {/* Slots List */}
              {/* Slots List + Amenities */}
              <div className="flex-1 overflow-y-auto p-8 pt-4 min-h-0">
                <div className="space-y-3">
                  {slots.length > 0 ? (
                    slots.map(s => {
                      const pred = getSlotPrediction(s.id);
                      const isHigh = pred?.demandLevel === 'High';
                      const isAvailable = checkSlotAvailability(s.id, selectedDate);
                      const booked = !isAvailable;

                      return (
                        <div
                          key={s.id}
                          onClick={() => setSelectedSlotInsight(pred || null)}
                          className={`group cursor-pointer p-4 rounded-lg border-2 transition-all flex items-center justify-between ${
                            selectedSlotInsight?.slotId === s.id
                              ? 'border-orange-500 bg-orange-50'
                              : booked
                              ? 'bg-neutral-100 border-transparent opacity-50'
                              : isHigh
                              ? 'bg-white border-orange-100 hover:border-orange-500'
                              : 'bg-white border-neutral-100 hover:border-black'
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-3">
                              <span className="text-lg font-black text-neutral-900">
                                {s.time}
                              </span>

                              {isHigh && !booked && (
                                <span className="text-[9px] font-black text-white uppercase tracking-wider bg-orange-500 px-1.5 py-0.5 rounded-sm">
                                  Hot
                                </span>
                              )}
                            </div>

                            {pred?.reasoning && isHigh && !booked && (
                              <p className="text-[10px] text-orange-600 font-bold uppercase tracking-wide mt-1">
                                {pred.reasoning}
                              </p>
                            )}
                          </div>

                          <div className="text-right flex items-center gap-4">
                            <div>
                              <p className="font-black text-xl text-neutral-900">
                                ₹{s.price}
                              </p>

                              {pred?.isSurge && !booked && (
                                <p className="text-[8px] text-orange-500 font-black uppercase tracking-widest">
                                  Surge
                                </p>
                              )}
                            </div>

                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleBook(s);
                              }}
                              disabled={!isAvailable}
                              className={`px-6 py-2 rounded-md text-xs font-black uppercase tracking-widest transition-all ${
                                isAvailable
                                  ? 'bg-black text-white group-hover:bg-orange-600'
                                  : 'bg-neutral-300 text-neutral-500 cursor-not-allowed'
                              }`}
                            >
                              {isAvailable ? 'Book' : 'Full'}
                            </button>
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {filteredFacilities.map((f) => (
              <div 
                key={f.id} 
                onClick={() => handleSelectFacility(f)}
                className="group bg-white rounded-xl overflow-hidden border-2 border-transparent hover:border-black transition-all cursor-pointer shadow-sm hover:shadow-none"
              >
                <div className="h-56 overflow-hidden relative">
                  <img src={f.imageUrl} alt={f.name} className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition-all duration-500" />
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

            <div className="space-y-4">
              {myBookings.filter(b => b.status === 'confirmed').length > 0 ? (
                myBookings
                  .filter(b => b.status === 'confirmed')
                  .map(b => {
                    const slot = allSlots.find(s => s.id === b.slotId);
                    const facility = facilities.find(f => f.id === slot?.facilityId);

                    return (
                      <div
                        key={b.id}
                        className="p-4 bg-neutral-50 border border-neutral-200 rounded-lg"
                      >
                        <p className="text-xs font-black text-orange-600 uppercase">
                          {b.bookingDate}
                        </p>

                        <p className="text-sm font-black uppercase italic mt-1">
                          {facility?.name || 'Unknown Facility'}
                        </p>

                        <p className="text-xs text-neutral-500 uppercase">
                          {slot?.time}
                        </p>
                      </div>
                    );
                  })
              ) : (
                <p className="text-neutral-400 text-xs font-bold uppercase">
                  No active bookings
                </p>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};

export default UserDashboard;