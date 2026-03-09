
// import React, { useState, useEffect } from 'react';
// import { User } from './types';
// import { userService } from './services/userService';
// import Navbar from './components/Navbar';
// import Auth from './components/Auth';
// import UserDashboard from './components/UserDashboard';
// import OwnerDashboard from './components/OwnerDashboard';
// import AdminDashboard from './components/AdminDashboard';
// import Community from './components/Community';
// import UserProfile from './components/UserProfile';
// import { seedDemoData } from "./services/demoSeeder";

// seedDemoData();

// const App: React.FC = () => {
//   const [user, setUser] = useState<User | null>(null);
//   const [activeTab, setActiveTab] = useState('dashboard');
//   const [isReady, setIsReady] = useState(false);

//   useEffect(() => {
//     const savedUser = userService.getCurrentUser();
//     if (savedUser) setUser(savedUser);
//     setIsReady(true);
//   }, []);

//   const handleLogin = (u: User) => {
//     setUser(u);
//     setActiveTab('dashboard');
//   };

//   const handleLogout = () => {
//     userService.logout();
//     setUser(null);
//   };

//   const handleProfileUpdate = (updatedUser: User) => {
//     setUser(updatedUser);
//   };

//   if (!isReady) return <div className="min-h-screen flex items-center justify-center bg-neutral-50"><div className="animate-spin rounded-full h-12 w-12 border-t-4 border-b-4 border-neutral-900"></div></div>;

//   if (!user) {
//     return <Auth onLogin={handleLogin} />;
//   }

//   const renderDashboard = () => {
//     switch (user.role) {
//       case 'admin':
//         return <AdminDashboard />;
//       case 'owner':
//         return <OwnerDashboard user={user} />;
//       default:
//         return <UserDashboard user={user} />;
//     }
//   };

//   return (
//     <div className="min-h-screen bg-white flex flex-col font-sans text-neutral-900">
//       <Navbar 
//         user={user} 
//         onLogout={handleLogout} 
//         activeTab={activeTab} 
//         setActiveTab={setActiveTab} 
//       />
      
//       <main className="flex-1">
//         {activeTab === 'dashboard' && renderDashboard()}
//         {activeTab === 'community' && <Community user={user} />}
//         {activeTab === 'profile' && <UserProfile user={user} onUpdate={handleProfileUpdate} />}
//       </main>

//       <footer className="bg-neutral-900 text-white border-t border-neutral-800 py-12 mt-12">
//         <div className="max-w-7xl mx-auto px-4 flex flex-col md:flex-row justify-between items-center gap-8">
//           <div className="flex items-center space-x-3">
//             <div className="w-8 h-8 bg-white rounded-none flex items-center justify-center text-neutral-900 transform -skew-x-12">
//               <i className="fas fa-running text-sm"></i>
//             </div>
//             <span className="text-xl font-black uppercase tracking-tighter italic">UniSport</span>
//           </div>
//           <div className="flex space-x-8 text-xs font-bold uppercase tracking-widest text-neutral-500">
//             <a href="#" className="hover:text-white transition-colors">Privacy</a>
//             <a href="#" className="hover:text-white transition-colors">Terms</a>
//             <a href="#" className="hover:text-white transition-colors">Status</a>
//           </div>
//           <p className="text-xs text-neutral-600 font-bold uppercase tracking-widest">© 2024 UniSport Ent.</p>
//         </div>
//       </footer>
//     </div>
//   );
// };

// export default App;


import React, { useState, useEffect } from 'react';
import { User, CommunityGroup } from './types';
import { userService } from './services/userService';
import Navbar from './components/Navbar';
import Auth from './components/Auth';
import UserDashboard from './components/UserDashboard';
import OwnerDashboard from './components/OwnerDashboard';
import AdminDashboard from './components/AdminDashboard';
import Community from './components/Community';
import CommunityDetail from './components/CommunityDetail';
import UserProfile from './components/UserProfile';
import { seedDemoData } from "./services/demoSeeder";
import PaymentPage from './components/PaymentPage';

seedDemoData();

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [selectedCommunity, setSelectedCommunity] = useState<CommunityGroup | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [paymentData, setPaymentData] = useState<any | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const savedUser = userService.getCurrentUser();
    if (savedUser) setUser(savedUser);
    setIsReady(true);
  }, []);

  useEffect(() => {
  if (!toast) return;
  const timer = setTimeout(() => setToast(null), 3000);
  return () => clearTimeout(timer);
}, [toast]);

  const handleLogin = (u: User) => {
    setUser(u);
    setActiveTab('dashboard');
  };

  const handleLogout = () => {
    userService.logout();
    setUser(null);
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

  if (!user) return <Auth onLogin={handleLogin} />;

  const renderDashboard = () => {
  switch (user.role) {
    case 'admin':
      return <AdminDashboard />;
    case 'owner':
      return <OwnerDashboard user={user} />;
    default:
      return (
        <UserDashboard
          user={user}
          onStartPayment={(data) => {
            setPaymentData(data);
            setActiveTab('payment');
          }}
        />
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
            © 2024 UniSport Ent.
          </p>
        </div>
      </footer>
    </div>
  );
};

export default App;