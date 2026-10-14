import React from 'react';
import FeatureUnavailable from './FeatureUnavailable';

/**
 * The admin console is not connected to the live database yet.
 *
 * It previously displayed and edited browser-local demo data (users,
 * venues, bookings, audit logs) and called functions that no longer
 * exist. Showing that as platform data would be misleading, so the
 * console is intentionally read-only and empty until each capability is
 * backed by Supabase with server-side authorization (RLS / RPC).
 */
const AdminDashboard: React.FC = () => (
  <FeatureUnavailable
    title="Governance Center"
    subtitle="System-wide oversight and role management."
    icon="fa-lock"
    headline="Admin tools are not connected yet"
    message="Venue approvals, role changes and audit records must be enforced by the database, not by this page. Until each of them is wired to the live backend, this console shows no data and offers no actions, so nothing here can be mistaken for a real record."
    items={[
      {
        icon: 'fa-building-circle-check',
        label: 'Venue approvals',
        description: 'Review pending venues and approve or reject them.'
      },
      {
        icon: 'fa-user-shield',
        label: 'User and role management',
        description: 'Promote owners and manage account access.'
      },
      {
        icon: 'fa-calendar-check',
        label: 'Booking oversight',
        description: 'Inspect bookings, payments and waitlists across venues.'
      },
      {
        icon: 'fa-list-check',
        label: 'Audit trail',
        description: 'A tamper-resistant history of administrative actions.'
      }
    ]}
    footnote="Until then, approvals and role changes are made directly in the database by an administrator."
  />
);

export default AdminDashboard;
