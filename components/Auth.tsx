import React, { useState } from 'react';
import { authService } from '../services/authService';

interface AuthProps {
  /**
   * Message from the session layer (for example "could not load your
   * profile"). Sign-in/sign-up success is not reported here: App.tsx
   * observes the Supabase session and swaps this screen out.
   */
  notice?: string | null;
}

const Auth: React.FC<AuthProps> = ({ notice }) => {
  const [isLogin, setIsLogin] = useState(true);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isValidPhoneNumber = (value: string) => {
    const cleaned = value.replace(/\D/g, '');
    return cleaned.length >= 10 && cleaned.length <= 12;
  };

  const switchMode = (loginMode: boolean) => {
    setIsLogin(loginMode);
    setError('');
    setInfo('');
    setConfirmPassword('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    setError('');
    setInfo('');

    if (!isValidEmail(email)) {
      setError('Please enter a valid email address.');
      return;
    }

    if (!isLogin) {
      if (!name.trim()) {
        setError('Please enter your full name.');
        return;
      }

      if (!isValidPhoneNumber(phone)) {
        setError('Please enter a valid phone number.');
        return;
      }

      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
    }

    setSubmitting(true);

    try {
      if (isLogin) {
        // On success App.tsx receives the session through the Supabase
        // auth listener and replaces this screen.
        await authService.signIn(email, password);
        return;
      }

      const { needsEmailConfirmation } = await authService.signUp({
        email,
        password,
        name,
        phone
      });

      if (needsEmailConfirmation) {
        setInfo('Account created. Check your email and follow the link to confirm it, then sign in.');
        setIsLogin(true);
        setPassword('');
        setConfirmPassword('');
      }
      // Otherwise a session was issued and App.tsx takes over.
    } catch (err: any) {
      setError(err?.message || 'Authentication failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const isValidEmail = (value: string) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
};

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 p-6 font-sans">
      <div className="max-w-md w-full bg-white rounded-lg border-2 border-neutral-200 p-8 shadow-xl">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-neutral-900 flex items-center justify-center text-white mx-auto mb-4 transform -skew-x-12">
            <i className="fas fa-running text-3xl"></i>
          </div>
          <h1 className="text-3xl font-black text-neutral-900 uppercase italic tracking-tighter">
            UniSport
          </h1>
          <p className="text-neutral-500 font-bold uppercase tracking-widest text-xs mt-2">
            Elite Sports Management
          </p>
        </div>

        <div className="flex border-b-2 border-neutral-100 mb-8">
          <button
            type="button"
            aria-pressed={isLogin}
            className={`flex-1 py-3 text-xs font-black uppercase tracking-widest transition-colors ${
              isLogin
                ? 'text-orange-600 border-b-2 border-orange-600'
                : 'text-neutral-400 hover:text-neutral-600'
            }`}
            onClick={() => switchMode(true)}
          >
            Log In
          </button>
          <button
            type="button"
            aria-pressed={!isLogin}
            className={`flex-1 py-3 text-xs font-black uppercase tracking-widest transition-colors ${
              !isLogin
                ? 'text-orange-600 border-b-2 border-orange-600'
                : 'text-neutral-400 hover:text-neutral-600'
            }`}
            onClick={() => switchMode(false)}
          >
            Register
          </button>
        </div>

        {(error || notice) && (
          <div role="alert" className="mb-4 p-3 bg-red-50 text-red-600 text-xs font-bold uppercase tracking-wide border border-red-200 flex items-center gap-2">
            <i className="fas fa-exclamation-circle"></i>
            {error || notice}
          </div>
        )}

        {info && (
          <div role="status" className="mb-4 p-3 bg-emerald-50 text-emerald-700 text-xs font-bold uppercase tracking-wide border border-emerald-200 flex items-center gap-2">
            <i className="fas fa-circle-check"></i>
            {info}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isLogin && (
            <>
              <div>
                <label htmlFor="auth-name" className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1">
                  Full Name
                </label>
                <input
                  type="text"
                  required
                  className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  id="auth-name"
                  autoComplete="name"
                  placeholder="JOHN DOE"
                />
              </div>

              <div>
                <label htmlFor="auth-phone" className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1">
                  Phone Number
                </label>
                <input
                  type="tel"
                  required
                  className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  id="auth-phone"
                  autoComplete="tel"
                  placeholder="+91 98765 43210"
                />
              </div>
            </>
          )}

          <div>
            <label htmlFor="auth-email" className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1">
              Email Address
            </label>
            <input
              type="email"
              required
              className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              id="auth-email"
              autoComplete="email"
              placeholder="PLAYER@EXAMPLE.COM"
            />
          </div>

          <div>
            <label htmlFor="auth-password" className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1">
              Password
            </label>
            <input
              type="password"
              required
              className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              id="auth-password"
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              placeholder="••••••••"
            />
          </div>

          {!isLogin && (
            <div>
              <label htmlFor="auth-confirm-password" className="block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1">
                Confirm Password
              </label>
              <input
                type="password"
                required
                className="w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                id="auth-confirm-password"
                autoComplete="new-password"
                placeholder="••••••••"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className={`w-full text-white font-black uppercase tracking-widest py-4 rounded-lg transition-all mt-6 shadow-lg ${
              submitting
                ? 'bg-neutral-400 cursor-not-allowed'
                : 'bg-neutral-900 hover:bg-orange-600 hover:shadow-xl transform hover:-translate-y-0.5'
            }`}
          >
            {submitting ? 'Please wait...' : isLogin ? 'Sign In' : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Auth;