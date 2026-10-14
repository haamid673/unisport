
import { storageService, STORAGE_KEYS } from './storageService';
import { userService } from './userService';
import { Facility, Slot, FacilityAmenity } from '../types';

/* ===========================
   SERVICE
=========================== */

export const facilityService = {

  getAllFacilities: (includePending = false): Facility[] => {
    const facilities = storageService.get<Facility[]>(STORAGE_KEYS.FACILITIES, []);
    if (includePending) return facilities;
    return facilities.filter(f => f.status === 'approved');
  },

  getFacilityById: (id: string): Facility | undefined => {
    const facilities = storageService.get<Facility[]>(STORAGE_KEYS.FACILITIES, []);
    return facilities.find(f => f.id === id);
  },

  deleteFacility: (id: string): void => {
    const facilities = storageService.get<Facility[]>(STORAGE_KEYS.FACILITIES, []);
    const newFacilities = facilities.filter(f => f.id !== id);
    storageService.set(STORAGE_KEYS.FACILITIES, newFacilities);
  },

  /* ===========================
     SLOT MANAGEMENT
  =========================== */

  getAllSlots: (): Slot[] => {
    return storageService.get<Slot[]>(STORAGE_KEYS.SLOTS, []);
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
    const facilities = storageService.get<Facility[]>(STORAGE_KEYS.FACILITIES, []);
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
    const facilities = storageService.get<Facility[]>(STORAGE_KEYS.FACILITIES, []);
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
    const facilities = storageService.get<Facility[]>(STORAGE_KEYS.FACILITIES, []);
    const facilityIndex = facilities.findIndex(f => f.id === facilityId);

    if (facilityIndex === -1 || !facilities[facilityIndex].amenityOptions) return;

    facilities[facilityIndex].amenityOptions = facilities[facilityIndex].amenityOptions!.filter(
      a => a.id !== amenityId
    );

    storageService.set(STORAGE_KEYS.FACILITIES, facilities);
  },

};