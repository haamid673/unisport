import { storageService, STORAGE_KEYS } from "./storageService";

export function seedDemoData() {
  if (localStorage.getItem("unisport_initialized_v5")) return;

  // USERS
  const users = [
    {
      id: "admin",
      email: "admin@unisport.com",
      passwordHash: btoa("admin123_unisport_salt"),
      role: "admin",
      name: "System Admin",
      createdAt: new Date().toISOString()
    },
    {
      id: "owner1",
      email: "owner@padel.com",
      passwordHash: btoa("owner123_unisport_salt"),
      role: "owner",
      name: "Facility Owner",
      createdAt: new Date().toISOString()
    },
    {
      id: "user1",
      email: "player@demo.com",
      passwordHash: btoa("player123_unisport_salt"),
      role: "user",
      name: "Demo Player",
      createdAt: new Date().toISOString()
    }
  ];

  storageService.set(STORAGE_KEYS.USERS, users);
  storageService.set(STORAGE_KEYS.BOOKINGS, []);
  storageService.set(STORAGE_KEYS.AUDIT_LOGS, []);

  localStorage.setItem("unisport_initialized_v5", "true");
}

export function resetDemoData() {
  Object.values(STORAGE_KEYS).forEach((key) => {
    localStorage.removeItem(key);
  });
  localStorage.removeItem("unisport_initialized_v5");
  seedDemoData();
  window.location.reload();
}