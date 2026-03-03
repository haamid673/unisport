
// import { CommunityEvent, CommunityGroup, AuditLog, ApprovalStatus } from '../types';
// import { storageService, STORAGE_KEYS } from './storageService';
// import { userService } from './userService';




// const initialEvents: CommunityEvent[] = [
//   { 
//     id: 'e1', 
//     title: 'Padel Beginners Workshop', 
//     date: '2024-06-15', 
//     time: '10:00 AM', 
//     facilityId: 'f1', 
//     createdBy: 'admin', 
//     participants: ['admin', 'user1', 'user2'], 
//     status: 'approved', 
//     groupId: 'g1',
//     imageUrl: 'https://images.unsplash.com/photo-1554068865-24cecd4e34b8?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e2', 
//     title: 'Weekend Volleyball Mix', 
//     date: '2024-06-16', 
//     time: '05:00 PM', 
//     facilityId: 'f2', 
//     createdBy: 'owner1', 
//     participants: ['owner1', 'user3', 'user4'], 
//     status: 'approved', 
//     groupId: 'g2',
//     imageUrl: 'https://images.unsplash.com/photo-1612872087720-bb876e2e67d1?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e3', 
//     title: '3x3 Basketball Tournament', 
//     date: '2024-06-20', 
//     time: '02:00 PM', 
//     facilityId: 'f3', 
//     createdBy: 'owner2', 
//     participants: ['owner2', 'user5'], 
//     status: 'approved', 
//     groupId: 'g3',
//     imageUrl: 'https://images.unsplash.com/photo-1546519638-68e109498ffc?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e4', 
//     title: 'Morning Yoga Session', 
//     date: '2024-06-22', 
//     time: '06:00 AM', 
//     facilityId: 'f1', 
//     createdBy: 'user1', 
//     participants: ['user1', 'admin', 'user2', 'user6'], 
//     status: 'approved', 
//     groupId: 'g4',
//     imageUrl: 'https://images.unsplash.com/photo-1599447421405-075115d6e300?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e5', 
//     title: 'Corporate Cricket League', 
//     date: '2024-06-25', 
//     time: '09:00 AM', 
//     facilityId: 'f4', 
//     createdBy: 'owner2', 
//     participants: ['owner2', 'user1', 'user5', 'user7'], 
//     status: 'approved', 
//     groupId: 'g5',
//     imageUrl: 'https://images.unsplash.com/photo-1531415074968-036ba1b575da?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e6', 
//     title: 'Badminton Doubles Night', 
//     date: '2024-06-28', 
//     time: '07:00 PM', 
//     facilityId: 'f1', 
//     createdBy: 'admin', 
//     participants: ['admin', 'user4'], 
//     status: 'approved', 
//     groupId: 'g1',
//     imageUrl: 'https://images.unsplash.com/photo-1626224583764-8478ab2e1539?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e7', 
//     title: 'Swimming Gala', 
//     date: '2024-07-01', 
//     time: '08:00 AM', 
//     facilityId: 'f5', 
//     createdBy: 'user2', 
//     participants: ['user2', 'user6'], 
//     status: 'approved', 
//     groupId: 'g6',
//     imageUrl: 'https://images.unsplash.com/photo-1530549387789-4c1017266635?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e8', 
//     title: 'Tennis Club Championship', 
//     date: '2024-07-05', 
//     time: '04:00 PM', 
//     facilityId: 'f6', 
//     createdBy: 'user6', 
//     participants: ['user6', 'user1'], 
//     status: 'approved', 
//     groupId: 'g7',
//     imageUrl: 'https://images.unsplash.com/photo-1622279457486-62dcc4a431d6?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e9', 
//     title: 'Futsal Friday', 
//     date: '2024-07-07', 
//     time: '08:00 PM', 
//     facilityId: 'f2', 
//     createdBy: 'user3', 
//     participants: ['user3', 'user7', 'user5'], 
//     status: 'approved', 
//     groupId: 'g8',
//     imageUrl: 'https://images.unsplash.com/photo-1579952363873-27f3bade9f55?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e10', 
//     title: 'Sunrise Meditation', 
//     date: '2024-07-10', 
//     time: '05:30 AM', 
//     facilityId: 'f7', 
//     createdBy: 'user2', 
//     participants: ['user2', 'admin'], 
//     status: 'approved', 
//     groupId: 'g4',
//     imageUrl: 'https://images.unsplash.com/photo-1506126613408-eca07ce68773?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e11', 
//     title: 'Powerlifting Meet', 
//     date: '2024-07-15', 
//     time: '10:00 AM', 
//     facilityId: 'f8', 
//     createdBy: 'owner3', 
//     participants: ['owner3', 'user3'], 
//     status: 'approved', 
//     groupId: 'g9',
//     imageUrl: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e12', 
//     title: 'Kids Cricket Coaching', 
//     date: '2024-07-20', 
//     time: '04:00 PM', 
//     facilityId: 'f4', 
//     createdBy: 'user5', 
//     participants: ['user5'], 
//     status: 'approved', 
//     groupId: 'g5',
//     imageUrl: 'https://images.unsplash.com/photo-1593341646782-e0b495cffd32?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e13', 
//     title: 'Women\'s Self Defense', 
//     date: '2024-07-25', 
//     time: '06:00 PM', 
//     facilityId: 'f7', 
//     createdBy: 'user4', 
//     participants: ['user4', 'user2', 'user6'], 
//     status: 'approved', 
//     groupId: 'g10',
//     imageUrl: 'https://images.unsplash.com/photo-1555597673-b21d5c935865?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e14', 
//     title: 'Table Tennis Tournament', 
//     date: '2024-07-28', 
//     time: '03:00 PM', 
//     facilityId: 'f9', 
//     createdBy: 'admin', 
//     participants: ['admin', 'user1'], 
//     status: 'approved', 
//     groupId: 'g1',
//     imageUrl: 'https://images.unsplash.com/photo-1534158914592-062992bbe900?q=80&w=800&auto=format&fit=crop'
//   },

