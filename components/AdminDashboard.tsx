
import React, { useState, useEffect } from 'react';
import { userService } from '../services/userService';
import { facilityService } from '../services/facilityService';
import { getAllBookings, cancelBooking } from '../services/bookingService';
import { eventService } from '../services/eventService';
import { aiEngine } from '../services/aiEngine';
import { storageService, STORAGE_KEYS } from '../services/storageService';
import { Facility, User, Booking, FraudRisk, AuditLog, CommunityEvent, CommunityGroup } from '../types';

const AdminDashboard: React.FC = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [events, setEvents] = useState<CommunityEvent[]>([]);
  const [groups, setGroups] = useState<CommunityGroup[]>([]);
  const [activeTab, setActiveTab] = useState<'overview' | 'users' | 'facilities' | 'approvals' | 'risk' | 'audit'>('overview');
  const [fraudRisks, setFraudRisks] = useState<FraudRisk[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loadingRisk, setLoadingRisk] = useState(false);

  useEffect(() => {
    refreshData();
  }, []);

  const refreshData = async () => {
    try {
      const allUsers = userService.getAllUsers();
      const allFacilities = facilityService.getAllFacilities(true); // Include pending
      const allBookings = getAllBookings();
      const allEvents = eventService.getAllEvents(true); // Include pending
      const allGroups = eventService.getAllGroups(true); // Include pending
      const logs = storageService.get<AuditLog[]>(STORAGE_KEYS.AUDIT_LOGS, []);

      setUsers(allUsers);
      setFacilities(allFacilities);
      setBookings(allBookings);
      setEvents(allEvents);
      setGroups(allGroups);
      setAuditLogs(logs);

      // Run Fraud Detection
      setLoadingRisk(true);
      const bookingData = allBookings.map(b => ({
        id: b.id,
        user: b.userId,
        amount: b.finalPrice || 0,
        date: b.bookingDate,
        createdAt: b.createdAt || new Date().toISOString()
      }));
      
      const risks = await aiEngine.detectFraud(bookingData);
      setFraudRisks(risks);
      setLoadingRisk(false);

    } catch (err: any) {
      console.error(err);
      // alert("Unauthorized: Only Admins can view this dashboard.");
    }
  };

  const handleApproveFacility = (id: string) => {
    facilityService.updateFacilityStatus(id, 'approved');
    refreshData();
  };

  const handleRejectFacility = (id: string) => {
    facilityService.updateFacilityStatus(id, 'rejected');
    refreshData();
  };

  const handleApproveEvent = (id: string) => {
    eventService.updateEventStatus(id, 'approved');
    refreshData();
  };

  const handleRejectEvent = (id: string) => {
    eventService.updateEventStatus(id, 'rejected');
    refreshData();
  };

  const handleApproveGroup = (id: string) => {
    eventService.updateGroupStatus(id, 'approved');
    refreshData();
  };

  const handleRejectGroup = (id: string) => {
    eventService.updateGroupStatus(id, 'rejected');
    refreshData();
  };

  const stats = [
    { label: 'Total Users', value: users.length, icon: 'fa-users', color: 'text-neutral-900', bg: 'bg-neutral-100' },
    { label: 'Active Venues', value: facilities.filter(f => f.status === 'approved').length, icon: 'fa-building', color: 'text-orange-600', bg: 'bg-orange-50' },
    { label: 'Pending Approvals', value: facilities.filter(f => f.status === 'pending').length + events.filter(e => e.status === 'pending').length + groups.filter(g => g.status === 'pending').length, icon: 'fa-clock', color: 'text-yellow-600', bg: 'bg-yellow-50' },
    { label: 'High Risk Events', value: fraudRisks.filter(r => r.riskLevel === 'High').length, icon: 'fa-shield-halved', color: 'text-red-600', bg: 'bg-red-50' }
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 font-sans">
      <div className="flex items-center gap-3 mb-8">
        <div className="w-12 h-12 bg-neutral-900 rounded-none transform -skew-x-12 flex items-center justify-center text-white">
          <i className="fas fa-lock"></i>
        </div>
        <div>
          <h2 className="text-4xl font-black text-neutral-900 uppercase italic tracking-tighter">Governance Center</h2>
          <p className="text-neutral-500 text-xs font-bold uppercase tracking-widest">System-wide data oversight and role management.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-10">
        {stats.map((stat, i) => (
          <div key={i} className="bg-white p-6 rounded-lg border-2 border-neutral-100 hover:border-neutral-300 transition-colors">
            <div className={`w-10 h-10 ${stat.bg} ${stat.color} rounded-sm flex items-center justify-center mb-4 text-lg`}>
              <i className={`fas ${stat.icon}`}></i>
            </div>
            <p className="text-[10px] font-black text-neutral-400 uppercase tracking-widest">{stat.label}</p>
            <p className="text-3xl font-black text-neutral-900 tracking-tighter">{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-lg border-2 border-neutral-100 overflow-hidden">
        <div className="flex border-b-2 border-neutral-100 bg-neutral-50 p-1 overflow-x-auto">
          {[
            { id: 'overview', label: 'Security Logs', icon: 'fa-history' },
            { id: 'users', label: 'User Registry', icon: 'fa-user-shield' },
            { id: 'facilities', label: 'Global Facilities', icon: 'fa-map-location-dot' },
            { id: 'risk', label: 'Risk Monitor', icon: 'fa-triangle-exclamation' },
            { id: 'audit', label: 'Audit Trail', icon: 'fa-list-check' }
          ].map((tab) => (
            <button 
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex-1 py-3 px-4 rounded-sm text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 min-w-[120px] ${
                activeTab === tab.id 
                  ? 'bg-white text-orange-600 border border-neutral-200 shadow-sm' 
                  : 'text-neutral-400 hover:text-neutral-600'
              }`}
            >
              <i className={`fas ${tab.icon}`}></i>
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>

        <div className="p-8">
          {activeTab === 'overview' && (
            <div className="space-y-5">
              <div className="flex justify-between items-center mb-4">
                <h4 className="font-black text-neutral-800 uppercase text-xs tracking-widest">Global Activity Heartbeat</h4>
                <span className="px-2 py-0.5 bg-emerald-100 text-emerald-600 rounded-sm text-[8px] font-black uppercase tracking-wider">LIVE SYNC</span>
              </div>
              {bookings.slice(-8).reverse().map(b => (
                <div key={b.id} className="flex items-center gap-4 p-4 bg-neutral-50 rounded-lg border-2 border-neutral-100 group hover:border-orange-200 transition-all">
                  <div className="w-10 h-10 bg-white rounded-sm flex items-center justify-center text-neutral-900 border-2 border-neutral-100 group-hover:bg-neutral-900 group-hover:text-white transition-all">
                    <i className="fas fa-key text-[10px]"></i>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-black text-neutral-900 uppercase tracking-tight">System Event: New Booking</p>
                      <span className="text-[10px] text-neutral-400 font-mono">#{b.id}</span>
                    </div>
                    <p className="text-[10px] text-neutral-500 mt-1 font-medium">User <span className="text-neutral-900 font-bold">{b.userId}</span> successfully reserved slot <span className="text-neutral-900 font-bold">{b.slotId}</span> for <span className="text-neutral-900 font-bold">{b.bookingDate}</span></p>
                  </div>
                  <div className="text-right">
                     <span className="text-[8px] font-black text-neutral-400 block mb-1 uppercase tracking-wider">AUTH_SUCCESS</span>
                     <button onClick={() => { cancelBooking(b.id); refreshData(); }} className="text-[10px] text-red-500 hover:text-red-700 font-black uppercase tracking-wider">REVOKE</button>
                  </div>
                </div>
              ))}
              {bookings.length === 0 && (
                <div className="py-20 text-center">
                   <i className="fas fa-inbox text-neutral-200 text-4xl mb-4"></i>
                   <p className="text-neutral-400 text-sm font-bold uppercase tracking-wide">No global activities recorded.</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'users' && (
            <div className="overflow-x-auto rounded-lg border-2 border-neutral-100">
              <table className="w-full text-left text-sm">
                <thead className="bg-neutral-50 text-neutral-400 font-black uppercase text-[10px] tracking-widest">
                  <tr>
                    <th className="px-6 py-4">Identity / Email</th>
                    <th className="px-6 py-4">Access Role</th>
                    <th className="px-6 py-4 text-center">Admin Controls</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {users.map(u => (
                    <tr key={u.id} className="hover:bg-neutral-50 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                           <div className="w-8 h-8 rounded-sm bg-neutral-100 flex items-center justify-center text-[10px] font-black text-neutral-500">{u.id.substring(0, 2).toUpperCase()}</div>
                           <span className="font-bold text-neutral-900 text-xs">{u.email}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-1 rounded-sm text-[9px] font-black uppercase tracking-widest ${
                          u.role === 'admin' ? 'bg-red-50 text-red-600 border border-red-100' : u.role === 'owner' ? 'bg-indigo-50 text-indigo-600 border border-indigo-100' : 'bg-emerald-50 text-emerald-600 border border-emerald-100'
                        }`}>
                          {u.role}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <div className="flex justify-center gap-3 text-neutral-300">
                          <button className="hover:text-neutral-900 transition-colors"><i className="fas fa-user-edit"></i></button>
                          <button className="hover:text-red-600 transition-colors"><i className="fas fa-ban"></i></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'facilities' && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {facilities.map(f => (
                <div key={f.id} className="bg-neutral-50 p-6 rounded-lg border-2 border-neutral-100 relative group overflow-hidden hover:border-neutral-300 transition-all">
                  <div className="absolute top-0 right-0 p-3 bg-white/90 backdrop-blur border-b-2 border-l-2 border-neutral-100 rounded-bl-lg text-[8px] font-black text-neutral-400 font-mono">
                    OWNER_ID: {f.ownerId}
                  </div>
                  <div className="flex items-center gap-4 mb-4">
                    <div className="w-14 h-14 bg-white rounded-sm overflow-hidden border-2 border-neutral-100">
                      <img src={f.imageUrl} className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition-all duration-500" alt="" />
                    </div>
                    <div>
                      <p className="font-black text-neutral-900 leading-tight mb-1 uppercase tracking-tight">{f.name}</p>
                      <p className="text-[10px] text-orange-600 font-black uppercase tracking-wider">{f.sport}</p>
                    </div>
                  </div>
                  <div className="pt-4 border-t-2 border-neutral-200 flex justify-between items-center">
                    <span className="text-[10px] font-black text-neutral-400 uppercase tracking-widest">{f.location}</span>
                    <div className="flex items-center gap-2">
                      <span className={`text-[8px] px-1.5 py-0.5 rounded-sm font-black uppercase tracking-wider ${
                        f.status === 'approved' ? 'bg-emerald-100 text-emerald-700' :
                        f.status === 'pending' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'
                      }`}>
                        {f.status || 'approved'}
                      </span>
                      <button 
                        onClick={() => { if(confirm('Permanently delete facility?')) { facilityService.deleteFacility(f.id); refreshData(); }}}
                        className="w-8 h-8 rounded-sm bg-white text-red-400 hover:bg-red-500 hover:text-white flex items-center justify-center transition-all border-2 border-neutral-100"
                      >
                        <i className="fas fa-trash-alt text-xs"></i>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'approvals' && (
            <div className="space-y-8">
              {/* Pending Facilities */}
              <div>
                <h4 className="font-black text-neutral-800 uppercase text-xs tracking-widest mb-4">Pending Facilities</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {facilities.filter(f => f.status === 'pending').map(f => (
                    <div key={f.id} className="bg-white p-4 rounded-lg border-2 border-yellow-200 flex justify-between items-center">
                      <div>
                        <p className="font-bold text-neutral-900 uppercase tracking-tight">{f.name}</p>
                        <p className="text-xs text-neutral-500 font-bold uppercase">{f.sport} • {f.location}</p>
                        <p className="text-[10px] text-neutral-400 mt-1 font-mono">Owner: {f.ownerId}</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => handleApproveFacility(f.id)} className="px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-sm text-xs font-black uppercase tracking-wider hover:bg-emerald-100">Approve</button>
                        <button onClick={() => handleRejectFacility(f.id)} className="px-3 py-1.5 bg-red-50 text-red-600 rounded-sm text-xs font-black uppercase tracking-wider hover:bg-red-100">Reject</button>
                      </div>
                    </div>
                  ))}
                  {facilities.filter(f => f.status === 'pending').length === 0 && (
                    <p className="text-neutral-400 text-xs font-bold uppercase tracking-wide italic col-span-full">No pending facility approvals.</p>
                  )}
                </div>
              </div>

              {/* Pending Groups */}
              <div>
                <h4 className="font-black text-neutral-800 uppercase text-xs tracking-widest mb-4">Pending Community Groups</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {groups.filter(g => g.status === 'pending').map(g => (
                    <div key={g.id} className="bg-white p-4 rounded-lg border-2 border-yellow-200 flex justify-between items-center">
                      <div>
                        <p className="font-bold text-neutral-900 uppercase tracking-tight">{g.name}</p>
                        <p className="text-xs text-neutral-500 font-bold uppercase">{g.sport} • {g.city}</p>
                        <p className="text-[10px] text-neutral-400 mt-1 font-mono">Created by: {g.createdBy}</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => handleApproveGroup(g.id)} className="px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-sm text-xs font-black uppercase tracking-wider hover:bg-emerald-100">Approve</button>
                        <button onClick={() => handleRejectGroup(g.id)} className="px-3 py-1.5 bg-red-50 text-red-600 rounded-sm text-xs font-black uppercase tracking-wider hover:bg-red-100">Reject</button>
                      </div>
                    </div>
                  ))}
                  {groups.filter(g => g.status === 'pending').length === 0 && (
                    <p className="text-neutral-400 text-xs font-bold uppercase tracking-wide italic col-span-full">No pending group approvals.</p>
                  )}
                </div>
              </div>

              {/* Pending Events */}
              <div>
                <h4 className="font-black text-neutral-800 uppercase text-xs tracking-widest mb-4">Pending Events</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {events.filter(e => e.status === 'pending').map(e => (
                    <div key={e.id} className="bg-white p-4 rounded-lg border-2 border-yellow-200 flex justify-between items-center">
                      <div>
                        <p className="font-bold text-neutral-900 uppercase tracking-tight">{e.title}</p>
                        <p className="text-xs text-neutral-500 font-bold uppercase">{e.date} • {e.time}</p>
                        <p className="text-[10px] text-neutral-400 mt-1 font-mono">Created by: {e.createdBy}</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => handleApproveEvent(e.id)} className="px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-sm text-xs font-black uppercase tracking-wider hover:bg-emerald-100">Approve</button>
                        <button onClick={() => handleRejectEvent(e.id)} className="px-3 py-1.5 bg-red-50 text-red-600 rounded-sm text-xs font-black uppercase tracking-wider hover:bg-red-100">Reject</button>
                      </div>
                    </div>
                  ))}
                  {events.filter(e => e.status === 'pending').length === 0 && (
                    <p className="text-neutral-400 text-xs font-bold uppercase tracking-wide italic col-span-full">No pending event approvals.</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'risk' && (
            <div className="space-y-6">
              <div className="bg-neutral-900 text-white p-6 rounded-lg border border-neutral-800 flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className="bg-red-600 p-2 rounded-sm">
                    <i className="fas fa-triangle-exclamation text-white"></i>
                  </div>
                  <div>
                    <h4 className="font-black text-lg uppercase italic tracking-tighter">AI Risk Monitor</h4>
                    <p className="text-xs text-neutral-400 font-bold uppercase tracking-wide">Real-time fraud detection analysis</p>
                  </div>
                </div>
                {loadingRisk && <span className="text-xs animate-pulse font-mono text-orange-500">ANALYZING_TRANSACTIONS...</span>}
              </div>

              <div className="grid grid-cols-1 gap-4">
                {fraudRisks.map((risk, idx) => (
                  <div key={idx} className={`p-4 rounded-lg border-l-4 ${
                    risk.riskLevel === 'High' ? 'bg-red-50 border-red-500' : 
                    risk.riskLevel === 'Medium' ? 'bg-yellow-50 border-yellow-500' : 'bg-emerald-50 border-emerald-500'
                  }`}>
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="font-black text-neutral-900 text-sm uppercase tracking-tight">Booking ID: {risk.bookingId}</p>
                        <p className="text-xs text-neutral-600 mt-1 font-medium">{risk.reason}</p>
                      </div>
                      <span className={`text-[10px] font-black uppercase px-2 py-1 rounded-sm tracking-wider ${
                        risk.riskLevel === 'High' ? 'bg-red-100 text-red-700' : 
                        risk.riskLevel === 'Medium' ? 'bg-yellow-100 text-yellow-700' : 'bg-emerald-100 text-emerald-700'
                      }`}>
                        {risk.riskLevel} Risk
                      </span>
                    </div>
                    <div className="mt-2 text-[10px] text-neutral-400 font-mono font-bold">
                      AI Confidence: {(risk.confidence * 100).toFixed(0)}%
                    </div>
                  </div>
                ))}
                {fraudRisks.length === 0 && !loadingRisk && (
                  <p className="text-center text-neutral-400 text-sm py-8 font-bold uppercase tracking-wide italic">No transactions flagged.</p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'audit' && (
             <div className="space-y-4">
                <h4 className="font-black text-neutral-800 uppercase text-xs tracking-widest mb-4">System Audit Trail</h4>
                <div className="bg-white rounded-lg border-2 border-neutral-100 overflow-hidden">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-neutral-50 text-neutral-400 font-black uppercase text-[10px] tracking-widest">
                      <tr>
                        <th className="px-6 py-4">Timestamp</th>
                        <th className="px-6 py-4">Action</th>
                        <th className="px-6 py-4">Entity</th>
                        <th className="px-6 py-4">Performed By</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {auditLogs.map(log => (
                        <tr key={log.id} className="hover:bg-neutral-50">
                          <td className="px-6 py-4 text-xs font-mono text-neutral-500 font-bold">{new Date(log.timestamp).toLocaleString()}</td>
                          <td className="px-6 py-4 font-black text-neutral-900 uppercase tracking-tight">{log.action}</td>
                          <td className="px-6 py-4 text-xs text-neutral-500 font-mono">{log.entityType} #{log.entityId}</td>
                          <td className="px-6 py-4 text-xs text-neutral-500 font-mono">{log.performedBy}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {auditLogs.length === 0 && (
                    <div className="p-8 text-center text-neutral-400 text-xs font-bold uppercase tracking-wide">No audit logs available.</div>
                  )}
                </div>
             </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdminDashboard;
