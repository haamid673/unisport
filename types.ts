
export type UserRole = 'user' | 'owner' | 'admin';

export interface User {
  id: string;
  email: string;
  role: UserRole;
  name?: string;
  phone?: string;
  bio?: string;
  preferences?: string[];
  avatarUrl?: string;
  createdAt?: string;
  city: string;
}

export type FacilityStatus = 'pending' | 'approved' | 'rejected';

export interface Facility {
  id: string;
  name: string;
  sport: string;
  location: string; // District/Area
  address?: string; // Full address
  contactNumber?: string;
  amenities?: string[]; // gym, pool, etc.
  amenityOptions?: FacilityAmenity[];
  basePrice: number;
  ownerId: string;
  imageUrl?: string;
  rating?: number;
  status: FacilityStatus;
  city:string;
  latitude?: number;
  longitude?: number;
}

/**
 * Result of the database's get_slot_availability() for one slot on one
 * date. A snapshot, not a reservation.
 */
export type SlotAvailabilityStatus =
  | 'available'
  | 'booked'
  | 'offer_held'
  | 'inactive'
  | 'closed';

export interface Slot {
  id: string;
  facilityId: string;
  time: string;
  price: number;
  /** Database is_active flag. Absent on legacy mock slots (treated as active). */
  isActive?: boolean;

  surgeEnabled?: boolean;
  surgeMultiplier?: number;
}

export type BookingStatus = 'confirmed' | 'pending'| 'cancelled' | 'completed' | 'expired' ;

export interface Booking {
  id: string;
  slotId: string;
  userId: string;
  bookingDate: string; // ISO String YYYY-MM-DD
  finalPrice?: number;
  selectedAmenities?: SelectedAmenity[];
  priceBreakdown?: {
    basePrice: number;
    amenitiesTotal?: number;
    demandMultiplier: number;
    peakHourMultiplier: number;
    weekendMultiplier: number;
  };
  status: BookingStatus;
  createdAt: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface CommunityGroup {
  id: string;
  name: string;
  sport: string;
  city: string;
  createdBy: string;
  status: ApprovalStatus;
  members: string[];
  imageUrl?: string;
}


export interface CommunityEvent {
  id: string;
  groupId?: string; // Optional for now to support legacy events
  title: string;
  date: string;
  time: string;
  facilityId: string;
  createdBy: string;
  participants: string[];
  status: ApprovalStatus;
  imageUrl?: string;
  city?: string;
  capacity?: number;
}

export interface DemandPrediction {
  demandLevel: 'Low' | 'Medium' | 'High';
  predictedOccupancy: number;
  suggestedPriceMultiplier: number;
  reasoning: string;
}

// --- New AI & Analytics Types ---

export interface AIRecommendation {
  facilityId: string;
  score: number; // 0-100 (Internal score, not displayed as match %)
  reasoning: string;
  confidence: 'Low' | 'Medium' | 'High';
  basis: string[]; // e.g. ["Past Bookings", "Sport Preference"]
}

export interface RevenueInsight {
  slotId: string;
  performance: 'Underperforming' | 'Average' | 'High Performing';
  suggestedAction: string;
  projectedRevenueImpact: number; // Percentage
}

export interface FraudRisk {
  bookingId: string;
  riskLevel: 'Low' | 'Medium' | 'High';
  reason: string;
  confidence: number;
}

export interface AuditLog {
  id: string;
  action: string;
  entityId: string;
  entityType: 'Booking' | 'Facility' | 'User' | 'Event' | 'Group';
  performedBy: string;
  timestamp: string;
  details?: string;
}

export interface SlotDemandPrediction {
  slotId: string;
  demandLevel: 'Low' | 'Medium' | 'High';
  suggestedPrice: number;
  isSurge: boolean;
  surgePercent: number;
  confidence: number;
  reasoning: string;
}

export interface FacilityAmenity {
  id: string;
  name: string;
  type: 'fnb' | 'recovery' | 'shower' | 'equipment' | 'wellness' | 'other';
  price: number;
  unit?: string; // e.g. "item", "15 min", "session"
  available?: boolean;
}

export interface SelectedAmenity {
  amenityId: string;
  name: string;
  price: number;
  quantity: number;
}

