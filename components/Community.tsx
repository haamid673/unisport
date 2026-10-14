import React, { useEffect, useState } from 'react';
import { eventService } from '../services/eventService';
import { CommunityGroup, User } from '../types';

interface CommunityProps {
  user: User;
  onSelectCommunity: (group: CommunityGroup) => void;
}

const Community: React.FC<CommunityProps> = ({ user, onSelectCommunity }) => {
  const [groups, setGroups] = useState<CommunityGroup[]>([]);

  useEffect(() => {
    refresh();
  }, [user.city]);

  const refresh = () => {
    const allGroups = eventService.getAllGroups(true).filter(
      g => g.status === 'approved'
    );

    if (!user.city || !user.city.trim()) {
      setGroups(allGroups);
      return;
    }

    const cityGroups = allGroups.filter(
      g =>
        (g.city || '').trim().toLowerCase() ===
        user.city.trim().toLowerCase()
    );

    setGroups(cityGroups);
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-10 font-sans">
      <div className="mb-12 border-b-2 border-neutral-900 pb-6">
        <h2 className="text-5xl font-black uppercase tracking-tighter italic">
          Communities
        </h2>
        <p className="text-neutral-500 font-medium mt-2 tracking-wide uppercase text-xs">
          {user.city
            ? `Find like-minded players in ${user.city}`
            : 'Find like-minded players near you'}
        </p>
      </div>

      {groups.length === 0 && (
        <div className="py-16 text-center border-2 border-dashed border-neutral-200 rounded-lg">
          <p className="text-neutral-400 font-bold uppercase tracking-widest">
            No communities yet.
          </p>
          <p className="text-neutral-400 text-xs font-medium mt-2 normal-case tracking-normal">
            Community groups are not live yet. They will appear here once they are created.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {groups.map(group => (
          <div
            key={group.id}
            onClick={() => onSelectCommunity(group)}
            className="cursor-pointer rounded-xl overflow-hidden border-2 border-neutral-200 hover:border-black transition group bg-white"
          >
            <div className="relative h-48 overflow-hidden">
              {group.imageUrl && (
                <img
                  src={group.imageUrl}
                  alt={group.name}
                  className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition duration-500"
                />
              )}
              <div className="absolute inset-0 bg-black/40"></div>

              <div className="absolute bottom-4 left-4 text-white">
                <h3 className="font-black text-2xl uppercase italic tracking-tight leading-none">
                  {group.name}
                </h3>
                <p className="text-xs uppercase tracking-widest opacity-80 mt-1">
                  {group.sport}
                </p>
              </div>
            </div>

            <div className="p-5 bg-white">
              <p className="text-xs text-neutral-500 font-bold uppercase tracking-widest">
                {group.members?.length || 0} Members
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Community;