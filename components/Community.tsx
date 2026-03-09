
// import React, { useState, useEffect } from 'react';
// import { eventService } from '../services/eventService';
// import { facilityService } from '../services/facilityService';
// import { createBookingTransactional } from '../services/bookingService';
// import { CommunityEvent, Facility, User, CommunityGroup } from '../types';

// interface CommunityProps {
//   user: User;
// }

// const Community: React.FC<CommunityProps> = ({ user }) => {
//   const [events, setEvents] = useState<CommunityEvent[]>([]);
//   const [facilities, setFacilities] = useState<Facility[]>([]);
//   const [showCreate, setShowCreate] = useState(false);
//   const [newEvent, setNewEvent] = useState({ title: '', facilityId: '', date: '', time: '' });

//   const [view, setView] = useState<'events' | 'groups'>('events');
//   const [groups, setGroups] = useState<CommunityGroup[]>([]);
//   const [showCreateGroup, setShowCreateGroup] = useState(false);
//   const [newGroup, setNewGroup] = useState({ name: '', sport: '', city: '' });
//   const [selectedSport, setSelectedSport] = useState<string>('All');
//   const [selectedLocation, setSelectedLocation] = useState<string>('All');

//   useEffect(() => {
//     refreshData();
//   }, []);

//   const refreshData = () => {
//     setEvents(eventService.getAllEvents());
//     setFacilities(facilityService.getAllFacilities());
//     setGroups(eventService.getAllGroups());
//   };

//   const handleCreate = (e: React.FormEvent) => {
//     e.preventDefault();
//     if (!newEvent.facilityId) return alert("Select a facility");
//     try {
//       eventService.createEvent({
//         ...newEvent,
//         createdBy: user.id
//       });
//       refreshData();
//       setShowCreate(false);
//       alert("Event submitted! It will be visible once approved by an admin.");
//     } catch (err: any) {
//       alert(err.message);
//     }
//   };

//   const handleJoin = (id: string) => {
//     try {
//       const event = events.find(e => e.id === id);
//       if (!event) return;
      
//       // Treat event joining as a booking
//       createBookingTransactional(event.id, user.id, event.date);
      
//       eventService.joinEvent(id);
//       refreshData();
//       alert("Joined event successfully!");
//     } catch (err: any) {
//       alert(err.message);
//     }
//   };

//   const handleCreateGroup = (e: React.FormEvent) => {
//     e.preventDefault();
//     try {
//       eventService.createGroup({
//         ...newGroup,
//         createdBy: user.id
//       });
//       refreshData();
//       setShowCreateGroup(false);
//       alert("Group submitted! It will be visible once approved by an admin.");
//     } catch (err: any) {
//       alert(err.message);
//     }
//   };

//   const handleJoinGroup = (id: string) => {
//     try {
//       eventService.joinGroup(id);
//       refreshData();
//     } catch (err: any) {
//       alert(err.message);
//     }
//   };

//   // Extract unique sports and locations for filters
//   const sports = ['All', ...Array.from(new Set(facilities.map(f => f.sport)))];
//   const locations = ['All', ...Array.from(new Set(facilities.map(f => f.location)))];

//   const filteredEvents = events.filter(event => {
//     const fac = facilities.find(f => f.id === event.facilityId);
//     const matchesSport = selectedSport === 'All' || fac?.sport === selectedSport;
//     const matchesLocation = selectedLocation === 'All' || fac?.location === selectedLocation;
//     return matchesSport && matchesLocation;
//   });

//   return (
//     <div className="max-w-7xl mx-auto px-4 py-8 font-sans">
//       <div className="flex flex-col md:flex-row justify-between items-end mb-12 gap-6 border-b-2 border-neutral-900 pb-6">
//         <div>
//            <h2 className="text-5xl font-black text-neutral-900 uppercase tracking-tighter italic">Community Games</h2>
//            <p className="text-neutral-500 font-medium mt-2 tracking-wide uppercase text-xs">Find teammates and join open matches.</p>
//         </div>
        
//         <div className="flex flex-wrap gap-4">
//           <select 
//             className="px-4 py-2 border-2 border-neutral-200 rounded-lg bg-white text-neutral-900 font-bold uppercase text-xs tracking-wider outline-none focus:border-orange-500 transition-colors"
//             value={selectedSport}
//             onChange={(e) => setSelectedSport(e.target.value)}
//           >
//             {sports.map(s => <option key={s} value={s}>{s === 'All' ? 'All Sports' : s}</option>)}
//           </select>
          
