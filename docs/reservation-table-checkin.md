# Reservation → Table Check-in + Multi-Guest Table Party — Design Plan

Status: **PLAN ONLY — not built.** Captured 2026-07-23. Nothing in this doc is
implemented yet; the current system is unchanged.

Goal: connect the reservation flow to the physical table, identify the reserved
party at check-in (even when the wrong member arrives first), and record every
diner at a table — not just one number.

---

## Where the system is today (the two gaps)

**1. Reservations and tables are disconnected.**
`ct_bookings` already has the right status enum
(`pending → confirmed → seated → completed / no_show / cancelled`), but a booking
has **no `table_id` and no check-in timestamp**. "Seated" is only a CRM label —
nothing ties a reservation to a physical table or to the order/bill. The floor
has no way to know "the 8pm Rao party is now on Table 5."

**2. A table holds only ONE guest identity.**
An `orders` row has a single `guest_name` / `guest_mobile`. When 2–3 people scan
the table QR, each creates a separate `pending_approval` order that the captain
merges into one bill — but only one number is ever kept. There is no "party" /
guest-list concept, so the other diners leave no record.

Relevant current schema:
- `ct_bookings(id, guest_id, booking_date, slot_time, party_size, occasion,
  section_pref, status, channel, advance_amount, notes, …)` — no table link.
- `orders(id, table_id, status, covers, guest_name, guest_mobile, origin, …)` —
  one open order per table; QR self-orders are `pending_approval` merged to one bill.
- `order_items(id, name, notes, …)` — no per-guest attribution.
- `restaurant_tables(id, table_number, zone, section, …)` — no reservation state.

---

## Part A — Reservation → the right table (handles "wrong person arrives first")

**Key idea: a reservation is for a PARTY, not a person.** Check-in links the
*booking* to the *table*, performed by staff — never dependent on which
individual walked in first. This dissolves the "late booker / friend arrives
first" problem.

### Schema changes
- `ct_bookings.table_id` (TEXT, nullable) + `ct_bookings.seated_at` (TEXT).
- `orders.booking_id` (TEXT, nullable) — ties the table's bill to the reservation.
- (Reuse the existing `seated` booking status; no new status needed.)

### Flow
1. **Host / Reservation board** — today's `confirmed` bookings, each with a
   **Seat** button. Host searches by **name OR any party member's mobile**,
   taps Seat → picks the table.
2. On Seat: `booking.status = 'seated'`, `booking.table_id = <table>`,
   `seated_at = now`; an order opens on that table with `booking_id` set and the
   booking guest's name/mobile pre-filled.
3. Because you seat the **booking** (not a person), it doesn't matter who
   arrives first. Whoever shows up, the host finds "Rao — party of 4, 8pm" and
   seats it; the late booker is already part of that booking.
4. On settle → booking auto-flips `seated → completed`. A booking never seated by
   close → `no_show` (already supported).
5. **Phase 2 (optional):** the same-day confirmation message carries a short
   **booking code / QR**; guest shows it → host scans → instant seat. The
   name/mobile lookup covers ~95% of cases, so this is a nice-to-have.

### Answers
- *"How will I know the same guest checked in?"* → the moment the host seats the
  booking, `booking ↔ table ↔ order` are linked and the CRM shows that guest as
  *seated on Table N at 8:04pm*, feeding their dining history.
- *"Reserved person comes late but another comes first."* → you seat the party,
  not the individual — any member arriving triggers the seat.

---

## Part B — Many diners at one table (share + capture everyone)

Introduce a **table party / guest list** so every diner is recorded, not just one.

### Schema changes
- `order_guests(id, order_id, mobile, name, is_primary, source, created_at)` —
  one **primary** (the registered/reserved member) + any number of additional diners.

### How the table "knows" the registered member
- Seated from a reservation → the booking's guest is the **primary**, attached automatically.
- Walk-in → the first person to give a number (captain-captured, or first QR OTP)
  becomes primary.

### How additional scanners join and are saved
- Every QR scan on the table resolves to the same table session. When a 2nd person
  scans, the guest screen shows a **confirmation banner**:
  *"Joining [Ramesh]'s table? (••••1234)"* — **last-4 digits are the human
  recognition cue, not the key**; the real link is the table's active session.
- They confirm, optionally enter their own name + number, and order. Their number
  is appended to `order_guests` (never overwriting the primary).
- **Payoff:** the CRM auto-save (already shipped — `src/lib/ct/guest-autosave.ts`)
  fires per number, so every diner's number becomes a CRM guest **and** gets a
  dining visit recorded. That is the "record that the guest came."

### Mandatory vs optional
Governed by the existing settings toggle: optional → extra diners may skip;
mandatory → each scanner enters a number (with the country picker) before ordering.

---

## Build order (when green-lit)
1. **Part A — Reservation → table seating.** Self-contained, biggest operational
   win: `table_id`/`seated_at`/`booking_id`, a host "Seat" board (search by
   name/mobile), order tied to booking, auto `seated → completed`.
2. **Part B — Table party / multi-guest capture.** `order_guests`, the QR
   "join this table" confirm (last-4 recognition), per-guest CRM visits.

## Already in place that makes Part B cheap
The CRM auto-save means any captured number — primary or additional diner —
already becomes a CRM guest with a recorded visit, so "record everyone who came"
is half-done the moment multi-guest capture lands.
