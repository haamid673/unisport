import React, { lazy, Suspense, useState, useEffect } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { User } from './types';
import { ROUTES, communityPath, homePath, pathForTab, redirectFor, tabForPath, type Tab } from './services/routes';
import { userService } from './services/userService';
import { authService } from './services/authService';
import { supabaseConfigError } from './services/supabaseClient';
import { purgeLegacyDemoData } from './services/legacyCleanup';
import Navbar from './components/Navbar';
import Auth from './components/Auth';
// Screens load on demand, so the first page only ships what it needs.
const UserDashboard = lazy(() => import('./components/UserDashboard'));
const OwnerDashboard = lazy(() => import('./components/OwnerDashboard'));
const AdminDashboard = lazy(() => import('./components/AdminDashboard'));
const Community = lazy(() => import('./components/Community'));
const CommunityDetail = lazy(() => import('./components/CommunityDetail'));
const UserProfile = lazy(() => import('./components/UserProfile'));
import NotFound from './components/NotFound';
import ResetPassword from './components/ResetPassword';
import AboutDemo from './components/AboutDemo';
import { PAYMENTS_AVAILABLE } from './services/razorpayCheckout';
import { TEST_MODE_HEADLINE } from './services/demoPayments';

// Earlier prototype builds stored a simulated login, demo accounts and
// mock records in this browser. None of it is honoured or shown.
purgeLegacyDemoData();

const PageSpinner: React.FC = () => (
  <div className="py-24 flex items-center justify-center" role="status" aria-label="Loading">
    <div className="animate-spin rounded-full h-10 w-10 border-t-4 border-b-4 border-neutral-900"></div>
  </div>
);

/** /community/:groupId: the group is looked up (and its absence reported) by the screen itself. */
const CommunityGroupRoute: React.FC<{ user: User; onBack: () => void; homeHref: string }> = ({
  user,
  onBack,
  homeHref
}) => {
  const { groupId } = useParams();
  return <CommunityDetail user={user} groupId={groupId ?? ''} onBack={onBack} homeHref={homeHref} />;
};

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const [isReady, setIsReady] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // Real session handling. supabase-js reports the restored session
  // (or its absence) first, then every sign-in / sign-out / user
  // change. The identity and role come from Supabase Auth and the
  // database profile, never from localStorage.
  useEffect(() => {
    if (supabaseConfigError) {
      setIsReady(true);
      return;
    }

    return authService.subscribe(
      (authenticated) => {
        const resolved = userService.setCurrentUser(authenticated);

        // The address bar is kept as it is: opening a deep link while
        // signed out lands on that page after signing in.
        setUser(resolved);

        if (resolved) setAuthError(null);
        setIsReady(true);
      },
      (message) => {
        setAuthError(message);
        setIsReady(true);
      },
      // A password-reset link was opened: go to the set-new-password
      // screen even if the link landed on another path.
      () => navigate(ROUTES.resetPassword, { replace: true })
    );
  }, []);

  useEffect(() => {
  if (!toast) return;
  const timer = setTimeout(() => setToast(null), 3000);
  return () => clearTimeout(timer);
}, [toast]);

  const handleLogout = async () => {
    try {
      await authService.signOut();
      // The auth listener clears the user.
    } catch {
      setToast('Could not sign out. Please try again.');
    }
  };

  const handleProfileUpdate = (updatedUser: User) => {
    setUser(updatedUser);
  };

  if (!isReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50">
        <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-b-4 border-neutral-900"></div>
      </div>
    );
  }

  if (supabaseConfigError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50 p-6 font-sans">
        <div className="max-w-lg w-full bg-white rounded-lg border-2 border-red-200 p-8 shadow-xl">
          <h1 className="text-xl font-black uppercase tracking-tighter text-neutral-900 mb-3">
            Configuration required
          </h1>
          <p className="text-sm text-neutral-700 mb-4">{supabaseConfigError}</p>
          <p className="text-xs text-neutral-400 font-bold uppercase tracking-widest">
            Authentication is disabled until Supabase is configured.
          </p>
        </div>
      </div>
    );
  }

  // The reset link's screen works signed out (no recovery session yet) and
  // with the short-lived recovery session the link creates.
  if (location.pathname.replace(/\/+$/, '') === ROUTES.resetPassword) {
    return <ResetPassword onDone={() => navigate(ROUTES.home, { replace: true })} />;
  }

  // Readable signed in or out, with a way back to the app.
  if (location.pathname.replace(/\/+$/, '') === ROUTES.about) return <AboutDemo />;

  if (!user) return <Auth notice={authError} />;

  const renderDashboard = () => {
    switch (user.role) {
      case 'admin':
        return <AdminDashboard user={user} />;
      case 'owner':
        return <OwnerDashboard user={user} />;
      default:
        return <UserDashboard user={user} />;
    }
  };

  // A wrong role, or /auth while signed in, is sent to its own home.
  const redirect = redirectFor(user.role, location.pathname);
  if (redirect) return <Navigate to={redirect} replace />;

  const home = homePath(user.role);
  const activeTab: Tab | '' = tabForPath(location.pathname) ?? '';

  return (
    <div className="min-h-screen bg-white flex flex-col font-sans text-neutral-900">
      <Navbar
        user={user}
        onLogout={handleLogout}
        activeTab={activeTab}
        setActiveTab={(tab) => navigate(pathForTab(tab as Tab, user.role))}
      />

      <main className="flex-1">
        <Suspense fallback={<PageSpinner />}>
        <Routes>
          <Route path={ROUTES.home} element={renderDashboard()} />
          <Route path={ROUTES.owner} element={renderDashboard()} />
          <Route path={ROUTES.admin} element={renderDashboard()} />

          <Route
            path={ROUTES.community}
            element={
              <Community
                user={user}
                onSelectCommunity={group => navigate(communityPath(group.id))}
              />
            }
          />
          <Route
            path={ROUTES.communityGroup}
            element={<CommunityGroupRoute user={user} onBack={() => navigate(ROUTES.community)} homeHref={home} />}
          />

          <Route path={ROUTES.profile} element={<UserProfile user={user} onUpdate={handleProfileUpdate} />} />

          <Route path="*" element={<NotFound homeHref={home} />} />
        </Routes>
        </Suspense>

        {toast && (
          <div className="fixed bottom-6 right-6 bg-black text-white px-6 py-3 rounded-lg shadow-xl z-50 animate-in fade-in slide-in-from-bottom-5">
            {toast}
          </div>
        )}
      </main>

      <footer className="bg-neutral-900 text-white border-t border-neutral-800 py-12 mt-12">
        <div className="max-w-7xl mx-auto px-4 flex flex-col md:flex-row justify-between items-center gap-8">
          <span className="text-xl font-black uppercase italic tracking-tighter">
            UniSport
          </span>
          <p className="text-xs text-neutral-600 font-bold uppercase tracking-widest">
            © {new Date().getFullYear()} UniSport
          </p>
          <Link to={ROUTES.about} className="text-xs text-neutral-400 font-bold uppercase tracking-widest hover:text-orange-500 transition-colors">
            About this demo
          </Link>
          {PAYMENTS_AVAILABLE && (
            <p className="text-[10px] text-amber-400 font-bold uppercase tracking-widest">{TEST_MODE_HEADLINE}</p>
          )}
        </div>
      </footer>
    </div>
  );
};

export default App;