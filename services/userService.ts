// const initialUsers: User[] = [
//   { 
//     id: 'admin', 
//     email: 'admin@unisport.com', 
//     passwordHash: hashPassword('admin123'),
//     role: 'admin', 
//     name: 'System Admin', 
//     bio: 'Platform Administrator',
//     createdAt: new Date().toISOString(), 
//     city: 'Chennai'
//   },
//   { 
//     id: 'haamid', 
//     email: 'haamid673@gmail.com', 
//     passwordHash: hashPassword('123456'),
//     role: 'user', 
//     name: 'Haamid', 
//     bio: 'Suiii',
//     createdAt: new Date().toISOString(),
//     city: 'Chennai'
//   },
//   { 
//     id: 'owner1', 
//     email: 'owner@padel.com', 
//     passwordHash: hashPassword('owner123'),
//     role: 'owner', 
//     name: 'Padel Owner', 
//     bio: 'Owner of Elite Padel Club',
//     createdAt: new Date().toISOString(),
//     city: 'Chennai'
//   },
//   { 
//     id: 'owner2', 
//     email: 'owner@sports.com', 
//     passwordHash: hashPassword('owner123'),
//     role: 'owner', 
//     name: 'Sports Complex Owner', 
//     bio: 'Managing multiple sports venues in Chennai',
//     createdAt: new Date().toISOString(),
//     city: 'Chennai'
//   },
//   { 
//     id: 'owner3', 
//     email: 'owner@gym.com', 
//     passwordHash: hashPassword('owner123'),
//     role: 'owner', 
//     name: 'Fitness Center Owner', 
//     bio: 'Dedicated to fitness and wellness',
//     createdAt: new Date().toISOString(),
//     city: 'Bangalore'
//   },
//   { 
//     id: 'user1', 
//     email: 'player@demo.com', 
//     passwordHash: hashPassword('player123'),
//     role: 'user', 
//     name: 'Demo Player', 
//     bio: 'Avid sports enthusiast', 
//     preferences: ['Padel', 'Tennis'], 
//     createdAt: new Date().toISOString(),
//     city: 'Chennai'
//   },
//   { 
//     id: 'user2', 
//     email: 'sarah@demo.com', 
//     passwordHash: hashPassword('user123'),
//     role: 'user', 
//     name: 'Sarah Jenkins', 
//     bio: 'Love swimming and yoga', 
//     preferences: ['Swimming', 'Yoga'], 
//     createdAt: new Date().toISOString(),
//     city: 'Delhi'
//   },
//   { 
//     id: 'user3', 
//     email: 'mike@demo.com', 
//     passwordHash: hashPassword('user123'),
//     role: 'user', 
//     name: 'Mike Ross', 
//     bio: 'Football fanatic', 
//     preferences: ['Football', 'Futsal'], 
//     createdAt: new Date().toISOString(),
//     city: 'Mumbai'
//   },
//   { 
//     id: 'user4', 
//     email: 'priya@demo.com', 
//     passwordHash: hashPassword('user123'),
//     role: 'user', 
//     name: 'Priya Sharma', 
//     bio: 'Badminton state player', 
//     preferences: ['Badminton'], 
//     createdAt: new Date().toISOString(),
//     city: 'Chennai'
//   },
//   { 
//     id: 'user5', 
//     email: 'rahul@demo.com', 
//     passwordHash: hashPassword('user123'),
//     role: 'user', 
//     name: 'Rahul Dravid', 
//     bio: 'Cricket is life', 
//     preferences: ['Cricket'], 
//     createdAt: new Date().toISOString(),
//     city: 'Bangalore'
//   },
//   { 
//     id: 'user6', 
//     email: 'emily@demo.com', 
//     passwordHash: hashPassword('user123'),
//     role: 'user', 
//     name: 'Emily Blunt', 
//     bio: 'Tennis pro in making', 
//     preferences: ['Tennis'], 
//     createdAt: new Date().toISOString(),
//     city: 'Delhi'
//   },
//   { 
//     id: 'user7', 
//     email: 'david@demo.com', 
//     passwordHash: hashPassword('user123'),
//     role: 'user', 
//     name: 'David Beckham', 
//     bio: 'Just here for the kick', 
//     preferences: ['Football'], 
//     createdAt: new Date().toISOString(),
//     city: 'Mumbai'
//   }
// ];
import { User, UserRole, AuditLog } from '../types';
import { storageService, STORAGE_KEYS } from './storageService';
import { authService } from './authService';

