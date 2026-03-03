import { Booking } from "../types";
import { storageService, STORAGE_KEYS } from "./storageService";
import { facilityService } from "./facilityService";

export function getAllBookings(): Booking[] {
  return storageService.get<Booking[]>(STORAGE_KEYS.BOOKINGS, []);
}

function saveAllBookings(bookings: Booking[]) {
  storageService.set(STORAGE_KEYS.BOOKINGS, bookings);
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
  bookingDate: string
): Booking {

  if (!isSlotAvailable(slotId, bookingDate)) {
    throw new Error("Slot already booked");
  }

  const bookings = getAllBookings();

  const slot = facilityService.getAllSlots().find(s => s.id === slotId);
  if (!slot) throw new Error("Slot not found");

  const newBooking: Booking = {
    id: crypto.randomUUID(),
    slotId,
    userId,
    bookingDate,
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
    return bookings[index]; // Prevent double confirm
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
      price: slot ? slot.price : 0
    };
  });
}

export function createBookingTransactional(
  slotId: string,
  userId: string,
  bookingDate: string
) {
  const booking = initiateBooking(slotId, userId, bookingDate);

  // For backward compatibility,
  // auto-confirm immediately (old behavior)
  return confirmPayment(booking.id);
}