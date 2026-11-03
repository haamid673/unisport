// TEST-ONLY harness for the local browser checkout run (see README.md).
// Runs OUTSIDE the browser: it creates fixtures, drives the payment
// simulator's control API (its token never reaches the page) and reads
// persisted state. Node >= 23 (type stripping):
//
//   node --env-file=<file outside the repo> e2e/checkout-browser/harness.ts <command> …
//
// Env: BROWSER_E2E_SUPABASE_URL (must be http://127.0.0.1:59401),
//      BROWSER_E2E_SERVICE_KEY, BROWSER_E2E_CONTROL_TOKEN,
//      BROWSER_E2E_STATE_FILE (fixture ids), BROWSER_E2E_SECRETS_FILE
//      (generated test-user passwords; mode 600; never printed).
//
// Commands:
//   setup <customer> <booking>...      a test user and one pending booking per label
//   state <booking>                    persisted booking / attempts / payments / refunds + simulator orders
//   pay <booking> <captured|authorized|failed> [amount]   a simulator payment on the booking's order
//   capture <pay_id> | refund <pay_id> [amount]
//   fault <operation> <mode> [delay_ms] [times]
//   expire <booking>                   end the hold of THIS fixture booking only
//   ids                                the recorded fixture ids
//   cleanup-sql                        SQL that removes unconfirmed fixtures only (no trigger is disabled)

import fs from 'node:fs';

// Output goes to stdout directly (the app's guard tests forbid console.log in the source tree).
const out = (text: string) => process.stdout.write(`${text}\n`);

const DISPOSABLE_STACK = 'http://127.0.0.1:59401';
const SIM = 'http://127.0.0.1:59480';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const API = need('BROWSER_E2E_SUPABASE_URL');
if (API !== DISPOSABLE_STACK) throw new Error(`refusing: BROWSER_E2E_SUPABASE_URL must be exactly ${DISPOSABLE_STACK}`);
const SERVICE = need('BROWSER_E2E_SERVICE_KEY');
const STATE_FILE = need('BROWSER_E2E_STATE_FILE');

interface Fixture {
  run: string;
  customers: Record<string, { id: string; email: string }>;
  bookings: Record<string, { id: string; facility: string; slot: string; customer: string }>;
  payments: string[];
}

function load(): Fixture {
  if (!fs.existsSync(STATE_FILE)) return { run: crypto.randomUUID().replaceAll('-', '').slice(0, 8), customers: {}, bookings: {}, payments: [] };
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Fixture;
}
function save(f: Fixture) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(f, null, 2), { mode: 0o600 });
}

interface Reply {
  status: number;
  // deno-lint-ignore no-explicit-any
  body: any;
}

async function call(url: string, init: RequestInit): Promise<Reply> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch { /* keep text */ }
  return { status: res.status, body };
}

