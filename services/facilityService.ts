
import { Facility, Slot, AuditLog, FacilityStatus } from '../types';
import { storageService, STORAGE_KEYS } from './storageService';
import { userService } from './userService';
import { getSportImage } from './sportImages';
import { Facility, Slot, AuditLog, FacilityStatus, FacilityAmenity } from '../types';






const initialFacilities: Facility[] = [
  // Chennai
  { 
    id: 'f1', 
    name: 'Chennai Smashers Arena', 
    sport: 'Badminton', 
    location: 'Anna Nagar, Chennai', 
    basePrice: 800, 
    ownerId: 'owner1', 
    imageUrl: getSportImage('badminton'), 
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
  },
    // Trivandrum
  { 
    id: 't1', 
    name: 'Kowdiar Badminton Hub', 
    sport: 'Badminton', 
    location: 'Kowdiar, Trivandrum', 
    basePrice: 900, 
    ownerId: 'owner1', 
    imageUrl: getSportImage('badminton'), 
    rating: 4.7, 
    status: 'approved', 
    latitude: 8.5222,
    longitude: 76.9605, 
    amenityOptions: [
    { id: 'am5', name: 'Protein Shake', type: 'fnb', price: 150, unit: 'item', available: true },
    { id: 'am6', name: 'Steam Room', type: 'wellness', price: 250, unit: 'session', available: true },
    { id: 'am7', name: 'Recovery Chair', type: 'recovery', price: 180, unit: '15 min', available: true }
  ]
  },

  { 
    id: 't2', 
    name: 'Technopark Turf Arena', 
    sport: 'Football', 
    location: 'Kazhakkoottam, Trivandrum', 
    basePrice: 1600, 
    ownerId: 'owner2', 
    imageUrl: getSportImage('football'), 
    rating: 4.8, 
    status: 'approved', 
    latitude: 8.5686,
    longitude: 76.8731
  },
  { 
    id: 't3', 
    name: 'Vellayambalam Fitness Club', 
    sport: 'Gym', 
    location: 'Vellayambalam, Trivandrum', 
    basePrice: 500, 
    ownerId: 'owner3', 
    imageUrl: getSportImage('gym'), 
    rating: 4.6, 
    status: 'approved',
    latitude: 8.5086 ,
    longitude: 76.9657
  },
  { 
    id: 't4', 
    name: 'Sanghumugham Aqua Center', 
    sport: 'Swimming', 
    location: 'Sanghumugham, Trivandrum', 
    basePrice: 700, 
    ownerId: 'owner2', 
    imageUrl: getSportImage('swimming'), 
    rating: 4.5, 
    status: 'approved',
    latitude: 8.4833,
    longitude: 76.9117
  },
  { 
    id: 't5', 
    name: 'Poojappura Cricket Nets', 
    sport: 'Cricket', 
    location: 'Poojappura, Trivandrum', 
    basePrice: 1300, 
    ownerId: 'owner2', 
    imageUrl: getSportImage('cricket'), 
    rating: 4.7, 
    status: 'approved' ,
    latitude: 8.4880,
    longitude: 76.9809
  },
  { 
    id: 't6', 
    name: 'LMS Tennis Court', 
    sport: 'Tennis', 
    location: 'Palayam, Trivandrum', 
    basePrice: 1400, 
    ownerId: 'owner1', 
    imageUrl: getSportImage('tennis'), 
    rating: 4.6, 
    status: 'approved' ,
    latitude: 8.5039,
    longitude: 76.9511
  }
];

