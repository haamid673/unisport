# Demo script

A repeatable walk through the whole product with three roles. About 20
minutes (10 of them waiting for a hold to lapse, which you can skip, see
step 7). It uses a **local** Supabase stack and test accounts; nothing here
touches a hosted project, and payment stays off.

## 0. Setup (once)

```bash
npm ci
supabase start
cp .env.example .env.local      # set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY from `supabase status`
npm run dev                     # http://localhost:3000
```

Use three browser profiles (or one normal and two private windows) so you can
stay signed in as all roles at once.

1. **Register** four accounts in the app (Register tab): `admin@demo.test`,
   `owner@demo.test`, `ada@demo.test`, `ben@demo.test` (any password of at
   least 6 characters; local email confirmation is off). Everyone starts as a
   player.
2. Make the first administrator (local only):

   ```bash
   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
        -v admin_email=admin@demo.test \
        -f supabase/dev/bootstrap_first_admin.sql
   ```
3. Sign in as the **admin** → *Governance Center* → *Accounts and roles*:
   enter `owner@demo.test`, *Find account*, choose `owner`, *Change role*,
   confirm. (This is also the proof that there is no way to browse accounts:
   only an exact email finds one.)

## 1. Owner creates a venue

Sign in as **owner** (Owner Portal): create a venue (name, sport, address,
city `Trivandrum`, price), set weekly operating hours, add a few one-hour
slots (e.g. 18:00 and 19:00) and activate them. The venue shows *Pending
approval*: players cannot see it yet.

## 2. Admin approves

As **admin**, *Awaiting approval* lists the venue. Approve (confirm). The
owner's bell shows *Your venue is live*. This is the "no SQL anywhere" flow.

## 3. Player reserves and cancels

As **ada** (set her city to Trivandrum from the selector): *Find Facilities* →
the venue → pick a date with open hours → *Book*. The slot becomes *Your
reservation*; *Your Schedule* shows **Held until HH:MM** and *Cancel
reservation*. Cancel (confirm): the slot is free again and her history on the
Profile shows **Cancelled**. Reserve it again for the next steps.

## 4. A second player, the waitlist and an offer

As **ben**, open the same slot: it is *Full* with *Join waitlist*. Join. Ben
sees "You're on the waitlist".

## 5. A hold that lapses → an offer

Ada's hold lasts 10 minutes. When it runs out (or she cancels), the next
minute's sweeper offers the slot to Ben: his slot row shows **Accept offer**
with the deadline and his bell shows *A slot opened up for you*. Accepting
gives Ben a normal 10-minute hold. Without payments, holds simply expire.

*Skip the wait (local database only, never anywhere else):*

```sql
-- psql ... as postgres: make Ada's hold lapse now
update public.bookings set expires_at = now() - interval '1 minute'
where status = 'pending_payment' and user_id =
  (select id from auth.users where email = 'ada@demo.test');
```

Within a minute Ada's bell says *Your reservation expired* and Ben gets the
offer. About 10 minutes later he also gets *Your offer is about to lapse* if
he leaves it.

## 6. Communities and events

As **ada**: *Community* → *Start a community* ("Kowdiar Smashers",
Badminton, Trivandrum). It shows **Awaiting approval** and Ben cannot see it.
As **admin**: *Community requests* → approve. Ada's bell: *Your community was
approved*. As **ben**: Community → open it → *Join Community*. As **ada**:
*Create an event* (title, date, the venue, **2 places**) → it is awaiting
approval → admin approves → Ben joins (2 / 2); a third person sees **Full**.
Both can leave; the Profile's *My Community Events* matches.

## 7. Roles and limits worth showing

- Reject something as admin: the creator sees *Rejected*, others never saw it.
- An admin cannot change their own role, and the last administrator can never
  be removed.
- Try booking a 4th slot as one player: the per-user cap (3 live holds)
  refuses it.
- Refresh on `/profile` or `/community/<id>`: every screen has a URL that
  survives reload and back/forward. `/admin` as a player redirects home.

## 8. What not to claim

Say plainly: payments are switched off and the payment code has only run
against a local simulator; there is no email; times are UTC; the app is not
deployed. See *Known limitations* in the [README](../README.md).

## Optional: the checkout UI against the simulator

`e2e/checkout-browser/README.md` runs the real checkout screens against a
labelled mock Checkout and the local payment simulator on a disposable
database. It never contacts Razorpay.