//           <select 
//             className="px-4 py-2 border-2 border-neutral-200 rounded-lg bg-white text-neutral-900 font-bold uppercase text-xs tracking-wider outline-none focus:border-orange-500 transition-colors"
//             value={selectedLocation}
//             onChange={(e) => setSelectedLocation(e.target.value)}
//           >
//             {locations.map(l => <option key={l} value={l}>{l === 'All' ? 'All Locations' : l}</option>)}
//           </select>

//           <button 
//             onClick={() => setShowCreate(true)}
//             className="bg-neutral-900 text-white px-6 py-2 rounded-lg font-black uppercase tracking-widest hover:bg-orange-600 transition-all"
//           >
//             <i className="fas fa-plus mr-2"></i> Create Event
//           </button>
//         </div>
//       </div>

//       <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
//         {filteredEvents.map(event => {
//           const fac = facilities.find(f => f.id === event.facilityId);
//           const isJoined = event.participants.includes(user.id);
          

//           return (
//             <div key={event.id} className="group bg-white rounded-lg border-2 border-neutral-100 hover:border-black transition-all p-0 overflow-hidden flex flex-col">
//               {event.imageUrl && (
//                 <div className="h-48 overflow-hidden relative border-b-2 border-neutral-100">
//                   <img src={event.imageUrl} alt={event.title} className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition-all duration-500" />
//                   <div className="absolute top-4 left-4">
//                      <span className="bg-orange-500 text-white text-[10px] font-black uppercase px-2 py-0.5 tracking-widest shadow-sm">
//                        {fac?.sport}
//                      </span>
//                   </div>
//                 </div>
//               )}
              
//               <div className="bg-neutral-50 p-6 border-b-2 border-neutral-100 group-hover:bg-neutral-900 group-hover:text-white transition-colors">
//                 <div className="flex justify-between items-start mb-2">
//                   {!event.imageUrl && (
//                     <span className="bg-orange-500 text-white text-[10px] font-black uppercase px-2 py-0.5 tracking-widest">
//                       {fac?.sport}
//                     </span>
//                   )}
//                   <span className="text-[10px] font-bold uppercase tracking-wider opacity-60 ml-auto">
//                     {event.participants.length} Players
//                   </span>
//                 </div>
//                 <h3 className="font-black text-2xl uppercase italic tracking-tighter leading-none mb-1">{event.title}</h3>
//                 <p className="text-xs font-bold uppercase tracking-wide opacity-70">{fac?.name || 'Unknown Location'}</p>
//               </div>
              
//               <div className="p-6 flex-1 flex flex-col justify-between">
//                 <div className="space-y-3 mb-6">
//                   <div className="flex items-center gap-3">
//                     <div className="w-8 h-8 bg-neutral-100 rounded-full flex items-center justify-center text-neutral-400">
//                       <i className="far fa-calendar"></i>
//                     </div>
//                     <div>
//                       <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest">Date</p>
//                       <p className="font-bold text-neutral-900 uppercase">{event.date}</p>
//                     </div>
//                   </div>
//                   <div className="flex items-center gap-3">
//                     <div className="w-8 h-8 bg-neutral-100 rounded-full flex items-center justify-center text-neutral-400">
//                       <i className="far fa-clock"></i>
//                     </div>
//                     <div>
//                       <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest">Time</p>
//                       <p className="font-bold text-neutral-900 uppercase">{event.time}</p>
//                     </div>
//                   </div>
//                 </div>

//                 <button 
//                   onClick={() => handleJoin(event.id)}
//                   disabled={isJoined}
//                   className={`w-full py-3 rounded-md font-black uppercase tracking-widest text-xs transition-all ${
//                     isJoined 
//                     ? 'bg-emerald-100 text-emerald-700 border-2 border-emerald-200 cursor-default' 
//                     : 'bg-neutral-900 text-white hover:bg-orange-600'
//                   }`}
//                 >
//                   {isJoined ? 'Joined' : 'Join Match'}
//                 </button>
//               </div>
//             </div>
//           );
//         })}
//         {events.length === 0 && (
//           <div className="col-span-full py-12 text-center border-2 border-dashed border-neutral-200 rounded-lg">
//             <p className="text-neutral-400 font-bold uppercase tracking-widest">No community events found. Create one!</p>
//           </div>
//         )}
//       </div>

