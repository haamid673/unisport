
import { Facility, Slot, AuditLog, FacilityStatus } from '../types';
import { storageService, STORAGE_KEYS } from './storageService';
import { userService } from './userService';




const getSportImage = (sport: string) => {
  switch (sport.toLowerCase()) {
    case 'badminton': return 'https://images.unsplash.com/photo-1626224583764-8478ab2e1539?q=80&w=800&auto=format&fit=crop';
    case 'football': return 'https://images.unsplash.com/photo-1579952363873-27f3bade9f55?q=80&w=800&auto=format&fit=crop';
    case 'basketball': return 'https://images.unsplash.com/photo-1546519638-68e109498ffc?q=80&w=800&auto=format&fit=crop';
    case 'cricket': return 'https://images.unsplash.com/photo-1531415074968-036ba1b575da?q=80&w=800&auto=format&fit=crop';
    case 'tennis': return 'https://images.unsplash.com/photo-1622279457486-62dcc4a431d6?q=80&w=800&auto=format&fit=crop';
    case 'padel': return 'https://images.unsplash.com/photo-1554068865-24cecd4e34b8?q=80&w=800&auto=format&fit=crop';
    case 'volleyball': return 'https://images.unsplash.com/photo-1612872087720-bb876e2e67d1?q=80&w=800&auto=format&fit=crop';
    case 'swimming': return 'https://images.unsplash.com/photo-1530549387789-4c1017266635?q=80&w=800&auto=format&fit=crop';
    case 'gym': return 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?q=80&w=800&auto=format&fit=crop';
    case 'yoga': return 'https://images.unsplash.com/photo-1599447421405-075115d6e300?q=80&w=800&auto=format&fit=crop';
    case 'table tennis': return 'https://images.unsplash.com/photo-1534158914592-062992bbe900?q=80&w=800&auto=format&fit=crop';
    default: return 'https://images.unsplash.com/photo-1517649763962-0c623066013b?q=80&w=800&auto=format&fit=crop'; // Generic gym/sport
  }
};