//   { 
//     id: 'e15', 
//     title: 'Marathon Training Run', 
//     date: '2024-08-01', 
//     time: '05:00 AM', 
//     facilityId: 'f2', 
//     createdBy: 'user7', 
//     participants: ['user7', 'user3'], 
//     status: 'approved', 
//     groupId: 'g8',
//     imageUrl: 'https://images.unsplash.com/photo-1552674605-46d536d2e609?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e16', 
//     title: 'Mumbai Football League', 
//     date: '2024-08-05', 
//     time: '06:00 PM', 
//     facilityId: 'm1', 
//     createdBy: 'owner1', 
//     participants: ['owner1', 'user3'], 
//     status: 'approved', 
//     groupId: 'g11',
//     imageUrl: 'https://images.unsplash.com/photo-1579952363873-27f3bade9f55?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e17', 
//     title: 'Delhi Tennis Open', 
//     date: '2024-08-10', 
//     time: '09:00 AM', 
//     facilityId: 'd1', 
//     createdBy: 'owner3', 
//     participants: ['owner3', 'user6'], 
//     status: 'approved', 
//     groupId: 'g12',
//     imageUrl: 'https://images.unsplash.com/photo-1622279457486-62dcc4a431d6?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e18', 
//     title: 'Bangalore Hoop Fest', 
//     date: '2024-08-12', 
//     time: '05:00 PM', 
//     facilityId: 'b1', 
//     createdBy: 'owner2', 
//     participants: ['owner2', 'user5'], 
//     status: 'approved', 
//     groupId: 'g13',
//     imageUrl: 'https://images.unsplash.com/photo-1546519638-68e109498ffc?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e19', 
//     title: 'Hyderabad Badminton Clash', 
//     date: '2024-08-15', 
//     time: '10:00 AM', 
//     facilityId: 'h2', 
//     createdBy: 'owner1', 
//     participants: ['owner1', 'user4'], 
//     status: 'approved', 
//     groupId: 'g14',
//     imageUrl: 'https://images.unsplash.com/photo-1626224583764-8478ab2e1539?q=80&w=800&auto=format&fit=crop'
//   },
//   { 
//     id: 'e20', 
//     title: 'Kolkata Cricket Cup', 
//     date: '2024-08-20', 
//     time: '08:00 AM', 
//     facilityId: 'k2', 
//     createdBy: 'owner2', 
//     participants: ['owner2', 'user1'], 
//     status: 'approved', 
//     groupId: 'g15',
//     imageUrl: 'https://images.unsplash.com/photo-1531415074968-036ba1b575da?q=80&w=800&auto=format&fit=crop'
//   }
// ];


