/**
 * Presentational default image per sport.
 *
 * This is a design default used until facility photos are served from
 * Supabase Storage (public.facility_images has no bucket yet). It is not
 * data and never substitutes for a failed database read.
 */
export const getSportImage = (sport: string) => {
  switch (sport.toLowerCase()) {
    case 'badminton': return 'images/stephan-rothe-VePgmkq3hHI-unsplash.jpg';
    case 'football': return 'https://images.unsplash.com/photo-1579952363873-27f3bade9f55?q=80&w=800&auto=format&fit=crop';
    case 'basketball': return 'https://images.unsplash.com/photo-1546519638-68e109498ffc?q=80&w=800&auto=format&fit=crop';
    case 'cricket': return 'https://images.unsplash.com/photo-1531415074968-036ba1b575da?q=80&w=800&auto=format&fit=crop';
    case 'tennis': return 'https://images.unsplash.com/photo-1622279457486-62dcc4a431d6?q=80&w=800&auto=format&fit=crop';
    case 'padel': return 'https://images.unsplash.com/photo-1554068865-24cecd4e34b8?q=80&w=800&auto=format&fit=crop';
    case 'volleyball': return 'images/jannes-glas-0NaQQsLWLkA-unsplash.jpg';
    case 'swimming': return 'https://images.unsplash.com/photo-1530549387789-4c1017266635?q=80&w=800&auto=format&fit=crop';
    case 'gym': return 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?q=80&w=800&auto=format&fit=crop';
    case 'yoga': return 'images/ginny-rose-stewart-UxkcSzRWM2s-unsplash.jpg';
    case 'table tennis': return 'images/inkiipow-7h9wGq4IUdE-unsplash.jpg';
    default: return 'https://images.unsplash.com/photo-1517649763962-0c623066013b?q=80&w=800&auto=format&fit=crop'; // Generic gym/sport
  }
};