const initialFacilities: Facility[] = [
  // Chennai
  { 
    id: 'f1', 
    name: 'Chennai Smashers Arena', 
    sport: 'Badminton', 
    location: 'Anna Nagar, Chennai', 
    basePrice: 800, 
    ownerId: 'owner1', 
    imageUrl: 'https://images.unsplash.com/photo-1626224583764-8478ab2e1539?q=80&w=800&auto=format&fit=crop', 
    rating: 4.8, 
    status: 'approved' 
  },
  { 
    id: 'f2', 
    name: 'Marina Turf FC', 
    sport: 'Football', 
    location: 'Marina Beach, Chennai', 
    basePrice: 1500, 
    ownerId: 'owner1', 
    imageUrl: getSportImage('football'), 
    rating: 4.5, 
    status: 'approved' 
  },
  { 
    id: 'f3', 
    name: 'Besant Nagar Hoops', 
    sport: 'Basketball', 
    location: 'Besant Nagar, Chennai', 
    basePrice: 1000, 
    ownerId: 'owner2', 
    imageUrl: getSportImage('basketball'), 
    rating: 4.6, 
    status: 'approved' 
  },
  { 
    id: 'f4', 
    name: 'Super Kings Cricket Nets', 
    sport: 'Cricket', 
    location: 'T. Nagar, Chennai', 
    basePrice: 1200, 
    ownerId: 'owner2', 
    imageUrl: getSportImage('cricket'), 
    rating: 4.9, 
    status: 'approved' 
  },
  { 
    id: 'f5', 
    name: 'Aqua Marine Pool', 
    sport: 'Swimming', 
    location: 'Mylapore, Chennai', 
    basePrice: 500, 
    ownerId: 'owner2', 
    imageUrl: getSportImage('swimming'), 
    rating: 4.7, 
    status: 'approved' 
  },
  { 
    id: 'f6', 
    name: 'Ace Tennis Academy', 
    sport: 'Tennis', 
    location: 'Nungambakkam, Chennai', 
    basePrice: 1800, 
    ownerId: 'owner1', 
    imageUrl: getSportImage('tennis'), 
    rating: 4.8, 
    status: 'approved' 
  },
  { 
    id: 'f7', 
    name: 'Zen Yoga Studio', 
    sport: 'Yoga', 
    location: 'Adyar, Chennai', 
    basePrice: 600, 
    ownerId: 'owner3', 
    imageUrl: getSportImage('yoga'), 
    rating: 4.9, 
    status: 'approved' 
  },
  { 
    id: 'f8', 
    name: 'Iron Pump Gym', 
    sport: 'Gym', 
    location: 'Alwarpet, Chennai', 
    basePrice: 300, 
    ownerId: 'owner3', 
    imageUrl: getSportImage('gym'), 
    rating: 4.6, 
    status: 'approved' 
  },
  { 
    id: 'f9', 
    name: 'Spin Table Tennis Club', 
    sport: 'Table Tennis', 
    location: 'Kilpauk, Chennai', 
    basePrice: 400, 
    ownerId: 'owner2', 
    imageUrl: getSportImage('table tennis'), 
    rating: 4.5, 
    status: 'approved' 
  },

  // Mumbai
  { 
    id: 'm1', 
    name: 'Mumbai City FC Arena', 
    sport: 'Football', 
    location: 'Andheri West, Mumbai', 
    basePrice: 2000, 
    ownerId: 'owner1', 
    imageUrl: getSportImage('football'), 
    rating: 4.7, 
    status: 'approved' 
  },
  { 
    id: 'm2', 
    name: 'Wankhede Nets', 
    sport: 'Cricket', 
    location: 'Churchgate, Mumbai', 
    basePrice: 2500, 
    ownerId: 'owner2', 
    imageUrl: getSportImage('cricket'), 
    rating: 4.9, 
    status: 'approved' 
  },
  { 
    id: 'm3', 
    name: 'Bandra Gymkhana', 
    sport: 'Badminton', 
    location: 'Bandra, Mumbai', 
    basePrice: 1200, 
    ownerId: 'owner1', 
    imageUrl: getSportImage('badminton'), 
    rating: 4.6, 
    status: 'approved' 
  },

  // Delhi
  { 
    id: 'd1', 
    name: 'Siri Fort Sports Complex', 
    sport: 'Tennis', 
    location: 'Hauz Khas, Delhi', 
    basePrice: 1500, 
    ownerId: 'owner3', 
    imageUrl: getSportImage('tennis'), 
    rating: 4.8, 
    status: 'approved' 
  },
  { 
    id: 'd2', 
    name: 'Delhi Daredevils Ground', 
    sport: 'Cricket', 
    location: 'Feroz Shah Kotla, Delhi', 
    basePrice: 2200, 
    ownerId: 'owner2', 
    imageUrl: getSportImage('cricket'), 
    rating: 4.7, 
    status: 'approved' 
  },

  // Bangalore
  { 
    id: 'b1', 
    name: 'Kanteerava Indoor Stadium', 
    sport: 'Basketball', 
    location: 'Sampangi Rama Nagar, Bangalore', 
    basePrice: 1000, 
    ownerId: 'owner2', 
    imageUrl: getSportImage('basketball'), 
    rating: 4.8, 
    status: 'approved' 
  },
  { 
    id: 'b2', 
    name: 'Padukone-Dravid Centre', 
    sport: 'Badminton', 
    location: 'Yelahanka, Bangalore', 
    basePrice: 1500, 
    ownerId: 'owner1', 
    imageUrl: getSportImage('badminton'), 
    rating: 4.9, 
    status: 'approved' 
  },
  { 
    id: 'b3', 
    name: 'Cubbon Park Yoga', 
    sport: 'Yoga', 
    location: 'Cubbon Park, Bangalore', 
    basePrice: 400, 
    ownerId: 'owner3', 
    imageUrl: getSportImage('yoga'), 
    rating: 4.7, 
    status: 'approved' 
  },

  // Hyderabad
  { 
    id: 'h1', 
    name: 'Gachibowli Stadium', 
    sport: 'Football', 
    location: 'Gachibowli, Hyderabad', 
    basePrice: 1800, 
    ownerId: 'owner1', 
    imageUrl: getSportImage('football'), 
    rating: 4.6, 
    status: 'approved' 
  },
  { 
    id: 'h2', 
    name: 'Pullela Gopichand Academy', 
    sport: 'Badminton', 
    location: 'Gachibowli, Hyderabad', 
    basePrice: 1600, 
    ownerId: 'owner1', 
    imageUrl: getSportImage('badminton'), 
    rating: 4.9, 
    status: 'approved' 
  },

  // Kolkata
  { 
    id: 'k1', 
    name: 'Salt Lake Stadium Practice', 
    sport: 'Football', 
    location: 'Salt Lake, Kolkata', 
    basePrice: 1200, 
    ownerId: 'owner1', 
    imageUrl: getSportImage('football'), 
    rating: 4.7, 
    status: 'approved' 
  },
  { 
    id: 'k2', 
    name: 'Eden Gardens Nets', 
    sport: 'Cricket', 
    location: 'Maidan, Kolkata', 
    basePrice: 2000, 
    ownerId: 'owner2', 
    imageUrl: getSportImage('cricket'), 
    rating: 4.8, 
    status: 'approved' 
  },

  // Jaipur
  { 
    id: 'j1', 
    name: 'Sawai Mansingh Stadium', 
    sport: 'Cricket', 
    location: 'Jaipur Nagar Nigam, Jaipur', 
    basePrice: 1800, 
    ownerId: 'owner2', 
    imageUrl: getSportImage('cricket'), 
    rating: 4.6, 
    status: 'approved' 
  },
  { 
    id: 'j2', 
    name: 'Pink City Polo Club', 
    sport: 'Tennis', 
    location: 'Bhawani Singh Road, Jaipur', 
    basePrice: 2500, 
    ownerId: 'owner3', 
    imageUrl: getSportImage('tennis'), 
    rating: 4.9, 
    status: 'approved' 
  }
];

