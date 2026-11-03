import React, { useEffect, useState } from 'react';
import { authService, MIN_PASSWORD_LENGTH, toAuthMessage } from '../services/authService';

const inputClass =
  'w-full px-4 py-3 border-2 border-neutral-200 rounded-lg font-bold text-neutral-900 outline-none focus:border-orange-500 transition-colors';
const labelClass = 'block text-xs font-black text-neutral-400 uppercase tracking-widest mb-1';

/**
 * The page a password-reset email leads to. Opening the link gives the
 * browser a short-lived recovery session; this screen only appears useful
 * when that session exists, and otherwise says the link is no good.
 */
const ResetPassword: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [phase, setPhase] = useState<'checking' | 'ready' | 'invalid' | 'done'>('checking');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authService.hasRecoverySession().then(ok => {
      if (!cancelled) setPhase(ok ? 'ready' : 'invalid');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError('');

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await authService.updatePassword(password);
      setPhase('done');
    } catch (err) {
      setError(toAuthMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-50 p-6 font-sans">
      <div className="max-w-md w-full bg-white rounded-lg border-2 border-neutral-200 p-8 shadow-xl">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-black text-neutral-900 uppercase italic tracking-tighter">Set a new password</h1>
          <p className="text-neutral-500 font-bold uppercase tracking-widest text-xs mt-2">UniSport</p>
        </div>

        {phase === 'checking' && (
          <p className="text-neutral-400 text-xs font-bold uppercase tracking-widest text-center">Checking your link…</p>
        )}

        {phase === 'invalid' && (
          <div role="alert" className="space-y-4">
            <p className="p-3 bg-red-50 text-red-600 text-xs font-bold uppercase tracking-wide border border-red-200">
              This reset link has expired or was already used. Request a new one from the sign-in page.
            </p>
            <button
              type="button"
              onClick={onDone}
              className="w-full bg-neutral-900 text-white font-black uppercase tracking-widest py-3 rounded-lg hover:bg-orange-600 transition-all"
            >
              Back to sign in
            </button>
          </div>
        )}

        {phase === 'ready' && (
          <form onSubmit={submit} className="space-y-4">
            {error && (
              <div role="alert" className="p-3 bg-red-50 text-red-600 text-xs font-bold uppercase tracking-wide border border-red-200">
                {error}
              </div>
            )}
            <div>
              <label htmlFor="reset-password" className={labelClass}>New password</label>
              <input id="reset-password" type="password" required autoComplete="new-password" className={inputClass}
                value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
              <p className="mt-1 text-[11px] text-neutral-400">At least {MIN_PASSWORD_LENGTH} characters.</p>
            </div>
            <div>
              <label htmlFor="reset-confirm" className={labelClass}>Confirm new password</label>
              <input id="reset-confirm" type="password" required autoComplete="new-password" className={inputClass}
                value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="••••••••" />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className={`w-full text-white font-black uppercase tracking-widest py-4 rounded-lg transition-all ${
                submitting ? 'bg-neutral-400 cursor-not-allowed' : 'bg-neutral-900 hover:bg-orange-600'
              }`}
            >
              {submitting ? 'Please wait...' : 'Save new password'}
            </button>
          </form>
        )}

        {phase === 'done' && (
          <div role="status" className="space-y-4">
            <p className="p-3 bg-emerald-50 text-emerald-700 text-xs font-bold uppercase tracking-wide border border-emerald-200">
              Your password was changed. You are signed in.
            </p>
            <button
              type="button"
              onClick={onDone}
              className="w-full bg-neutral-900 text-white font-black uppercase tracking-widest py-3 rounded-lg hover:bg-orange-600 transition-all"
            >
              Continue
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ResetPassword;