// const initialGroups: CommunityGroup[] = [
//   { id: 'g1', name: 'Padel Enthusiasts', sport: 'Padel', city: 'Adyar', createdBy: 'admin', status: 'approved', members: ['admin', 'user1', 'user2'] },
//   { id: 'g2', name: 'Volleyball Spikers', sport: 'Volleyball', city: 'Besant Nagar', createdBy: 'owner1', status: 'approved', members: ['owner1', 'user3', 'user4'] },
//   { id: 'g3', name: 'Hoop Dreams', sport: 'Basketball', city: 'T. Nagar', createdBy: 'owner2', status: 'approved', members: ['owner2', 'user5'] },
//   { id: 'g4', name: 'Zen Yoga Club', sport: 'Yoga', city: 'Anna Nagar', createdBy: 'user1', status: 'approved', members: ['user1', 'admin', 'user2', 'user6'] },
//   { id: 'g5', name: 'Weekend Warriors Cricket', sport: 'Cricket', city: 'Velachery', createdBy: 'owner2', status: 'approved', members: ['owner2', 'user1', 'user5', 'user7'] },
//   { id: 'g6', name: 'Aqua Fit', sport: 'Swimming', city: 'Mylapore', createdBy: 'user2', status: 'approved', members: ['user2', 'user6'] },
//   { id: 'g7', name: 'Ace Tennis Academy', sport: 'Tennis', city: 'Nungambakkam', createdBy: 'user6', status: 'approved', members: ['user6', 'user1'] },
//   { id: 'g8', name: 'Chennai Futsal Club', sport: 'Football', city: 'Egmore', createdBy: 'user3', status: 'approved', members: ['user3', 'user7', 'user5'] },
//   { id: 'g9', name: 'Iron Pumpers', sport: 'Gym', city: 'Alwarpet', createdBy: 'owner3', status: 'approved', members: ['owner3', 'user3'] },
//   { id: 'g10', name: 'Martial Arts & Defense', sport: 'Martial Arts', city: 'Kilpauk', createdBy: 'user4', status: 'approved', members: ['user4', 'user2', 'user6'] },
//   { id: 'g11', name: 'Mumbai Strikers', sport: 'Football', city: 'Mumbai', createdBy: 'owner1', status: 'approved', members: ['owner1', 'user3'] },
//   { id: 'g12', name: 'Delhi Smashers', sport: 'Tennis', city: 'Delhi', createdBy: 'owner3', status: 'approved', members: ['owner3', 'user6'] },
//   { id: 'g13', name: 'Bangalore Ballers', sport: 'Basketball', city: 'Bangalore', createdBy: 'owner2', status: 'approved', members: ['owner2', 'user5'] },
//   { id: 'g14', name: 'Hyderabad Shuttlers', sport: 'Badminton', city: 'Hyderabad', createdBy: 'owner1', status: 'approved', members: ['owner1', 'user4'] },
//   { id: 'g15', name: 'Kolkata Knights', sport: 'Cricket', city: 'Kolkata', createdBy: 'owner2', status: 'approved', members: ['owner2', 'user1'] }
// ];

// export const eventService = {
//   // --- Events ---

//   getAllEvents: (includePending = false): CommunityEvent[] => {
//   const currentUser = userService.getCurrentUser();
//   const events = storageService.get<CommunityEvent[]>(STORAGE_KEYS.EVENTS, initialEvents);

//   let filtered = includePending ? events : events.filter(e => e.status === 'approved');