//       {showCreate && (
//         <div className="fixed inset-0 bg-neutral-900/90 backdrop-blur-sm z-50 flex items-center justify-center p-4">
//           <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-8 animate-in zoom-in-95 duration-200 border-2 border-neutral-100">
//             <div className="flex justify-between items-center mb-8">
//               <h3 className="text-2xl font-black text-neutral-900 uppercase italic tracking-tighter">Create Event</h3>
//               <button onClick={() => setShowCreate(false)} className="text-neutral-400 hover:text-black transition-colors">
//                 <i className="fas fa-times text-xl"></i>
//               </button>
//             </div>
//             <form onSubmit={handleCreate} className="space-y-6">
//               <div>
//                 <label className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-2">Event Title</label>
//                 <input required className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors" placeholder="e.g. SUNDAY MORNING PADEL" value={newEvent.title} onChange={e => setNewEvent({...newEvent, title: e.target.value})} />
//               </div>
//               <div>
//                 <label className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-2">Facility</label>
//                 <select required className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors bg-white" value={newEvent.facilityId} onChange={e => setNewEvent({...newEvent, facilityId: e.target.value})}>
//                   <option value="">Select a facility...</option>
//                   {facilities.map(f => <option key={f.id} value={f.id}>{f.name} ({f.sport})</option>)}
//                 </select>
//               </div>
//               <div className="grid grid-cols-2 gap-4">
//                 <div>
//                   <label className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-2">Date</label>
//                   <input type="date" required className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors uppercase" value={newEvent.date} onChange={e => setNewEvent({...newEvent, date: e.target.value})} />
//                 </div>
//                 <div>
//                   <label className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-2">Time</label>
//                   <input type="time" required className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors uppercase" value={newEvent.time} onChange={e => setNewEvent({...newEvent, time: e.target.value})} />
//                 </div>
//               </div>
//               <button type="submit" className="w-full py-4 bg-neutral-900 text-white font-black uppercase tracking-widest rounded-lg hover:bg-orange-600 transition-colors mt-4 text-sm">
//                 Create Event
//               </button>
//             </form>
//           </div>
//         </div>
//       )}
//     </div>
//   );
// };

// export default Community;


import React, { useEffect, useState } from 'react';
import { eventService } from '../services/eventService';
import { CommunityGroup, User } from '../types';

interface CommunityProps {
  user: User;
  onSelectCommunity: (group: CommunityGroup) => void;
}

const Community: React.FC<CommunityProps> = ({ user, onSelectCommunity }) => {
  const [groups, setGroups] = useState<CommunityGroup[]>([]);

  useEffect(() => {
    refresh();
  }, [user.city]);

  const refresh = () => {
    const allGroups = eventService.getAllGroups(true).filter(
      g => g.status === 'approved'
    );

    if (!user.city || !user.city.trim()) {
      setGroups(allGroups);
      return;
    }

    const cityGroups = allGroups.filter(
      g =>
        (g.city || '').trim().toLowerCase() ===
        user.city.trim().toLowerCase()
    );

    setGroups(cityGroups);
    console.log(allGroups);
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-10 font-sans">
      <div className="mb-12 border-b-2 border-neutral-900 pb-6">
        <h2 className="text-5xl font-black uppercase tracking-tighter italic">
          Communities
        </h2>
        <p className="text-neutral-500 font-medium mt-2 tracking-wide uppercase text-xs">
          {user.city
            ? `Find like-minded players in ${user.city}`
            : 'Find like-minded players near you'}
        </p>
      </div>

      {groups.length === 0 && (
        <div className="py-16 text-center border-2 border-dashed border-neutral-200 rounded-lg">
          <p className="text-neutral-400 font-bold uppercase tracking-widest">
            No communities found in your city.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {groups.map(group => (
          <div
            key={group.id}
            onClick={() => onSelectCommunity(group)}
            className="cursor-pointer rounded-xl overflow-hidden border-2 border-neutral-200 hover:border-black transition group bg-white"
          >
            <div className="relative h-48 overflow-hidden">
              {group.imageUrl && (
                <img
                  src={group.imageUrl}
                  alt={group.name}
                  className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition duration-500"
                />
              )}
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

            <div className="p-5 bg-white">
              <p className="text-xs text-neutral-500 font-bold uppercase tracking-widest">
                {group.members?.length || 0} Members
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Community;