// Mock hash function for demo purposes
const hashPassword = (password: string): string => {
  return btoa(password + "_unisport_salt");
};


const initialUsers: User[] = [
  { 
    id: 'admin', 
    email: 'admin@unisport.com', 
    passwordHash: hashPassword('admin123'),
    role: 'admin', 
    name: 'System Admin', 
    bio: 'Platform Administrator',
    createdAt: new Date().toISOString(), 
    city: 'Chennai'
  },
  { 
    id: 'haamid', 
    email: 'haamid673@gmail.com', 
    passwordHash: hashPassword('123456'),
    role: 'user', 
    name: 'Haamid', 
    bio: 'Suiii',
    createdAt: new Date().toISOString(),
    city: 'Trivandrum'
  },
  { 
    id: 'owner1', 
    email: 'owner@padel.com', 
    passwordHash: hashPassword('owner123'),
    role: 'owner', 
    name: 'Padel Owner', 
    bio: 'Owner of Elite Padel Club',
    createdAt: new Date().toISOString(),
    city: 'Chennai'
  },
  { 
    id: 'owner2', 
    email: 'owner@sports.com', 
    passwordHash: hashPassword('owner123'),
    role: 'owner', 
    name: 'Sports Complex Owner', 
    bio: 'Managing multiple sports venues in Chennai',
    createdAt: new Date().toISOString(),
    city: 'Chennai'
  },
  { 
    id: 'owner3', 
    email: 'owner@gym.com', 
    passwordHash: hashPassword('owner123'),
    role: 'owner', 
    name: 'Fitness Center Owner', 
    bio: 'Dedicated to fitness and wellness',
    createdAt: new Date().toISOString(),
    city: 'Bangalore'
  },
  { 
    id: 'user1', 
    email: 'player@demo.com', 
    passwordHash: hashPassword('player123'),
    role: 'user', 
    name: 'Demo Player', 
    bio: 'Avid sports enthusiast', 
    preferences: ['Padel', 'Tennis'], 
    createdAt: new Date().toISOString(),
    city: 'Trivandrum'
  },
  { 
    id: 'user2', 
    email: 'sarah@demo.com', 
    passwordHash: hashPassword('user123'),
    role: 'user', 
    name: 'Sarah Jenkins', 
    bio: 'Love swimming and yoga', 
    preferences: ['Swimming', 'Yoga'], 
    createdAt: new Date().toISOString(),
    city: 'Delhi'
  },
  { 
    id: 'user3', 
    email: 'mike@demo.com', 
    passwordHash: hashPassword('user123'),
    role: 'user', 
    name: 'Mike Ross', 
    bio: 'Football fanatic', 
    preferences: ['Football', 'Futsal'], 
    createdAt: new Date().toISOString(),
    city: 'Mumbai'
  },
  { 
    id: 'user4', 
    email: 'priya@demo.com', 
    passwordHash: hashPassword('user123'),
    role: 'user', 
    name: 'Priya Sharma', 
    bio: 'Badminton state player', 
    preferences: ['Badminton'], 
    createdAt: new Date().toISOString(),
    city: 'Chennai'
  },
  { 
    id: 'user5', 
    email: 'rahul@demo.com', 
    passwordHash: hashPassword('user123'),
    role: 'user', 
    name: 'Rahul Dravid', 
    bio: 'Cricket is life', 
    preferences: ['Cricket'], 
    createdAt: new Date().toISOString(),
    city: 'Bangalore'
  },
  { 
    id: 'user6', 
    email: 'emily@demo.com', 
    passwordHash: hashPassword('user123'),
    role: 'user', 
    name: 'Emily Blunt', 
    bio: 'Tennis pro in making', 
    preferences: ['Tennis'], 
    createdAt: new Date().toISOString(),
    city: 'Delhi'
  },
  { 
    id: 'user7', 
    email: 'david@demo.com', 
    passwordHash: hashPassword('user123'),
    role: 'user', 
    name: 'David Beckham', 
    bio: 'Just here for the kick', 
    preferences: ['Football'], 
    createdAt: new Date().toISOString(),
    city: 'Mumbai'
  }
];