//   if (!currentUser) return filtered;

//   const groups = storageService.get<CommunityGroup[]>(STORAGE_KEYS.GROUPS, initialGroups);

//   return filtered.filter(event => {
//     const group = groups.find(g => g.id === event.groupId);
//     if (!group) return false;

//     return group.city === currentUser.city; // assuming user has city
//   });
// },

//   createEvent: (event: Omit<CommunityEvent, 'id' | 'participants' | 'status'>): CommunityEvent => {
//     const currentUser = userService.getCurrentUser();
//     if (!currentUser) throw new Error("Must be logged in");

//     const events = storageService.get<CommunityEvent[]>(STORAGE_KEYS.EVENTS, initialEvents);
//     const newEvent: CommunityEvent = { 
//       ...event, 
//       id: `evt_${Date.now()}`, 
//       participants: [currentUser.id], 
//       createdBy: currentUser.id,
//       status: currentUser.role === 'admin' ? 'approved' : 'pending'
//     };
    
//     events.push(newEvent);
//     storageService.set(STORAGE_KEYS.EVENTS, events);

//     // Audit Log
//     const logs = storageService.get<AuditLog[]>(STORAGE_KEYS.AUDIT_LOGS, []);
//     logs.unshift({
//       id: `log_${Date.now()}`,
//       action: 'Event Created',
//       entityId: newEvent.id,
//       entityType: 'Event',
//       performedBy: currentUser.id,
//       timestamp: new Date().toISOString(),
//       details: `Status: ${newEvent.status}`
//     });
//     storageService.set(STORAGE_KEYS.AUDIT_LOGS, logs);

//     return newEvent;
//   },

//   updateEventStatus: (id: string, status: ApprovalStatus): void => {
//     const currentUser = userService.getCurrentUser();
//     if (currentUser?.role !== 'admin') throw new Error("Unauthorized");

//     const events = storageService.get<CommunityEvent[]>(STORAGE_KEYS.EVENTS, initialEvents);
//     const eventIndex = events.findIndex(e => e.id === id);
    
//     if (eventIndex !== -1) {
//       events[eventIndex].status = status;
//       storageService.set(STORAGE_KEYS.EVENTS, events);
      
//       // Audit Log
//       const logs = storageService.get<AuditLog[]>(STORAGE_KEYS.AUDIT_LOGS, []);
//       logs.unshift({
//         id: `log_${Date.now()}`,
//         action: `Event ${status.charAt(0).toUpperCase() + status.slice(1)}`,
//         entityId: id,
//         entityType: 'Event',
//         performedBy: currentUser.id,
//         timestamp: new Date().toISOString()
//       });
//       storageService.set(STORAGE_KEYS.AUDIT_LOGS, logs);
//     }
//   },

//   joinEvent: (eventId: string): void => {
//     const currentUser = userService.getCurrentUser();
//     if (!currentUser) throw new Error("Must be logged in");

//     const events = storageService.get<CommunityEvent[]>(STORAGE_KEYS.EVENTS, initialEvents);
//     const eventIndex = events.findIndex(e => e.id === eventId);
    
//     if (eventIndex !== -1 && !events[eventIndex].participants.includes(currentUser.id)) {
//       events[eventIndex].participants.push(currentUser.id);
//       storageService.set(STORAGE_KEYS.EVENTS, events);
      
//       // Audit Log
//       const logs = storageService.get<AuditLog[]>(STORAGE_KEYS.AUDIT_LOGS, []);
//       logs.unshift({
//         id: `log_${Date.now()}`,
//         action: 'Event Joined',
//         entityId: eventId,
//         entityType: 'Event',
//         performedBy: currentUser.id,
//         timestamp: new Date().toISOString()
//       });
//       storageService.set(STORAGE_KEYS.AUDIT_LOGS, logs);
//     }
//   },

//   // --- Groups ---

//   getAllGroups: (includePending = false): CommunityGroup[] => {
//     const groups = storageService.get<CommunityGroup[]>(STORAGE_KEYS.GROUPS, initialGroups);
//     if (includePending) return groups;
//     return groups.filter(g => g.status === 'approved');
//   },

