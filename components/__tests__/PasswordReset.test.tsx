import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const auth = read('../Auth.tsx');
const reset = read('../ResetPassword.tsx');
const app = read('../../App.tsx');

describe('password reset screens', () => {
  it('the sign-in form offers "Forgot password?" and an email-only reset form', () => {
    expect(auth).toContain('Forgot password?');
    expect(auth).toContain('Send reset link');
    expect(auth).toMatch(/authService\.requestPasswordReset\(email\)/);
    expect(auth).toMatch(/\{!forgot && \(\s*<div>\s*<label htmlFor="auth-password"/);
  });

  it('answers the same whether or not an account exists', () => {
    expect(auth).toContain('If an account exists for that email');
    expect(auth).not.toMatch(/no account|not registered|unknown email/i);
  });

  it('the reset screen needs the recovery session, enforces length and match, and reports the outcome', () => {
    expect(reset).toMatch(/authService\.hasRecoverySession\(\)/);
    expect(reset).toContain('This reset link has expired or was already used');
    expect(reset).toMatch(/password\.length < MIN_PASSWORD_LENGTH/);
    expect(reset).toContain('Passwords do not match.');
    expect(reset).toMatch(/await authService\.updatePassword\(password\)/);
    expect(reset).toContain('Your password was changed');
  });

  it('App shows the reset screen on /reset-password signed in or out, and follows the recovery event', () => {
    expect(app).toMatch(/pathname\.replace\(\/\\\/\+\$\/, ''\) === ROUTES\.resetPassword/);
    expect(app).toMatch(/navigate\(ROUTES\.resetPassword, \{ replace: true \}\)/);
    // the reset check comes before the signed-out sign-in screen
    expect(app.indexOf('ROUTES.resetPassword) {')).toBeLessThan(app.indexOf('if (!user) return <Auth'));
  });
});
