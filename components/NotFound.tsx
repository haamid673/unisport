import React from 'react';
import { Link } from 'react-router-dom';

interface NotFoundProps {
  /** Where "back" goes: the signed-in role's home. */
  homeHref: string;
  title?: string;
  message?: string;
}

/** Shown for a URL that does not exist, or a record that cannot be found. */
const NotFound: React.FC<NotFoundProps> = ({
  homeHref,
  title = 'Page not found',
  message = 'That address does not match anything in UniSport.'
}) => (
  <div className="max-w-3xl mx-auto px-4 py-20 font-sans text-center">
    <p className="text-xs font-black text-neutral-400 uppercase tracking-widest">404</p>
    <h2 className="mt-2 text-4xl font-black text-neutral-900 uppercase italic tracking-tighter">
      {title}
    </h2>
    <p className="mt-3 text-sm font-bold text-neutral-500">{message}</p>
    <Link
      to={homeHref}
      className="inline-block mt-8 px-6 py-3 bg-neutral-900 text-white text-xs font-black uppercase tracking-widest rounded-lg hover:bg-orange-600 transition-all"
    >
      Back to home
    </Link>
  </div>
);

export default NotFound;
