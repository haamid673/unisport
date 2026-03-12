import { Booking, SelectedAmenity } from "../types";
import { storageService, STORAGE_KEYS } from "./storageService";
import { facilityService } from "./facilityService";

export function getAllBookings(): Booking[] {
  return storageService.get<Booking[]>(STORAGE_KEYS.BOOKINGS, []);
}

function saveAllBookings(bookings: Booking[]) {
  storageService.set(STORAGE_KEYS.BOOKINGS, bookings);
}

function normalizeDate(date: Date) {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

export function isBookingDateValid(bookingDate: string): boolean {
  const selected = normalizeDate(new Date(bookingDate));
  const today = normalizeDate(new Date());

  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + 30);

  return selected >= today && selected <= maxDate;
}

export function isSlotAvailable(slotId: string, date: string): boolean {
  const bookings = getAllBookings();

  const conflict = bookings.find(
    b =>
      b.slotId === slotId &&
      b.bookingDate === date &&
      b.status !== "cancelled"
  );

  return !conflict;
}

export const checkSlotAvailability = isSlotAvailable;

export function initiateBooking(
  slotId: string,
  userId: string,
  bookingDate: string,
  selectedAmenities: SelectedAmenity[] = [],
  finalPrice?: number
): Booking {
  if (!isBookingDateValid(bookingDate)) {
    throw new Error("Bookings are only allowed from today up to 30 days in advance.");
  }

  if (!isSlotAvailable(slotId, bookingDate)) {
    throw new Error("Slot already booked");
  }

  const bookings = getAllBookings();

  const slot = facilityService.getAllSlots().find(s => s.id === slotId);
  if (!slot) throw new Error("Slot not found");

  const amenitiesTotal = selectedAmenities.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );

  const newBooking: Booking = {
    id: crypto.randomUUID(),
    slotId,
    userId,
    bookingDate,
    selectedAmenities,
    finalPrice: finalPrice ?? slot.price + amenitiesTotal,
    priceBreakdown: {
      basePrice: slot.price,
      amenitiesTotal,
      demandMultiplier: 1,
      peakHourMultiplier: 1,
      weekendMultiplier: 1
    },
    status: "pending",
    createdAt: new Date().toISOString()
  };

  bookings.push(newBooking);
  saveAllBookings(bookings);

  return newBooking;
}

export function confirmPayment(bookingId: string): Booking {
  const bookings = getAllBookings();
  const index = bookings.findIndex(b => b.id === bookingId);

  if (index === -1) throw new Error("Booking not found");

  if (bookings[index].status === "confirmed") {
    return bookings[index];
  }

  bookings[index].status = "confirmed";
  saveAllBookings(bookings);

  return bookings[index];
}

export function cancelBooking(bookingId: string): Booking {
  const bookings = getAllBookings();
  const index = bookings.findIndex(b => b.id === bookingId);

  if (index === -1) throw new Error("Booking not found");

  bookings[index].status = "cancelled";
  saveAllBookings(bookings);

  return bookings[index];
}

export function getBookingsByUser(userId: string): Booking[] {
  return getAllBookings().filter(b => b.userId === userId);
}

export function getEnrichedUserBookings(userId: string): any[] {
  const bookings = getBookingsByUser(userId);
  const facilities = facilityService.getAllFacilities(true);
  const slots = facilityService.getAllSlots();

  return bookings.map(booking => {
    const slot = slots.find(s => s.id === booking.slotId);
    const facility = slot
      ? facilities.find(f => f.id === slot.facilityId)
      : null;

    return {
      ...booking,
      facilityName: facility ? facility.name : "Unknown Facility",
      sport: facility ? facility.sport : "Unknown Sport",
      slotTime: slot ? slot.time : "Unknown Time",
      price: booking.finalPrice ?? slot?.price ?? 0,
      location: facility ? facility.location : ""
    };
  });
}

export function createBookingTransactional(
  slotId: string,
  userId: string,
  bookingDate: string,
  selectedAmenities: SelectedAmenity[] = [],
  finalPrice?: number
) {
  const booking = initiateBooking(
    slotId,
    userId,
    bookingDate,
    selectedAmenities,
    finalPrice
  );

  return confirmPayment(booking.id);
}