function rest(path: string, init: RequestInit = {}): Promise<Reply> {
  return call(`${API}${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers ?? {}) },
  });
}

function control(path: string, body: Record<string, unknown> = {}): Promise<Reply> {
  return call(`${SIM}${path}`, {
    method: 'POST',
    headers: { 'X-Simulator-Control-Token': need('BROWSER_E2E_CONTROL_TOKEN'), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function expect(r: Reply, status: number, label: string): Reply {
  if (r.status !== status) throw new Error(`${label}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

function bookingOf(f: Fixture, label: string) {
  const b = f.bookings[label];
  if (!b) throw new Error(`unknown booking label ${label}`);
  return b;
}

async function openOrder(bookingId: string): Promise<string> {
  const a = (await rest(`/rest/v1/payment_attempts?booking_id=eq.${bookingId}&provider_order_id=not.is.null&select=provider_order_id`)).body;
  if (!Array.isArray(a) || a.length !== 1) throw new Error(`expected exactly one provider order for the booking, found ${a?.length}`);
  return a[0].provider_order_id;
}

async function setup(f: Fixture, customer: string, labels: string[]) {
  let c = f.customers[customer];
  if (!c) {
    const email = `browser-e2e-${f.run}-${customer}@unisport-payments.test`;
    const password = `${crypto.randomUUID()}Aa1!`;
    const created = expect(await rest('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true }) }), 200, 'user');
    c = { id: created.body.id, email };
    f.customers[customer] = c;
    save(f);
    const secretsFile = need('BROWSER_E2E_SECRETS_FILE');
    const secrets = fs.existsSync(secretsFile) ? JSON.parse(fs.readFileSync(secretsFile, 'utf8')) : {};
    secrets[customer] = { email, password };
    fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  }
  for (const label of labels) {
    if (f.bookings[label]) throw new Error(`booking label ${label} already exists`);
    const ids = { id: crypto.randomUUID(), facility: crypto.randomUUID(), slot: crypto.randomUUID(), customer };
    f.bookings[label] = ids;
    save(f);
    const n = Object.keys(f.bookings).length;
    expect(await rest('/rest/v1/facilities', {
      method: 'POST',
      body: JSON.stringify({ id: ids.facility, owner_id: c.id, name: `BROWSER ${f.run} ${label}`, sport: 'Badminton', address: '1 Browser Lane', city: 'Testville', status: 'active', base_price: 500 }),
    }), 201, 'facility');
    expect(await rest('/rest/v1/facility_slots', {
      method: 'POST',
      body: JSON.stringify({ id: ids.slot, facility_id: ids.facility, start_time: '06:00', end_time: '07:00', duration_min: 60, base_price: 500 }),
    }), 201, 'slot');
    const date = new Date(Date.now() + (20 + n) * 86400_000).toISOString().slice(0, 10);
    expect(await rest('/rest/v1/bookings', {
      method: 'POST',
      body: JSON.stringify({
        id: ids.id, user_id: c.id, facility_id: ids.facility, slot_id: ids.slot, booking_date: date,
        start_time: '06:00', end_time: '07:00', amount: 500, status: 'pending_payment',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    }), 201, 'booking');
  }
  out(JSON.stringify({ run: f.run, customer, email: c.email, bookings: labels.map((l) => ({ label: l, id: f.bookings[l].id, facility_name: `BROWSER ${f.run} ${l}` })) }, null, 2));
}

async function state(f: Fixture, label: string) {
  const b = bookingOf(f, label);
  const booking = (await rest(`/rest/v1/bookings?id=eq.${b.id}&select=status,payment_status,fulfilled_by_payment_id,confirmed_at,expires_at`)).body[0];
  const attempts = (await rest(`/rest/v1/payment_attempts?booking_id=eq.${b.id}&select=id,state,provider_order_id,amount_paise,currency,closed_reason&order=created_at`)).body;
  const payments = (await rest(`/rest/v1/payments?booking_id=eq.${b.id}&select=id,provider_payment_id,provider_order_id,provider_status,amount_paise,provider_amount_refunded_paise,settlement_decision,decision_recorded_at&order=first_seen_at`)).body;
  const refunds = payments.length === 0 ? [] : (await rest(`/rest/v1/refunds?payment_id=in.(${payments.map((p: { id: string }) => p.id).join(',')})&select=id,state`)).body;
  const simOrders: Record<string, string[]> = {};
  for (const a of attempts) {
    const r = await call(`${SIM}/v1/orders?receipt=${a.id}&count=100`, {
      headers: { Authorization: 'Basic ' + btoa('rzp_test_LOCALSIMULATORONLY:local-simulator-placeholder-not-a-secret') },
    });
    simOrders[a.id] = r.status === 200 ? r.body.items.map((o: { id: string }) => o.id) : [`<lookup HTTP ${r.status}>`];
  }
  const fulfiller = payments.find((p: { id: string }) => p.id === booking?.fulfilled_by_payment_id)?.provider_payment_id ?? null;
  out(JSON.stringify({ label, booking, fulfilled_by_provider_payment_id: fulfiller, attempts, simulator_orders_by_receipt: simOrders, payments, refunds }, null, 2));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const f = load();
  if (cmd === 'setup') return setup(f, args[0], args.slice(1));
  if (cmd === 'state') return state(f, args[0]);
  if (cmd === 'ids') return out(JSON.stringify(f, null, 2));
  if (cmd === 'pay') {
    const order = await openOrder(bookingOf(f, args[0]).id);
    const body: Record<string, unknown> = { outcome: args[1] };
    if (args[2]) body.amount = Number(args[2]);
    const r = expect(await control(`/__control/orders/${order}/payments`, body), 200, 'pay');
    f.payments.push(r.body.payment.id);
    save(f);
    return out(JSON.stringify({ order_id: order, payment_id: r.body.payment.id, status: r.body.payment.status, amount: r.body.payment.amount }));
  }
  if (cmd === 'capture' || cmd === 'refund') {
    const body: Record<string, unknown> = cmd === 'refund' && args[1] ? { amount: Number(args[1]) } : {};
    const r = expect(await control(`/__control/payments/${args[0]}/${cmd}`, body), 200, cmd);
    return out(JSON.stringify({ payment_id: r.body.payment.id, status: r.body.payment.status, amount_refunded: r.body.payment.amount_refunded }));
  }
  if (cmd === 'fault') {
    const body: Record<string, unknown> = { operation: args[0], mode: args[1] };
    if (args[2] && args[2] !== '-') body.delay_ms = Number(args[2]);
    if (args[3]) body.times = Number(args[3]);
    return out(JSON.stringify(expect(await control('/__control/faults', body), 200, 'fault').body));
  }
  if (cmd === 'expire') {
    const b = bookingOf(f, args[0]);
    const r = expect(await rest(`/rest/v1/bookings?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ expires_at: new Date(Date.now() - 1000).toISOString() }) }), 200, 'expire');
    if (r.body.length !== 1) throw new Error('expected exactly one fixture row');
    return out(JSON.stringify({ expired: args[0], rows: r.body.length }));
  }
  if (cmd === 'cleanup-sql') return out(cleanupSql(f));
  throw new Error(`unknown command ${cmd}`);
}

// Removes ONLY recorded fixtures whose booking was never fulfilled, with
// every guard and foreign key in force. A fulfilled booking cannot be
// removed without disabling bookings_guard_fulfilment, so it is kept
// (with its payments, attempts, slot, facility and user) and reported.
function cleanupSql(f: Fixture): string {
  const list = (xs: string[]) => (xs.length ? `ARRAY[${xs.map((x) => `'${x}'`).join(',')}]::uuid[]` : `ARRAY[]::uuid[]`);
  const bookings = Object.values(f.bookings);
  return `\\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  v_bookings uuid[] := ${list(bookings.map((b) => b.id))};
  v_fac uuid[] := ${list(bookings.map((b) => b.facility))};
  v_slots uuid[] := ${list(bookings.map((b) => b.slot))};
  v_users uuid[] := ${list(Object.values(f.customers).map((c) => c.id))};
  v_del uuid[];
  v_kept uuid[];
  n integer;
BEGIN
  IF (SELECT count(*) FROM public.bookings WHERE id = ANY(v_bookings) AND user_id = ANY(v_users)) <> cardinality(v_bookings) THEN
    RAISE EXCEPTION 'fixture set mismatch';
  END IF;
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_del FROM public.bookings WHERE id = ANY(v_bookings) AND fulfilled_by_payment_id IS NULL;
  SELECT coalesce(array_agg(id), ARRAY[]::uuid[]) INTO v_kept FROM public.bookings WHERE id = ANY(v_bookings) AND fulfilled_by_payment_id IS NOT NULL;
  RAISE NOTICE 'removing % unconfirmed fixture bookings; keeping % confirmed ones: %', cardinality(v_del), cardinality(v_kept), v_kept;

  DELETE FROM public.payment_events WHERE provider_payment_id IN (SELECT provider_payment_id FROM public.payments WHERE booking_id = ANY(v_del));
  GET DIAGNOSTICS n = ROW_COUNT; RAISE NOTICE 'payment_events: %', n;
  DELETE FROM public.refunds WHERE payment_id IN (SELECT id FROM public.payments WHERE booking_id = ANY(v_del));
  GET DIAGNOSTICS n = ROW_COUNT; RAISE NOTICE 'refunds: %', n;
  DELETE FROM public.payments WHERE booking_id = ANY(v_del);
  GET DIAGNOSTICS n = ROW_COUNT; RAISE NOTICE 'payments: %', n;
  DELETE FROM public.payment_attempts WHERE booking_id = ANY(v_del);
  GET DIAGNOSTICS n = ROW_COUNT; RAISE NOTICE 'payment_attempts: %', n;
  DELETE FROM public.waitlist_entries WHERE booking_id = ANY(v_del);
  DELETE FROM public.bookings WHERE id = ANY(v_del);
  GET DIAGNOSTICS n = ROW_COUNT; RAISE NOTICE 'bookings: %', n;
  DELETE FROM public.facility_slots s WHERE s.id = ANY(v_slots) AND NOT EXISTS (SELECT 1 FROM public.bookings b WHERE b.slot_id = s.id);
  GET DIAGNOSTICS n = ROW_COUNT; RAISE NOTICE 'facility_slots: %', n;
  DELETE FROM public.facilities fa WHERE fa.id = ANY(v_fac) AND NOT EXISTS (SELECT 1 FROM public.bookings b WHERE b.facility_id = fa.id);
  GET DIAGNOSTICS n = ROW_COUNT; RAISE NOTICE 'facilities: %', n;
  DELETE FROM auth.users u WHERE u.id = ANY(v_users)
    AND NOT EXISTS (SELECT 1 FROM public.bookings b WHERE b.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM public.facilities fa WHERE fa.owner_id = u.id);
  GET DIAGNOSTICS n = ROW_COUNT; RAISE NOTICE 'auth.users (cascades profiles): %', n;
END $$;
COMMIT;`;
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