//   createGroup: (group: Omit<CommunityGroup, 'id' | 'members' | 'status'>): CommunityGroup => {
//     const currentUser = userService.getCurrentUser();
//     if (!currentUser) throw new Error("Must be logged in");

//     const groups = storageService.get<CommunityGroup[]>(STORAGE_KEYS.GROUPS, initialGroups);
//     const newGroup: CommunityGroup = {
//       ...group,
//       id: `grp_${Date.now()}`,
//       members: [currentUser.id],
//       createdBy: currentUser.id,
//       status: currentUser.role === 'admin' ? 'approved' : 'pending'
//     };

//     groups.push(newGroup);
//     storageService.set(STORAGE_KEYS.GROUPS, groups);

//     // Audit Log
//     const logs = storageService.get<AuditLog[]>(STORAGE_KEYS.AUDIT_LOGS, []);
//     logs.unshift({
//       id: `log_${Date.now()}`,
//       action: 'Group Created',
//       entityId: newGroup.id,
//       entityType: 'Group',
//       performedBy: currentUser.id,
//       timestamp: new Date().toISOString(),
//       details: `Status: ${newGroup.status}`
//     });
//     storageService.set(STORAGE_KEYS.AUDIT_LOGS, logs);

//     return newGroup;
//   },

//   updateGroupStatus: (id: string, status: ApprovalStatus): void => {
//     const currentUser = userService.getCurrentUser();
//     if (currentUser?.role !== 'admin') throw new Error("Unauthorized");

//     const groups = storageService.get<CommunityGroup[]>(STORAGE_KEYS.GROUPS, initialGroups);
//     const groupIndex = groups.findIndex(g => g.id === id);

//     if (groupIndex !== -1) {
//       groups[groupIndex].status = status;
//       storageService.set(STORAGE_KEYS.GROUPS, groups);

//       // Audit Log
//       const logs = storageService.get<AuditLog[]>(STORAGE_KEYS.AUDIT_LOGS, []);
//       logs.unshift({
//         id: `log_${Date.now()}`,
//         action: `Group ${status.charAt(0).toUpperCase() + status.slice(1)}`,
//         entityId: id,
//         entityType: 'Group',
//         performedBy: currentUser.id,
//         timestamp: new Date().toISOString()
//       });
//       storageService.set(STORAGE_KEYS.AUDIT_LOGS, logs);
//     }
//   },

//   joinGroup: (groupId: string): void => {
//     const currentUser = userService.getCurrentUser();
//     if (!currentUser) throw new Error("Must be logged in");

//     const groups = storageService.get<CommunityGroup[]>(STORAGE_KEYS.GROUPS, initialGroups);
//     const groupIndex = groups.findIndex(g => g.id === groupId);

//     if (groupIndex !== -1 && !groups[groupIndex].members.includes(currentUser.id)) {
//       groups[groupIndex].members.push(currentUser.id);
//       storageService.set(STORAGE_KEYS.GROUPS, groups);
//     }
//   }
// };


import { CommunityEvent, CommunityGroup, AuditLog, ApprovalStatus } from '../types';
import { storageService, STORAGE_KEYS } from './storageService';
import { userService } from './userService';


const getSportImage = (sport: string) => {
  const map: Record<string, string> = {
    Padel: 'https://images.unsplash.com/photo-1554068865-24cecd4e34b8?q=80&w=1200',
    Football: 'https://images.unsplash.com/photo-1579952363873-27f3bade9f55?q=80&w=1200',
    Basketball: 'https://images.unsplash.com/photo-1546519638-68e109498ffc?q=80&w=1200',
    Yoga: 'https://images.unsplash.com/photo-1599447421405-075115d6e300?q=80&w=1200',
    Cricket: 'https://images.unsplash.com/photo-1531415074968-036ba1b575da?q=80&w=1200',
    Swimming: 'https://images.unsplash.com/photo-1530549387789-4c1017266635?q=80&w=1200',
    Tennis: 'https://images.unsplash.com/photo-1622279457486-62dcc4a431d6?q=80&w=1200',
    Gym: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?q=80&w=1200',
    Badminton: 'https://images.unsplash.com/photo-1626224583764-8478ab2e1539?q=80&w=1200',
    Volleyball: 'https://unsplash.com/photos/silhouette-of-people-playing-basketball-during-sunset-0NaQQsLWLkA',
  };

  return map[sport] || map['Football'];
};
/* -------------------------------------------------- */
/* ---------------- SEEDED DATA --------------------- */
/* -------------------------------------------------- */

