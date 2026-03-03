

import React, { useState } from 'react';
import { User } from '../types';

interface NavbarProps {
  user: User | null;
  onLogout: () => void;
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

const Navbar: React.FC<NavbarProps> = ({ user, onLogout, activeTab, setActiveTab }) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  if (!user) return null;

  const dashboardLabel = user.role === 'admin' ? 'Admin Console' : user.role === 'owner' ? 'Owner Portal' : 'Find Facilities';

  const handleTabClick = (tab: string) => {
    setActiveTab(tab);
    setIsMenuOpen(false);
  };

  return (
    <nav className="bg-white border-b-2 border-neutral-900 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-20 items-center">
          <div className="flex items-center space-x-3 cursor-pointer group" onClick={() => handleTabClick('dashboard')}>
            <div className="w-10 h-10 bg-neutral-900 rounded-none flex items-center justify-center text-white group-hover:bg-orange-600 transition-colors">
              <i className="fas fa-running text-xl transform -skew-x-12"></i>
            </div>
            <span className="text-2xl font-black text-neutral-900 uppercase tracking-tighter italic">
              UniSport
            </span>
          </div>

          {/* Desktop Menu */}
          <div className="hidden md:flex space-x-12">
            <button 
              onClick={() => setActiveTab('dashboard')}
              className={`text-sm font-black uppercase tracking-widest transition-all border-b-2 ${activeTab === 'dashboard' ? 'text-orange-600 border-orange-600' : 'text-neutral-400 border-transparent hover:text-neutral-900'}`}
            >
              {dashboardLabel}
            </button>
            {user.role === 'user' && (
            <button 
              onClick={() => setActiveTab('community')}
              className={`text-sm font-black uppercase tracking-widest transition-all border-b-2 ${activeTab === 'community' ? 'text-orange-600 border-orange-600' : 'text-neutral-400 border-transparent hover:text-neutral-900'}`}
            >
              Community
            </button>
            )}

            {user.role === 'user' && (
            <button 
              onClick={() => setActiveTab('profile')}
              className={`text-sm font-black uppercase tracking-widest transition-all border-b-2 ${activeTab === 'profile' ? 'text-orange-600 border-orange-600' : 'text-neutral-400 border-transparent hover:text-neutral-900'}`}
            >
              Profile
            </button>
            )}
          </div>

          <div className="hidden md:flex items-center space-x-6">
            <div 
              className="text-right hidden sm:block"
            >
              <p className="text-xs font-bold text-neutral-900 uppercase tracking-wide">{user.name || user.email}</p>
              <div className="flex items-center justify-end gap-1">
                 <span className={`w-1.5 h-1.5 rounded-full ${user.role === 'admin' ? 'bg-red-600' : user.role === 'owner' ? 'bg-blue-600' : 'bg-emerald-500'}`}></span>
                 <p className="text-[10px] text-neutral-400 uppercase font-bold tracking-widest">{user.role}</p>
              </div>
            </div>
            <button 
              onClick={onLogout}
              className="px-4 py-2 text-xs font-black uppercase tracking-widest text-white bg-neutral-900 hover:bg-red-600 transition-colors rounded-sm"
            >
              Sign Out
            </button>
          </div>

          {/* Mobile Menu Button */}
          <div className="md:hidden flex items-center">
            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="text-neutral-900 hover:text-orange-600 focus:outline-none p-2"
            >
              <i className={`fas ${isMenuOpen ? 'fa-times' : 'fa-bars'} text-2xl`}></i>
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu */}
      {isMenuOpen && (
        <div className="md:hidden bg-white border-t-2 border-neutral-100 absolute w-full left-0 shadow-xl animate-in slide-in-from-top-5 duration-200">
          <div className="px-4 pt-4 pb-6 space-y-2">
            <div className="flex items-center gap-3 mb-6 p-4 bg-neutral-50 rounded-lg border border-neutral-100">
              <div className={`w-2 h-2 rounded-full ${user.role === 'admin' ? 'bg-red-600' : user.role === 'owner' ? 'bg-blue-600' : 'bg-emerald-500'}`}></div>
              <div>
                <p className="text-sm font-black text-neutral-900 uppercase tracking-wide">{user.name || user.email}</p>
                <p className="text-[10px] text-neutral-400 uppercase font-bold tracking-widest">{user.role}</p>
              </div>
            </div>

            <button 
              onClick={() => handleTabClick('dashboard')}
              className={`block w-full text-left px-4 py-3 text-sm font-black uppercase tracking-widest rounded-lg transition-colors ${activeTab === 'dashboard' ? 'bg-orange-50 text-orange-600' : 'text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900'}`}
            >
              {dashboardLabel}
            </button>
            <button 
              onClick={() => handleTabClick('community')}
              className={`block w-full text-left px-4 py-3 text-sm font-black uppercase tracking-widest rounded-lg transition-colors ${activeTab === 'community' ? 'bg-orange-50 text-orange-600' : 'text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900'}`}
            >
              Community
            </button>
            <button 
              onClick={() => handleTabClick('profile')}
              className={`block w-full text-left px-4 py-3 text-sm font-black uppercase tracking-widest rounded-lg transition-colors ${activeTab === 'profile' ? 'bg-orange-50 text-orange-600' : 'text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900'}`}
            >
              Profile
            </button>
            
            <div className="pt-4 mt-4 border-t border-neutral-100">
              <button 
                onClick={onLogout}
                className="block w-full text-left px-4 py-3 text-sm font-black uppercase tracking-widest text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
};

export default Navbar;
