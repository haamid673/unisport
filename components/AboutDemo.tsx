import React from 'react';
import { Link } from 'react-router-dom';
import { ROUTES } from '../services/routes';

/**
 * Plain statement of what this site is. Readable signed in or out. It sets
 * expectations for a project demo; it is not a legal document written for
 * a real business.
 */
const AboutDemo: React.FC = () => (
  <div className="min-h-screen bg-neutral-50 px-6 py-12 font-sans">
    <div className="max-w-2xl mx-auto bg-white rounded-lg border-2 border-neutral-200 p-8">
      <h1 className="text-3xl font-black text-neutral-900 uppercase italic tracking-tighter">About this demo</h1>
      <p className="mt-2 text-xs font-bold uppercase tracking-widest text-neutral-500">UniSport is a project demonstration</p>

      <div className="mt-8 space-y-6 text-sm text-neutral-700">
        <section>
          <h2 className="font-black uppercase text-neutral-900 mb-1">Not a real business</h2>
          <p>Venues, communities and events here are sample data. Booking a slot does not reserve anything in the real world.</p>
        </section>
        <section>
          <h2 className="font-black uppercase text-neutral-900 mb-1">No real money</h2>
          <p>
            Where payment is switched on, it runs in Razorpay test mode: Razorpay simulates the payment and nothing is
            charged. Use only the published test card shown in the app. Never enter a real card, UPI ID or bank detail.
          </p>
        </section>
        <section>
          <h2 className="font-black uppercase text-neutral-900 mb-1">Your data</h2>
          <p>
            The app stores the email address, name and phone number you register with, and what you do here (bookings,
            communities, events, notifications). Please use made-up details. Passwords are handled by Supabase Auth and are not
            visible to the app. Nothing is sold or shared; there is no analytics or advertising.
          </p>
        </section>
        <section>
          <h2 className="font-black uppercase text-neutral-900 mb-1">It can change or vanish</h2>
          <p>Data may be reset or removed at any time and without notice, and the site may be taken down. It comes with no guarantee.</p>
        </section>
      </div>

      <Link
        to={ROUTES.home}
        className="inline-block mt-8 px-6 py-3 bg-neutral-900 text-white text-xs font-black uppercase tracking-widest rounded-lg hover:bg-orange-600 transition-all"
      >
        Back to UniSport
      </Link>
    </div>
  </div>
);

export default AboutDemo;