const seededGroups: CommunityGroup[] = [
  { id: 'g1', name: 'Padel Enthusiasts', sport: 'Padel', city: 'Chennai', createdBy: 'admin', status: 'approved', members: ['admin', 'user1', 'user2'], imageUrl: getSportImage('Padel') },
  { id: 'g2', name: 'Volleyball Spikers', sport: 'Volleyball', city: 'Chennai', createdBy: 'owner1', status: 'approved', members: ['owner1', 'user3', 'user4'], imageUrl: getSportImage('Volleyball') },
  { id: 'g3', name: 'Hoop Dreams', sport: 'Basketball', city: 'Chennai', createdBy: 'owner2', status: 'approved', members: ['owner2', 'user5'], imageUrl: getSportImage('Basketball') },
  { id: 'g4', name: 'Zen Yoga Club', sport: 'Yoga', city: 'Chennai', createdBy: 'user1', status: 'approved', members: ['user1', 'admin', 'user2', 'user6'], imageUrl: getSportImage('Yoga') },
  { id: 'g5', name: 'Weekend Warriors Cricket', sport: 'Cricket', city: 'Chennai', createdBy: 'owner2', status: 'approved', members: ['owner2', 'user1', 'user5', 'user7'], imageUrl: getSportImage('Cricket') },
  { id: 'g6', name: 'Aqua Fit', sport: 'Swimming', city: 'Chennai', createdBy: 'user2', status: 'approved', members: ['user2', 'user6'], imageUrl: getSportImage('Swimming') },
  { id: 'g7', name: 'Ace Tennis Academy', sport: 'Tennis', city: 'Chennai', createdBy: 'user6', status: 'approved', members: ['user6', 'user1'], imageUrl: getSportImage('Tennis') },
  { id: 'g8', name: 'Chennai Futsal Club', sport: 'Football', city: 'Chennai', createdBy: 'user3', status: 'approved', members: ['user3', 'user7', 'user5'], imageUrl: getSportImage('Football') },
  { id: 'g9', name: 'Iron Pumpers', sport: 'Gym', city: 'Chennai', createdBy: 'owner3', status: 'approved', members: ['owner3', 'user3'], imageUrl: getSportImage('Gym') },
  { id: 'g10', name: 'Martial Arts & Defense', sport: 'Martial Arts', city: 'Chennai', createdBy: 'user4', status: 'approved', members: ['user4', 'user2', 'user6'], imageUrl: getSportImage('Martial Arts') },
  { id: 'g11', name: 'Mumbai Strikers', sport: 'Football', city: 'Mumbai', createdBy: 'owner1', status: 'approved', members: ['owner1', 'user3'], imageUrl: getSportImage('Football') },
  { id: 'g12', name: 'Delhi Smashers', sport: 'Tennis', city: 'Delhi', createdBy: 'owner3', status: 'approved', members: ['owner3', 'user6'], imageUrl: getSportImage('Tennis') },
  { id: 'g13', name: 'Bangalore Ballers', sport: 'Basketball', city: 'Bangalore', createdBy: 'owner2', status: 'approved', members: ['owner2', 'user5'], imageUrl: getSportImage('Basketball') },
  { id: 'g14', name: 'Hyderabad Shuttlers', sport: 'Badminton', city: 'Hyderabad', createdBy: 'owner1', status: 'approved', members: ['owner1', 'user4'], imageUrl: getSportImage('Badminton') },
  { id: 'g15', name: 'Kolkata Knights', sport: 'Cricket', city: 'Kolkata', createdBy: 'owner2', status: 'approved', members: ['owner2', 'user1'], imageUrl: getSportImage('Cricket') }
];

