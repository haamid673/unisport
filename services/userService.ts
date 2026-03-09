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

export const userService = {
  getCurrentUser: (): User | null => {
    return storageService.get<User | null>(STORAGE_KEYS.CURRENT_USER, null);
  },

  register: (email: string, password: string, name: string, phone: string): User => {
    const users = storageService.get<User[]>(STORAGE_KEYS.USERS, initialUsers);
    
    if (users.find(u => u.email === email)) {
      throw new Error("User already exists");
    }

    const newUser: User = {
      id: `user_${Date.now()}`,
      email,
      passwordHash: hashPassword(password),
      role: 'user', // Default role
      name,
      phone,
      city: 'Trivandrum',
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    storageService.set(STORAGE_KEYS.USERS, users);
    
    // Auto login after register
    storageService.set(STORAGE_KEYS.CURRENT_USER, newUser);
    auditService.log('User Registration', newUser.id, 'User', newUser.id);
    
    return newUser;
  },

  login: (email: string, password: string): User => {
    const users = storageService.get<User[]>(STORAGE_KEYS.USERS, initialUsers);
    const user = users.find(u => u.email === email);
    
    if (!user || (user.passwordHash && user.passwordHash !== hashPassword(password))) {
      // Allow legacy users without passwordHash to login with any password for now, or force reset
      // But for this demo, let's assume all users have passwordHash or we migrate them
      if (user.passwordHash && user.passwordHash !== hashPassword(password)) {
        throw new Error("Invalid credentials");
      }
      // If no passwordHash (legacy), we might want to set it on first login, but let's keep it simple
    }
    
    if (!user) throw new Error("User not found");

    storageService.set(STORAGE_KEYS.CURRENT_USER, user);
    auditService.log('User Login', user.id, 'User', user.id);
    return user;
  },

  logout: () => {
    const user = userService.getCurrentUser();
    if (user) auditService.log('User Logout', user.id, 'User', user.id);
    storageService.remove(STORAGE_KEYS.CURRENT_USER);
  },

  updateProfile: (updates: Partial<User>): User => {
    const currentUser = userService.getCurrentUser();
    if (!currentUser) throw new Error("Not logged in");

    const users = storageService.get<User[]>(STORAGE_KEYS.USERS, initialUsers);
    const updatedUser = { ...currentUser, ...updates };
    
    const newUsers = users.map(u => u.id === currentUser.id ? updatedUser : u);
    storageService.set(STORAGE_KEYS.USERS, newUsers);
    storageService.set(STORAGE_KEYS.CURRENT_USER, updatedUser);
    
    auditService.log('Profile Updated', currentUser.id, 'User', currentUser.id);
    return updatedUser;
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
