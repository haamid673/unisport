import { expect, test } from '@playwright/test';

/**
 * Browser smoke test of the main player journey, against a running site:
 * sign in, reserve a slot, cancel it, see it in the history, sign out.
 *
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... npm run smoke
 *   SMOKE_BASE_URL=https://<site> SMOKE_EMAIL=... SMOKE_PASSWORD=... npm run smoke
 *
 * It writes one cancelled booking per run for that account, so use a
 * throwaway player. Credentials come only from the environment. Payment is
 * not exercised here. Run it on a date with open hours: it picks the next
 * Saturday, which both the sample data and the demo seed have open.
 */

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

const FORBIDDEN_HOSTS = /cdn\.tailwindcss\.com|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|images\.unsplash\.com/;

const nextSaturday = (): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
};

test('a player can sign in, reserve, cancel and see the history', async ({ page }) => {
  test.skip(!email || !password, 'set SMOKE_EMAIL and SMOKE_PASSWORD');

  const consoleErrors: string[] = [];
  const forbidden: string[] = [];
  page.on('console', m => {
    // A failed request is reported below with its URL, which says more.
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) consoleErrors.push(m.text());
  });
  const failedResponses: string[] = [];
  page.on('response', r => {
    if (r.status() >= 400) failedResponses.push(`${r.status()} ${r.url().split('?')[0]}`);
  });
  page.on('request', r => {
    if (FORBIDDEN_HOSTS.test(r.url())) forbidden.push(r.url());
  });

  // Signed out: the public page and the sign-in screen.
  await page.goto('/about');
  await expect(page.getByRole('heading', { name: 'About this demo' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to UniSport' }).click();

  await page.getByPlaceholder('PLAYER@EXAMPLE.COM').fill(email as string);
  await page.locator('#auth-password').fill(password as string);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByRole('heading', { name: 'Your Schedule' })).toBeVisible();

  // Reserve the first free slot at the first venue.
  await page.getByText('Book Now', { exact: true }).first().click();
  await page.getByLabel('Booking date').fill(nextSaturday());
  await page.getByRole('button', { name: /^Reserve / }).first().click();
  await expect(page.getByText(/Held until/i).first()).toBeVisible();

  // Cancel it, with the confirm step.
  await page.getByRole('button', { name: 'Close facility details' }).click();
  await page.getByRole('button', { name: 'Cancel reservation' }).first().click();
  await page.getByRole('button', { name: 'Yes, cancel' }).click();
  await expect(page.getByText('Reservation cancelled. The slot is free again.')).toBeVisible();

  // A real URL survives a reload and shows the truthful state.
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'Booking History' })).toBeVisible();
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();

  // Wrong role: a player is sent home from the admin address.
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/$/);

  await page.getByRole('button', { name: 'Sign Out' }).first().click();
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();

  expect(forbidden, 'requests to a third-party CDN').toEqual([]);
  expect(failedResponses, 'failed requests').toEqual([]);
  expect(consoleErrors, 'browser console errors').toEqual([]);
});