const seededEvents: CommunityEvent[] = [
  { id: 'e1', title: 'Padel Beginners Workshop', date: '2024-06-15', time: '10:00 AM', facilityId: 'f1', createdBy: 'admin', participants: ['admin','user2'], status: 'approved', groupId: 'g1' },
  { id: 'e2', title: 'Weekend Volleyball Mix', date: '2024-06-16', time: '05:00 PM', facilityId: 'f2', createdBy: 'owner1', participants: ['owner1','user3','user4'], status: 'approved', groupId: 'g2', imageUrl: getSportImage('Volleyball') },
  { id: 'e3', title: '3x3 Basketball Tournament', date: '2024-06-20', time: '02:00 PM', facilityId: 'f3', createdBy: 'owner2', participants: ['owner2','user5'], status: 'approved', groupId: 'g3', imageUrl: 'https://images.unsplash.com/photo-1546519638-68e109498ffc?q=80&w=1200'},
  { id: 'e4', title: 'Morning Yoga Session', date: '2024-06-22', time: '06:00 AM', facilityId: 'f1', createdBy: 'user1', participants: ['user1','admin','user2','user6'], status: 'approved', groupId: 'g4', imageUrl: getSportImage('Yoga') },
  { id: 'e5', title: 'Corporate Cricket League', date: '2024-06-25', time: '09:00 AM', facilityId: 'f4', createdBy: 'owner2', participants: ['owner2','user1','user5','user7'], status: 'approved', groupId: 'g5', imageUrl: getSportImage('Cricket') },
  { id: 'e6', title: 'Badminton Doubles Night', date: '2024-06-28', time: '07:00 PM', facilityId: 'f1', createdBy: 'admin', participants: ['admin','user4'], status: 'approved', groupId: 'g1', imageUrl: getSportImage('Badminton') },
  { id: 'e7', title: 'Swimming Gala', date: '2024-07-01', time: '08:00 AM', facilityId: 'f5', createdBy: 'user2', participants: ['user2','user6'], status: 'approved', groupId: 'g6', imageUrl: getSportImage('Swimming') },
  { id: 'e8', title: 'Tennis Club Championship', date: '2024-07-05', time: '04:00 PM', facilityId: 'f6', createdBy: 'user6', participants: ['user6','user1'], status: 'approved', groupId: 'g7', imageUrl: getSportImage('Tennis') },
  { id: 'e9', title: 'Futsal Friday', date: '2024-07-07', time: '08:00 PM', facilityId: 'f2', createdBy: 'user3', participants: ['user3','user7','user5'], status: 'approved', groupId: 'g8', imageUrl: getSportImage('Football') },
  { id: 'e10', title: 'Sunrise Meditation', date: '2024-07-10', time: '05:30 AM', facilityId: 'f7', createdBy: 'user2', participants: ['user2','admin'], status: 'approved', groupId: 'g4', imageUrl: getSportImage('Yoga') }
];

/* -------------------------------------------------- */
/* ---------------- ONE-TIME SEED ------------------- */
/* -------------------------------------------------- */

if (!localStorage.getItem(STORAGE_KEYS.GROUPS)) {
  storageService.set(STORAGE_KEYS.GROUPS, seededGroups);
}

if (!localStorage.getItem(STORAGE_KEYS.EVENTS)) {
  storageService.set(STORAGE_KEYS.EVENTS, seededEvents);
}

/* -------------------------------------------------- */
/* ---------------- SERVICE LOGIC ------------------- */
/* -------------------------------------------------- */

