import React, { useState, useEffect } from 'react';
import { facilityService } from '../services/facilityService';
import { getAllBookings } from '../services/bookingService';
import { Facility, Slot, User, Booking } from '../types';

interface OwnerDashboardProps {
  user: User;
}

const OwnerDashboard: React.FC<OwnerDashboardProps> = ({ user }) => {
  const [myFacilities, setMyFacilities] = useState<Facility[]>([]);
  const [selectedFac, setSelectedFac] = useState<Facility | null>(null);
  const [facSlots, setFacSlots] = useState<Slot[]>([]);
  const [allBookings, setAllBookings] = useState<Booking[]>([]);

  useEffect(() => {
    refreshData();
  }, [user.id]);

  const refreshData = () => {
    const facilities = facilityService
      .getAllFacilities(true)
      .filter(f => f.ownerId === user.id);

    setMyFacilities(facilities);
    setAllBookings(getAllBookings());

    if (selectedFac) {
      setFacSlots(
        facilityService.getSlotsByFacility(selectedFac.id)
      );
    }
  };

  /* =====================================
     DEMAND ANALYSIS
  ====================================== */

  const analyzeDemand = (slotId: string) => {
    const confirmed = allBookings.filter(
      b => b.slotId === slotId && b.status === "confirmed"
    );

    const uniqueDays = [
      ...new Set(confirmed.map(b => b.bookingDate))
    ].sort(
      (a, b) => new Date(b).getTime() - new Date(a).getTime()
    );

    if (uniqueDays.length === 0) {
      return {
        demandScore: 0,
        streak: 0,
        reason: "No booking activity"
      };
    }

    let streak = 1;

    for (let i = 0; i < uniqueDays.length - 1; i++) {
      const current = new Date(uniqueDays[i]);
      const next = new Date(uniqueDays[i + 1]);

      const diff =
        (current.getTime() - next.getTime()) /
        (1000 * 60 * 60 * 24);

      if (diff === 1) streak++;
      else break;
    }

    const demandScore = Math.min(100, streak * 20);

    let reason = "Stable demand";
    if (streak >= 5) reason = `${streak}-day booking streak`;
    else if (streak >= 3) reason = `Rising trend (${streak} days)`;

    return { demandScore, streak, reason };
  };

  /* =====================================
     ADAPTIVE SURGE ENGINE
  ====================================== */

  const calculateSurgeMultiplier = (demandScore: number) => {
    const baseSurge = 0.05;   // 5%
    const surgeRange = 0.15;  // additional up to 15% (max 20%)
    const surgePercent = baseSurge + (demandScore / 100) * surgeRange;
    return 1 + surgePercent;
  };

  const enableSurge = (slot: Slot) => {
    const demand = analyzeDemand(slot.id);
    const multiplier = calculateSurgeMultiplier(demand.demandScore);

    facilityService.updateSlot(slot.id, {
      price: Math.round(slot.price * multiplier),
      surgeEnabled: true,
      surgeMultiplier: multiplier
    });

    refreshData();
  };

  const disableSurge = (slot: Slot) => {
    const original =
      Math.round(slot.price / (slot.surgeMultiplier || 1));

    facilityService.updateSlot(slot.id, {
      price: original,
      surgeEnabled: false,
      surgeMultiplier: 1
    });

    refreshData();
  };

  /* =====================================
     REVENUE METRICS
  ====================================== */

  const facilitySlotIds = facSlots.map(s => s.id);

  const confirmedBookings = allBookings.filter(
    b =>
      facilitySlotIds.includes(b.slotId) &&
      b.status === "confirmed"
  );

  const totalRevenue = confirmedBookings.reduce((sum, b) => {
    const slot = facSlots.find(s => s.id === b.slotId);
    return sum + (slot?.price || 0);
  }, 0);

  /* =====================================
     UI
  ====================================== */

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 font-sans">

      <h2 className="text-5xl font-black uppercase italic mb-12">
        Owner Dashboard
      </h2>

      <div className="grid grid-cols-4 gap-8">

        {/* Sidebar */}
        <div className="col-span-1 space-y-4">
          {myFacilities.map(f => (
            <div
              key={f.id}
              onClick={() => {
                setSelectedFac(f);
                setFacSlots(
                  facilityService.getSlotsByFacility(f.id)
                );
              }}
              className={`p-4 rounded-lg border-2 cursor-pointer ${
                selectedFac?.id === f.id
                  ? 'bg-neutral-900 text-white border-neutral-900'
                  : 'bg-white border-neutral-200'
              }`}
            >
              <p className="font-bold uppercase">{f.name}</p>
              <p className="text-xs text-neutral-400">
                {f.sport} • {f.location}
              </p>
            </div>
          ))}
        </div>

        {/* Main */}
        <div className="col-span-3 space-y-8">

          {selectedFac && (
            <>
              <div className="bg-white p-6 rounded-lg border-2">
                <p className="text-xs text-neutral-400 uppercase">
                  Estimated Revenue
                </p>
                <p className="text-3xl font-black">
                  ₹{totalRevenue.toFixed(2)}
                </p>
              </div>

              <div className="bg-white p-6 rounded-lg border-2">
                <h4 className="font-black uppercase mb-6">
                  Adaptive Surge Pricing
                </h4>

                <div className="grid grid-cols-2 gap-4">

                  {facSlots.map(slot => {
                    const demand = analyzeDemand(slot.id);
                    const projectedMultiplier =
                      calculateSurgeMultiplier(demand.demandScore);

                    const projectedPercent =
                      Math.round((projectedMultiplier - 1) * 100);

                    return (
                      <div
                        key={slot.id}
                        className="p-4 rounded-lg border-2 bg-neutral-50"
                      >
                        <p className="font-black uppercase">
                          {slot.time}
                        </p>

                        <p className="text-lg mt-1">
                          ₹{slot.price}
                        </p>

                        <p className="text-[9px] mt-2 uppercase font-bold text-neutral-400">
                          Demand Score: {demand.demandScore}%
                        </p>

                        <p className="text-[9px] text-neutral-500">
                          {demand.reason}
                        </p>

                        {!slot.surgeEnabled && (
                          <>
                            <p className="text-[10px] text-orange-600 font-black uppercase mt-3">
                              Suggested Surge: +{projectedPercent}%
                            </p>

                            <button
                              onClick={() => enableSurge(slot)}
                              className="mt-3 px-5 py-2 rounded-xl bg-neutral-900 text-white text-[10px] font-black uppercase tracking-widest
                                         border-2 border-neutral-900
                                         hover:bg-orange-600 hover:border-orange-700
                                         transition-all duration-150 active:scale-95"
                            >
                              Enable Surge
                            </button>
                          </>
                        )}

                        {slot.surgeEnabled && (
                          <button
                            onClick={() => disableSurge(slot)}
                            className="mt-3 px-5 py-2 rounded-xl bg-white text-red-600 text-[10px] font-black uppercase tracking-widest
                                       border-2 border-red-600
                                       hover:bg-red-600 hover:text-white
                                       transition-all duration-150 active:scale-95"
                          >
                            Disable Surge
                          </button>
                        )}
                      </div>
                    );
                  })}

                </div>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
};

export default OwnerDashboard;