// -- Authenticated identity --------------------------------------------
//
// The signed-in user comes from the Supabase session and the database
// profile (see authService / App.tsx). It is held in memory only: it is
// NOT read from or written to localStorage, so editing localStorage
// cannot change who the app thinks you are.
//
// The mock-backed services (events, facilities, ...) still ask
// userService.getCurrentUser() for the identity, which is why it is
// kept here.
let authenticatedUser: User | null = null;

// UI-only profile fields the database has no columns for yet. Stored
// locally per user id; never used for any authorization decision.
const PROFILE_EXTRAS_KEY = 'unisport_profile_extras_v1';

interface ProfileExtras {
  bio?: string;
  preferences?: string[];
}

const readExtras = (userId: string): ProfileExtras => {
  const all = storageService.get<Record<string, ProfileExtras>>(PROFILE_EXTRAS_KEY, {});
  return all[userId] ?? {};
};

const writeExtras = (userId: string, extras: ProfileExtras) => {
  const all = storageService.get<Record<string, ProfileExtras>>(PROFILE_EXTRAS_KEY, {});
  all[userId] = { ...all[userId], ...extras };
  storageService.set(PROFILE_EXTRAS_KEY, all);
};

export const userService = {
  getCurrentUser: (): User | null => authenticatedUser,

  /**
   * Called by App.tsx when the Supabase session changes. Returns the
   * user with the local UI-only extras merged in.
   */
  setCurrentUser: (user: User | null): User | null => {
    authenticatedUser = user ? { ...user, ...readExtras(user.id) } : null;
    return authenticatedUser;
  },

  /**
   * Update the signed-in user's profile. name and phone are persisted
   * to public.profiles (RLS: own row only); bio and preferences have no
   * database columns yet and are kept locally.
   */
  updateProfile: async (updates: Partial<User>): Promise<User> => {
    const currentUser = authenticatedUser;
    if (!currentUser) throw new Error("Not logged in");

    const saved = await authService.updateOwnProfile({
      name: updates.name,
      phone: updates.phone
    });

    const extras: ProfileExtras = {};
    if (updates.bio !== undefined) extras.bio = updates.bio;
    if (updates.preferences !== undefined) extras.preferences = updates.preferences;
    writeExtras(currentUser.id, extras);

    // Keep the database as the source of the role and email.
    authenticatedUser = { ...currentUser, ...saved, ...readExtras(currentUser.id) };

    auditService.log('Profile Updated', currentUser.id, 'User', currentUser.id);
    return authenticatedUser;
  },

  getAllUsers: (): User[] => {
    return storageService.get<User[]>(STORAGE_KEYS.USERS, initialUsers);
  }
};

// Circular dependency workaround for simple audit logging
const auditService = {
  log: (action: string, entityId: string, entityType: any, performedBy: string) => {
    const logs = storageService.get<AuditLog[]>(STORAGE_KEYS.AUDIT_LOGS, []);
    logs.unshift({
      id: `log_${Date.now()}`,
      action,
      entityId,
      entityType,
      performedBy,
      timestamp: new Date().toISOString()
    });
    storageService.set(STORAGE_KEYS.AUDIT_LOGS, logs);
  }
};