const initialSlots: Slot[] = [
  { id: 's1', facilityId: 'f1', time: '06:00 AM - 07:00 AM', price: 800 },
  { id: 's2', facilityId: 'f1', time: '07:00 AM - 08:00 AM', price: 800 },
  { id: 's3', facilityId: 'f2', time: '06:00 PM - 07:00 PM', price: 1500 },
  { id: 's4', facilityId: 'f2', time: '07:00 PM - 08:00 PM', price: 1800 },
  { id: 's5', facilityId: 'f2', time: '07:00 PM - 08:00 PM', price: 1800 },  // Peak hour
  { id: 's6', facilityId: 'f3', time: '05:00 PM - 06:00 PM', price: 1000 },
  { id: 's7', facilityId: 'f3', time: '06:00 PM - 07:00 PM', price: 1000 },
  { id: 's8', facilityId: 'f4', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's9', facilityId: 'f4', time: '08:00 AM - 09:00 AM', price: 1200 },
  { id: 's10', facilityId: 'f5', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's11', facilityId: 'f5', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's12', facilityId: 'f6', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's13', facilityId: 'f6', time: '06:00 PM - 07:00 PM', price: 1200 },
  { id: 's14', facilityId: 'f7', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's15', facilityId: 'f8', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's16', facilityId: 'f9', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's17', facilityId: 'f9', time: '06:00 PM - 07:00 PM', price: 1200 },
  { id: 's18', facilityId: 'm1', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's19', facilityId: 'm2', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's20', facilityId: 'm3', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's21', facilityId: 'd1', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's22', facilityId: 'd2', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's23', facilityId: 'b1', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's24', facilityId: 'b2', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's25', facilityId: 'b3', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's26', facilityId: 'h1', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's27', facilityId: 'h2', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's28', facilityId: 'k1', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's29', facilityId: 'k2', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's30', facilityId: 'j1', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's31', facilityId: 'j2', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's32', facilityId: 'j2', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's33', facilityId: 'f6', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's34', facilityId: 'f7', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's35', facilityId: 'f8', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's36', facilityId: 'f9', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's37', facilityId: 'm1', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's38', facilityId: 'm2', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's39', facilityId: 'm3', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's40', facilityId: 'd1', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's41', facilityId: 'd2', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's42', facilityId: 'b1', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's43', facilityId: 'b2', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's44', facilityId: 'b3', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's45', facilityId: 'h1', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's46', facilityId: 'h2', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's47', facilityId: 'k1', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's48', facilityId: 'k2', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's49', facilityId: 'j1', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's50', facilityId: 'j2', time: '06:00 AM - 07:00 AM', price: 1200 },
  { id: 's51', facilityId: 'j2', time: '07:00 AM - 08:00 AM', price: 1200 },
  { id: 's52', facilityId: 't1', time: '06:00 AM - 07:00 AM', price: 900 },
  { id: 's53', facilityId: 't1', time: '07:00 AM - 08:00 AM', price: 900 },
  { id: 's54', facilityId: 't2', time: '06:00 PM - 07:00 PM', price: 1600 },
  { id: 's55', facilityId: 't2', time: '07:00 PM - 08:00 PM', price: 1800 },
  { id: 's56', facilityId: 't3', time: '06:00 AM - 07:00 AM', price: 500 },
  { id: 's57', facilityId: 't3', time: '07:00 AM - 08:00 AM', price: 500 },
  { id: 's58', facilityId: 't4', time: '06:00 AM - 07:00 AM', price: 700 },
  { id: 's59', facilityId: 't4', time: '07:00 AM - 08:00 AM', price: 700 },
  { id: 's60', facilityId: 't5', time: '06:00 AM - 07:00 AM', price: 1300 },
  { id: 's61', facilityId: 't5', time: '08:00 AM - 09:00 AM', price: 1300 },
  { id: 's62', facilityId: 't6', time: '06:00 AM - 07:00 AM', price: 1400 },
  { id: 's63', facilityId: 't6', time: '07:00 AM - 08:00 AM', price: 1400 }
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
  },

    addAmenityToFacility: (
    facilityId: string,
    amenity: Omit<FacilityAmenity, 'id'>
  ): void => {
    const facilities = storageService.get<Facility[]>(STORAGE_KEYS.FACILITIES, initialFacilities);
    const index = facilities.findIndex(f => f.id === facilityId);

    if (index === -1) return;

    const newAmenity: FacilityAmenity = {
      ...amenity,
      id: `amenity_${Date.now()}`,
      available: amenity.available ?? true
    };

    if (!facilities[index].amenityOptions) {
      facilities[index].amenityOptions = [];
    }

    facilities[index].amenityOptions!.push(newAmenity);
    storageService.set(STORAGE_KEYS.FACILITIES, facilities);
  },

  updateAmenityInFacility: (
    facilityId: string,
    amenityId: string,
    updates: Partial<FacilityAmenity>
  ): void => {
    const facilities = storageService.get<Facility[]>(STORAGE_KEYS.FACILITIES, initialFacilities);
    const facilityIndex = facilities.findIndex(f => f.id === facilityId);

    if (facilityIndex === -1 || !facilities[facilityIndex].amenityOptions) return;

    facilities[facilityIndex].amenityOptions = facilities[facilityIndex].amenityOptions!.map(a =>
      a.id === amenityId ? { ...a, ...updates } : a
    );

    storageService.set(STORAGE_KEYS.FACILITIES, facilities);
  },

  deleteAmenityFromFacility: (
    facilityId: string,
    amenityId: string
  ): void => {
    const facilities = storageService.get<Facility[]>(STORAGE_KEYS.FACILITIES, initialFacilities);
    const facilityIndex = facilities.findIndex(f => f.id === facilityId);

    if (facilityIndex === -1 || !facilities[facilityIndex].amenityOptions) return;

    facilities[facilityIndex].amenityOptions = facilities[facilityIndex].amenityOptions!.filter(
      a => a.id !== amenityId
    );

    storageService.set(STORAGE_KEYS.FACILITIES, facilities);
  },

};