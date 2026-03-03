import React, { useEffect, useState } from 'react';
import { eventService } from '../services/eventService';
import { CommunityEvent, CommunityGroup, User } from '../types';

interface Props {
  user: User;
  group: CommunityGroup;
  onBack: () => void;
}

const CommunityDetail: React.FC<Props> = ({ user, group, onBack }) => {
  const [events, setEvents] = useState<CommunityEvent[]>([]);
  const [isMember, setIsMember] = useState(false);
  const [currentGroup, setCurrentGroup] = useState<CommunityGroup>(group);

  const refresh = () => {
    const updatedGroups = eventService.getAllGroups(true);
    const updatedGroup = updatedGroups.find(g => g.id === group.id);
    if (!updatedGroup) return;

    setCurrentGroup(updatedGroup);
    setIsMember(updatedGroup.members.includes(user.id));

    const groupEvents = eventService
      .getAllEvents(true)
      .filter(e => e.groupId === group.id && e.status === 'approved');

    setEvents(groupEvents);
    console.log("Updated Group:", updatedGroup);
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleJoin = () => {
    eventService.joinGroup(group.id);
    refresh();
  };

  const handleLeave = () => {
    eventService.leaveGroup(group.id);
    refresh();
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-10 font-sans">

      <button
        onClick={onBack}
        className="mb-6 text-xs font-black uppercase tracking-widest text-neutral-500 hover:text-black transition"
      >
        ← Back to Communities
      </button>

      {/* Banner */}
      <div className="relative h-72 rounded-xl overflow-hidden mb-10">
        {currentGroup.imageUrl && (
                <img
                    src={currentGroup.imageUrl}
                    alt={currentGroup.name}
                    className="w-full h-full object-cover"
                />
                )}
        <div className="absolute inset-0 bg-black/50"></div>

        <div className="absolute bottom-6 left-6 text-white">
          <h1 className="text-4xl font-black uppercase italic tracking-tight">
            {currentGroup.name}
          </h1>
          <p className="mt-2 text-xs uppercase tracking-widest opacity-90">
            {currentGroup.sport} • {currentGroup.city}
          </p>
          <p className="text-xs mt-2 opacity-80">
            {currentGroup.members.length} Members
          </p>
        </div>
      </div>

      <div className="mb-12">
        {isMember ? (
          <button
            onClick={handleLeave}
            className="px-6 py-3 bg-neutral-200 rounded-full font-black uppercase tracking-widest text-xs hover:bg-neutral-300 transition"
          >
            Leave Community
          </button>
        ) : (
          <button
            onClick={handleJoin}
            className="px-6 py-3 bg-orange-600 text-white rounded-full font-black uppercase tracking-widest text-xs hover:bg-orange-700 transition shadow-lg"
          >
            Join Community
          </button>
        )}
      </div>

      {/* Events */}
<h2 className="text-3xl font-black uppercase italic tracking-tight mb-6">
  Community Events
</h2>

{events.length === 0 && (
  <p className="text-neutral-400 uppercase text-xs font-bold tracking-widest">
    No events yet in this community.
  </p>
)}

<div className="grid grid-cols-1 md:grid-cols-2 gap-8">
  {events.map(event => {
    const isJoined = event.participants.includes(user.id);
    const isFull =
      event.capacity && event.participants.length >= event.capacity;

    return (
      <div
        key={event.id}
        className="border rounded-lg p-6 bg-white flex flex-col justify-between"
      >
        <div>
          <h3 className="font-black uppercase italic text-lg">
            {event.title}
          </h3>
          <p className="text-xs text-neutral-500 mt-2 uppercase tracking-wide">
            {event.date} • {event.time}
          </p>
          <p className="text-xs text-neutral-400 mt-1 uppercase tracking-wide">
            {event.participants.length}
            {event.capacity ? ` / ${event.capacity}` : ''} Players
          </p>
        </div>

        <button
          onClick={() => {
            try {
              if (isJoined) {
                eventService.leaveEvent(event.id);
              } else {
                eventService.joinEvent(event.id);
              }
              refresh();
            } catch (err: any) {
              alert(err.message);
            }
          }}
          disabled={!isJoined && isFull}
          className={`mt-6 py-3 rounded-md font-black uppercase tracking-widest text-xs transition-all ${
            isJoined
              ? 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300'
              : isFull
              ? 'bg-neutral-200 text-neutral-500 cursor-not-allowed'
              : 'bg-neutral-900 text-white hover:bg-orange-600'
          }`}
        >
          {isJoined
            ? 'Leave Event'
            : isFull
            ? 'Full'
            : 'Join Event'}
        </button>
      </div>
    );
  })}
</div>
      </div>

  );
};

export default CommunityDetail;