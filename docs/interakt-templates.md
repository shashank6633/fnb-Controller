# Interakt / Meta WhatsApp templates — submission sheet

Seven templates. Six reach guests; the seventh is the daily calls report to the
owner. Paste each **Body** verbatim into Interakt → *Templates* → *Create*, using
the Category and Language shown. Meta reviews them, usually within a few hours.

## Before you start

**Category is not cosmetic.** Meta reclassifies or rejects a template that is
filed wrongly, and the price differs by ~7×:

| Category | What it may say | India rate (Jan 2026) |
|---|---|---|
| UTILITY | Follows up on something the guest did — they rang us, they sent an enquiry. **No offers, no discounts, no "special", no "book now and save".** | ~₹0.115 |
| MARKETING | Anything promotional. Needs prior opt-in under DPDPA. | ₹0.8631 |

Both attract 18% GST, plus Interakt's own platform fee.

**Variables are positional.** Interakt shows `{{1}}`, `{{2}}` … in that order.
The app stores friendly names and maps them via `param_order`, so the order below
must be preserved exactly.

**Two Meta formatting rules that cause most rejections:** a body may not start or
end with a variable, and two variables may not sit next to each other. Every
template below already complies.

---

## 1. `ct_missed_call_ack` — UTILITY

Sent the moment a call is missed. Deliberately contains no offer — one
promotional word turns this into MARKETING, and it then cannot be used as a
service reply.

**Body**
```
Sorry we missed your call to {{1}}. Reply to this message and our team will help you book a table.
```
| Var | Meaning | Sample for submission |
|---|---|---|
| {{1}} | Venue name | AKAN |

---

## 2. `ct_missed_call_ack_after_hours` — UTILITY

Same, for a call that lands after closing. Tells the guest when you open, which
is the useful thing to say at 2am.

**Body**
```
Sorry we missed your call to {{1}}. We open at {{2}}. Reply to this message and we will help you book a table.
```
| Var | Meaning | Sample |
|---|---|---|
| {{1}} | Venue name | AKAN |
| {{2}} | Opening time | 12:00 PM |

---

## 3. `ct_enquiry_followup` — UTILITY

Follow-up to an enquiry **the guest started**, which keeps it transactional — as
long as it offers help rather than a deal.

**Body**
```
Hi {{1}}, thank you for your enquiry about an event at {{2}}. Reply to this message and our events team will share dates and options.
```
| Var | Meaning | Sample |
|---|---|---|
| {{1}} | Guest name | Rahul |
| {{2}} | Venue name | AKAN |

---

## 4. `ct_winback` — MARKETING

The win-back. Requires opt-in.

**Body**
```
Hi {{1}}, it has been a while since your last visit to {{2}}. We would love to welcome you back — reply to this message to book a table.
```
| Var | Meaning | Sample |
|---|---|---|
| {{1}} | Guest name | Rahul |
| {{2}} | Venue name | AKAN |

---

## 5. `ct_slow_night` — MARKETING

Filling a quiet night.

**Body**
```
Hi {{1}}, we have tables free at {{2}} on {{3}}. Reply to this message to reserve yours.
```
| Var | Meaning | Sample |
|---|---|---|
| {{1}} | Guest name | Rahul |
| {{2}} | Venue name | AKAN |
| {{3}} | Day | Wednesday |

---

## 6. `ct_birthday` — MARKETING

Typically the highest-converting message a venue sends, and the one most worth
getting approved.

**Body**
```
Happy birthday {{1}}! Everyone at {{2}} wishes you a wonderful year. Reply to this message to plan your celebration with us.
```
| Var | Meaning | Sample |
|---|---|---|
| {{1}} | Guest name | Rahul |
| {{2}} | Venue name | AKAN |

---

## 7. `calls_daily` — UTILITY · **the admin report**

Yesterday's reservations line, to the owner and managers. Internal: it goes to
your own staff about your own operation, so it is utility, not marketing.

Reports **yesterday**, not today — the job runs in the morning, and a
part-finished day would send a "40% missed" panic at 9am that fixes itself by
lunch. Figures come from `dashboardStats()`, the same source the CRM dashboard
renders, so the message and the screen cannot disagree.

**Body**
```
📞 AKAN Calls — {{1}}

Calls {{2}} · Answered {{3}} ({{4}}%) · Missed {{5}}
Bookings from calls: {{6}}
Missed still open: {{7}}
Busiest hour: {{8}}

{{9}}
```
| Var | Meaning | Sample |
|---|---|---|
| {{1}} | Date reported | 2026-07-30 |
| {{2}} | Total calls | 48 |
| {{3}} | Answered | 41 |
| {{4}} | Answered % | 85 |
| {{5}} | Missed | 7 |
| {{6}} | Bookings from calls | 12 |
| {{7}} | Missed still open | 2 |
| {{8}} | Busiest hour | 20:00 (11 calls) |
| {{9}} | Top agents | • Priya: 18 handled, 6 booking(s) |

**If Meta rejects this one**, nine variables is the likely reason. Collapse the
body to two — `{{1}}` date and `{{2}}` a single pre-formatted summary block —
and build that block in `runWaDailyNotifications()`. Only `param_order` has to
change.

---

## Wiring an approved template up

The app already has all seven as drafts. Once Interakt shows one as **Approved**:

1. **Settings → Integrations → WhatsApp → Templates**
2. Open the row with the matching name.
3. Put the approved name from Interakt into **Provider template name** — it must
   match character for character.
4. Set **Provider language** to the code Interakt shows (usually `en`, sometimes
   `en_US` — copy theirs exactly; a mismatch fails at send with a template-not-
   found error that reads like a name problem).
5. Turn **Send as template** on.

Nothing sends until the feature's own switch is on as well:

| Template | Switch |
|---|---|
| `ct_missed_call_ack`, `..._after_hours` | CRM Settings → missed-call WhatsApp (off / every miss / after-hours only) |
| `ct_winback`, `ct_slow_night`, `ct_birthday` | CRM Settings → win-back enabled, then send a campaign explicitly |
| `ct_enquiry_followup` | Used from the enquiry follow-up action |
| `calls_daily` | Settings → Integrations → WhatsApp → Notifications → **Daily calls analytics**, plus recipient numbers, under the master switch |

## What is still yours to do

- **Opt-in for the three MARKETING templates.** Meta requires it and DPDPA
  requires you to be able to show it. Record where each guest's consent came
  from before the first campaign.
- **Recipients for `calls_daily`** — add the owner/manager numbers on the
  Notifications tab. With none set, the job runs and sends to nobody.
- **The 24-hour window.** A phone call does *not* open it; only a message from
  the guest does. That is exactly why the missed-call acknowledgement has to go
  out as an approved template rather than free text.