export const eventService = {

 getAllEvents: (includePending = false): CommunityEvent[] => {
  const currentUser = userService.getCurrentUser();
  const events = storageService.get<CommunityEvent[]>(STORAGE_KEYS.EVENTS, []);
  const groups = storageService.get<CommunityGroup[]>(STORAGE_KEYS.GROUPS, []);

  let filtered = includePending
    ? events
    : events.filter(e => e.status === 'approved');

  // If no logged-in user OR user has no city → return approved events
  if (!currentUser || !currentUser.city) {
    return filtered;
  }

  return filtered.filter(event => {
    if (!event.groupId) return true; // allow legacy events

    const group = groups.find(g => g.id === event.groupId);
    if (!group) return false;

    return group.city === currentUser.city;
  });
},
getAllGroups: (includePending = false): CommunityGroup[] => {
  const currentUser = userService.getCurrentUser();
  const groups = storageService.get<CommunityGroup[]>(STORAGE_KEYS.GROUPS, []);

  let filtered = includePending
    ? groups
    : groups.filter(g => g.status === 'approved');

  if (!currentUser || !currentUser.city) return filtered;

  return filtered.filter(group => group.city === currentUser.city);
},

joinGroup: (groupId: string): void => {
  const currentUser = userService.getCurrentUser();
  if (!currentUser) throw new Error("Must be logged in");

  const groups = storageService.get<CommunityGroup[]>(STORAGE_KEYS.GROUPS, []);
  const index = groups.findIndex(g => g.id === groupId);

  if (index === -1) return;

  if (!groups[index].members.includes(currentUser.id)) {
    groups[index].members.push(currentUser.id);
    storageService.set(STORAGE_KEYS.GROUPS, groups);
  }
},

leaveGroup: (groupId: string): void => {
  const currentUser = userService.getCurrentUser();
  if (!currentUser) return;

  const groups = storageService.get<CommunityGroup[]>(STORAGE_KEYS.GROUPS, []);
  const index = groups.findIndex(g => g.id === groupId);

  if (index === -1) return;

  groups[index].members = groups[index].members.filter(
    m => m !== currentUser.id
  );

  storageService.set(STORAGE_KEYS.GROUPS, groups);
},

  createEvent: (event: Omit<CommunityEvent, 'id' | 'participants' | 'status'>): CommunityEvent => {
    const currentUser = userService.getCurrentUser();
    if (!currentUser) throw new Error("Must be logged in");

    const events = storageService.get<CommunityEvent[]>(STORAGE_KEYS.EVENTS, []);

    const newEvent: CommunityEvent = {
      ...event,
      id: `evt_${Date.now()}`,
      participants: [currentUser.id],
      createdBy: currentUser.id,
      status:
        currentUser.role === 'admin'
          ? 'approved'
          : currentUser.role === 'owner'
            ? 'approved'
            : 'pending'
    };

    events.push(newEvent);
    storageService.set(STORAGE_KEYS.EVENTS, events);
    return newEvent;
  },

  joinEvent: (eventId: string): void => {
    const currentUser = userService.getCurrentUser();
    if (!currentUser) throw new Error("Must be logged in");

    const events = storageService.get<CommunityEvent[]>(STORAGE_KEYS.EVENTS, []);
    const groups = storageService.get<CommunityGroup[]>(STORAGE_KEYS.GROUPS, []);

    const index = events.findIndex(e => e.id === eventId);
    if (index === -1) return;

    const event = events[index];
    const group = groups.find(g => g.id === event.groupId);
    if (!group) return;

    if (!group.members.includes(currentUser.id)) {
      throw new Error("Join the community before joining this event.");
    }

    if (event.capacity && event.participants.length >= event.capacity) {
      throw new Error("Event is full.");
    }

    if (!event.participants.includes(currentUser.id)) {
      event.participants.push(currentUser.id);
      storageService.set(STORAGE_KEYS.EVENTS, events);
    }
  },

  leaveEvent: (eventId: string): void => {
  const currentUser = userService.getCurrentUser();
  if (!currentUser) throw new Error("Must be logged in");

  const events = storageService.get<CommunityEvent[]>(STORAGE_KEYS.EVENTS, []);
  const index = events.findIndex(e => e.id === eventId);
  if (index === -1) return;

  const event = events[index];

  event.participants = event.participants.filter(
    id => id !== currentUser.id
  );

  storageService.set(STORAGE_KEYS.EVENTS, events);
},
};