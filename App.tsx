import React, { useState, useEffect } from 'react';
import { User, CommunityGroup } from './types';
import { userService } from './services/userService';
import { authService } from './services/authService';
import { supabaseConfigError } from './services/supabaseClient';
import { purgeLegacyDemoData } from './services/legacyCleanup';
import Navbar from './components/Navbar';
import Auth from './components/Auth';
import UserDashboard from './components/UserDashboard';
import OwnerDashboard from './components/OwnerDashboard';
import AdminDashboard from './components/AdminDashboard';
import Community from './components/Community';
import CommunityDetail from './components/CommunityDetail';
import UserProfile from './components/UserProfile';
import PaymentPage from './components/PaymentPage';

// Earlier prototype builds stored a simulated login, demo accounts and
// mock records in this browser. None of it is honoured or shown.
purgeLegacyDemoData();

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [selectedCommunity, setSelectedCommunity] = useState<CommunityGroup | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [paymentData, setPaymentData] = useState<any | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // Real session handling. supabase-js reports the restored session
  // (or its absence) first, then every sign-in / sign-out / user
  // change. The identity and role come from Supabase Auth and the
  // database profile, never from localStorage.
  useEffect(() => {
    if (supabaseConfigError) {
      setIsReady(true);
      return;
    }

    return authService.subscribe(
      (authenticated) => {
        const resolved = userService.setCurrentUser(authenticated);

        setUser((previous) => {
          if (!previous && resolved) setActiveTab('dashboard');
          return resolved;
        });

        if (resolved) setAuthError(null);
        setIsReady(true);
      },
      (message) => {
        setAuthError(message);
        setIsReady(true);
      }
    );
  }, []);

  useEffect(() => {
  if (!toast) return;
  const timer = setTimeout(() => setToast(null), 3000);
  return () => clearTimeout(timer);
}, [toast]);

  const handleLogout = async () => {
    try {
      await authService.signOut();
      // The auth listener clears the user.
    } catch {
      setToast('Could not sign out. Please try again.');
    }
  };

  const handleProfileUpdate = (updatedUser: User) => {
    setUser(updatedUser);
  };

  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50">
        <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-b-4 border-neutral-900"></div>
      </div>
    );
  }

  if (supabaseConfigError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50 p-6 font-sans">
        <div className="max-w-lg w-full bg-white rounded-lg border-2 border-red-200 p-8 shadow-xl">
          <h1 className="text-xl font-black uppercase tracking-tighter text-neutral-900 mb-3">
            Configuration required
          </h1>
          <p className="text-sm text-neutral-700 mb-4">{supabaseConfigError}</p>
          <p className="text-xs text-neutral-400 font-bold uppercase tracking-widest">
            Authentication is disabled until Supabase is configured.
          </p>
        </div>
      </div>
    );
  }

  if (!user) return <Auth notice={authError} />;

  const renderDashboard = () => {
  switch (user.role) {
    case 'admin':
      return <AdminDashboard />;
    case 'owner':
      return <OwnerDashboard user={user} />;
    default:
      return (
        <UserDashboard user={user} />
      );
  }
};


  return (
    <div className="min-h-screen bg-white flex flex-col font-sans text-neutral-900">
      <Navbar 
        user={user} 
        onLogout={handleLogout} 
        activeTab={activeTab} 
        setActiveTab={(tab) => {
          setSelectedCommunity(null);
          setActiveTab(tab);
        }}
      />

      <main className="flex-1">
        {activeTab === 'dashboard' && renderDashboard()}
        
        {activeTab === 'community' && !selectedCommunity && (
          <Community 
            user={user} 
            onSelectCommunity={setSelectedCommunity}
          />
        )}

        {activeTab === 'community' && selectedCommunity && (
          <CommunityDetail
            user={user}
            group={selectedCommunity}
            onBack={() => setSelectedCommunity(null)}
          />
        )}

        {activeTab === 'profile' && (
          <UserProfile user={user} onUpdate={handleProfileUpdate} />
        )}

        {activeTab === 'payment' && paymentData && (
        <PaymentPage
          data={paymentData}
          onSuccess={() => {
            setPaymentData(null);
            setActiveTab('dashboard');
          }}
          onCancel={() => {
            setPaymentData(null);
            setActiveTab('dashboard');
          }}
          user={user}
          onSuccessMessage={(msg) => setToast(msg)}
        />
      )}
      {toast && (
  <div className="fixed bottom-6 right-6 bg-black text-white px-6 py-3 rounded-lg shadow-xl z-50 animate-in fade-in slide-in-from-bottom-5">
    {toast}
  </div>
)}
      </main>

      <footer className="bg-neutral-900 text-white border-t border-neutral-800 py-12 mt-12">
        <div className="max-w-7xl mx-auto px-4 flex flex-col md:flex-row justify-between items-center gap-8">
          <span className="text-xl font-black uppercase italic tracking-tighter">
            UniSport
          </span>
          <p className="text-xs text-neutral-600 font-bold uppercase tracking-widest">
            © {new Date().getFullYear()} UniSport
          </p>
        </div>
      </footer>
    </div>
  );
};

export default App;