const initialSlots: Slot[] = [
  { id: 's1', facilityId: 'f1', time: '06:00 AM - 07:00 AM', price: 800 },
  { id: 's2', facilityId: 'f1', time: '07:00 AM - 08:00 AM', price: 800 },
  { id: 's3', facilityId: 'f2', time: '06:00 PM - 07:00 PM', price: 1500 },
  { id: 's4', facilityId: 'f2', time: '07:00 PM - 08:00 PM', price: 1800 }, // Peak hour
  { id: 's5', facilityId: 'f3', time: '05:00 PM - 06:00 PM', price: 1000 },
  { id: 's6', facilityId: 'f4', time: '06:00 AM - 07:00 AM', price: 1200 },
];

/* ===========================
   SERVICE
=========================== */

export const facilityService = {

  getAllFacilities: (includePending = false): Facility[] => {
    const facilities = storageService.get<Facility[]>(STORAGE_KEYS.FACILITIES, initialFacilities);
    if (includePending) return facilities;
    return facilities.filter(f => f.status === 'approved');
  },

  getFacilityById: (id: string): Facility | undefined => {
    const facilities = storageService.get<Facility[]>(STORAGE_KEYS.FACILITIES, initialFacilities);
    return facilities.find(f => f.id === id);
  },

  deleteFacility: (id: string): void => {
    const facilities = storageService.get<Facility[]>(STORAGE_KEYS.FACILITIES, initialFacilities);
    const newFacilities = facilities.filter(f => f.id !== id);
    storageService.set(STORAGE_KEYS.FACILITIES, newFacilities);
  },

  /* ===========================
     SLOT MANAGEMENT
  =========================== */

  getAllSlots: (): Slot[] => {
    return storageService.get<Slot[]>(STORAGE_KEYS.SLOTS, initialSlots);
  },

  getSlotsByFacility: (facilityId: string): Slot[] => {
    return facilityService.getAllSlots().filter(s => s.facilityId === facilityId);
  },

  addSlot: (slot: Omit<Slot, 'id'>): Slot => {
    const slots = facilityService.getAllSlots();

    const newSlot: Slot = {
      ...slot,
      id: `slot_${Date.now()}`,
      surgeEnabled: false,
      surgeMultiplier: 1
    };

    slots.push(newSlot);
    storageService.set(STORAGE_KEYS.SLOTS, slots);

    return newSlot;
  },

  updateSlot: (slotId: string, updates: Partial<Slot>): void => {
    const slots = facilityService.getAllSlots();
    const index = slots.findIndex(s => s.id === slotId);

    if (index === -1) return;

    slots[index] = { ...slots[index], ...updates };

    storageService.set(STORAGE_KEYS.SLOTS, slots);
  }

};