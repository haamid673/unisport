/**
 * Presentational default image per sport.
 *
 * This is a design default used until facility photos are served from
 * Supabase Storage (public.facility_images has no bucket yet). It is not
 * data and never substitutes for a failed database read.
 *
 * Bundled images live in public/images and are served from the app's
 * base path, so they resolve in development, in production and when the
 * app is deployed under a sub-path.
 */
export const assetUrl = (path: string): string =>
  `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`;

export const getSportImage = (sport: string) => {
  switch (sport.trim().toLowerCase()) {
    case 'badminton': return assetUrl('images/stephan-rothe-VePgmkq3hHI-unsplash.jpg');
    case 'football': return assetUrl('images/sport-football.jpg');
    case 'basketball': return assetUrl('images/sport-basketball.jpg');
    case 'cricket': return assetUrl('images/sport-cricket.jpg');
    case 'tennis': return assetUrl('images/sport-tennis.jpg');
    case 'padel': return assetUrl('images/sport-padel.jpg');
    case 'volleyball': return assetUrl('images/jannes-glas-0NaQQsLWLkA-unsplash.jpg');
    case 'swimming': return assetUrl('images/sport-swimming.jpg');
    case 'gym': return assetUrl('images/sport-gym.jpg');
    case 'yoga': return assetUrl('images/ginny-rose-stewart-UxkcSzRWM2s-unsplash.jpg');
    case 'table tennis': return assetUrl('images/inkiipow-7h9wGq4IUdE-unsplash.jpg');
    default: return assetUrl('images/sport-default.jpg'); // Generic gym/sport
  }
};
