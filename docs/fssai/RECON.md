# FSSAI COMPLIANCE MODULE — THE BUILD CONTRACT (P0 output)

**Branch** `fssai-compliance` · worktree `/Users/shashankreddy/Desktop/Claude/fnb-fssai` · forked from main @ `4125237`, HEAD `dd03c58`
**Status** BUILD ONLY. The owner deploys. Never merge to main, never push, never run the deploy workflow.
**Authority** This document supersedes the six raw lane reports appended below it. Where a lane and this contract disagree, this contract is right — every disagreement was re-checked against the source or the live database and is recorded in §11.
**Every line number below is from THIS worktree**, not the live repo. The live `src/lib/db.ts` is 10,129 lines; ours is 9,561. Copying a live line number puts your code in the wrong place.

> **⚠️ CORRECTION, 2026-09-17 (P1 fix lane). BOTH LINE COUNTS ABOVE ARE NOW STALE — and one of them will raise a FALSE ALARM if you use it as a gate.**
> Measured today, read-only:
> ```
> $ wc -l /Users/shashankreddy/Desktop/Claude/fnb-controller/src/lib/db.ts   # live
>    10158
> $ grep -c lq_ /Users/shashankreddy/Desktop/Claude/fnb-controller/src/lib/db.ts
>    57
> ```
> The live file grew from 10,129 to **10,158** because the *liquor* lane added 29 more lines
> there on 2026-09-17 at 08:11. It is **not** FSSAI contamination — `grep -c fssai` on the live
> `db.ts` is **0**, and the arithmetic closes: live HEAD `db.ts` is 9,623 lines and
> `git diff --numstat` reports `535 0`, so 9,623 + 535 = 10,158. Do not read the 29-line delta as
> this module leaking into the live repo. The `lq_` count of **57** is unchanged and is still the
> right thing to check.
> This worktree's `db.ts` is no longer 9,561 either — P1 added the `fssai_` block and this fix
> lane rebuilt the boot path, so the section line numbers quoted throughout §3 have moved. Always
> re-measure with `grep -n` before editing; never trust a line number in this document.
>
> **AND A TRAP IN THE §0 DEPLOY GATE ITSELF.** The gate says every carve must show a **zero count**
> of `fssai` paths. A bare-word `grep -ri fssai src/` in the LIVE repo returns **11**, and always
> has — they are the **FSSAI licence number printed on a customer bill** (`src/lib/bill-pdf.ts`,
> `src/lib/offline-print/print.ts`, `src/app/settings/print-design/page.tsx`), committed at live
> HEAD since 2026-07-16 and legally required on an Indian restaurant bill. They have nothing to do
> with this module. Grep the module's **signature**, not the word — all of these are 0 in the live
> repo today:
> ```
> grep -r 'fssai_' src/        # the table prefix      -> 0
> grep -r "'/fssai" src/       # the twenty nav paths  -> 0
> ls -d src/app/fssai src/app/api/fssai src/lib/fssai.ts   # none exist
> ```

---

# ONE-PAGE SUMMARY — THE TEN THINGS THAT MATTER

1. **`page_access` gating is inert in production.** Measured: 9 users, `role_id` set on **0**, `page_access` NULL on **8** — and NULL means *all pages* (`page-catalog.ts:837`). `canAccessPage` fails open four ways (NULL map, bad JSON, empty array, prefix match). The only gates that hold are the tier flags (`adminOnly` / `mgmtOnly` / `hodOnly`, which run *before* the NULL grant) **and each API route's own check**. Never rely on the page catalog for security.

2. **The proxy guards PAGES, not APIs** (`proxy.ts:181` `if (!isApi)`), and its page check itself fails open twice more (`:228` catch-and-continue; `:202-210` an unresolved session leaves `user` undefined so the check is skipped). **Every `/api/fssai/*` handler, GET included, opens with `getCurrentUser()` plus its own predicate.**

3. **Three path bans, absolute.** No FSSAI path may contain the substring `print` — `proxy.ts:125` `pathname.includes('/print')` makes it **publicly unauthenticated**, and `AppShell.tsx:15` strips its chrome. No FSSAI URL may end `.png`/`.jpg`/`.json` (same file, `:141`). Add `'/api/fssai'` to `CSRF_REQUIRED_PREFIXES` (`proxy.ts:30`) in the same commit as the first write route, and use `api()`/`apiJson()` from `@/lib/api` on every client mutation or it 403s.

4. **Schema errors are swallowed.** `initializeSchema` ends at `db.ts:8190`; the last block's catch is `db.ts:8189`. 130 blocks in that file swallow their own exception, and a multi-statement exec **abandons every statement after the first throw** — a typo in one index name silently destroys the tables declared after it. Ship FSSAI DDL as a **per-statement array with the table named in the catch**, plus the **shape guard** (re-run each CREATE into `temp.zz_*`, diff `pragma_table_xinfo`, ALTER the missing columns). The pattern is written out in §3; the live repo's uncommitted `lq_*` block is the reference — **copy the pattern, never import the code**.

5. **Two files or it does not exist.** `src/lib/page-catalog.ts` gates the page; `src/components/Sidebar.tsx` keeps its own separate nav tree. Measured drift today: catalog 162 paths, sidebar 160; `/dine-in/order`, `/crm/guests`, `/settings/integrations/whatsapp` are gated-but-invisible and `/inventory/closing-history` is visible-but-ungrantable. **Edit both in the same commit. There is no `unbuilt` flag** — `grep -rn "unbuilt" src/` returns nothing and `PageEntry` has exactly `path`, `label`, `hodOnly?`, `mgmtOnly?`, `adminOnly?` (`page-catalog.ts:19-35`). Do not catalog a page that has no `page.tsx`; `/dine-in/order` proves it 404s.

6. **Do not duplicate masters.** Reference `raw_materials.id`, `vendors.id`, `goods_receipt_notes.id`, `production_batches.id`, `departments.id`, `users.email`, `store_locations.id`. §5 is the binding table, with the trap for each. Two facts that will bite: **`store_vendors` is not a table** (it is a JSON key computed in `api/stores/[id]/stock/route.ts:158`) and **`roles` has `base_role`, not `tier`** (`db.ts:2803`).

7. **There is no equipment master, so `fssai_equipment` is not a duplication.** `hr_assets` is a staff-issued-item register (uniform/ID card/device). Cold units exist today only as free text in `production_batches.storage_location` — live distinct values are `Cold Room 1`, `Cold Room 2`, `Cold Room 3`, `walkin chiller 1`. Seed `fssai_equipment.location_label` from those exact strings so existing batches join.

8. **Model the engine on the HRMS test/SOP tables, not on the Task checklist.** The Task checklist has no run entity — its key is `(template_id, item_id, date)`, so one run per template per day, overwritten on re-save, with no submitter, no signature, no target area, no shift, no version. HRMS gives questions-as-rows, a template `version` frozen onto each attempt, resume-not-duplicate, immutable-on-submit. **Copy the HRMS data model and the Task module's lifecycle, plumbing and screens.** Full argument in §8.

9. **The phone is the primary client, and there is no offline cache.** `ServiceWorkerRegister.tsx` is a service-worker *disabler* (stale-chunk incident) — any "FSSAI works offline" promise is false today and is an architecture escalation, not a UI choice. The app's shipped answer is the Captain heartbeat banner (`CaptainShell.tsx:~232`). Mobile rules are concrete in §6: 44px steppers, `text-base` inputs with `inputMode` + digit-stripping (never `type="number"` on the phone runner), `active:scale-95`, sticky-bottom submit with a count in the label.

10. **PDF: the degree sign works, the rupee sign does not.** Measured on this repo's pdfkit 0.15.1 — `°` encodes to WinAnsi byte `B0` and renders; `₹` encodes to the two bytes `20 B9`, i.e. it prints as **space + `¹`**. Use `inr()` from `report-pdf.ts`, which emits `Rs `. Cells **truncate with an ellipsis and never wrap** (`report-pdf.ts:143`), so corrective-action free text will be cut on an inspector's sheet — decide the workaround in P4 (§7). Also: `buildReportPdf` has never been served over HTTP; all four call sites attach it to WhatsApp.

---

# §0 · HOW TO USE THIS DOCUMENT

* §1-§4 are **mechanical**: follow them literally and the result is indistinguishable from an existing page.
* §5 is the **anti-duplication contract** (owner §21). A new item/vendor/employee master is an automatic CRITICAL.
* §6 is the brief for the phone runner, §7 for reports, §8 is the settled engine decision with its counter-argument.
* §9 is for the owner — do not guess these. §10 is what will go wrong.
* §11 records where the six lanes contradicted each other and which was wrong.
* The appendix holds the six raw lane reports verbatim. Treat them as evidence, not as instructions.

**House conventions that apply everywhere:** IDs are `crypto.randomUUID()` TEXT primary keys (190 of 204 tables). `created_by` / `recorded_by` / `actor_email` hold an **email string**, denormalised on purpose so the record survives a renamed or deleted user. JSON lives in a plain TEXT column suffixed `_json`. Dates are `YYYY-MM-DD` strings in IST; timestamps are `TEXT NOT NULL DEFAULT (datetime('now'))`. better-sqlite3 is **synchronous — never `await` a `db.prepare(...).run()`**.

---

# §1 · HOW TO BUILD A PAGE HERE

## 1.1 The shell

`AppShell.tsx` already supplies the sidebar, the mobile top bar and the outer padding (`px-3 sm:px-5 lg:px-8 pt-3 sm:pt-5 lg:pt-8`). Your page renders *inside* that and still paints its own background — 76 `page.tsx` files open with the same wrapper:

```tsx
<div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
  <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
```

The inner `max-w-7xl` line appears in 36 pages and is the list/report width. The checklist **runner** is narrower and uses `max-w-4xl mx-auto p-4 sm:p-6 space-y-4 pb-24` (`tasks/checklists/page.tsx:253`) — the `pb-24` clears the sticky save bar. Use `max-w-3xl`/`max-w-4xl` for anything a person fills in on a phone.

**Tailwind v4, CSS-first. There is no `tailwind.config`.** Tokens are declared in `@theme inline` at `src/app/globals.css:7-28`, but the codebase writes arbitrary hex literals everywhere and FSSAI must too or it will look foreign:

| Role | Value |
|---|---|
| Page background | `bg-[#FFF8F0]` |
| Body ink | `text-[#2D1B0E]` |
| Muted ink | `text-[#6B5744]`, fainter `text-[#8B7355]` |
| Brand / primary action | `bg-[#af4408]`, hover `hover:bg-[#8a3606]`, heading `text-[#af4408]` |
| Card border | `border-[#E8D5C4]`, input border `border-[#D4B896]` |
| Tint / secondary button | `bg-[#FFF1E3]` |
| Focus ring | `focus:ring-2 focus:ring-[#af4408]` |

**Light only. There is no dark mode** (`globals.css:5`, `layout.tsx:41`). Do not add `prefers-color-scheme` blocks.

**`globals.css` reshapes your page without being asked.** Know these before you debug a layout:

| Line | Rule |
|---|---|
| `:151` | Any element matching white + `#E8D5C4` + `rounded-*` gets an automatic hover lift |
| `:159-167` | First-level children of a grid inside `main` get an automatic fade-up |
| `:247` | `main button { min-height: 36px }` — the global touch floor |
| `:282` | `.flex.gap-2/3/4` is force-wrapped unless you add `flex-nowrap` |
| `:295` | `body:has(.fixed.inset-0[class*="bg-black/"])` locks scroll — a modal overlay **must** use a `bg-black/NN` class or the page scrolls behind it |
| `:305` | Hover lift is disabled on touch devices |
| `:124-127` | `.animate-fade-up` must keep `fill-mode: backwards`, never `both`, or fixed-position descendants offset |

## 1.2 The components to reuse — by name and path

| Need | Use | Path |
|---|---|---|
| On/off switch | `Toggle` — `{checked, onChange, disabled?, size?: 'sm'\|'md', label?, title?, id?, className?}` | `src/components/Toggle.tsx` |
| Pick an **item from the Item Master** | `MaterialTypeahead` — `{materials, value, onPick(id), excludeIds?, excludeMode?, placeholder?, compact?, showStock?, purchaseBasis?}` | `src/components/MaterialTypeahead.tsx` |
| Any other dropdown, incl. inside a modal | `Combobox` — `{options: ComboOption[], value, onChange(v, opt), placeholder?, allowCustom?, className?}` | `src/components/Combobox.tsx` |
| Pick a person | `UserPicker` (single or `multiple`), backed by `useTaskUsers()` → `/api/tasks/users` | `src/app/tasks/_components/UserPicker.tsx` |
| Photo evidence | `ImageUpload` + `ImageThumb` | `src/app/tasks/_components/ImageUpload.tsx` |
| Quantity display in purchase units | `Qty` + `dualQty`/`displayQty` | `src/components/Qty.tsx`, `src/lib/pack-units.ts` |
| A count field where blank ≠ 0 | `CountState` | `src/components/CountState.tsx` |
| Horizontally scrolling tab strip | `TabScroller` | `src/components/TabScroller.tsx` |
| Collapsible filter toolbar | `CollapsibleToolbar` | `src/components/ct/CollapsibleToolbar.tsx` |
| Push opt-in | `PushEnable` | `src/components/PushEnable.tsx` |

**What does NOT exist — do not import it, do not invent a shared one:** there is no shared `Table`, `Card`, `Modal`, `Tabs`, `EmptyState`, `DatePicker`, `Toast` or `VendorSelect`. All are open-coded per page. Date input is the native `<input type="date">` (166 uses, zero picker packages). `NotificationBell.tsx` exists but is mounted nowhere — dead code.

**Icons:** `lucide-react ^1.7.0`, imported by name. Nav rows size by depth: `size={collapsed || indent ? 16 : 18}` (`Sidebar.tsx:597`). Icons are deliberately reused across rows. `Thermometer` is not yet imported anywhere — it is free for the temperature module.

**The portal rule.** Any dropdown that opens inside a modal, a scroll pane or an `overflow-x-auto` table must portal to `<body>`. `Combobox.tsx:42-61, 98-126` is the canonical recipe: measure the anchor, `createPortal` with `position: fixed` and `z-[100]`, re-measure on capture-phase `scroll` + `resize`, and use `onMouseDown` + `preventDefault` so the click beats the input's blur. 26 call sites already do this.

## 1.3 The page skeleton — copy this

```tsx
'use client';
import { useEffect, useState } from 'react';
import { apiJson } from '@/lib/api';
import { ClipboardCheck, Loader2, RefreshCw, Plus } from 'lucide-react';

type Row = { id: string; name: string; status: string; created_at: string };

export default function FssaiSomethingPage() {
  const [rows, setRows]       = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [err, setErr]     = useState('');
  const [toast, setToast] = useState('');

  async function load() {
    setLoading(true); setErr('');
    try {
      const j = await apiJson<{ rows: Row[] }>('/api/fssai/something');
      setRows(j.rows || []);
    } catch (e: any) {
      if (String(e.message).includes('403')) setForbidden(true);
      else setErr(e?.message || 'Failed to load');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  // Permission-refused panel — the house pattern (reports/sales/page.tsx:120-130)
  if (forbidden) {
    return (
      <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
            🔒 This page is restricted to management. Ask an administrator for access.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F0] text-[#2D1B0E]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {/* Header — icon tile + title + subtitle + right-aligned actions */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#af4408] text-white flex items-center justify-center shrink-0">
            <ClipboardCheck size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl sm:text-3xl font-bold text-[#af4408]">Food Safety Checks</h1>
            <p className="text-xs text-[#8B7355]">Run today&apos;s checks, record evidence, raise corrective actions.</p>
          </div>
          <button onClick={load} disabled={loading}
            className="inline-flex items-center gap-1.5 text-sm border border-[#E8D5C4] bg-white rounded-lg px-3 py-2 hover:bg-[#FFF1E3] disabled:opacity-50">
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
          </button>
          <button className="inline-flex items-center gap-1.5 text-sm font-semibold bg-[#af4408] hover:bg-[#8a3606] text-white rounded-lg px-3 py-2">
            <Plus size={15} /> New
          </button>
        </div>

        {err && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{err}</div>}

        {/* Card + table. overflow-x-auto is REQUIRED — the body must never scroll sideways. */}
        <div className="bg-white rounded-xl border border-[#E8D5C4] overflow-hidden">
          {loading ? (
            <div className="p-10 text-center text-sm text-[#8B7355]">
              <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm font-semibold text-[#2D1B0E]">Nothing recorded yet</p>
              <p className="text-xs text-[#8B7355] mt-1">Checks you run today will appear here.</p>
            </div>
          ) : (
            <>
              {/* Phone: cards. md: the table. This is the house switch point. */}
              <div className="md:hidden divide-y divide-[#E8D5C4]">
                {rows.map(r => (
                  <div key={r.id} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-semibold text-sm min-w-0 truncate">{r.name}</p>
                      <StatusBadge status={r.status} />
                    </div>
                    <p className="text-xs text-[#8B7355] mt-1">{r.created_at}</p>
                  </div>
                ))}
              </div>
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[#FFF1E3] text-[#6B5744]">
                    <tr>
                      <th className="text-left font-semibold px-3 py-2">Check</th>
                      <th className="text-left font-semibold px-3 py-2">Status</th>
                      <th className="text-right font-semibold px-3 py-2">Recorded</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E8D5C4]">
                    {rows.map(r => (
                      <tr key={r.id} className="hover:bg-[#FFF8F0]">
                        <td className="px-3 py-2">{r.name}</td>
                        <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                        <td className="px-3 py-2 text-right text-[#6B5744]">{r.created_at}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[120] bg-[#2D1B0E] text-white text-sm px-4 py-2.5 rounded-lg shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
```

## 1.4 The form / modal pattern

Modals are open-coded. The house "safe modal" shell is `src/app/vendors/page.tsx:331-373` — a `fixed inset-0 bg-black/40` overlay (the `bg-black/` class is what triggers the scroll lock at `globals.css:295`), a flex-column panel with a `max-h` and an internal scroll region so the footer buttons never leave the screen:

```tsx
<div className="fixed inset-0 z-[110] bg-black/40 flex items-center justify-center p-4"
     onClick={() => setOpen(false)}>
  <div onClick={e => e.stopPropagation()}
       className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-2xl shadow-xl flex flex-col overflow-hidden max-h-[90vh]">
    <div className="px-4 py-3 border-b border-[#E8D5C4] flex items-center justify-between shrink-0">
      <h2 className="font-bold">Title</h2>
      <button onClick={() => setOpen(false)} className="w-9 h-9 rounded-lg hover:bg-[#FFF1E3]">✕</button>
    </div>
    <div className="p-4 space-y-4 overflow-y-auto">{/* fields */}</div>
    <div className="px-4 py-3 border-t border-[#E8D5C4] flex justify-end gap-2 shrink-0">
      <button className="text-sm px-3 py-2 rounded-lg border border-[#E8D5C4]">Cancel</button>
      <button className="text-sm px-3 py-2 rounded-lg bg-[#af4408] text-white font-semibold">Save</button>
    </div>
  </div>
</div>
```

On a phone the same content becomes a bottom sheet: `fixed inset-0 flex items-end` with a `rounded-t-3xl max-h-[85vh] overflow-y-auto` panel.

Field label pattern: a `<label className="block">` wrapping `<span className="text-xs text-[#6B5744]">Label <span className="text-[#af4408]">*</span></span>` and an input classed `mt-1 w-full bg-white border border-[#D4B896] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#af4408]`.

**Confirmations.** The house default is native `window.confirm` (94 uses). For anything irreversible, escalate to a written explainer modal that states what will change and requires a typed reason — `variance-approvals/page.tsx:2134-2180` is the reference. **Every FSSAI verification, rejection and corrective-action close is in the second category.**

**Toasts** are per-page `useState`, no library (27 pages). Two shipped variants: `variance-approvals/page.tsx:2391` and `cashier/page.tsx:557`.

## 1.5 Status colours — a metadata array, not CSS classes

The house pattern is a lib-module array of `{ key, label, color }` where `color` is a ready-made Tailwind triple, plus a `statusMeta()` lookup with a fallback. See `src/lib/tasks.ts:44-66` and `:64`, and `src/lib/hr.ts:97-106`. **FSSAI declares its own in `src/lib/fssai.ts`** (a pure module, no DB import, safe to import from client components — model it on `src/lib/tasks.ts`):

| State | `color` |
|---|---|
| Approved / verified | `bg-green-100 text-green-700 border-green-200` |
| Completed (awaiting verification) | `bg-teal-100 text-teal-700 border-teal-200` |
| Awaiting verification | `bg-purple-100 text-purple-700 border-purple-200` |
| In progress | `bg-amber-100 text-amber-800 border-amber-200` |
| Failed | `bg-red-100 text-red-700 border-red-200` |
| Reopened | `bg-orange-100 text-orange-700 border-orange-200` |
| Not applicable | `bg-gray-100 text-gray-600 border-gray-200` |

Badge markup: a `<span>` classed `inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border` plus `statusMeta(s).color`, rendering `statusMeta(s).label`.

**Overdue is not a badge.** The house treatment is red text on the due-date cell (`tasks/page.tsx:396`, `tasks/board/page.tsx:287`). A missed FSSAI check follows that, not a new colour.

**Pass / Fail / NA buttons are already settled** — copy the class strings verbatim from `tasks/checklists/page.tsx:247-251`:
`pass` on `bg-green-600 text-white border-green-600` / off `bg-white text-green-700 border-green-200 hover:border-green-400`; `fail` on `bg-red-600 text-white border-red-600` / off `bg-white text-red-700 border-red-200 hover:border-red-400`; `na` on `bg-gray-500 text-white border-gray-500` / off `bg-white text-gray-600 border-gray-200 hover:border-gray-400`.

## 1.6 Accessibility — the honest state

`role="switch"`, `aria-label`, `aria-expanded` and `sr-only` are used in places. There is **no focus trap, no `role="dialog"`, no `aria-live` region and no skip link anywhere in the app.** FSSAI should add `role="dialog"` + `aria-modal` + an Escape handler to its own modals (cheap, invisible, no redesign) but must not embark on an app-wide accessibility programme under a no-redesign rule.

---

# §2 · HOW TO BUILD AN API ROUTE HERE

## 2.1 The gate

**The proxy does not protect your route.** `proxy.ts:181` runs the page check only `if (!isApi)`. For API calls it checks the session cookie's *presence* (`:168`), and validates the token against the `sessions` table only for state-changing methods (`:235`) — the comment there says outright that "sensitive GETs authenticate in-handler".

So every route starts:

```ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, isManagement, getCurrentOutletId } from '@/lib/auth';
import { canRunFssaiCheck, canVerifyFssai } from '@/lib/fssai';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  // …and the route's OWN predicate, e.g.:
  // if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });
  try {
    const url = new URL(request.url);
    const db  = getDb();
    /* … */
    return Response.json({ rows, generated_at: new Date().toISOString() });
  } catch (e: any) {
    console.error('GET /api/fssai/checks failed:', e);
    return Response.json({ error: e?.message || 'Failed to load checks' }, { status: 500 });
  }
}
```

**The predicates available today**, and what they actually mean:

| Predicate | Where | Means |
|---|---|---|
| `getCurrentUser()` | `auth.ts:81` | resolves the effective tier + page set, reading them from the assigned role when `role_id` is set — **including a deactivated role**, deliberately (`auth.ts:104-107`) |
| `isManagement(u)` | `auth.ts:192` | `admin \|\| manager \|\| is_head_chef` |
| `requireRole('admin')` | `auth.ts:239` | the only enforcing tier — **`requireRole('manager')` authenticates and authorises nothing** (`:242` tests `'admin'` only). Never use it as a manager gate. |
| `canManageTasks` / `canApproveTasks` | `tasks.ts:192` / `:198` | identical sets: `admin \|\| manager \|\| is_head_chef \|\| is_store_manager` |
| `canSeeAllDeptStock` / `allowedDeptSetExpanded` | dept scoping | **an empty set means "sees nothing", not "no filter"** |

**FSSAI must not inherit `canApproveTasks === canManageTasks`.** That equality lets a head chef verify his own kitchen's checklist, which is the exact failure a food-safety record exists to prevent. Declare `canVerifyFssai` in `src/lib/fssai.ts` and make it **strictly narrower** than the runner gate. See §9 Q3.

## 2.2 CSRF

`CSRF_REQUIRED_PREFIXES` (`proxy.ts:30-96`) is an **opt-in** list matched with `startsWith` (`:250`). `/api/fssai` is not in it. Two changes land together or the module is broken in one direction or the other:

1. add `'/api/fssai',` to that array, and
2. make every client mutation go through `api()` / `apiJson()` from `@/lib/api`, which reads the `fnb_csrf` cookie and sets `X-CSRF-Token` on POST/PUT/PATCH/DELETE (`src/lib/api.ts:38-42`). A bare `fetch()` POST will 403.

Bare `fetch()` is fine for GETs — `isStateChanging()` never checks them.

## 2.3 Response shape and errors

* Success: `Response.json({ <named collections> })` — e.g. `{ templates, template, records, date }`, `{ users, generated_at }`. Never return a bare array.
* Failure: `Response.json({ error: '<human sentence>' }, { status })`. `apiJson` surfaces `.error` as the thrown message, so the string reaches the user's screen — write it for a restaurant manager, not a developer.
* Codes in use: 401 `'Sign in required'`, 403 for permission and CSRF, 400 for a missing or invalid field, 404 `'<Thing> not found'`, 409 for "already decided" / duplicate, 500 from the catch.
* Always `console.error('<METHOD> /api/... failed:', e)` before returning 500.
* Validate before opening the transaction; return the 400 early. `api/tasks/checklists/route.ts:105-130` is the model.

## 2.4 Writes

* Wrap multi-table writes in `db.transaction(() => { … })()`. better-sqlite3 is synchronous — no `await` inside.
* **Side effects go after the commit.** Push notifications use the `firePush` helper (`api/tasks/checklists/route.ts:13-24`): `Promise.resolve().then(() => sendPushToUser(...))`, deferred to a microtask so it runs after the surrounding transaction commits and can never break the insert. The same helper is copy-pasted into four routes; FSSAI should import one copy from `src/lib/fssai.ts`.
* **Audit every state change** with `logAuditEvent(db, { event_type, entity_type, entity_id, actor_email, outlet_id, before, after, note })` (`db.ts:8285-8317`). It is best-effort and never throws. Use `entity_type: 'fssai_<table>'` — **do not create a second audit table.** Audit state changes, not every response; `audit_events` has no retention policy.
* Uniqueness is enforced by a **partial unique index**, not by application code. `uq_variance_appr_pending` (`db.ts:396`) is the house example: `CREATE UNIQUE INDEX … WHERE status = 'pending'`.

## 2.5 Settings keys

`GET /api/settings` returns every non-secret key to **every signed-in user**, and `PUT` has a floor of admin-**or-manager**. Register the FSSAI prefix in `OWNED_PREFIXES` (`src/app/api/settings/route.ts:208-215`) **before the first key exists** — the comment on the `hr_` entry names the trap: "the gate being decorative-until-registered is the trap".

```ts
{ re: /^fssai_/i, route: '/api/fssai/settings' },
```

Anything sensitive (a temperature standard an inspector relies on, an escalation recipient) belongs in an `fssai_` **table** behind a gated route, not in `settings`. Note also that `PUT /api/settings` does **not** audit and `settings` has no `updated_by`/`updated_at` — a standard changed there leaves no trace of who or when.

---

# §3 · HOW TO ADD A TABLE HERE

## 3.1 Where

`initializeSchema(db)` starts at `src/lib/db.ts:77` and its closing brace is **line 8190**. The last block inside it is the HRMS block, whose catch sits at **line 8189**:

```
8188          `);
8189        } catch (e) { console.error('hrms schema failed:', e); }
8190      }
```

**Append the FSSAI block immediately after line 8189, before the closing brace.** Nothing else in `db.ts` is edited; nothing existing moves.

## 3.2 The pattern — per-statement, named failures, then a shape guard

The house one-shot form (one `try` wrapping a single exec of 100 lines of DDL, with a `catch` that only logs) is used 130 times and is a trap: a multi-statement exec applies statements in order and **abandons everything after the first throw**, in silence. Proven on a fixture with this repo's better-sqlite3 — a typo in one index's column name destroyed the two tables declared after it.

FSSAI ships nine tables. Use the array form, then the shape guard:

```ts
  /* ── FSSAI COMPLIANCE ─────────────────────────────────────────────────────
   * Per-statement, so one bad table cannot take its neighbours with it, and
   * the catch names the table that failed. See the note in this file about the
   * one-shot form abandoning every statement after a throw. */
  const FSSAI_TABLE_DDL: string[] = [
    `CREATE TABLE IF NOT EXISTS fssai_templates ( … );`,
    `CREATE TABLE IF NOT EXISTS fssai_questions ( … );`,
    /* … one string per table … */
  ];
  for (const stmt of FSSAI_TABLE_DDL) {
    const named = /CREATE TABLE IF NOT EXISTS (fssai_[a-z_]+)/.exec(stmt);
    try {
      db.exec(stmt);
    } catch (e) {
      console.error('fssai schema failed for ' + (named ? named[1] : '?') + ':', e);
    }
  }
```

**Then the shape guard**, because `CREATE TABLE IF NOT EXISTS` answers "is there an object with this name", never "does it have the right columns". A table that already exists in the wrong shape survives in complete silence and throws at runtime three deploys later. This matters *most* for a phased build: the day P6 adds a column, dev is a fresh database and works, while testing and production already have the table and never get it.

The reference implementation is in the **live** repo at `src/lib/db.ts:8596-8666` (part of the uncommitted `lq_*` liquor work). **Copy the technique; do not import or branch that code.** The technique:

1. Re-run every CREATE into the TEMP schema with a `zz_` prefix — the CREATE text *is* the specification, so there is no second column list to keep in sync.
2. Read the intended columns off the temp copy with **`pragma_table_xinfo`, not `table_info`** — `table_info` omits generated columns, so a guard written on it re-ALTERs them on every boot.
3. ALTER any column the real table is missing. `dflt_value` comes back **without** its parentheses, so re-wrap it: `DEFAULT (datetime('now'))` is rejected unparenthesised.
4. Refuse to auto-add a generated column, or a `NOT NULL` column with no default (it would break every future INSERT) — report those by name instead.
5. Drop the temp copies. Add columns only, only to `fssai_` tables, only when missing. A correct database is a silent no-op.
6. **Shout when it fires.** `CHECK` constraints and foreign keys cannot be added by ALTER, so a table the guard repairs is only *partly* repaired.

Indexes and unique rules go in their **own** try/catch after the tables, so one swallowed error cannot hide the other half.

## 3.3 Naming and column conventions

* Every table is prefixed **`fssai_`**. Every index is `idx_fssai_*`; a partial unique rule is `uq_fssai_*`.
* `id TEXT PRIMARY KEY` filled with `crypto.randomUUID()` (or `generateId()` from `db.ts`).
* `created_at TEXT NOT NULL DEFAULT (datetime('now'))`; add `updated_at` only where rows are edited.
* Actor columns hold an **email**: `recorded_by`, `created_by`, `verified_by`, `reviewed_by`.
* A calendar day is `date TEXT NOT NULL` as `YYYY-MM-DD`. Reserve `txn_date` for ledger-style tables — only 3 tables use it, and `inventory_transactions` carries `date`, `txn_date` and `created_at` meaning three different things.
* Soft state: `is_active INTEGER NOT NULL DEFAULT 1` (42 tables). **Never hard-delete a compliance record** — follow the void-not-delete model of `goods_receipt_notes` (`db.ts:3141-3146`: `status='void'` plus `voided_at`/`voided_by`), the only complete implementation of it in the codebase.
* JSON goes in a plain TEXT column suffixed `_json`.
* **Foreign keys: declare them.** `store_*` and `lq_*` tables declare FKs; `task_*`, `hr_*` and `ct_*` declare none "by design". Compliance evidence must not be orphaned by a deleted vendor or material, so FSSAI follows the `store_*` style — `FOREIGN KEY (material_id) REFERENCES raw_materials(id)` — *except* where it would block a legitimate master edit, in which case store the id and the denormalised display text side by side.
* `outlet_id TEXT NOT NULL DEFAULT ''` on every record table. See §9 Q1 — there are 2 outlets live, and the house filter is `AND (outlet_id = ? OR outlet_id IS NULL)` with `getCurrentOutletId()`.

## 3.4 The best audit shape to copy

For anything that is proposed, then decided: `hr_attendance_corrections` (`db.ts:7670-7686`) — `original_json` (frozen) + `requested_json` + `reason` + `requested_by` + `status` + `reviewed_by`/`reviewed_at`/`review_reason` + `approved_json`, with a partial `UNIQUE … WHERE status='pending'`. It satisfies every clause of owner §19 in one shape and never rewrites the original.

## 3.5 HOW TO PROVE IT APPLIED

**There is no runtime migration verification in this app.** No `schema_version`, no boot assertion, no health endpoint. `scripts/check-boot-migrations.js` is a static lint of the text of `db.ts` — it cannot tell whether a table exists. `config_fingerprint_log` covers only users and roles. The only existing proof is the admin Database console at `/admin/database?view=catalog`.

**P1 must therefore add a boot assertion for `fssai_` — nothing like it exists.** Minimum bar:

```ts
  // Boot assertion — the ONLY thing that distinguishes a migration that ran
  // from one that was swallowed. Runs after the guard, logs once.
  try {
    const want = FSSAI_TABLE_DDL
      .map(s => /CREATE TABLE IF NOT EXISTS (fssai_[a-z_]+)/.exec(s)?.[1])
      .filter(Boolean) as string[];
    const have = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fssai_%'`)
         .all() as Array<{ name: string }>).map(r => r.name),
    );
    const missing = want.filter(t => !have.has(t));
    if (missing.length) console.error('[db] FSSAI SCHEMA INCOMPLETE — missing: ' + missing.join(', '));
    else console.log('[db] fssai schema OK (' + want.length + ' tables)');
  } catch (e) { console.error('fssai boot assertion failed:', e); }
```

Verification checklist for the P1 reviewer, in order:

1. `grep -n "fssai" src/lib/db.ts` shows the block between the HRMS catch and the closing brace of `initializeSchema`.
2. Boot the dev server against a **scratch** database (never the live file) and read the console for `fssai schema OK (n tables)`.
3. `sqlite3 <scratch.db> "SELECT name FROM sqlite_master WHERE name LIKE 'fssai_%' ORDER BY 1;"` — count tables **and** indexes.
4. `PRAGMA table_xinfo(<each table>)` and diff against the CREATE text.
5. Delete one column from a copy, reboot, and confirm the shape guard re-adds it and shouts.
6. Add an `'fssai'` prefix rule to `GROUP_RULES` in `src/lib/db-explorer.ts:163` (a one-line change) or every FSSAI table lands in the "Other" bucket of the admin console.

**Never test against `/Users/shashankreddy/Desktop/Claude/fnb-controller/fnb-controller.db`.** `DB_PATH` is `process.cwd()/fnb-controller.db`, so never start a server in the live repo. To take a snapshot: `sqlite3 "file:<live>?mode=ro" "VACUUM INTO '<dest>'"` — a plain `cp` loses the WAL, which currently holds 1.4 MB of changes the main file does not.

---

# §4 · HOW TO ADD A NAV ENTRY HERE

## 4.1 Both files. Always. Same commit.

`src/lib/page-catalog.ts` decides whether a page can be **granted and reached**. `src/components/Sidebar.tsx` keeps a completely separate `navTree` that decides whether it can be **seen**. Neither reads the other.

* **Catalog only** → the page is gated and grantable but invisible; a user with access cannot find it.
* **Sidebar only** → the page is visible to everyone but appears nowhere in the roles grid, so it can never be granted or revoked individually.

Measured right now in this worktree: **catalog 162 paths, sidebar 160.** Catalog-only: `/dine-in/order`, `/crm/guests`, `/settings/integrations/whatsapp`. Sidebar-only: `/inventory/closing-history`. Five in-file comments in `Sidebar.tsx` (`:207-215`, `:245-252`, `:406-412`, `:428-434`, `:450-455`) recount real incidents caused by this drift — one of them hid eight pages including `/variance-approvals` and read to the owner as a stock bug.

**The drift check, to be re-run at the end of every phase that adds a page:**

```bash
node -e '
const fs=require("fs");
const cat=fs.readFileSync("src/lib/page-catalog.ts","utf8");
const side=fs.readFileSync("src/components/Sidebar.tsx","utf8");
const cp=new Set([...cat.matchAll(/\{\s*path:\s*.([^\x27"]+)./g)].map(m=>m[1]));
const sp=new Set([...side.matchAll(/href:\s*"([^"]+)"/g)].map(m=>m[1]));
console.log("catalog-only:",[...cp].filter(p=>!sp.has(p)).join(", "));
console.log("sidebar-only:",[...sp].filter(p=>!cp.has(p)).join(", "));
'
```

## 4.2 The exact row shapes

**Catalog** (`page-catalog.ts:19-35` — these five fields are all that exist):

```ts
  {
    label: 'FSSAI Compliance',
    pages: [
      { path: '/fssai',             label: 'Compliance Dashboard' },
      { path: '/fssai/checks',      label: 'Run a Check' },
      { path: '/fssai/temperature', label: 'Temperature Logs' },
      { path: '/fssai/corrective',  label: 'Corrective Actions' },
      { path: '/fssai/verify',      label: 'Verification Queue',      mgmtOnly: true },
      { path: '/fssai/documents',   label: 'Documents & Certificates', mgmtOnly: true },
      { path: '/fssai/reports',     label: 'Compliance Reports',       mgmtOnly: true },
      { path: '/fssai/settings',    label: 'FSSAI Settings',           adminOnly: true },
    ],
  },
```

**Sidebar** (`Sidebar.tsx:84-86`; the `Task Management` section at `:279-302` is the model):

```ts
  {
    kind: "section",
    label: "FSSAI Compliance",
    icon: ShieldCheck,
    items: [
      { kind: "link", label: "Compliance Dashboard", href: "/fssai",             icon: LayoutDashboard },
      { kind: "link", label: "Run a Check",          href: "/fssai/checks",      icon: ClipboardCheck },
      { kind: "link", label: "Temperature Logs",     href: "/fssai/temperature", icon: Thermometer },
      /* … one link per catalog path, same order, same labels … */
    ],
  },
```

The `href` strings and the `path` strings must match character for character; the labels should too.

## 4.3 Nesting depth: two levels, hard

`type NavSection = { kind: "section"; label; icon; items: NavLink[] }` — `items` is `NavLink[]`, **not** `NavEntry[]`, and `renderSection` has no recursive branch. A section cannot contain a sub-section. FSSAI's twenty-ish children in one section **fit natively** — HR already runs 19 links in one section and Admin 22. Sub-grouping would require an app-wide navigation change, which the no-redesign rule forbids. If the list feels long, group *inside the pages* with tabs (`TabScroller`), not in the sidebar.

## 4.4 Tier flags

Exactly three, all optional booleans on `PageEntry`, all evaluated **before** the NULL-map grant (`page-catalog.ts:823 / :828 / :834`):

| Flag | Who passes |
|---|---|
| `hodOnly` | HODs (`is_head_chef`) and admins — **managers are excluded** |
| `mgmtOnly` | admin, manager, or HOD |
| `adminOnly` | `role === 'admin'` only |

Two cautions. `hodOnly` is the only flag an admin can switch off at runtime without a deploy (settings key `hod_only_overrides`, loaded at `proxy.ts:185`), so it is unsuitable for a gate that must hold. And because `canAccessPage` matches grants by **prefix** (`:847`), a `/fssai` catalog entry grants every `/fssai/*` child — so put the tier flag on each sensitive child rather than relying on the parent.

## 4.5 There is no `unbuilt` flag

`grep -rn "unbuilt" src/` returns nothing. `FSSAI-BUILD-STATE.md` §4 is wrong about this and must be corrected. Two lawful options:

* **Preferred:** only catalog and list a page once its `page.tsx` exists. Phases land nav entries incrementally.
* If a placeholder is genuinely needed, ship a real `page.tsx` that renders a "Coming in Phase N" card. A catalogued path with no page 404s — `/dine-in/order` is live proof.

Adding an `unbuilt` field to `PageEntry` plus `Sidebar.tsx` is a change to two shared committed files and needs the owner's approval first.

## 4.6 One more file, for roles

`cleanPages` in `src/app/api/auth/roles/route.ts:13-18` returns `null` — meaning **ALL PAGES** — when none of the submitted paths matches `ALL_PAGE_PATHS`. If an admin ticks only FSSAI pages for a role *before* those paths are in the catalog, that role is silently granted the entire application. The catalog entries must therefore land **before or with** the first role that references them, never after.

---

# §5 · THE INTEGRATION TABLE — THE ANTI-DUPLICATION CONTRACT (owner §21)

FSSAI **reads** these. It creates no parallel master. One row per master; the trap column is the part that will bite.

| # | Master | Real table | Reference by | Display by | Read through | The trap |
|---|---|---|---|---|---|---|
| 1 | **Item Master** | `raw_materials` (952 rows) | `id` | `name`, plus `sku` | `GET /api/inventory`; `MaterialTypeahead` in the UI | Money: `last_purchase_price` is stored in **mixed bases** — up to 5,000× wrong (a 5 L crush stores ₹0.13482 when the real rate is ₹674.10/BTL). Always value through `src/lib/closing-valuation.ts` (`materialRate:62`, `rateMap:93`, `valueCount:115`). Note `GET /api/inventory` already *overrides* the stored column with a `purchases` subquery (`route.ts:39-41`), so the API value and the column value disagree — never mix them on one screen. Quantity: display in **purchase units** via `src/lib/pack-units.ts` (`packFactor:79`, `dualQty:217`, `displayQty:271`); `packFactor` needs **both** halves — `pack_size > 1 && unit !== purchase_unit`. `npm run check:units` fails the build if you hand-roll it. |
| 2 | **Vendor Master** | `vendors` (59 rows; columns `id, name, contact_person, phone, email, gstin, address, payment_terms, lead_time_days, is_active, notes, created_at, updated_at`) | `id` | `name` | `GET /api/vendors`; mapping via `src/lib/vendor-mapping.ts` (`vendor_materials`, 554 rows) | **`store_vendors` is NOT a table** — it is a JSON response key computed live at `src/app/api/stores/[id]/stock/route.ts:158-168`. **There is no shared `VendorSelect`** — the one that exists is a page-local function inside gated liquor work at `inventory/liquor-store/page.tsx:1336`; do not import it. Use `Combobox`. Separately: `src/app/api/vendors/route.ts` has **no role gate** on GET/POST/PUT and is absent from the CSRF list — report it, do not fix it in this module. |
| 3 | **Receiving / GRN** | `goods_receipt_notes` (29) + `goods_receipt_note_items` (31) | `goods_receipt_notes.id`, line `goods_receipt_note_items.id` | `grn_number` (NOT NULL UNIQUE) | extend `src/lib/grn-qc.ts` — `resolveQcRequirement:763` is the gate, `decideGrnQc:1337` the single writer, `canSignQcFor:869` the signer test, `QC_AWAITING:123` the hold state | Attach to the **GRN**, not to `purchases`: one delivery is one GRN but fans into N `purchases` rows. The GRN already models QC (`qc_by, qc_required, qc_checker, qc_outcome, qc_quality, qc_temperature, qc_expiry, qc_damage, qc_weight, qc_invoice_match, qc_kitchen_by/at, qc_store_by/at, qc_override_by/at/reason, qc_applied_at, qc_escalated_at`) — **extend it, do not shadow it**. Measured: all six QC booleans are 0 across all 29 GRNs, so a seventh unticked boolean is not a food-safety control; the real control is the `awaiting_qc` hold. `qc_temperature` is a pass/fail INTEGER, **not a reading** — an actual °C value has nowhere to go today. |
| 3b | **Purchase Order** | `purchase_orders` | `id` | `po_number` (UNIQUE) | `GET /api/purchase-orders` | **Never read `purchases.po_id`** — nothing writes it at insert (verified across all seven INSERT sites); only a boot backfill fills it, so it is NULL between restarts (2,145 of 2,165 NULL). Resolve via `purchases.grn_id → goods_receipt_notes.po_id`. The "PO No" shown on `/purchases` is a **regex parse of `notes`** (`purchases/page.tsx:225`), not proof of anything. |
| 4 | **Batch / FIFO** | `production_batches` (9) + `batch_transactions` (28, append-only) + `production_items` (3) | `production_batches.id` | `barcode` (`PROD######`, UNIQUE) + `batch_number` | **import** `src/lib/production-batch.ts` — `expiryStatus:44`, `batchAgeHours:58`, `shelfLifeRemaining:70`, `enrichBatch:90`, `itemGroupClause:109`, `computeFifo:127` | The module is **FIFO, not FEFO** — `computeFifo` orders `production_date, production_time, created_at`. FEFO does not exist anywhere. A second FIFO ranking written inside `fssai_` is an automatic drift defect. Also `kitchen-production/route.ts:34` states "NOTHING HERE MOVES MATERIAL" — an FSSAI FIFO check must never become a stock movement. |
| 4b | **Raw-material expiry** | — | — | — | — | **There is none.** `purchases` and `goods_receipt_note_items` carry neither batch nor expiry, and on the Item Master `shelf_life_days > 0` is **0 of 952** and `storage_location <> ''` is **0 of 952**. FEFO on incoming goods has nowhere to store a lot and no data to stand on. See §9 Q5. |
| 5 | **Departments** | `departments` (29) | `department_id` (UUID FK) | `name` | `src/lib/dept-hierarchy.ts` — `mainDeptOf:34`, `userMainDept:45`, `effectiveCategoriesForUser:73` | **READ ONLY** — 1,630 requisitions and 16,353 requisition items reference these ids. Two conventions coexist: `department_id` FK (requisitions, users, `hr_*`, `station_departments`) vs a **free-text `department`** column (tasks, `maintenance_schedules`, `checklist_templates`, `batch_transactions`), whose values include `'HR'` and `'Store'` — **not rows in `departments`**. The Task module keeps its own 10-value vocabulary (`TASK_DEPARTMENTS`, `tasks.ts:121`). Live names contain double spaces ("Akan  Indian"): **match on id, never on name.** |
| 6 | **People (who performed the check)** | `users` (9 active: 5 admin, 2 manager, 2 staff) | store `users.email` in the record | `users.name` | `GET /api/tasks/users` (any signed-in user; returns `id, name, email, position, department_id`; marked "Do NOT widen this SELECT") + `UserPicker` | **Do not key on `hr_employees`** — it has **0 rows**, and `GET /api/hr/employees` is gated by `canManageHr` = `admin \|\| manager \|\| is_head_chef` (`hr.ts:144`), so a tier-`staff` user gets 403 from the employee master, and staff are exactly who runs phone checks. If HR is ever needed, reach it behind `canManageHr` via `hr_employees.user_id`. |
| 7 | **Equipment / cold units** | **none exists** → create `fssai_equipment` | new `fssai_equipment.id` | `name` | — | Not a §21 violation: `hr_assets` is a staff-issued-item register (`kind` = uniform \| id_card \| device, plus `employee_id` and a status of in_store \| issued \| returned \| damaged \| lost) with no location, class or temperature attribute, and an exhaustive search of all 205 tables for equipment/asset/temperature/chiller/freezer/cold found nothing else. Seed `location_label` from the live free-text values `Cold Room 1`, `Cold Room 2`, `Cold Room 3`, `walkin chiller 1` so existing batches join. |
| 8 | **Maintenance** | `maintenance_schedules` (21) + `maintenance_logs` (21) | `id` | `name` | generated tasks carry `source='maintenance'` | **Pest Control and Water Filter Inspection already exist here as schedules** and are also FSSAI sub-modules. Do not build a second one before §9 Q2 is answered. |
| 9 | **Tasks (corrective actions)** | `tasks` (21, all `source='maintenance'`, all `draft`) + `task_status_history` + `task_notifications` | `tasks.id`, stored back on the FSSAI row as `created_task_id` | `tasks.title` | copy the recipe at `api/tasks/checklists/route.ts:164-214` verbatim, inside one `db.transaction` | Add `'fssai'` to the `Task.source` union (`tasks.ts:308+`) — it already carries `'manual' \| 'checklist' \| 'maintenance' \| 'hygiene' \| 'recurring'`. Keep FSSAI-specific state in `fssai_corrective_actions` and link by id; **do not build a second task system.** Default the assignee to the department lead the way `hodFor()` does (`tasks/checklists/page.tsx:94-108`: `/api/departments` → `head_user_email` then `head_chef_email`). |
| 10 | **Stores / locations** | `store_locations` (1 row locally) | `id` | `name` | `listStores`, `userStoreAccess` | `listStores` **returns inactive stores too** — filter yourself. `userStoreAccess` fails closed. `store_user_access` has 0 rows locally, which proves nothing about production. |
| 11 | **Outlets / scoping** | `outlets` (2) | `outlet_id` | — | `getCurrentOutletId()` (`auth.ts:249`) | House filter is `AND (outlet_id = ? OR outlet_id IS NULL)`. `outlet_id` is on 49 stock/money tables but **not** on the Task module, the checklist engine or the HR vault. See §9 Q1. |
| 12 | **Department scoping of records** | — | `departments.id` in the allowed set | `name` | `canSeeAllDeptStock(me) ? all : allowedDeptSetExpanded(db, me)` | An **empty allowed set means "sees nothing", not "no filter"**. Fail closed. |
| 13 | **Audit trail** | `audit_events` (241 rows; `db.ts:3936-3950`) | `entity_type='fssai_*'` + `entity_id` | — | `logAuditEvent` (`db.ts:8285`) | Never throws, so it cannot be used as proof a write happened. No retention policy — audit state changes, not reads. See §9 Q4. |

**Rails FSSAI must not rebuild:** `nextRecurrence(freq, from, dow, dom)` (`tasks.ts:217`) is the shared UTC-safe recurrence maths; `statusMeta`/`priorityMeta` (`tasks.ts:64`/`:95`) are the badge convention; `parseMentions` (`tasks.ts:164`) is @-mention parsing; `push(key, label, count, href)` in `src/app/api/notifications/inbox/route.ts:60` is the one extension point for the global bell (a live COUNT, **no new table**, both bells render it free — one row per queue with `count` = queue size, never one row per record, because the badge sums counts).

---

# §6 · THE MOBILE CHECKLIST RUNNER BRIEF

Most checks happen on a phone while staff move around the restaurant. These are rules, not suggestions.

## 6.1 Breakpoints — measured in this worktree

`sm:` 1,204 uses · `md:` 239 · `lg:` 182 · `xl:` 23. The app is authored **mobile-first** and steps at 640 (`sm`). Two switch points matter:

* **`md` (768) is the card ↔ table switch.** Phone gets a stacked card list (`md:hidden divide-y`), tablet and up get the table (`hidden md:block overflow-x-auto`). Reference: `src/app/crm/guests/page.tsx:515-547`.
* **`lg` (1024) is the app-chrome switch** — `MobileTopBar` below it, the floating `UserBar` pill above.

The page body must **never** scroll horizontally. Every wide thing lives in its own `overflow-x-auto` container.

## 6.2 Touch targets

| Element | Size |
|---|---|
| Global floor | 36px — `globals.css:247` applies `min-height: 36px` to every `main button` |
| Icon button in a bar | `w-9 h-9` |
| **Numeric stepper (− / +)** | **`w-11 h-11`** (44px) — `CaptainShell.tsx:493,497` |
| Primary action | `py-3` to `py-3.5`, `rounded-xl` |
| Press affordance | `active:scale-95` (61 uses) |

Answer buttons in the runner should be at least 44px tall and full-width on a phone. A three-way Pass/Fail/NA sits in a `grid grid-cols-3 gap-2`.

## 6.3 Minimal typing — the input rules

**On the phone runner, do not use `type="number"`.** The app-wide count is 209, but those are desktop forms; the mobile surfaces use 46 `inputMode` inputs instead, because `type="number"` brings scroll-wheel drift, a locale-sensitive decimal separator, and a spinner nobody can hit with a thumb. The captain pattern (`CaptainShell.tsx:494-495`) is the one to copy:

```tsx
<input
  value={v}
  onChange={e => setV(e.target.value.replace(/[^0-9.\-]/g, ''))}
  inputMode="decimal"
  className="flex-1 min-w-0 bg-white border border-[#D4B896] rounded-xl px-3 py-3 text-base text-center focus:outline-none focus:ring-2 focus:ring-[#af4408]"
/>
```

* **`text-base` (16px) on every input.** Anything smaller makes iOS Safari zoom the page on focus and the layout never recovers. 48 uses today.
* `inputMode="numeric"` for counts, `inputMode="decimal"` for temperatures (allow a leading `-` for freezers).
* Wrap numeric fields in `w-11 h-11` −/+ steppers so a temperature can be nudged without the keyboard.
* Dates: native `<input type="date">` (166 uses). No date-picker package exists; do not add one.
* Free text only where a regulation demands words. Everything else is a button, a toggle or a dropdown.

## 6.4 The eight question types, rendered

| Type | Control |
|---|---|
| Yes/No | two full-width buttons, same classes as Pass/Fail |
| Pass/Fail | `tasks/checklists/page.tsx:247-251`, verbatim |
| Numeric | stepper + `inputMode="numeric"`, unit suffix as static text |
| Temperature | stepper + `inputMode="decimal"`, `Thermometer` icon, **in-range / out-of-range colour computed from the template's min/max**, not typed by the user |
| Text | `<textarea rows={2}>` at `text-base`, only where required |
| Photo | `ImageUpload` (§6.5) |
| Multiple choice | ≤4 options → a button grid; >4 → `Combobox` |
| Signature | see §9 Q6 — do **not** guess; a name + timestamp + the authenticated `users.email` is the fallback |

**A blank numeric or temperature answer is NOT zero.** `Number('') === 0` sailed past every `isNaN || < 0` guard on four of five writers in the closing-stock module and stored 793 phantom "we have zero" counts, each of which deleted a real count. The fix already exists: `readPhysicalCount()` in `src/lib/variance-approval.ts:167` returns a tri-state (`not_counted | count | error`) represented by **row absence**, not NULL. Import it or restate it as one shared call — never as a rule people are asked to remember. An unanswered temperature field must never record 0 °C.

**A question type the runner does not recognise must fail loudly**, not render a blank field. See §10 R1.

## 6.5 Photo evidence

`ImageUpload` (`src/app/tasks/_components/ImageUpload.tsx`) is client-only — **there is no upload service in this app.** It reads the file, downscales on a canvas to `MAX_EDGE = 1200`, encodes JPEG at `START_QUALITY = 0.7` (floor `MIN_QUALITY = 0.4`), re-encoding until under `TARGET_BYTES = 250 * 1024`, and hands back a `data:` URI you store in an ordinary TEXT column.

```tsx
<ImageUpload value={url ? [url] : []} onAdd={(u) => setUrl(u)} />   // single
<ImageUpload multiple value={imgs} onChange={setImgs} />            // many
<ImageThumb src={url} />                                            // portaled lightbox
```

**Why ~250 KB matters:** production's real body limit is **1 MB**, not the 25 MB the checked-in nginx config claims. A production probe recorded at `crm-calls/database/page.tsx:83-87` measured 900 KB through and 1,100 KB rejected with a 413. So: compress client-side, **one photo per request**, and never assume the `task_files` BLOB route works — its declared caps (image 10 MB, video 20 MB) all exceed the real ceiling and would 413.

## 6.6 Submit

Sticky-bottom bar with the answered count in the label (`tasks/checklists/page.tsx:462-471`), page padded `pb-24` to clear it:

```tsx
<div className="sticky bottom-0 -mx-4 sm:mx-0 px-4 sm:px-0 py-3 bg-gradient-to-t from-[#FFF8F0] via-[#FFF8F0] to-transparent">
  <button onClick={save} disabled={saving || answered === 0}
    className="w-full inline-flex items-center justify-center gap-2 bg-[#af4408] hover:bg-[#8a3606] text-white text-sm font-semibold rounded-lg px-4 py-3 disabled:opacity-50">
    {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
    Submit Check{answered > 0 ? ` (${answered})` : ''}
  </button>
</div>
```

## 6.7 Connectivity — say the true thing

**There is no offline cache.** `src/components/ServiceWorkerRegister.tsx` is a service-worker *disabler*: it unregisters any SW and purges its caches on every page load (the stale-chunk incident), sparing only the push-only `public/push-sw.js`. Any claim that "FSSAI works offline" is false today.

The shipped answer is the Captain heartbeat banner (`CaptainShell.tsx:~232`) — a 15-second poll and a red in-flow strip when it fails, placed in normal flow so it pushes the page down instead of covering a sticky header. The FSSAI runner adopts that. If the owner needs true offline (a cold-room round in a basement), the pattern to copy is the kitchen scanner's **IndexedDB queue** (`src/lib/kitchen-scan-queue.ts`) that flushes on the `online` event — that is an architecture decision for §9 Q7, not a UI choice. **Do not re-register a caching service worker**: that resurrects the exact bug the disabler exists to prevent.

---

# §7 · REPORTS AND EXPORTS

## 7.1 Where reports live

Seven pages under `src/app/reports/**`, plus six more report stacks outside it (`/hr/reports`, `/tasks/reports`, `/kitchen-production/reports`, `/crm-calls/reports`, `/sales-dashboard`, `/admin/database`). FSSAI reports belong under `/fssai/reports`, following the module-local convention (Tasks and HR both do this), not under `/reports`.

The best-built server pattern is `/api/hr/reports`: a generic module contract of `COLUMNS` plus `run(db, outletId, from, to)` per report (`src/lib/reports/hr-headcount.ts:43,56`). Copy it — one file per FSSAI report, a thin route that dispatches.

## 7.2 The date-range trap — half-fixed, and the owner has already been burned

`src/app/reports/purchase-bill-summary/page.tsx:482-511` records the incident in the code: a first-of-month default showed "0 of 2,165 rows and ₹0 of ₹69.26 lakh… He read that as his books having been lost." The fix is an explicit intent state (`{mode:'all'}`) plus server-resolved dates. **Two pages were rebuilt and five were not** — `/reports/sales:60` still opens on `istMonthStart`.

**FSSAI rule:** an inspection-history view defaults to **all records**, and any date filter is a visible, deliberate choice. A compliance report that silently shows an empty window is the worst possible failure mode for this module.

## 7.3 CSV

No shared helper exists; **66 files** roll their own `text/csv` Blob. Only **6** emit a UTF-8 BOM. The correct pattern is `src/app/api/hr/reports/route.ts:124` — prefix the body with `'﻿'`, join rows with `\r\n`, and serve `Content-Type: text/csv;charset=utf-8`.

**Without the BOM, Excel renders `4 °C` as `4 Â°C`** — which matters more for FSSAI than for any other module, because temperature logs are the bulk of the export. Always BOM, always `charset=utf-8`, and escape a leading `=`/`+`/`-`/`@` in any free-text cell.

Excel export is SheetJS (`xlsx`), dynamically imported client-side. Download is the `Blob` + `<a download>` idiom.

## 7.4 PDF — what it can and cannot do, measured

`buildReportPdf(spec)` at `src/lib/report-pdf.ts:164` is a genuine A4 multi-page tabular renderer: mid-table page breaks with the header redrawn (`:274`), "Page n of m" plus an IST stamp on every page (`:311-319`), KPI tiles, footnotes, and it never throws on empty input. It is **pure** — no DB, no settings, an injectable clock.

**Can do:** A4 portrait, multi-page tables, KPIs, footnotes, deterministic pagination, and the characters `°` `±` `µ` `…` `“ ”` (all WinAnsi).

**Cannot do, verified on this repo's pdfkit 0.15.1:**

| Thing | Measured result |
|---|---|
| `°` degree sign | encodes to WinAnsi byte **`B0` — renders correctly**. Temperature reports are safe. *(This closes the reports lane's open question.)* |
| `₹` rupee sign | encodes to the two bytes **`20 B9`** — prints as **space + `¹`**. Use `inr()` (`report-pdf.ts:95`), which emits `Rs `. `inrText()` is for WhatsApp message bodies only. |
| Long text | **Cells truncate to one line with an ellipsis and never wrap** (`fit()`, `:143`). Deliberate: a wrapped cell makes row height depend on content, which makes pagination depend on content, which is how a 200-row table becomes a 40-page PDF. **Corrective-action free text will be cut on an inspector's sheet.** Decide the workaround in P4 — the recommended one is a second "Notes" section below the table printing full text per flagged row, rather than widening the column. |
| Serving it over HTTP | **Never done.** All four call sites are inside `src/lib/wa-report-builders.ts` and attach the buffer to a WhatsApp message. The HTTP precedents are `src/app/api/dine-in/orders/[id]/bill-pdf/route.ts` and `src/app/api/tables/qr/pdf/route.ts`. An FSSAI "download the inspection pack" endpoint is new work — a route returning `application/pdf`, **not** a path containing `print`. |

## 7.5 Print

There is **no global print stylesheet** (`globals.css` contains zero `@media print` rules); three pages define their own. An A4 record printed from the browser uses a **dedicated print route** on the `src/app/grn/print/[id]/page.tsx:196-208` pattern.

**But an FSSAI print route may not be named `/print`** — `proxy.ts:125` would make it public. Either serve the pack as a PDF from an authenticated API route (recommended), or use a different segment such as `/fssai/records/[id]/sheet` and confirm it is not caught by `isPublic`.

The thermal bridge is **not** an option for inspection records: it is per-machine and localhost-only, and `doc.lines` gates what it renders.

## 7.6 Scheduling — the honest answer

A real self-rescheduling driver exists in `src/lib/scheduler.ts` (adaptive 5/30-minute tick, 9 jobs), but:

* it is **production-only** unless `ENABLE_SCHEDULER=1` (`scheduler.ts:72`), and
* it is **lazy-armed**: `startSchedulerOnce()` is called from exactly three routes — `api/upcoming-parties`, `api/crm-calls/broadcasts`, `api/crm-calls/broadcasts/[id]/action`. The app admits this in its own UI (`settings/integrations/page.tsx:104`: "not started yet (will start on first /api/upcoming-parties request)").
* `runTaskAutomation` — the recurring-task, maintenance and escalation engine — is **not on the scheduler at all**. Its only caller is `src/app/api/cron/refresh-parties/route.ts:84`, which needs an admin session or an `x-cron-token` header. If that external cron is not configured on the box, **no recurring task has ever generated and nothing has ever escalated.** Consistent with the live data: all 21 tasks are `source='maintenance'`, `status='draft'`.

**An FSSAI "check is due / was missed / escalate" engine must therefore either register itself in `src/lib/scheduler.ts` (accepting the lazy arm) or accept the same silent external dependency. P1 decides this and writes it down.** A fixed-hour compliance alert genuinely needs external cron via `CRON_TOKEN`. See §9 Q7.

## 7.7 Notifications

The extension point is one function: `push(key, label, count, href)` in `src/app/api/notifications/inbox/route.ts:60` — a live COUNT over existing pending state, no new table, and both bells render it for free. Each bucket must be in its own try/catch with a dynamic import: un-isolated code there kills every user's bell. `src/lib/alert-audience.ts` already solves role targeting. Durable addressed notifications follow the `task_notifications` / `hr_notifications` shape; the producer pattern to copy is `src/lib/hr-notify.ts:32-68` — **call it outside/after the caller's transaction**, push after the row exists, never throw.

---

# §8 · WHICH EXISTING MODULE THE CHECKLIST ENGINE IS MODELLED ON

## The ruling

**Data model: the HRMS test / SOP engine. Lifecycle, plumbing and screens: the Task module. Not the Task checklist.**

## Why not the Task checklist, the superficially obvious choice

`daily_checklist_records` is keyed `(template_id, item_id, date)` and upserted (`api/tasks/checklists/route.ts:130`). That single fact kills it:

* **One run per template per calendar day, maximum** — a second submission overwrites the first. FSSAI needs opening *and* closing runs, per-shift temperature rounds, and the same checklist run against three different cold rooms on the same day.
* **No run header** — no `started_at`, no `submitted_at`, no `submitted_by` (only per-row `recorded_by`), no run status, no signature, no target area, no shift, no template version.
* **Three results, one optional photo, and that is the whole vocabulary.** `VALID = new Set(['pass','fail','na'])` (`route.ts:122`); `checklist_items` is `label + sort_order + requires_image` (`db.ts:5599-5606`) — no type, no unit, no min/max, no section, no options, no required flag.
* **No frequency, no scheduling, no missed-check detection, no compliance reporting.** `grep "checklist" src/app/api/tasks/reports/route.ts src/app/api/tasks/dashboard/route.ts` returns nothing: the Task module's own reports never read its checklist tables.
* **Its uniqueness is application-code only** — `idx_daily_checklist_records_tpl_date` is not UNIQUE, so two concurrent saves duplicate a row.

Adopting it means rewriting it on day one while carrying its name. And an inspector's questions — *which version of this checklist was in force on 14 March; who signed it; at what time; against which cold room; on the second round of that day* — are **structurally unrepresentable** in `(template_id, item_id, date)`.

## What HRMS gives that nothing else does

```
db.ts:8009  hr_tests(id, name, department_id, designation_id, pass_score, max_attempts,
                     time_limit_minutes, shuffle, version, is_active, …)
db.ts:8024  hr_test_questions(id, test_id, kind, question, options_json, correct,
                              sort_order, is_active)
db.ts:8036  hr_test_attempts(id, test_id, test_version, employee_id, attempt_no,
                             answers_json, score, passed, started_at, finished_at,
                             UNIQUE(test_id, employee_id, attempt_no))
db.ts:7957  hr_sop_versions(id, sop_id, version, body, status draft|published|archived,
                            require_ack, published_by, published_at, UNIQUE(sop_id, version))
```

1. **Questions are ROWS with `sort_order` and `is_active`** — editable, orderable, soft-deletable, queryable. `knowledge_tests.questions_json` is none of those, and §24 requires the owner to edit the twelve seeded checklists in Settings when regulations change.
2. **A template `version`, frozen onto each run** (`hr_test_attempts.test_version`). This is the single most valuable pattern in the codebase for FSSAI: a 2026 edit must not rewrite a 2025 record.
3. **The answer key / threshold is projected out in SQL**, never loaded then deleted in JS.
4. **Attempt lifecycle**: start *resumes* an unfinished attempt rather than duplicating it; a finished attempt is **immutable** — re-submitting is a 409. A half-finished cold-room round needs exactly that.
5. `hr_sop_versions`' `draft → published → archived` is the template publishing flow.

## What to take from the Task module, unchanged

The status ladder (`TASK_STATUSES`, `tasks.ts:44`) `draft → assigned → accepted → in_progress → waiting_verification → completed → approved` plus `reopened / on_hold / cancelled`; the transition chokepoint with per-target permission tiering (`api/tasks/[id]/route.ts:281-287`); `task_status_history` on every transition; the counterparty notification and `@mention` fan-out; the `waiting_verification` queue; `firePush`; `ImageUpload`; the `fail → tasks(source=…)` corrective bridge; the settings-KV config pattern (a `tm_*` prefix with a default read, no schema change); the `page-catalog` + `Sidebar` twin edit; and the **screens** — `src/app/tasks/checklists/page.tsx` is 474 lines of shipped, demonstrably-rendered mobile runner, and the FSSAI runner should be visually indistinguishable from it.

From Kitchen Production: `computeFifo` / `itemGroupClause` / `expiryStatus` imported, never re-derived; the four-bucket expiry watchdog with composite dedupe keys (`'kbatch-expiry:<id>:<date>'` against `UNIQUE(party_unique_id, kind, channel)`) — exactly the shape certificate-expiry (§17) and temperature-breach alerts need.

From the variance queue: the count → pending → approve/reject state machine; decision functions that refuse a non-pending row (`'Already ${row.status}'`); **one predicate shared by the list query and the API** so the button and the refusal can never disagree; fail-closed verdict parsing; **no bulk approve by filter, ever** (bulk *reject* is fine — it changes no number; bulk verify must be explicit-ids-only, one transaction per row, every guard judged per row).

## The strongest argument against this ruling — state it, do not hide it

**The HRMS engine has never run.** Live counts: `hr_tests 0`, `hr_test_questions 0`, `hr_test_attempts 0`, `hr_sops 0`, `hr_employees 0`, `hr_documents 0`. Every claim about resume-not-duplicate, version freezing and immutability-on-submit is read from **code and docstrings, not from behaviour**. The Task checklist, though far thinner, has a working screen. Copying the model that has never executed over the one with a working screen is a real bet, and it is the more expensive one: five or six `fssai_` tables and a full admin CRUD before the first box is tickable, where bolting a `type` column onto `checklist_items` and adding a run header would be about two days.

**The ruling stands anyway**, because the FSSAI record is legal evidence, and a schema you must migrate *underneath live audit history* is worse than one built right. But P1 should read the counter-argument before starting, and the owner should be told the cost (§9 Q2).

## Also settled by this ruling

`checklist_templates` is live with **5 templates / 56 items** belonging to a different feature (role-based manager checklists: "Restaurant Cleanliness", "Washrooms"), while `daily_checklist_records` has **0 rows** and `hygiene_audits` has **0 rows**. Separate `fssai_*` tables therefore disturb nothing in use — cite this when asked why FSSAI did not just reuse them. Note the cautionary tale in the same data: the seed is live, the feature is dead, and nobody noticed because the rows exist.

## Document the decision

Write `docs/fssai/FSSAI_DECISIONS.md` on the model of `docs/HRMS_DECISIONS.md` — numbered decisions with the reason and the rejected alternative. HRMS's D4 (the documents vault) is the quality bar: it states what was copied, what was deliberately *not* reused, and why. That file is what stops phase 9 from relitigating phase 2.

---

# §9 · OPEN QUESTIONS FOR THE OWNER

Short, with options and a recommendation. None of these should be guessed by a build agent.

### Q1 — Should FSSAI records be per-outlet?
There are 2 outlets in the database. Stock and money tables carry `outlet_id`; the Task module, the checklist engine and the HR vault do not.
* **(a)** `outlet_id` on every FSSAI table, filtered everywhere. Correct if a second kitchen is ever inspected separately; costs a filter on every query.
* **(b)** No outlet column — one restaurant, one compliance file.
* **(c)** Column present, filtering deferred to a later phase.
**Recommendation: (c).** Add `outlet_id TEXT NOT NULL DEFAULT ''` now, because adding it later to tables holding audit history is painful — but do not build the switcher until a second outlet is really inspected.

### Q2 — The existing checklist / hygiene / maintenance features overlap FSSAI. What happens to them?
`/tasks/checklists` (5 templates, 56 items, 0 records), `/tasks/hygiene` (0 records, and `/tasks/reports` already has a Hygiene tab), and **Pest Control + Water Filter Inspection already exist as `maintenance_schedules` rows**.
* **(a)** Leave them alone; FSSAI is additive and the overlap is accepted. Two places to do a similar thing.
* **(b)** Retire them once FSSAI ships — hide the nav entries, keep the data.
* **(c)** Migrate the 5 templates / 56 items into the FSSAI engine and retire the old screens.
* **(d)** Keep Pest Control and Water Filter in Maintenance; FSSAI *reads* them for its compliance view rather than re-implementing them.
**Recommendation: (d) + (b).** Pest control genuinely is a maintenance schedule — let FSSAI show its status and attach the certificate, not own the schedule. Hide the dead `/tasks/checklists` and `/tasks/hygiene` nav entries once the FSSAI runner ships, keeping the data. Do not migrate the 56 items: they are manager checklists ("Washrooms"), not FSSAI records.

### Q3 — Who verifies a check?
The person who ran it must not be the person who signs it off. Today `canApproveTasks === canManageTasks` (`admin | manager | is_head_chef | is_store_manager`), so a head chef verifies his own kitchen.
* **(a)** Any management (admin/manager/HOD) may verify, but **never the same person who recorded the run** (blocked by `recorded_by !== verifier`).
* **(b)** Manager tier and above only — HODs run, managers verify.
* **(c)** Admin only.
* **(d)** Per-template: the template names the verifying role.
**Recommendation: (a), with (d) available later.** It is the narrowest rule that still works on a nine-person roster, and "you cannot sign your own check" is the part an inspector cares about.

### Q4 — May a compliance record be saved if its audit row fails?
`logAuditEvent` never throws, by design.
* **(a)** Yes — the record is what matters; a missing audit line is acceptable.
* **(b)** No — audit failure rolls back the write.
* **(c)** Yes, but a failed audit raises an admin alert.
**Recommendation: (c).** Never lose a check a member of staff actually performed, but do not let the audit trail silently rot either.

### Q5 — FIFO / FEFO has no data on raw materials. What is in scope?
`shelf_life_days` and `storage_location` are empty for **all 952** items, and purchase/GRN lines carry no batch or expiry at all. Only `production_batches` (9 rows) has real expiry dates.
* **(a)** Scope FIFO/FEFO to **produced batches only** — works today, zero data entry.
* **(b)** Add batch + expiry capture at goods receipt (a new `fssai_receiving_lots` table keyed to the GRN line) — correct, and a real change to the receiving workflow staff already perform.
* **(c)** Budget a data-entry phase to fill `shelf_life_days` / `storage_location` for the perishable subset (perhaps 100-200 items), then compute expiry from the receipt date.
* **(d)** All of the above, phased.
**Recommendation: (a) now, (c) next, (b) only if an inspector actually asks for lot traceability on incoming goods.** (b) adds a step to every delivery and will be skipped in practice unless it is genuinely required.

### Q6 — What counts as a signature?
* **(a)** The authenticated user plus a timestamp — the record already knows who was signed in. No drawing.
* **(b)** A drawn signature on a canvas, stored as a data URI like a photo.
* **(c)** Name typed + timestamp + authenticated email.
* **(d)** A 4-digit staff PIN re-entered at submit.
**Recommendation: (a).** It is stronger evidence than a drawing (which anyone can scribble), costs nothing, and matches how the rest of the app records an actor. Offer (d) only if an inspector has specifically asked for a distinct act of signing.

### Q7 — Who wakes the system up to say a check is due or overdue?
The in-process scheduler is production-only and lazy-armed; `runTaskAutomation` is not on it at all and needs an external cron that may never have been configured.
* **(a)** Register FSSAI's due/overdue sweep in `src/lib/scheduler.ts` and accept that it starts on the first qualifying request.
* **(b)** External cron hitting an `x-cron-token` endpoint at fixed hours — the only way to get a reliable 8 a.m. alert.
* **(c)** Compute "due/overdue" on page load only; no alerts at all in v1.
* **(d)** (a) for detection, plus (b) later for the morning reminder.
**Recommendation: (d).** Ship (a) so nothing depends on infrastructure that may not exist, and tell the owner plainly that a fixed-time WhatsApp reminder needs (b) configured on the box.

### Q8 — Three roles named in §20 do not exist.
Live roles are Administrator (admin), Manager, Floor Manager, Bar Manager, Head Chef, Store Manager (all `manager` tier), Staff, Captain, Cashier (all `staff`). **There is no Maintenance, no Supervisor and no "F&B Controller" role**, and `users.section` is empty for all 9 users, so section-based routing has nobody to route to.
* **(a)** Map §20's Maintenance → Store Manager, Supervisor → Captain, F&B Controller → Manager.
* **(b)** Create the three missing roles in `/settings/roles` (the owner's own screen — production mappings are his to set).
* **(c)** Drop the distinctions; FSSAI uses Staff / Manager / Admin only.
**Recommendation: (c) for v1, (b) when he wants the finer split.** Nine people do not need eleven roles, and FSSAI must not create roles itself — that is production config, which is the owner's to set.

### Q9 — May a check be backdated?
* **(a)** No — a check records the moment it is submitted. Cleanest evidence, hardest on reality.
* **(b)** Yes, within N days, with a reason recorded and the row flagged as backdated.
* **(c)** Management only, any date, always flagged.
**Recommendation: (b) with N = 1 and a mandatory reason.** A restaurant that lost power at 11 p.m. will record the closing check next morning, and a system that forbids it gets worked around by falsifying a live entry — which is worse.

### Q10 — Who may see the compliance reports?
* **(a)** Management only (`isManagement`), matching the Sales Reports precedent.
* **(b)** Everyone signed in sees their own department's; management sees all.
* **(c)** Admin only.
**Recommendation: (b).** Staff completing the checks should see their own record; the cross-department and inspection-pack views are management (`mgmtOnly` on the catalog entry **and** `isManagement` in the route — the catalog alone is not a gate).

---

# §10 · RISKS, RANKED

**R1 — Engine/seed drift between P2 and P8.** *Most likely failure.* Twelve checklists ship as seeded template rows; the engine that reads them is built earlier. If the engine gains a question type, a pass/fail condition grammar or a section rule after the seeds are written, the seeds silently encode the old shape — and because boot errors are swallowed and seeds are `INSERT OR IGNORE`, **a half-migrated template looks exactly like a correct one.** The Task module already demonstrates the failure: 5 templates and 56 items were seeded and then nothing ever reported on them.
**Mitigation:** freeze the question-type vocabulary and the pass/fail condition grammar **in writing at the end of P2, before a single template is seeded**. A template referencing an unknown type must **throw a visible error in the runner**, never render a blank field. Add one test that loads every seeded template through the renderer's type resolver.

**R2 — A swallowed migration ships as a working build.** Nine tables, a 130-precedent habit of one-shot DDL with a silent catch, and zero runtime verification anywhere in the app. A typo in statement 3 destroys statements 4 and 5 in silence, and the failure surfaces as a runtime crash on a screen three phases later.
**Mitigation:** the per-statement array, the shape guard, and the boot assertion in §3 — all three, in P1, before any table is used. Plus the six-step verification checklist in §3.5.

**R3 — Version-freeze is specified but not actually written on submit.** If `fssai_runs.template_version` is not stamped at submit, the first template edit turns every historical record into a lie — and nothing will detect it, because the records still look complete.
**Mitigation:** make the column `NOT NULL`, stamp it inside the same transaction that creates the run, and add a test that edits a template and re-reads an old run.

**R4 — The verification loop collapses into self-approval.** Inheriting `canApproveTasks` means the chef who ran the check signs it off. It will pass code review because it reuses an existing predicate, and it destroys the module's entire purpose.
**Mitigation:** `canVerifyFssai` in `src/lib/fssai.ts`, strictly narrower than the runner gate, plus an explicit `recorded_by !== verifier` check in the route (pending §9 Q3).

**R5 — Nav/catalog drift.** Twenty pages across eleven phases, two files that must be edited together, and a measured history of four drifted paths in the current tree.
**Mitigation:** every phase that adds a page edits both files in the same commit; the phase's checklist ends with the §4.1 drift script re-run and its output pasted into the phase report.

**R6 — A gate that is not a gate.** `page_access` is inert on 8 of 9 live users; `requireRole('manager')` authorises nothing; `proxy.ts` fails open twice; `cleanPages` can grant the whole app. It is very easy to ship an FSSAI page that *looks* restricted and is not.
**Mitigation:** the route's own predicate is the gate; the catalog flag is cosmetic reinforcement. Every phase review tests the API with a tier-`staff` session, not just the page.

**R7 — Photo evidence 413s in production.** The real body ceiling is 1 MB, not the 25 MB the checked-in nginx claims, and the existing `task_files` route declares caps of 10-20 MB that cannot work.
**Mitigation:** `ImageUpload`'s ~250 KB path only; one photo per request; never the BLOB route. Test with a 12 MP phone photo, not a screenshot.

**R8 — "It works offline" is promised and then is not true.** The service worker is deliberately disabled app-wide.
**Mitigation:** say "needs a connection" in the UI and ship the heartbeat banner. Escalate to §9 Q7 rather than quietly re-registering a caching service worker — that would resurrect the stale-chunk bug the disabler exists to prevent.

**R9 — An FSSAI path contains `print` or ends `.png`.** One careless route name (`/fssai/records/[id]/print`) makes an inspection record world-readable with no session.
**Mitigation:** stated in §2.1 and §7.5; add it to every phase's review checklist. Grep the diff for `print` before each phase closes.

**R10 — The module is built for data that does not exist.** `hr_employees` 0 rows, `shelf_life_days` 0 of 952, `storage_location` 0 of 952, `store_user_access` 0, the GRN QC booleans never ticked once across 29 receipts. A Personal Hygiene module keyed on `hr_employees` has nobody to check on day one.
**Mitigation:** key people on `users`; scope FIFO to `production_batches`; seed `fssai_equipment` from the four real free-text cold-room strings. Where a phase depends on data that does not exist, it must say so in its report rather than shipping an empty screen.

**R11 — Scope collision with the Task module confuses the owner.** `/tasks/hygiene` and a Hygiene tab on `/tasks/reports` already exist, and FSSAI adds its own.
**Mitigation:** settle §9 Q2 before P1 designs the nav.

---

# §11 · WHERE THE LANES CONTRADICTED EACH OTHER — RESOLVED

Each of these was re-checked against the source or the live database.

| # | Dispute | Resolution | Who was wrong |
|---|---|---|---|
| 1 | Does an `unbuilt` page flag exist? | **No.** `grep -rn "unbuilt" src/` → nothing; `PageEntry` has exactly `path`, `label`, `hodOnly?`, `mgmtOnly?`, `adminOnly?` (`page-catalog.ts:19-35`). | `FSSAI-BUILD-STATE.md` §4. The auth-rbac and adjacent-modules lanes were right. |
| 2 | Is `store_vendors` a table? | **No.** No `CREATE TABLE` for it exists; it is a JSON key computed at `api/stores/[id]/stock/route.ts:158`. | integration-masters was right; any code assuming a table is wrong. |
| 3 | `roles.tier` or `roles.base_role`? | **`base_role`** (`db.ts:2803`), values `admin | manager | staff`. | integration-masters right. |
| 4 | Insertion point in `db.ts` | **8189/8190 in this worktree** (live is 8251/8252 — a 568-line delta of uncommitted `lq_*` work). | db-conventions right; never copy a live line number. |
| 5 | "A checklist engine already ships" (ui lane) vs "zero records, dead feature" (adjacent lane) | **Both true, not in conflict.** The screen is shipped and renders; `checklist_templates` 5 / `checklist_items` 56 are live seeds for a *different* feature; `daily_checklist_records` is **0** and `hygiene_audits` is **0**. Copy the screen, reject the schema. | Neither wrong; the combination is the §8 ruling. |
| 6 | Does `°` render in PDF? (reports lane: "could not verify") | **It renders** — measured on pdfkit 0.15.1: `°` → WinAnsi byte `B0`. `₹` → bytes `20 B9`, i.e. space + `¹`, confirming the mojibake. `…` `±` `µ` also fine. | Open question now closed. |
| 7 | "Four shipped `buildReportPdf` call sites" | True, but **all four are inside `src/lib/wa-report-builders.ts`** and attach to WhatsApp. **No HTTP route has ever served `buildReportPdf`.** An FSSAI download endpoint is new work. | reports-exports understated the constraint. |
| 8 | "Mobile uses `inputMode`, not `type="number"`" (ui lane) | **True of the mobile/captain surfaces only.** App-wide there are 209 `type="number"` and 46 `inputMode` uses. The rule holds for the FSSAI phone runner; it is not an app-wide convention. | ui-conventions overgeneralised. |
| 9 | Page-shell counts (66 / 29) | Re-measured: `min-h-screen bg-[#FFF8F0]` in **76** `page.tsx` files (82 files overall), inner `max-w-7xl …` in **36**. | Minor drift; the pattern is confirmed. |
| 10 | Sidebar/catalog drift ("162 vs 160", "`/inventory/closing-history` sidebar-only") | **Confirmed exactly**: catalog 162, sidebar 160; catalog-only `/dine-in/order`, `/crm/guests`, `/settings/integrations/whatsapp`; sidebar-only `/inventory/closing-history`. | auth-rbac right. |
| 11 | Role list for §20 | Confirmed against the live DB: 9 roles, **0 users assigned to any of them**. Head Chef and Store Manager are `manager` tier carrying `is_head_chef` / `is_store_manager`. **No Maintenance, Supervisor or F&B Controller.** | auth-rbac right. |

## Carried forward — genuinely not determined

1. **Production row counts.** Everything measured here is the **local** `fnb-controller.db` (main file last written 10 Sep, with a 1.4 MB WAL). Production runs on AWS Lightsail and was not read. Specifically unknown: whether production `hr_employees` is populated, whether production users have `role_id` set (which would make `page_access` live and change R6 materially), and whether `shelf_life_days` / `storage_location` are equally empty there.
2. **Whether the external cron that drives `runTaskAutomation` is configured on the production box.** If it is not, nothing has ever escalated — and the same would be true of FSSAI if it takes that route.
3. **Rendered pixel measurements.** No server was started. `docs/mobile-audit.md` has real 375×812 data but is dated 2026-07-13 and audit-only; how many of its 36 findings are fixed was not verified.
4. **Print CSS.** `globals.css` has no `@media print` rules; the existing `/grn/print/[id]` and `/purchase-orders/[id]/print` views were not read line by line. If FSSAI prints from the browser rather than serving a PDF, that needs its own pass — under a path that does not contain `print`.
5. **Accessibility standard.** No focus trap, no `role="dialog"`, no `aria-live`, no skip link anywhere. Whether the owner wants any of that has not been asked.
6. **Whether production has recently run the `po_id` boot backfill.** The GRN-join recommendation in §5 row 3b is immune either way.

---

*End of contract. Everything below this line is the raw P0 lane evidence, preserved unedited. Where it disagrees with the contract above, the contract wins.*

---

# APPENDIX — RAW P0 LANE REPORTS (evidence, not instructions)

# FSSAI P0 RECON — LANE: AUTH / RBAC / NAVIGATION GATE

Worktree: `/Users/shashankreddy/Desktop/Claude/fnb-fssai`, branch `fssai-compliance` (forked from main @ `4125237`).
Source read at HEAD `4125237`; HEAD advanced to `dd03c58` during this pass via orchestrator commits that touched only `FSSAI-BUILD-STATE.md`, not `src/`. Every `file:line` below is against the `src/` tree as read.
Live repo `/Users/shashankreddy/Desktop/Claude/fnb-controller` was READ ONLY (62 pre-existing uncommitted files, unchanged). No code changed. No migration run. No server started.
Live DB read via `sqlite3 "file:…?mode=ro" "VACUUM INTO …"` into the scratchpad; the real file was never opened read-write.

Every claim below carries `file:line` or a command and its real output.

---

## 0. THE HEADLINE — READ THIS BEFORE DESIGNING ANY FSSAI GATE

Three measured facts that together decide the whole module's security design:

**FACT 1 — the roles table is fully built and COMPLETELY UNUSED in production.**

```
$ sqlite3 "file:<snapshot>?mode=ro" \
  "SELECT COUNT(*) AS total_users, SUM(role_id IS NOT NULL) AS with_role_id,
          SUM(page_access IS NULL) AS null_page_access FROM users;"
9|0|8
```

All 9 users. **Zero** have `role_id` set. **Eight of nine** have `page_access = NULL`.
Nine named roles exist (Administrator, Manager, Staff, Floor Manager, Captain, Cashier, Bar Manager, Head Chef, Store Manager) and **not one is assigned to anybody.**

**FACT 2 — a NULL `page_access` means FULL ACCESS**, `src/lib/page-catalog.ts:837`:

```ts
// No explicit map → grant everything (backward compat)
if (!user.page_access) return true;
```

**FACT 3 — therefore `page_access` gating is inert on the production database today.**
Eight of nine real users pass `canAccessPage()` for every path that is not tier-flagged. The ninth ("ZZ Kitchen Staff", `page_access = ["/requisitions"]`) is a test account.

### What this means for FSSAI, concretely

> **An FSSAI page with NO tier flag is visible to, and openable by, 8 of the 9 real users the day it ships — including every "staff" account. The `page_access` map will not stop them, because they do not have one.**

The load-bearing gates are, in this order:

1. **The tier flags** (`adminOnly` / `mgmtOnly` / `hodOnly`) — these are the ONLY catalog-level gates that run **before** the null-map grant (`page-catalog.ts:823,828,834` all precede line 837). They are real locks.
2. **The API route's own check** (`requireRole('admin')` / `isManagement()` / a bespoke helper). This is the actual security boundary for data.

The catalog entry is **navigation gating, not the security boundary** — the committed code says so repeatedly and correctly (e.g. `page-catalog.ts:329-330`, `:361-363`, `:536-539`, `:567-570`).

**Build rule this dictates:** every FSSAI route must self-authenticate. Do not let a catalog flag be the only thing standing between a line cook and the corrective-action log.

---

## 1. `src/lib/auth.ts` — SESSION, USER OBJECT, EXPORTED HELPERS

### 1.1 How the session is carried

Cookie `fnb_session`, `auth.ts:6`:

```ts
export const SESSION_COOKIE = 'fnb_session';
const SESSION_DAYS = 30;
```

Opaque 32-byte hex token (`auth.ts:62-64`), stored in a `sessions` table. Real schema from the live DB:

```sql
CREATE TABLE sessions (
        token       TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at  TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
```

Cookie attributes set at login, `src/app/api/auth/login/route.ts:27-33`:

```ts
c.set(SESSION_COOKIE, token, {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: maxAgeSec,
  secure: false, // local dev / LAN access over HTTP
});
```

Note `secure: false` — deliberate, the venue runs over LAN HTTP. Not an FSSAI decision to revisit.

### 1.2 The user object — `SessionUser` (`auth.ts:11-52`)

This is the **exact** shape every FSSAI server route will receive from `getCurrentUser()`. Real field names:

| Field | Type | Meaning (from the committed comments) |
|---|---|---|
| `id` | `string` | user id |
| `email` | `string` | |
| `name` | `string` | |
| `role` | `'admin' \| 'manager' \| 'staff'` | **resolved effective tier** — the named role's `base_role` wins over legacy `users.role` |
| `role_id` | `string \| null` | assigned named role id; **null for all 9 live users** |
| `role_name` | `string \| null` | e.g. "Floor Manager"; **null for all 9 live users** |
| `position` | `string` | free-text title (Bar Manager, Sous Chef, Storekeeper) |
| `department_id` | `string \| null` | "staff are tied to a department; null for admin/store/chef who are cross-cutting" |
| `is_head_chef` | `boolean` | **HOD flag.** Union of user's own column and the role's |
| `is_store_manager` | `boolean` | union of user + role |
| `can_approve_requisitions` | `boolean` | granular approve WITHOUT full HOD |
| `page_access` | `string \| null` | **JSON-stringified array.** `null` = full access |
| `visible_department_ids` | `string \| null` | JSON array; null = only own dept |
| `preferred_zones` | `string \| null` | captain zones |
| `preferred_table_ids` | `string \| null` | captain tables |
| `section` | `string` | `Kitchen\|Bar\|Service\|Maintenance\|Store` (`''` = unset) |
| `can_request_discount` | `boolean` | |
| `max_discount_pct` | `number` | |

**`section` IS EMPTY IN PRODUCTION** — measured:

```
$ sqlite3 … "SELECT COALESCE(NULLIF(section,''),'(empty)'), COUNT(*) FROM users GROUP BY 1;"
(empty)|9
```

All 9 users have `section = ''`. See §10 — this is the single biggest gap for §20's "Maintenance" role.

### 1.3 `getCurrentUser()` — `auth.ts:81-139`

Reads the cookie, joins `sessions → users LEFT JOIN roles`, checks expiry, resolves the effective tier and page set. The load-bearing resolution, `auth.ts:113-129`:

```ts
const hasRole = !!row.role_id && !!row.role_base;
…
role: ((hasRole ? row.role_base : row.role) as UserRole) || 'staff',
…
is_head_chef: !!row.is_head_chef || (hasRole && !!row.role_head_chef),
is_store_manager: !!row.is_store_manager || (hasRole && !!row.role_store),
can_approve_requisitions: !!row.can_approve_requisitions || (hasRole && !!row.role_can_approve_req),
page_access: row.page_access != null ? row.page_access : (hasRole ? (row.role_page_access ?? null) : null),
```

**Deliberate design note — a DEACTIVATED role still governs**, `auth.ts:104-107`:

```ts
// NOTE: we resolve access from the assigned role even if it's been deactivated
// (is_active=0) — a deactivated role keeps governing its users' pages/tier until
// they're reassigned. Otherwise a role-based user would fall back to a null
// page_access = ALL pages (privilege escalation). Roles in use can't be deleted.
```

The `roles` JOIN at `auth.ts:101` has **no** `is_active` filter. Any FSSAI admin screen that resolves a user's effective access must fetch roles with `?include_inactive=1` or it will misread those users as "no role".

### 1.4 Every other exported helper (complete list)

| Export | Line | Rule |
|---|---|---|
| `SESSION_COOKIE` | 6 | `'fnb_session'` |
| `UserRole` (type) | 9 | `'admin' \| 'manager' \| 'staff'` |
| `SessionUser` (interface) | 11 | §1.2 |
| `hashPassword` | 54 | bcrypt, 10 rounds |
| `verifyPassword` | 58 | |
| `newSessionToken` | 62 | 32 random bytes hex |
| `createSession` | 66 | inserts row, 30-day expiry |
| `destroySession` | 75 | |
| `getCurrentUser` | 81 | §1.3 |
| `canApproveAsChef` | 146 | `admin \|\| is_head_chef \|\| can_approve_requisitions` |
| `canManageKitchenProduction` | 159 | `admin \|\| manager \|\| is_head_chef` |
| `canProcessAsStore` | 163 | `admin \|\| is_store_manager` |
| `canIssueAsStore` | 171 | `!!is_store_manager` — **no admin bypass, deliberate** |
| `canApproveAsMgmt` | 177 | `role === 'admin'` only |
| `canApproveTableOp` | 182 | `admin \|\| manager \|\| role_name === 'Cashier'` |
| `isManagement` | 192 | **see below** |
| `verifyApprover` | 202 | email+password re-auth for on-the-spot override |
| `requireRole` | 239 | **see below** |
| `getCurrentOutletId` | 249 | selected outlet, falls back to default |
| `ensureFirstUser` | 263 | seeds `admin@local` / `admin123` if users empty |

**`isManagement`** — `auth.ts:192-195`. This is the one FSSAI will use most:

```ts
export function isManagement(user: { role?: string; is_head_chef?: boolean } | null): boolean {
  if (!user) return false;
  return user.role === 'admin' || user.role === 'manager' || !!user.is_head_chef;
}
```

Admin **OR** manager **OR** HOD. Note it takes a structural type, not `SessionUser` — it accepts any `{role, is_head_chef}`.

**`requireRole`** — `auth.ts:239-246`. **TRAP: it only ever enforces `admin`.**

```ts
export async function requireRole(role: 'admin' | 'manager'): Promise<…> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401, message: 'Sign in required' };
  if (role === 'admin' && user.role !== 'admin') {
    return { ok: false, status: 403, message: 'Admin role required' };
  }
  return { ok: true, user };
}
```

`requireRole('manager')` authenticates but **authorises nothing** — a `staff` user passes it. Do not use `requireRole('manager')` in FSSAI expecting a manager gate; use `isManagement(me)` with an explicit 403.

---

## 2. `src/proxy.ts` — WHAT IT GUARDS AND WHAT IT DOES NOT

Next.js 16 renamed `middleware` → `proxy`. There is **no** `src/middleware.ts` (verified: `ls: src/middleware.ts: No such file or directory`).

### 2.1 The matcher — `proxy.ts:301-304`

```ts
// Run on every request except static asset paths Next.js handles internally.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

So it runs on **everything**, pages and APIs alike.

### 2.2 What it actually does, step by step

| Step | Lines | Applies to | What it does |
|---|---|---|---|
| 1 | 154-165 | all | Public bypass (`isPublic()`), issues CSRF cookie on `/login` |
| 2 | 167-176 | all | **Cookie PRESENCE** check. API → 401 JSON; page → redirect to `/login?next=…` |
| 2b | 178-229 | **PAGES ONLY** (`if (!isApi)`) | `canAccessPage()` enforcement + `firstAllowedPath()` fallback redirect |
| 2c | 231-246 | APIs, **state-changing only** | Validates the session token against the DB |
| 3 | 248-261 | APIs, state-changing, **prefix-listed only** | CSRF double-submit check |
| 4 | 263-271 | non-API | Ensures CSRF cookie exists |

### 2.3 THE CRITICAL BOUNDARY — it guards PAGES, not APIs

`proxy.ts:181` gates the whole page-access block:

```ts
if (!isApi) {
```

**No API route anywhere in this app has its page access checked by the proxy.** For `/api/*` the proxy only proves:
- the `fnb_session` cookie is *present* (step 2), and
- for POST/PUT/PATCH/DELETE only, that the token is *valid* (step 2c), and
- for POST/PUT/PATCH/DELETE on a *listed prefix* only, that CSRF matches (step 3).

**A GET to any API route is checked for cookie PRESENCE ONLY.** A forged/expired cookie string reaches every GET handler. The committed comment at `proxy.ts:235-236` says exactly this:

```
// (GETs stay lenient; sensitive GETs authenticate in-handler.)
```

This is why the Kitchen Production note at `page-catalog.ts:229-236` states the flag "never protected the DATA". **Every FSSAI GET that returns compliance records must call `getCurrentUser()` itself.**

### 2.4 Two ADDITIONAL proxy-level fail-opens (beyond the four in §3)

**(a) DB error → page gate skipped entirely**, `proxy.ts:228`:

```ts
} catch { /* on DB error, fall through — fail open */ }
```

**(b) Unresolvable session row → page gate skipped entirely**, `proxy.ts:202-210`:

```ts
const user = row ? { … } : undefined;
…
if (user && !canAccessPage(pathname, user)) {
```

If the `SELECT` returns no row (expired session, deactivated user) `user` is `undefined` and the `&&` short-circuits — **the page-access check never runs**. Step 2 already let the request past on cookie presence. The page itself then renders and must handle `getCurrentUser() === null`.

FSSAI page components must not assume the proxy authenticated them.

### 2.5 The tier resolution in the proxy MUST mirror `getCurrentUser`

`proxy.ts:194-209` re-implements the role resolution with its own SQL. The comment at `:205-207` is explicit:

```ts
// Effective HOD flag = own column OR assigned role's flag. Mirror
// getCurrentUser EXACTLY (auth.ts): the role contributes only when it is a
// real assigned role (role_id AND base_role present), so the two never drift.
is_head_chef: !!row.is_head_chef || (!!row.role_id && !!row.role_base && !!row.role_head_chef),
```

**FSSAI adds no new field here** as long as it gates on `role` / `is_head_chef` / `page_access`. If any FSSAI gate needs a *new* user attribute at the page level, it must be added in **both** `auth.ts:114-138` and `proxy.ts:202-209` or the sidebar and the proxy will disagree.

### 2.6 Public paths — FSSAI must not collide

`isPublic()`, `proxy.ts:97-143`. Two wildcards worth knowing:

```ts
if (pathname.includes('/print')) return true;            // PO print pages render via cookie if present
```

`proxy.ts:125` — **`.includes()`, not `.startsWith()`.** Any FSSAI path containing the substring `/print` anywhere becomes PUBLIC. A route like `/fssai/reports/print` or `/api/fssai/print-certificate` would be **unauthenticated**. Avoid the substring, or accept that the route must authenticate entirely in-handler.

```ts
if (pathname.match(/\.(png|jpg|jpeg|svg|ico|webp|gif|css|js|jsx|mjs|map|json|webmanifest|txt|woff2?|ttf|bat|ps1)$/)) return true;
```

`proxy.ts:141` — any path ending in those extensions is public. FSSAI photo-evidence URLs must not end in `.png`/`.jpg` if they are meant to be access-controlled; serve them through a route that authenticates and streams.

---

## 3. `canAccessPage` — THE FOUR FAIL-OPENS

`src/lib/page-catalog.ts:812-848`. Full body, in order:

```ts
export function canAccessPage(
  pathname: string,
  user: { role?: string; page_access?: string | null; is_head_chef?: boolean } | null,
): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (ALWAYS_ALLOWED.some(p => pathname === p)) return true;

  if (isHodOnlyPath(pathname) && !user.is_head_chef) return false;          // :823
  if (isMgmtOnlyPath(pathname) && !(user.role === 'manager' || user.is_head_chef)) return false;  // :828
  if (isAdminOnlyPath(pathname)) return false;                             // :834

  // No explicit map → grant everything (backward compat)
  if (!user.page_access) return true;                                      // ① :837

  let allowed: string[];
  try { allowed = JSON.parse(user.page_access); }
  catch { return true; }   // garbled value → don't lock out                  ② :841
  if (!Array.isArray(allowed) || allowed.length === 0) return true;        // ③ :842

  return allowed.some(p => pathname === p || pathname.startsWith(p + '/')); // ④ :847
}
```

### The four, named

| # | Line | Trigger | Result |
|---|---|---|---|
| ① | 837 | `page_access` is `NULL` | **ALL pages granted.** Hits 8 of 9 live users |
| ② | 841 | `page_access` is unparseable JSON | **ALL pages granted** |
| ③ | 842 | parsed value is not an array, **or is an empty array** | **ALL pages granted** |
| ④ | 847 | prefix match — `pathname.startsWith(p + '/')` | a **parent grant carries every sibling page under that URL prefix** |

### Fail-open ④ quantified by the committed code itself

`page-catalog.ts:862-868`:

```
 * Across the catalog 8 parents carry 43 such grants:
 *   /tasks +14, /crm-calls +10, /inventory +7, /reports +6,
 *   /kitchen-production +3, /dine-in/kitchen +1, /vendors +1,
 *   /settings/integrations +1
```

**FSSAI will add a 9th.** A catalog parent `/fssai` with 20 children means **one tick of `/fssai` grants all 20 FSSAI pages**, including anything sensitive. The strict twin `canAccessPageStrict()` (`:943-977`) exists and fixes exactly this, but `:850-882` is unambiguous:

```
 * STRICT PATH MATCHING — MEASURED, **NOT YET ENFORCED**. DO NOT WIRE UP.
…
 * If you are here to "finish the fix", the fix is a one-line swap in
 * canAccessPage — but do not make it until the owner says the top-ups are done.
```

**Do not wire it up during the FSSAI build.** Design the FSSAI catalog around the prefix leak instead: put anything that must not be carried by a `/fssai` tick behind a **tier flag** (which runs before the map) rather than relying on a separate grant.

### Which gate is actually load-bearing?

**Only the three tier flags**, because they are the sole checks that execute *before* fail-opens ① ② ③. On today's production data `page_access` decides nothing for 8 of 9 users. For FSSAI the answer is:

> Tier flag = the page lock. API self-check = the data lock. `page_access` = a preference, not a boundary.

---

## 4. THE TIER FLAGS — EXACT DEFINITIONS

The complete type, `page-catalog.ts:17-39` (quoted verbatim, all three flags, nothing omitted):

```ts
export interface PageEntry {
  /** Path that proxy.ts + sidebar will match against */
  path: string;
  /** Display label */
  label: string;
  /**
   * When true, only HODs (is_head_chef) and admins may see/open this page,
   * regardless of the user's page_access map. First catalog-level tier gate.
   */
  hodOnly?: boolean;
  /**
   * When true, only management — Admin, any Manager, or an HOD (is_head_chef) —
   * may see/open this page. Broader than hodOnly (which excludes managers). Used
   * for sensitive customer PII (the Customers page).
   */
  mgmtOnly?: boolean;
  /**
   * When true, ONLY an Admin (role === 'admin') may see/open this page —
   * stricter than mgmtOnly/hodOnly. Used for admin-only consoles like the App
   * Errors page. Non-admins are blocked even with an explicit page_access grant.
   */
  adminOnly?: boolean;
}
```

### Precise semantics (derived from the code, not the prose)

| Flag | Enforcing line | Who passes |
|---|---|---|
| `adminOnly` | `:834` `if (isAdminOnlyPath(pathname)) return false;` | **admin only** (admins already returned `true` at `:817`) |
| `mgmtOnly` | `:828` `!(user.role === 'manager' \|\| user.is_head_chef)` | admin, **manager**, HOD |
| `hodOnly` | `:823` `!user.is_head_chef` | admin, **HOD only** |

### CONFIRMED: `hodOnly` = HODs + admins, EXCLUDING managers

Yes. `:823` tests `is_head_chef` alone. A user with `role === 'manager'` and `is_head_chef === 0` is **blocked**. The type comment at `:30` says the same ("Broader than hodOnly (which excludes managers)").

Caveat on the live data: the seeded **Head Chef** role has `base_role = 'manager'` AND `is_head_chef = 1`, so in practice an HOD is also management. But the *flag* does not grant on tier — only on `is_head_chef`.

### Is there any other flag (e.g. `unbuilt`)?

**No.** Measured:

```
$ grep -rn "unbuilt" src/
(no matches)

$ grep -n "^\s*\(hodOnly\|mgmtOnly\|adminOnly\|unbuilt\)?:" src/lib/page-catalog.ts
26:  hodOnly?: boolean;
32:  mgmtOnly?: boolean;
38:  adminOnly?: boolean;
```

`PageEntry` has exactly `path`, `label`, and those three optional booleans. See §9 for what actually happens to an unbuilt page.

### Longest-prefix matching for flags

`bestEntry()`, `page-catalog.ts:584-594`, picks the **longest** matching catalog path:

```ts
if (pathname === p.path || pathname.startsWith(p.path + '/')) {
  if (!best || p.path.length > best.path.length) best = p;
}
```

So a child entry can sit *unflagged* under a *flagged* parent and escape the lock — and vice versa. This is how `/kitchen-production/scan` stays open under a once-`hodOnly` `/kitchen-production` (`:580-583`). **FSSAI can use this deliberately:** flag `/fssai/documents` `mgmtOnly` while `/fssai` itself stays open, or flag the parent and carve out the staff runner as a longer child path.

### `hodOnly` can be switched OFF at runtime by an admin

`page-catalog.ts:621-651`. State is a per-bundle module global:

```ts
let HOD_ONLY_OVERRIDES: Record<string, false> | null = null;
```

`isHodOnlyPath()` at `:643-651`:

```ts
export function isHodOnlyPath(pathname: string): boolean {
  const entry = bestEntry(pathname);
  if (!entry?.hodOnly) return false;
  if (HOD_ONLY_OVERRIDES && HOD_ONLY_OVERRIDES[entry.path] === false) return false;
  return true;
}
```

Constraints that make this safe (`:600-619`): only `false` values survive sanitisation (`:632-634`), it is consulted **only** when the coded flag is `hodOnly`, so **`mgmtOnly` and `adminOnly` are untouchable by construction**, and anything malformed resets to `null` (coded flags stand).

Plumbing: server side `loadHodOnlyOverrides()` (`src/lib/hod-overrides.ts:53`, 2s TTL) is called by `proxy.ts:190` before every `canAccessPage`; client side the Sidebar pushes it from `/api/auth/me` (`Sidebar.tsx:515`).

**Implication for FSSAI:** an `hodOnly` FSSAI page is *relaxable by an admin without a deploy*. `mgmtOnly` and `adminOnly` are not. If a gate must be non-negotiable, do not use `hodOnly`.

---

## 5. THE ROLES SYSTEM

### 5.1 The `roles` table — real DDL, `src/lib/db.ts:2800-2814`

```sql
CREATE TABLE IF NOT EXISTS roles (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  base_role        TEXT NOT NULL DEFAULT 'staff',   -- admin | manager | staff
  page_access      TEXT,                            -- JSON array of paths; NULL = all pages
  is_head_chef     INTEGER NOT NULL DEFAULT 0,
  is_store_manager INTEGER NOT NULL DEFAULT 0,
  is_system        INTEGER NOT NULL DEFAULT 0,
  is_active        INTEGER NOT NULL DEFAULT 1,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  description      TEXT DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_roles_active ON roles(is_active);
```

Three columns added later by boot migration (`db.ts:2822-2827`), each guarded by a `PRAGMA table_info(roles)` check:

```sql
ALTER TABLE roles ADD COLUMN can_request_discount     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE roles ADD COLUMN max_discount_pct         REAL    NOT NULL DEFAULT 0;
ALTER TABLE roles ADD COLUMN can_approve_requisitions INTEGER NOT NULL DEFAULT 0;
```

And on `users`, `db.ts:2816-2817` — a `PRAGMA table_info(users)` guard followed by:

```sql
ALTER TABLE users ADD COLUMN role_id TEXT;
```

`users.role_id` is a plain `TEXT` column — **no foreign key**.

### 5.2 Resolution happens in TWO places that must stay in sync

| Where | Lines | Purpose |
|---|---|---|
| `src/lib/auth.ts` | 89-138 (`getCurrentUser`) | every server route, every API handler, the Sidebar via `/api/auth/me` |
| `src/proxy.ts` | 194-209 | the page gate at the network boundary |

They resolve the same three things — effective `role`, effective `page_access`, effective `is_head_chef` — with **separate SQL**. `auth.ts` additionally resolves `is_store_manager`, `can_approve_requisitions`, discount fields.

The two SQL statements differ in one respect worth recording:

- `auth.ts:102` — `WHERE s.token = ? AND u.is_active = 1` (expiry checked in JS at `:109`)
- `proxy.ts:200` — `WHERE s.token = ? AND u.is_active = 1 AND s.expires_at > datetime('now')` (expiry in SQL)

Same outcome, different mechanism. `verifyApprover` (`auth.ts:214`) is a **third** copy and is the only one that joins `roles … AND r.is_active = 1`.

### 5.3 The live roles — exact production data

```
name           base_role  hod  store  appr  sys  act  ord  pages
-------------  ---------  ---  -----  ----  ---  ---  ---  ---------
Administrator  admin      0    0      0     1    1    0    NULL(all)
Manager        manager    0    0      0     1    1    1    NULL(all)
Staff          staff      0    0      0     1    1    2    len=17
Floor Manager  manager    0    0      0     0    1    10   len=163
Captain        staff      0    0      0     0    1    11   len=12
Cashier        staff      0    0      0     0    1    12   len=99
Bar Manager    manager    0    0      0     0    1    13   len=130
Head Chef      manager    1    0      0     0    1    14   len=87
Store Manager  manager    0    1      0     0    1    15   len=148
```

Verbatim page bundles:

```
Administrator  ->  NULL
Manager        ->  NULL
Staff          ->  ["/requisitions"]
Floor Manager  ->  ["/","/dine-in/floor","/dine-in/tables","/dine-in/kitchen","/dine-in/order","/dine-in/reconciliation","/captain","/print/agent","/reports","/dine-in/reservations"]
Captain        ->  ["/captain"]
Cashier        ->  ["/dine-in/floor","/dine-in/tables","/dine-in/order","/captain","/dine-in/reservations","/cashier"]
Bar Manager    ->  ["/dine-in/floor","/dine-in/tables","/dine-in/kitchen","/dine-in/offline-print","/print/agent","/reports","/dine-in/reservations"]
Head Chef      ->  ["/dine-in/kitchen","/requisitions","/menu-items","/recipes","/department-consumption"]
Store Manager  ->  ["/store-dashboard","/store-requisitions","/purchases","/purchase-orders","/grn","/inventory","/closing-stock","/wastage","/departments","/vendors"]
```

Note **`Administrator` and `Manager` both carry `page_access = NULL` = ALL pages.** Assigning the seeded "Manager" role to someone grants them every non-`adminOnly` page in the app, FSSAI included.

### 5.4 `/settings/roles` — how the UI works

Page: `src/app/settings/roles/page.tsx`. API: `src/app/api/auth/roles/route.ts` — **all four verbs are `requireRole('admin')`** (`:28, :47, :70, :111`).

The page grid is built **directly from `PAGE_CATALOG`** (`page.tsx:5`, rendered at `:273` and `:320`), section by section with a per-section count (`:285` `{selCount}/{section.pages.length}`). **An FSSAI section added to `PAGE_CATALOG` appears in this grid automatically — no edit to the roles page is needed.**

Submission, `page.tsx:113`:

```ts
page_access: draft.base_role === 'admin' ? null : Array.from(draft.pages),
```

`GET` supports `?include_inactive=1` (`route.ts:35`) — required by admin screens, per the comment at `:31-34`, because a deactivated role still governs.

Delete is a **soft delete** (`route.ts:121` sets `is_active = 0`), refused for `is_system` roles (`:118`) and for roles in use (`:119-120`).

### 5.5 THE EMPTY-ARRAY RULE — and a sharper trap next to it

**Confirmed: an empty array means FOLLOW-ROLE / no restriction on the wire, never deny-all.**

Per-user path, `src/app/api/auth/users/route.ts:38-52`:

```ts
/**
 * Normalize a JSON-array column (page_access, visible_department_ids,
 * preferred_zones, preferred_table_ids) for storage.
 *   undefined / null / []  → null  (column NULL = "the default applies")
 *   ['/a','/b']            → '["/a","/b"]'
 * An EMPTY array deliberately stores NULL, never '[]': on the wire an empty
 * page_access means "follow the role" (canAccessPage + proxy both treat an
 * empty array as no restriction), so persisting '[]' would read as a grant,
 * not a lockout. PUT has always done this — POST now matches it.
 */
function jsonArrOrNull(input: unknown): string | null {
  if (!Array.isArray(input)) return null;
  const vals = input.filter((v) => typeof v === 'string' && v !== '');
  return vals.length ? JSON.stringify(vals) : null;
}
```

And `users/route.ts:154-159`:

```ts
// page_access: array of paths → JSON string. null/[] clears the map (= full access).
if (page_access !== undefined) {
  if (page_access === null || (Array.isArray(page_access) && page_access.length === 0)) {
    sets.push('page_access = NULL'); // no param push for NULL
```

Three layers agree: the wire (`[]` → `NULL`), the column (`NULL`), and the reader (`canAccessPage:837` → `true`).

**⚠️ THE SHARPER TRAP — `cleanPages` silently grants EVERYTHING on an all-unknown array.**

`src/app/api/auth/roles/route.ts:13-18`:

```ts
/** Keep only real catalog paths; null/empty → NULL (= all pages). */
function cleanPages(input: unknown): string | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const valid = input.filter((p) => typeof p === 'string' && ALL_PAGE_PATHS.includes(p));
  return valid.length ? JSON.stringify(valid) : null;
}
```

It filters against `ALL_PAGE_PATHS` (`page-catalog.ts:577`), and **if nothing survives the filter it returns `null` — which is ALL PAGES.**

> **FSSAI build consequence:** if FSSAI pages are surfaced in the roles UI but are **not registered in `PAGE_CATALOG`**, an admin who creates an "FSSAI Inspector" role and ticks *only FSSAI pages* will have every path filtered out → `page_access = NULL` → **that role is granted every page in the application**, including `/hr/payroll` and `/admin/database` (minus `adminOnly`, which still blocks at read time).
>
> **Rule: register every FSSAI path in `PAGE_CATALOG` in the same commit that makes it tickable. Never one without the other.**

---

## 6. CSRF — `fnb_csrf` / `x-csrf-token`

Classic double-submit. Cookie is **not** `httpOnly` on purpose so JS can echo it.

### 6.1 Where issued (three places)

| Where | Line | When |
|---|---|---|
| `src/app/api/auth/login/route.ts:34-41` | on successful login | fresh 16-byte hex, `maxAge` = session lifetime |
| `src/proxy.ts:157-162` | visiting `/login` without the cookie | so the very first POST has one |
| `src/proxy.ts:264-270` | any signed-in non-API request missing it | self-healing |

Login route, `:34-41`:

```ts
// Issue a fresh CSRF token. NOT httpOnly so the browser JS can read & echo it in the header.
const csrf = randomBytes(16).toString('hex');
c.set(CSRF_COOKIE, csrf, {
  httpOnly: false,
  sameSite: 'lax',
  path: '/',
  maxAge: maxAgeSec,
  secure: false,
});
```

### 6.2 Where enforced — `proxy.ts:248-261`

```ts
if (isApi && isStateChanging(req.method)) {
  const required = CSRF_REQUIRED_PREFIXES.some(p => pathname.startsWith(p));
  if (required) {
    const cookieToken = req.cookies.get(CSRF_COOKIE)?.value;
    const headerToken = req.headers.get(CSRF_HEADER);
    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      return NextResponse.json(
        { error: 'CSRF token missing or mismatched. Refresh the page.' },
        { status: 403 },
      );
    }
  }
}
```

`isStateChanging` = POST/PUT/PATCH/DELETE (`proxy.ts:145-147`). GETs are never CSRF-checked.

**Enforcement is OPT-IN BY PREFIX.** `CSRF_REQUIRED_PREFIXES` (`proxy.ts:30-95`) is a hand-maintained list of 60 prefixes. **`/api/fssai` is not on it.**

> **FSSAI build consequence:** add `'/api/fssai',` to `CSRF_REQUIRED_PREFIXES` in `src/proxy.ts`. One prefix covers every present and future FSSAI mutation — exactly the pattern the HR module used (`proxy.ts:94`: *"one prefix covers every present and future HR mutation; HR client writes must use src/lib/api.ts or they 403 here"*). Without it, every FSSAI write is CSRF-unprotected.

### 6.3 The helper every page uses — `src/lib/api.ts`

The load-bearing part (`api.ts:27-45`):

```ts
export async function api(input: string, init: ApiOptions = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const method  = (init.method || 'GET').toUpperCase();

  // Auto-JSON
  let body = init.body;
  if (body && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    body = JSON.stringify(body);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  }

  // CSRF
  if (isStateChanging(method)) {
    const token = readCookie(CSRF_COOKIE);
    if (token) headers.set('X-CSRF-Token', token);
  }

  return fetch(input, { ...init, method, headers, body, credentials: 'same-origin' });
}
```

Plus `apiJson<T>()` (`:48-56`) which throws on `!res.ok`, extracting `.error` from the JSON body.

Usage contract (`api.ts:5-7`):

```ts
import { api } from '@/lib/api';
await api('/api/purchase-orders', { method: 'POST', body: { … } });
```

`body` may be a plain object — it is auto-stringified. `FormData` passes through untouched, which matters for FSSAI **photo evidence uploads** (the CSRF header is still injected; `Content-Type` is correctly left for the browser to set with its boundary).

> **FSSAI client rule:** every state-changing FSSAI fetch goes through `api()` / `apiJson()`. A bare `fetch()` POST will 403 once `/api/fssai` is added to the prefix list. Bare `fetch()` is fine for GETs (`isStateChanging` never fires).

---

## 7. HOW AN API ROUTE GATES ITSELF — THE THREE PATTERNS TO COPY

Scale, for calibration:

```
$ find src/app/api -name route.ts | wc -l            →  475
$ grep -rl "getCurrentUser" src/app/api | wc -l      →  370
$ grep -rl "requireRole('admin')" src/app/api | wc -l →   82
$ grep -rl "isManagement" src/app/api | wc -l        →   58
```

### Pattern A — ADMIN tier. `src/app/api/settings/hod-only/route.ts`

```ts
import { requireRole } from '@/lib/auth';
…
const gate = await requireRole('admin');                                       // :40
if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });  // :41
```

Repeated per verb (`:40-41` GET, `:49-50` PUT). Unauthorised response: `401 {"error":"Sign in required"}` when signed out, `403 {"error":"Admin role required"}` when signed in as a non-admin (strings from `auth.ts:241,243`).

Use for: FSSAI settings, template authoring, anything that rewrites compliance history.

### Pattern B — MANAGEMENT tier. `src/app/api/department-variance/route.ts`

```ts
import { getCurrentUser, isManagement } from '@/lib/auth';   // :2
…
const me = await getCurrentUser();                            // :248
if (!isManagement(me)) {
  return Response.json({ error: 'Management only' }, { status: 403 });  // :250
}
```

Unauthorised response: `403 {"error":"Management only"}`. Note it does **not** distinguish signed-out (401) — `isManagement(null)` returns `false` (`auth.ts:193`) so an anonymous caller also gets 403.

Use for: FSSAI verification, corrective-action sign-off, inspection-ready exports.

### Pattern C — AUTHENTICATED + BESPOKE AUTHORITY. `src/app/api/grn/[id]/qc/route.ts`

The closest existing analogue to an FSSAI checklist runner, and the pattern to copy for "any staffer in the right department may record this":

```ts
const me = await getCurrentUser();                                        // :53
if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });  // :54
…
if (!canSignQcFor(db, me, checker)) {                                     // :105
  return Response.json({ … }, { status: 403 });                          // :110
}
```

The authority helper itself, `src/lib/grn-qc.ts:869-890` — worth copying wholesale for FSSAI's "who may sign this check?":

```ts
export function canSignQcFor(
  db: Database.Database,
  user: SessionUser | null,
  checker: QcChecker,
): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  // A head of department may sign. The escalation goes to them, but decision 6
  // says the HOD is not the ONLY one who may — not that they may not.
  if (user.is_head_chef) return true;
  if (checker === 'none') return false;

  const wanted = checker === 'both' ? ['kitchen', 'bar'] : [checker];
  const section = String(user.section || '').toLowerCase().trim();
  if (section && wanted.includes(section)) return true;
  try {
    const main = mainDeptOf(db, user.department_id);
    const name = String(main?.name || '').toLowerCase().trim();
    if (name && wanted.includes(name)) return true;
  } catch { /* unreadable department tree ⇒ no membership proven ⇒ refuse */ }
  return false;
}
```

Note the two-key membership test (`section` **OR** resolved main department name), the lowercase/trim normalisation, and that the `catch` **fails closed** — the opposite of `proxy.ts:228`.

Also note it is the **exact shape** §20's "Staff / Chef / Store Manager / Maintenance" gating needs — but see §10: `section` is empty for all 9 live users, so today only the `department_id` branch and the `admin`/`is_head_chef` short-circuits can ever return true.

### The response vocabulary FSSAI should match

| Situation | Status | Body |
|---|---|---|
| no session | 401 | `{"error":"Sign in required"}` |
| signed in, not admin | 403 | `{"error":"Admin role required"}` |
| signed in, not management | 403 | `{"error":"Management only"}` |
| signed in, wrong department/section | 403 | `{"error":"<specific sentence naming who may>"}` |
| CSRF fail (from proxy) | 403 | `{"error":"CSRF token missing or mismatched. Refresh the page."}` |

`apiJson()` surfaces `.error` as the thrown message (`api.ts:52`), so these strings reach the user directly. Write them as sentences.

---

## 8. THE SIDEBAR / CATALOG DRIFT TRAP

Two files keep two independent lists. A page in only one of them is either **gated but invisible** or **visible but un-gated**.

### 8.1 Exact row shape in EACH file

**`src/lib/page-catalog.ts`** — the gate. Type at `:17-39` (§4). A section, `:41-46`:

```ts
export interface PageSection {
  /** Section heading */
  label: string;
  /** Pages inside this section. Children must be a non-empty list */
  pages: PageEntry[];
}
```

Real rows (`:437-438`, `:443`):

```ts
{ path: '/hr',           label: 'HR Dashboard', mgmtOnly: true },
{ path: '/hr/employees', label: 'Employees',    mgmtOnly: true },
{ path: '/hr/geofences',  label: 'Geofences',            adminOnly: true },
```

**`src/components/Sidebar.tsx`** — the nav. Types at `:84-86`:

```ts
type NavLink    = { kind: "link"; label: string; href: string; icon: LucideIcon };
type NavSection = { kind: "section"; label: string; icon: LucideIcon; items: NavLink[] };
type NavEntry   = NavLink | NavSection;
```

Real rows (`:381-382`, `:397`):

```ts
{ kind: "link", label: "HR Dashboard", href: "/hr",            icon: LayoutDashboard },
{ kind: "link", label: "Employees",    href: "/hr/employees",  icon: Users },
{ kind: "link", label: "Geofences",    href: "/hr/geofences",  icon: Radar },
```

Differences that cause mistakes: **`path` vs `href`**, the sidebar requires an **`icon`** (a `lucide-react` import), and **the sidebar carries NO tier flags** — visibility is computed by running `canAccessPage` over the nav tree (`Sidebar.tsx:523-535`):

```ts
const filteredNavTree = useMemo<NavEntry[]>(() => {
  if (!me) return navTree;   // optimistic — most users have full access
  return navTree
    .map(entry => {
      if (entry.kind === 'link') {
        return canAccessPage(entry.href, me) ? entry : null;
      }
      const allowed = entry.items.filter(i => canAccessPage(i.href, me));
      if (allowed.length === 0) return null;
      return { ...entry, items: allowed };
    })
    .filter((e): e is NavEntry => e !== null);
}, [me]);
```

So tier flags propagate to the sidebar **automatically** — but only for rows that exist in `navTree`. A section whose children are all filtered out disappears entirely (`:531`).

Note `:524` — `if (!me) return navTree;` renders the **whole unfiltered tree** before `/api/auth/me` resolves. Restricted users see a flash of every link. Not an FSSAI bug to fix, but do not read a screenshot of the sidebar as proof of access.

### 8.2 A real grouped section, quoted — the template for FSSAI

**Catalog** (`page-catalog.ts:435-462`, HR, 19 entries) — header comment first, because it states the trap and the rules FSSAI inherits:

```ts
  {
    // HR — HRMS module (contract: docs/HRMS_DECISIONS.md). Entries are added
    // phase by phase: registering a path whose page.tsx does not exist yet gives
    // granted users a 404 (the proxy happily lets them through), so this list
    // must only ever name pages that are BUILT. Phase 1: dashboard, employees,
    // settings.
    //
    // Every entry here is tier-flagged on purpose: canAccessPage fails OPEN for
    // legacy NULL page_access users (8 of 9 on the reference DB), so an
    // unflagged HR page would be visible to nearly everyone the day it ships.
    label: 'HR',
    pages: [
      { path: '/hr',           label: 'HR Dashboard', mgmtOnly: true },
      { path: '/hr/employees', label: 'Employees',    mgmtOnly: true },
      …
      { path: '/hr/settings',  label: 'HR Settings',  adminOnly: true },
    ],
  },
```

**Sidebar** (`Sidebar.tsx:370-401`):

```ts
  // HR — HRMS module (contract: docs/HRMS_DECISIONS.md). Every entry here must
  // ALSO be registered in src/lib/page-catalog.ts (and vice versa) — this file
  // keeps its own nav tree, and a catalog-only page is correctly gated but
  // completely invisible. Rows are added phase by phase, only for pages that
  // exist. canAccessPage() filters per user, so mgmtOnly/adminOnly visibility
  // is automatic once the row is here.
  {
    kind: "section",
    label: "HR",
    icon: Users,
    items: [
      { kind: "link", label: "HR Dashboard", href: "/hr",            icon: LayoutDashboard },
      …
      { kind: "link", label: "HR Settings",  href: "/hr/settings",   icon: Settings2 },
    ],
  },
```

### 8.3 DEEPEST NESTING THE SIDEBAR SUPPORTS: **TWO LEVELS. NO MORE.**

`NavSection.items` is typed `NavLink[]` (`:85`) — **not** `NavEntry[]`. A section cannot contain a section. Confirmed by the renderer, `renderSection()` at `:604-643`:

```ts
{open && (
  <div className="space-y-0.5">
    {section.items.map(i => renderLink(i, true))}
  </div>
)}
```

It maps straight to `renderLink` — there is no recursive branch. `renderLink(item, indent)` supports exactly one indent level (`:595` `${indent && !collapsed ? "pl-9" : ""}`).

**Verdict for FSSAI's "parent with 20 children": it fits natively and needs no change.** One `NavSection` labelled "FSSAI Compliance" with 20 `NavLink` items is the *normal* size here — measured section sizes:

```
catalog:  Dine-In 20 | Admin 22 | Inventory 19 | HR 19 | Reports 19 | CRM 17 | Task Management 15
sidebar:  Settings 23 | Inventory 20 | Dine-In 19 | HR 19 | Reports 17 | CRM 17 | Task Management 15
```

If sub-grouping within FSSAI is wanted (e.g. "Daily Checks" / "Logs" / "Documents"), the options are (a) several sibling top-level sections, (b) flat 20 with ordering doing the grouping — the existing app's choice everywhere — or (c) extend `NavSection.items` to `NavEntry[]` and make `renderSection` recursive. **(c) is an app-wide nav change and violates "do not redesign the app". Prefer (b), fall back to (a).**

Note the section header renders a live child count (`:630` `({section.items.length})`) — that is the *filtered* count, so it is already per-user correct.

### 8.4 Current live drift — measured, not assumed

```
catalog entries: 162 | sidebar links: 160

--- IN CATALOG, NOT IN SIDEBAR (gated but INVISIBLE) ---
   /dine-in/order
   /crm/guests
   /settings/integrations/whatsapp

--- IN SIDEBAR, NOT IN CATALOG (visible, inherits prefix grant) ---
   /inventory/closing-history
```

Three of these are deliberate and documented: `/crm/guests` is *"Kept accessible (deep links / points admin) but off the sidebar"* (`page-catalog.ts:409-411`); `/settings/integrations/whatsapp` is reachable via its parent page; `/dine-in/order` is discussed in §9.

`/inventory/closing-history` is the reverse case — a sidebar link with no catalog entry. It is not ungated: `canAccessPage` matches it via fail-open ④ against an `/inventory` grant. But it cannot be granted or denied *individually*, and it does not appear in the roles/page-access grid. **This is precisely the drift FSSAI must not reproduce.**

### 8.5 The rule FSSAI must follow

> **Every FSSAI path goes in BOTH files, in the same commit.** Catalog-only = gated and invisible (this is how `/variance-approvals` was lost once). Sidebar-only = visible, un-individually-grantable, and absent from the roles grid.

---

## 9. `homePathFor` / `firstAllowedPath` / THE UNBUILT PAGE

### 9.1 `homePathFor` — `page-catalog.ts:689-777`

Chooses a landing page for a freshly-opened session. Call sites: `src/app/launch/page.tsx:21`, `src/app/login/page.tsx:60`, `src/components/BackExitGuard.tsx:210`.

Mechanism: build an ordered preference list, return the **first entry `canAccessPage` actually allows**.

```ts
const isMgmt = user.role === 'admin' || user.role === 'manager' || user.is_head_chef;
// Legacy full-access (null map) NON-management users … Send them to the dashboard '/'
if (!user.page_access && !isMgmt) return '/';           // :697
const prefs: string[] = [];
if (isMgmt) prefs.push('/');                             // :700
```

Then a **strictly-read** cashier check (`:737-746`) — deliberately *not* using `canAccessPage`, because that function's fail-opens would make every legacy user look like a cashier:

```ts
let grantsCashierPage = false;
if (user.page_access) {
  try {
    const map: unknown = JSON.parse(user.page_access);
    grantsCashierPage =
      Array.isArray(map) &&
      map.some(p => typeof p === 'string' && ('/cashier' === p || '/cashier'.startsWith(p + '/')));
  } catch { grantsCashierPage = false; }   // garbled map → not an explicit grant
}
if (grantsCashierPage) prefs.push('/cashier');
```

Then role homes (`:751-767`): `/captain`, `/crm-calls/recovery`, `/crm-calls`, `/dine-in/kitchen`, `/dine-in/floor`, `/cashier`, `/requisitions`, `/tasks/my`, `/`.

Then resolution and fallback (`:768-776`):

```ts
for (const p of prefs) if (canAccessPage(p, user)) return p;
for (const section of PAGE_CATALOG) {
  for (const pg of section.pages) if (canAccessPage(pg.path, user)) return pg.path;
}
return '/login';
```

**FSSAI implication:** the fallback sweep runs `PAGE_CATALOG` in **declaration order**. An FSSAI section placed near the top would become the landing page for any user whose only grants are FSSAI pages — probably desirable. It must **not** be placed before `Core` (`/` Dashboard) or management users with restricted maps could land on a checklist instead of the dashboard. **Append the FSSAI section after `HR`, before `Admin`.**

If FSSAI wants a dedicated home for a compliance role (e.g. `/fssai/my-checks`), add it to the `prefs` list at `:751-767`. That is a deliberate, reviewable edit — do not rely on catalog ordering for it.

### 9.2 `firstAllowedPath` — `page-catalog.ts:779-800`

Used **only** by `proxy.ts:215`, as the redirect target when a user is blocked:

```ts
if (user.role === 'admin') return '/';
if (!user.page_access) return '/';                     // null map = full access → /
let allowed: string[] = [];
try { allowed = JSON.parse(user.page_access); }
catch { return '/'; }
if (!Array.isArray(allowed) || allowed.length === 0) return '/';
for (const section of PAGE_CATALOG) {
  for (const p of section.pages) {
    if (allowed.includes(p.path)
      && !(p.hodOnly && !user.is_head_chef)
      && !(p.mgmtOnly && !(user.role === 'manager' || user.is_head_chef))
      && !(p.adminOnly && user.role !== 'admin')) return p.path;
  }
}
return '/login';
```

Note it re-implements the tier checks inline (`:794-796`) rather than calling `canAccessPage` — **a fourth place the tier rules are written out.** If FSSAI ever adds a tier flag, it must be added here too or a blocked user gets redirected to a page that immediately re-blocks them. The loop guard is in the proxy (`:217-221`), which returns a plain-text 403 when the fallback equals the blocked path.

### 9.3 THE UNBUILT FLAG — IT DOES NOT EXIST

There is **no** `unbuilt` flag, and no mechanism keeps a registered-but-unbuilt page out of anything. Measured (§4): `grep -rn "unbuilt" src/` returns nothing.

What actually happens is stated at `page-catalog.ts:420-423`:

```
// phase by phase: registering a path whose page.tsx does not exist yet gives
// granted users a 404 (the proxy happily lets them through), so this list
// must only ever name pages that are BUILT.
```

**Proven against the live filesystem** — one catalog path has no page component:

```
$ node -e '…check every catalog path for src/app/<path>/page.tsx…'
catalog paths: 162 | MISSING page.tsx: 1
    /dine-in/order  -> src/app/dine-in/order/page.tsx
```

`/dine-in/order` is registered in the catalog (`page-catalog.ts:78`), is in the **Floor Manager** and **Cashier** seeded role bundles (§5.3), and **has no page**. It 404s. It is also one of the three catalog-only paths from §8.4 — invisible in the sidebar, so nobody trips over it. That is the whole of the protection: it is not linked.

> **FSSAI rule, restated from the HR precedent:** register a path in `PAGE_CATALOG` and `Sidebar.tsx` **only once its `page.tsx` exists**. Ship the 20 sub-modules in phases and add catalog+sidebar rows phase by phase. A row added early is a 404 in a user's face, and — because `firstAllowedPath`/`homePathFor` iterate the catalog — potentially their **landing page**.

---

## 10. OWNER'S §20 ROLE LIST vs WHAT ACTUALLY EXISTS

Mapped against the live `roles` table (§5.3). **No roles invented.**

| §20 role | Exists today? | Actual row / mechanism | Gap |
|---|---|---|---|
| **Staff** | ✅ | `Staff`, `base_role='staff'`, `page_access=["/requisitions"]`, `is_system=1` | None as a tier. But **assigned to nobody** — the one staff-ish live user is `page_access=NULL` = full access |
| **Captain / Supervisor** | ⚠️ Half | `Captain`, `base_role='staff'`, `page_access=["/captain"]` | "Captain" exists. **"Supervisor" does not exist at all** — no role, no flag, no `position` convention. If FSSAI needs a supervisor verification step it must be defined |
| **Chef / Kitchen Manager** | ✅ | `Head Chef`, `base_role='manager'`, **`is_head_chef=1`** | Present, and the *only* role carrying the HOD flag. Tier is `manager`, so an HOD is also `isManagement()`. No separate "Kitchen Manager" |
| **Store Manager** | ✅ | `Store Manager`, `base_role='manager'`, **`is_store_manager=1`** | Present |
| **Maintenance** | ❌ **ABSENT** | No role. `users.section` allows the literal `'Maintenance'` (`auth.ts:46`) but **is empty for all 9 users** | **Full gap.** See below |
| **F&B Controller** | ❌ **ABSENT** | No role of this name. Closest is `Administrator` (`base_role='admin'`) | **Full gap.** The app has no tier between Manager and Admin |
| **Manager** | ✅ | `Manager`, `base_role='manager'`, `is_system=1`, **`page_access=NULL` = ALL PAGES** | Present but **blunt** — assigning it grants everything non-`adminOnly`. `Floor Manager` and `Bar Manager` also exist at `manager` tier with scoped bundles |
| **Admin** | ✅ | `Administrator`, `base_role='admin'`, `is_system=1` | Present. `canAccessPage:817` returns `true` unconditionally for admins |

### The gaps, stated plainly

1. **"Maintenance" has no representation whatsoever.** No role row, and the `section` field that could carry it is empty across the board:
   ```
   (empty)|9
   ```
   Any FSSAI design that routes pest-control or equipment-calibration tasks to "Maintenance" has **nobody to route them to today**. Options, least disruptive first: (a) create a `Maintenance` role via `/settings/roles` — no code change, the API supports it (`api/auth/roles/route.ts:46`); (b) populate `users.section = 'Maintenance'` — an owner data action, **not ours** (Never-Change-Prod-Mappings); (c) FSSAI carries its own responsible-role reference on the template row. **(c) is the only option that is purely additive and inside our lane.**

2. **"F&B Controller" has no representation.** There is no tier between `manager` and `admin`, and `requireRole` only enforces `admin` (§1.4). An FSSAI "controller verifies" step maps today onto either `isManagement()` (too wide — includes every manager and HOD) or `role === 'admin'` (too narrow). **This needs an owner decision, not a guess.** Surface it as a question rather than silently picking `isManagement`.

3. **"Supervisor" has no representation** — only `Captain`.

4. **The whole roles system is dormant.** Nine roles defined, zero assigned (§0 FACT 1). Any FSSAI RBAC that assumes "the Chef role will be assigned to chefs" is assuming an owner configuration step that **has not happened for any existing module either**. FSSAI must be correct when every user is a null-map full-access user — which means **tier flags and API self-checks, not `page_access`**.

5. **`is_head_chef` is the only usable per-person capability flag actually set in production:** `Latesh`, `Shashank Reddy`, `ZZ Test Store` carry `u_hod=1`; `Ganesh`, `Shashank Reddy`, `ZZ Test Store` carry `u_store=1`. Everything else (`section`, `role_id`) is empty. **If FSSAI needs to distinguish a kitchen staffer from a bar staffer today, `department_id` is the only field with real data** — and confirming that is the masters lane's job.

---

## 11. THE BUILD CONTRACT — WHAT LATER PHASES ARE HELD TO

**Registration (do both, same commit)**
1. Every FSSAI path in `src/lib/page-catalog.ts` **and** `src/components/Sidebar.tsx`. §8.5, proven by `/inventory/closing-history` and `/dine-in/order`.
2. One `NavSection` labelled "FSSAI Compliance" with up to 20 `NavLink` children. Two levels only. §8.3.
3. Place the catalog section **after `HR`, before `Admin`** — `homePathFor`/`firstAllowedPath` sweep in declaration order. §9.1, §9.2.
4. Add a row **only when its `page.tsx` exists.** There is no `unbuilt` flag. §9.3.

**Gating**
5. **Tier-flag every FSSAI page deliberately** — the only catalog gate that survives the null-map fail-open covering 8 of 9 live users. §0, §3. Follow the HR precedent (`page-catalog.ts:426-431`).
6. Anything that rewrites compliance history, or configures templates/frequencies → `adminOnly`. Verification/sign-off/exports → `mgmtOnly`. The staff checklist runner → **unflagged on purpose**, following `/grn/qc` (`page-catalog.ts:117-130`): *"at 6am with a truck waiting that guarantees workarounds."* The same logic applies to a 7am hygiene check.
7. Do **not** use `hodOnly` for a non-negotiable gate — an admin can switch it off at runtime. §4.
8. **Every FSSAI API route authenticates itself.** The proxy does not gate APIs, and GETs are cookie-presence only. §2.3. Copy Pattern A/B/C from §7.
9. Do not use `requireRole('manager')` — it enforces nothing. §1.4.
10. Match the existing 401/403 response vocabulary; the strings surface to users via `apiJson`. §7.

**CSRF**
11. Add `'/api/fssai',` to `CSRF_REQUIRED_PREFIXES` in `src/proxy.ts:30-95`. One prefix covers all future FSSAI mutations (HR precedent, `proxy.ts:94`). §6.2.
12. Every state-changing FSSAI client call goes through `api()` / `apiJson()` from `src/lib/api.ts`. §6.3.

**Naming / collision**
13. No FSSAI path may contain the substring `/print` — `isPublic` uses `.includes()` and would make it unauthenticated. `proxy.ts:125`, §2.6.
14. Photo-evidence URLs must not end in an image extension if they are to be access-controlled. `proxy.ts:141`, §2.6.

**Roles**
15. If FSSAI paths become tickable in `/settings/roles`, they **must** be in `PAGE_CATALOG` — `cleanPages` turns an all-unknown array into `NULL` = **all pages granted**. §5.5.
16. An empty `page_access` array means *follow the role / no restriction*, never deny-all. Never persist `'[]'`. §5.5.
17. Any admin screen resolving effective access must fetch roles with `?include_inactive=1`. §5.4.
18. If FSSAI needs a new user attribute at the **page** level, add it to **both** `auth.ts:114-138` and `proxy.ts:202-209`. §2.5. A new tier flag additionally needs `firstAllowedPath` (`page-catalog.ts:794-796`). §9.2.

**Open questions for the owner — do not guess**
19. **"F&B Controller"** is not a role and there is no tier between manager and admin. Which existing authority verifies FSSAI records? §10 gap 2.
20. **"Maintenance"** has no role and `users.section` is empty for all 9 users. Who receives pest-control / equipment tasks? §10 gap 1.
21. **"Supervisor"** does not exist; only `Captain`. §10 gap 3.

---

## 12. WHAT I COULD NOT DETERMINE

Stated plainly, per the evidence rule:

- **Whether the owner intends FSSAI roles to finally be assigned.** The roles system is fully built and entirely unused. Whether FSSAI ships assuming null-map users forever (my working assumption, and the safe one) or triggers a role rollout is an owner decision. It changes how much weight the tier flags must carry.
- **Whether `/inventory/closing-history` is a deliberate omission or genuine drift.** Unlike `/crm/guests` and `/settings/integrations/whatsapp`, it carries no explanatory comment in either file. I did not change it. Flagged only so the FSSAI build does not copy the pattern.
- **The real-world meaning of `users.department_id` values** — whether departments map cleanly onto FSSAI's Kitchen/Bar/Store/Maintenance responsibility model. That is the masters/departments lane; `canSignQcFor` (§7 Pattern C) shows the join exists (`mainDeptOf`), but I did not verify the department tree's shape or contents.
- **Whether any FSSAI check must be recordable by a signed-OUT user** (e.g. a delivery driver's temperature reading). If so, the `isPublic` carve-out pattern (`/api/customer/`, `/api/telecmi/webhook/`, `proxy.ts:104,119`) is the precedent — unguessable token in the path, validated in-handler — but nothing in §21/§24 as given to me says this is needed.
- **Test coverage / CI expectations for the auth layer.** I did not run the test suite: P0 is read-only and I did not want to start anything that touches a DB.

---
---

# FSSAI P0 RECON — LANE: INTEGRATION MASTERS (§21 anti-duplication)

Read-only phase. No code written, no existing file modified, no migration run, no server started.

**Evidence base.** Live DB snapshotted read-only, WAL included:

```
$ sqlite3 "file:/Users/shashankreddy/Desktop/Claude/fnb-controller/fnb-controller.db?mode=ro" \
    "VACUUM INTO '/private/tmp/.../fssai-recon/live-snapshot.db'"
```

Fidelity proof (live vs snapshot, identical => the 1.4 MB WAL was captured, not lost):

```
raw_materials  live=952   snap=952        purchases   live=2165 snap=2165
vendors        live=59    snap=59         grn         live=29   snap=29
departments    live=29    snap=29         tasks       live=21   snap=21
production_batches live=9 snap=9          store_locations live=1 snap=1
sqlite_master tables: live=205  snap=205
MAX(audit_events.created_at): live=2026-08-20 03:29:56 == snap
```

**READ THIS BEFORE TRUSTING ANY ROW COUNT BELOW.** This database is a DEV database, not
production. `hr_employees=0`, `hr_assets=0`, `hr_designations=0`, `store_user_access=0`,
`store_locations=1`, `closing_stock=0`, newest order `2026-08-11`. Schemas are real and are
what production runs; ROW COUNTS for the HR and Store subsystems prove nothing about
production. Where a count is load-bearing I say so.

## 0. THE FOUR FINDINGS THAT CHANGE THE BUILD

**F1 — A CHECKLIST ENGINE ALREADY EXISTS, AND IT ALREADY RAISES CORRECTIVE TASKS.**
`checklist_templates` (5 live rows) + `checklist_items` (56 live rows) +
`daily_checklist_records` + `hygiene_audits`, served by `/api/tasks/checklists` and
`/api/tasks/hygiene`. `daily_checklist_records` already carries `result`, `comment`,
`image_url`, `corrective_action`, `created_task_id`, `recorded_by`. A failed item already
spins off a `tasks` row with `source='checklist'`, writes `task_status_history`, fires
`task_notifications` + web push, and fans `@mentions`. `src/lib/tasks.ts:339` types
`Task.source` as `'manual' | 'checklist' | 'maintenance' | 'hygiene' | 'recurring'`.
This is 60% of the FSSAI corrective-action loop, shipped and working. The FSSAI engine must
be positioned as the typed/frequency-aware successor to it, and the P0 owner decision is:
extend it, or run `fssai_*` alongside it and leave it untouched. It must NOT be
re-implemented in ignorance — see §9.

**F2 — THERE IS NO EQUIPMENT / ASSET MASTER. Cold rooms cannot be "referenced from Asset
Management", because Asset Management is not what the brief assumes.** `hr_assets` is a
STAFF-ISSUED-ITEM register (`kind` = uniform | id_card | device; `employee_id`; status
in_store|issued|returned|damaged|lost). It has no location, no equipment class, no
temperature attribute. The only plant-shaped table is `maintenance_schedules`, whose `name`
is free text ("Freezer Service", "Refrigerator Cleaning", "Generator"). Cold units exist
today ONLY as free-text strings in `production_batches.storage_location`
("Cold Room 1", "Cold Room 2", "Cold Room 3", "walkin chiller 1"). FSSAI MUST create
`fssai_equipment` — that is not duplication, there is nothing to duplicate — and seed it
from those distinct strings.

**F3 — THE EXISTING BATCH MODULE IS FIFO, NOT FEFO.** `computeFifo()`
(`src/lib/production-batch.ts:127`) orders `production_date ASC, production_time ASC,
created_at ASC`. Expiry is ranked separately on the dashboard
(`ORDER BY expiry_date ASC, expiry_time ASC`, `src/app/api/kitchen-production/dashboard/route.ts:249`).
FEFO does not exist anywhere. The dashboard already computes `fifo_compliance_pct`.

**F4 — THE ITEM MASTER'S SHELF-LIFE AND STORAGE COLUMNS EXIST BUT ARE 100% EMPTY.**
`raw_materials.shelf_life_days > 0`: **0 of 952**. `raw_materials.storage_location <> ''`:
**0 of 952**. Both columns are real and writable (`/api/inventory/bulk-storage-location`
exists for the latter). FSSAI FIFO/FEFO on RAW materials therefore has NO data to stand on
today; only `production_batches` carries real expiry dates.

---

## 1. ITEM MASTER — `raw_materials`

**Table `raw_materials`, PK `id` TEXT (not an integer, not a rowid). 952 rows, all
`is_active = 1`.** Verbatim from the live snapshot (`PRAGMA table_info`), 35 columns:

```
 0 id TEXT PK              12 purchase_unit TEXT ''        24 cess_percent REAL 0
 1 name TEXT NOT NULL      13 recipe_unit TEXT ''          25 standard_purchase_rate REAL 0
 2 category TEXT 'other'   14 conversion_factor REAL 1     26 closing_cadence TEXT 'none'
 3 unit TEXT 'kg'          15 yield_percent REAL 100       27 is_recipe_item INT 0
 4 current_stock REAL 0    16 last_purchase_price REAL 0   28 is_direct_sell INT 0
 5 reorder_level REAL 5    17 last_purchase_date TEXT NULL 29 is_semifinished INT 0
 6 costing_method TEXT     18 is_auto_discovered INT 0     30 case_size REAL 1
 7 average_price REAL 0    19 discovered_source TEXT ''    31 storage_location TEXT ''
 8 created_at TEXT         20 pack_size REAL 1             32 shelf_life_days INT 0
 9 updated_at TEXT         21 super_category TEXT ''       33 is_active INT 1
10 sku TEXT                22 brand TEXT ''                34 priority INT 2
11 primary_vendor TEXT ''  23 tax_percent REAL 0
```

### The unit columns (memorise these — they are the app's deepest convention)

- `unit` = the **RECIPE** unit (g / ml / pcs). `current_stock` and `average_price` are in
  this basis. `average_price` is Rs per RECIPE unit.
- `purchase_unit` = the **PURCHASE** unit (kg / L / BTL / CASE / PKT). `purchases.quantity`
  and `purchases.unit_price` are in this basis.
- `pack_size` = recipe units per purchase unit. `case_size` = purchase units per outer case.
- Live spread: `purchase_unit=''` **0 of 952**; `recipe_unit=''` **0 of 952**;
  `pack_size = 1` 538; `pack_size > 1` 414.

**THE PACK GUARD HAS TWO HALVES AND LOCAL COPIES KEEP DROPPING THE SECOND.** From
`src/lib/pack-units.ts:88`:

```ts
export function packFactor(m: PackMeta): number {
  const ps = Number(m?.pack_size) || 1;
  const ru = String(m?.unit || '').toLowerCase().trim();
  const pu = String(m?.purchase_unit || m?.unit || '').toLowerCase().trim();
  return ps > 1 && ru !== pu ? ps : 1;
}
```

A bare `pack_size > 1` mis-converts every material whose recipe unit already equals its
purchase unit (the file names the live casualty: PICKLED GINGER 1.5KG, kg/kg, pack_size 1.5
— the short guard turns 6 kg into "4.00 kg"). **FSSAI must import `packFactor` /
`toPurchaseQty` / `dualQty` / `displayQty` from `@/lib/pack-units` and never re-derive.**
`npm run check:units` (`scripts/check-purchase-units.js`) fails the build on a bare
recipe-unit render in Purchase/Inventory modules and carries an allow-list.

Owner rule (2026-07-29, `pack-units.ts:7`): every quantity on a Purchase / Inventory page
LEADS with the PURCHASE unit. Only four things stay in recipe units and each must be
LABELLED as recipe: recipe/menu costing, recipe-derived consumption, exact-balance ledger
reports, and cross-material sums (which must print an em-dash, never add ml + g).

### THE `last_purchase_price` MIXED-BASIS TRAP — reproduced on this snapshot

`raw_materials.last_purchase_price` is stored in MIXED bases. Live proof:

```sql
SELECT name, unit, purchase_unit, pack_size, last_purchase_price, average_price
  FROM raw_materials WHERE name LIKE '%STRAWBERRY CRUSH%';

MALA STRAWBERRY CRUSH 1 LTR  ml  BTL  1000.0  0.2016    0.2
MALA STRAWBERRY CRUSH 5 LTR  ml  BTL  5000.0  0.13482   0.1348
```

The 5 LTR row's real last rate is Rs 674.10 per BTL. The stored column says `0.13482`.
**That is the documented 5,000x error, live in this database.** My own naive
last-purchase join over the 191 packed materials that carry both prices scored 77 in the
purchase basis and 20 in the recipe basis (the header comment of `closing-valuation.ts`
records 87 / 105 by its own stricter method) — either way the column is **not one basis**.

**THE RULE: never read `raw_materials.last_purchase_price` for money. Go through
`src/lib/closing-valuation.ts`.** Its contract (`:64`, `:96`, `:121`):

```ts
materialRate(db, material, preloaded?) -> { ratePerPurchaseUnit, source, asOf }
rateMap(db)            // ONE select for a whole sheet, Map<material_id, {unit_price,date}>
valueCount(db, material, recipeQty, preloaded?) -> ValuedCount
```

Resolution order, cheapest-truth-first: `last_purchase` (the `unit_price` of the most
recent `purchases` row — unambiguous, Rs/purchase-unit by canon) -> `average_cost`
(`average_price x packFactor`) -> `none` (rate 0, and the caller must SAY so, never print
a confident zero). The chosen `source` travels with the number.

**A SECOND, SUBTLER TRAP, AND IT CUTS THE OTHER WAY.** `GET /api/inventory` does NOT return
the stored column. It overrides it in the SELECT
(`src/app/api/inventory/route.ts:39-41`):

```sql
COALESCE((SELECT unit_price FROM purchases WHERE material_id = rm.id
          ORDER BY date DESC, created_at DESC LIMIT 1), 0) as last_purchase_price,
COALESCE((SELECT date      FROM purchases WHERE material_id = rm.id
          ORDER BY date DESC, created_at DESC LIMIT 1), '') as last_purchase_date,
```

So `last_purchase_price` **over the API is already repaired and is Rs/purchase-unit**,
while the same name read straight off the table is poisoned. FSSAI must not mix the two
sources in one screen.

### Other live facts

- `shelf_life_days > 0`: **0 of 952**. `storage_location <> ''`: **0 of 952**. (F4.)
- Categories (top): grocery 286, other 141, bar 118, veg 117, packaging 92, beverages 73,
  dairy 33, non-veg 25, housekeeping 21, meat 10, stationery 8, syrups 4.
- A separate `units` table (22 rows) is the canonical unit vocabulary:
  `key` PK, `label`, `aliases` (JSON array), `dimension` CHECK IN ('volume','weight','count'),
  `to_base`, `is_builtin`.
- `src/lib/unit-audit-lock.ts` (`unit_audit_locks` table) is authoritative over unit fields:
  `lockedUnitFields()` is applied by `/api/inventory` on write. FSSAI must not write unit
  columns at all.

### How it is normally queried

`GET /api/inventory` — the item-master API. There is no `/api/materials` and no
`/api/raw-materials`. Params: `category`, `search`, `low_stock`, `scope=all`, `vendor_id`,
`exclude_store_mapped=1`. **Department-scoped by default**: for a non-admin,
non-store-manager without `scope=all`, results are filtered to the user's MAIN department's
`material_categories` whitelist via `effectiveCategoriesForUser(db, me)`
(`src/lib/dept-hierarchy.ts:73`). Store operations (GRN, Purchases, POs) opt out with
`scope=all`.

> **FSSAI should reference this by `raw_materials.id` and display `raw_materials.name`**
> (with `sku` as the secondary identifier; quantities through `displayQty`, money through
> `closing-valuation.ts`).

---

## 2. VENDOR / SUPPLIER MASTER — `vendors`

**Table `vendors`, PK `id` TEXT. 59 live rows.**

```
id TEXT PK | name TEXT NOT NULL | contact_person TEXT '' | phone TEXT '' | email TEXT ''
gstin TEXT '' | address TEXT '' | payment_terms TEXT '' | lead_time_days INT 0
is_active INT 1 | notes TEXT '' | created_at | updated_at
```

**There is no FSSAI licence column, no licence-expiry column, and no vendor-approval
state.** FSSAI vendor certification must live in a new `fssai_*` sidecar keyed on
`vendors.id` — adding columns to `vendors` is the alternative, but a sidecar keeps §21
clean and keeps `/api/vendors` PUT (which `COALESCE`s every field) from touching them.

### `store_vendors` IS NOT A TABLE. THIS IS THE CORRECTION THAT MATTERS.

```
$ sqlite3 snapshot "SELECT COUNT(*) FROM store_vendors;"
Error: in prepare, no such table: store_vendors
```

`store_vendors` is a **JSON response key** computed live in
`src/app/api/stores/[id]/stock/route.ts:158-168`. It is the vendor auto-learn behaviour,
derived per store from the ledger:

```sql
SELECT v.id, v.name, MAX(l.created_at) AS last_used
  FROM vendors v
  JOIN store_stock_ledger l
    ON l.store_id = ?
   AND ( l.vendor_id = v.id
         OR (TRIM(l.supplier) != '' AND LOWER(TRIM(l.supplier)) = LOWER(TRIM(v.name))) )
 WHERE v.is_active = 1
 GROUP BY v.id, v.name
 ORDER BY last_used DESC
```

i.e. "any active vendor already used at this store, matched by id OR by case-insensitive
name equality for bills entered as free text, most-recent first". The picker shows these
first and falls back to the full list behind a "show all" toggle. **There is also no
`VendorSelect` component** (`ls src/components | grep -i vendor` -> empty). A P4 that
codes `FROM store_vendors` or `import VendorSelect` crashes at runtime.

### Vendor <-> item mapping

- `vendor_materials` (vendor_id, material_id) PK pair, **554 live rows**, FKs to both
  masters, plus `notes`, `created_at`, `created_by`. This is the many-to-many the owner
  ruled on: "1 vendor may have limited items but an item can have different vendors."
- `src/lib/vendor-mapping.ts` is the one place the rule lives: `pairRows()`,
  `vendorMappingIndex()` (feeds the composer's `?index=1` payload) and
  `vendorMappingError()` (the server-side rejection). Its own header: *"A FILTERED
  `<select>` IS A CONVENIENCE. THE SERVER IS THE RULE."* `PairSource` is
  `'history' | 'contracts' | 'person'`.
- `vendor_contracts` (0 live rows) is the **price list** — `unit_price`, `valid_from`,
  `valid_to`, `is_active` — explicitly *not* the mapping.

### API

`GET /api/vendors` (`?id=`, `?search=`, `?stats=1`), `POST`, `PUT`.
`GET /api/vendors/for-material`, `/api/vendors/materials-summary`, `/api/vendors/bulk`.
Name is trimmed at the write boundary because **`vendors.name` is the join key back to
`purchases.vendor`** (`LOWER(TRIM(name))` matching in `for-material`, `materials-summary`,
`vendor-contracts` and the PO `vendor_id` lookups).

**Security note, in passing, since FSSAI will read this route.**
`src/app/api/vendors/route.ts` contains no `getCurrentUser()` / `requireRole()` /
`isManagement()` call in any of GET / POST / PUT. It is covered only by the blanket session
check in `src/proxy.ts:172` (`if (!session) -> 401` for every non-public `/api/*`), so any
signed-in user — including tier `staff` — can create and edit vendors. `/api/vendors` is
also absent from the CSRF-protected prefix list in `proxy.ts:80-96`. Reported, not edited;
out of this lane's footprint.

> **FSSAI should reference this by `vendors.id` and display `vendors.name`.**
> Never join on `purchases.vendor` text when `vendor_id` is available.

---

## 3. PURCHASING / RECEIVING — `purchases`, `goods_receipt_notes`, `purchase_orders`

### `purchases` (2,165 live rows) — PK `id` TEXT

```
id | material_id (FK raw_materials) | vendor TEXT '' | brand TEXT '' | quantity REAL
unit_price REAL | total_price REAL | date TEXT | notes TEXT | created_at
outlet_id | is_emergency | payment_mode | emergency_reason | invoice_number
discount | cgst | sgst | special_excise_cess | tcs | delivery_charges | mrp_round_off
invoice_id TEXT '' | bill_no TEXT '' | po_qty REAL 0 | compensation_cess
grn_id TEXT | po_id TEXT | direct_issue_dept_id TEXT
```

`quantity` and `unit_price` are in PURCHASE units by canon.

### THE PO-ID TRAP — reproduced live

```
SELECT COUNT(*) total, SUM(po_id IS NULL) po_id_null,
       SUM(po_id IS NOT NULL AND po_id<>'') po_id_set,
       SUM(grn_id IS NOT NULL AND grn_id<>'') grn_id_set FROM purchases;

total=2165   po_id_null=2145   po_id_set=20   grn_id_set=31
-- and: rows with grn_id set but po_id NULL = 11
-- goods_receipt_notes: 29 rows, 20 with a po_id
```

`src/app/api/purchases/route.ts:161` states it exactly:

> *"NOTHING WRITES purchases.po_id. All seven INSERT INTO purchases statements in this
> codebase — PO receive, ad-hoc GRN, full bill, bulk, opening stock, inward import, seed —
> omit the column. It is populated only by the boot migration in db.ts, so a bill received
> since the last restart carries po_id = NULL."*

I verified the seven inserts: `api/seed:94`, `api/purchases/route:604`,
`api/purchases/bulk:167`, `api/purchases/opening-stock:59`,
`api/purchase-orders/[id]/receive:1361`, `api/inward-import/commit:79`, `api/grn:1575`
(plus `lib/grn-reversal:1729` and `lib/grn-qc:1719`). None names `po_id`.

The only writer is the boot migration at `src/lib/db.ts:3455-3500`, a two-pass idempotent
backfill (`WHERE po_id IS NULL`): PASS 1 structural `purchases.grn_id ->
goods_receipt_notes.po_id`, PASS 2 a `notes`-text fallback guarded by `COUNT(*) = 1` so an
ambiguous sentence writes nothing. `db.ts:3446` states NULL is the honest value and *most*
rows keep it: *"Readers MUST render a missing po_id as 'not recorded' — never as zero,
never by falling back to a guess."*

**THE RULE: resolve the PO through `purchases.grn_id -> goods_receipt_notes.po_id`, and
let the stored `purchases.po_id` win only when it is non-empty.** That is exactly what the
list route does at `:186-190`. Note also that the "PO No" on `/purchases` is a **regex parse
of the `notes` sentence** (`src/app/purchases/page.tsx:225`), not proof of `po_id` — a
rendered PO No with a blank `po_id` is the exact production symptom this trap produced.

### `invoice_id` vs `bill_no` vs `invoice_number` — and which one Receiving QC attaches to

Live data:

```
invoice_id      bill_no        invoice_number  vendor              date
PINV-2026-0013  BILL-T7B-NEW   (empty)         ZZ R71 TEST VENDOR  2026-08-07
PINV-2026-0012  BILL-T7A-NEW   (empty)         ZZ R71 TEST VENDOR  2026-08-07
PINV-2026-0011  (empty)        (empty)         ZZ R71 TEST VENDOR  2026-08-07
...
has_invoice_id=13   has_bill_no=14   has_invoice_number=0   total=2165
```

- `invoice_id` = **OURS**, auto-generated `PINV-yyyy-####`, one per vendor bill. Every
  non-empty value on this snapshot carries the `PINV-2026-` prefix.
- `bill_no` = the **VENDOR's** bill number. Free text, frequently blank (and the documented
  dup-guard rule is that a stored empty `bill_no` must be treated as a WILDCARD, or stock
  doubles).
- `invoice_number` = a legacy/parallel column, **0 non-empty rows of 2,165**. Dead.
  `goods_receipt_notes` has its own `invoice_number` + `invoice_date`, which is where a GRN
  records the vendor document.

**RECEIVING QC MUST ATTACH TO `goods_receipt_notes.id`, NOT TO A PURCHASE ROW AND NOT TO AN
INVOICE NUMBER.** Three reasons, each verifiable above:

1. **The GRN is the physical-receipt event; `purchases` is the cost event.** One delivery is
   ONE `goods_receipt_notes` row with N `goods_receipt_note_items`, but it fans out into N
   separate `purchases` rows (one per material). QC is judged per delivery and per line, not
   per cost row.
2. **The GRN already models QC and `purchases` does not.** `goods_receipt_notes` carries
   `qc_by`, `qc_required`, `qc_checker`, `qc_outcome`, `qc_quality`, `qc_temperature`,
   `qc_expiry`, `qc_damage`, `qc_weight`, `qc_invoice_match`, `qc_kitchen_by/at`,
   `qc_store_by/at`, `qc_override_by/at/reason`, `qc_applied_at`, `qc_escalated_at`.
   `goods_receipt_note_items` carries `quantity_received`, `quantity_accepted`,
   `quantity_rejected`, `rejection_reason` (damage|short_weight|expired|quality|
   rate_mismatch|other). FSSAI Receiving QC is an ENRICHMENT of an existing model.
3. **`invoice_id` and `bill_no` are both sparse and neither is a key.** 13 and 14 non-empty
   of 2,165. `bill_no` is not unique and is legitimately blank. Keying QC on either loses
   99% of history and breaks the moment a vendor bill is blank.

`goods_receipt_notes`: PK `id` TEXT, `grn_number` TEXT **NOT NULL UNIQUE** (`GRN-YYYY-NNNN`),
`date`, `time`, `po_id` (FK purchase_orders), `vendor_id` (FK vendors), `vendor` cached name,
`invoice_number`, `invoice_date`, `received_by`, `status` (received|partial|rejected),
`notes`, `outlet_id`, plus the QC and void/edit blocks above.

The existing QC gate is `src/lib/grn-qc.ts` (2,100 lines) — perishables hold as
`awaiting_qc` with NO stock until kitchen/bar signs; one helper gates BOTH receiving routes.
`qc_category_checkers` is the mapping table. FSSAI Receiving QC should extend this, not
shadow it.

> **FSSAI should reference this by `goods_receipt_notes.id` (line-level:
> `goods_receipt_note_items.id`) and display `goods_receipt_notes.grn_number`**, with
> `vendor` + `invoice_number` as secondary context. Resolve the PO via
> `purchases.grn_id -> goods_receipt_notes.po_id`, never `purchases.po_id` alone.
> **FSSAI should reference the order by `purchase_orders.id` and display
> `purchase_orders.po_number`** (UNIQUE at schema level).

---

## 4. BATCH / BARCODE / FIFO — `production_batches`

**Table `production_batches`, PK `id` TEXT. 9 live rows.**

```
id | outlet_id | batch_number TEXT | barcode TEXT UNIQUE | item_name TEXT NOT NULL
category | material_id | recipe_id | production_date | production_time
expiry_date | expiry_time | shelf_life TEXT '' | quantity_produced REAL | quantity_consumed REAL
unit | prepared_by | kitchen_section | storage_location | remarks
status TEXT 'active'  -- active | consumed | expired | disposed
created_at | updated_at | production_item_id TEXT
```

### The `PROD######` scheme — exact generator

`src/app/api/kitchen-production/route.ts:42-50`:

```ts
function nextBarcode(db) {
  const row = db.prepare(
    `SELECT MAX(CAST(SUBSTR(barcode, 5) AS INTEGER)) AS m
       FROM production_batches WHERE barcode LIKE 'PROD______'`).get();
  return 'PROD' + String((row?.m || 0) + 1).padStart(6, '0');
}
```

Live: `PROD000001` .. `PROD000009`, `barcode` is UNIQUE. `batch_number` is a separate human
code — up-to-2-word initials + `YYMMDD` + a 3-digit per-(item,day) sequence
(`buildBatchNumber`, `:55-77`), falling back to the barcode when the name has no letters.
Live examples: `CG260707001`, `PT260709001`, `M260708001`.

### Expiry and FIFO

`src/lib/production-batch.ts` is the shared helper module:

```
parseDateTime(date, time)          expiryStatus(...) -> 'green' | 'yellow' | 'red'
batchAgeHours(...)                 shelfLifeRemaining(...) -> "2d 4h left" | "expired"
enrichBatch(b, now)                itemGroupClause(row) -> { cond, params }
computeFifo(db, row, outletId, now) -> { fifo_priority, fifo_use_first }
```

`expiryStatus`: red when `exp - now <= 0`, yellow within 24 h, else green.
`itemGroupClause` is *the* single source of truth for FIFO grouping — by
`production_item_id` when present (a rename or case-typo can never split a chain), folding
in legacy unlinked same-name rows, falling back to NOCASE name only for rows with no master
item. Every surface (scan, take, list, by-barcode, dashboard) shares it so they cannot drift.

`computeFifo` (`:127`) orders `production_date ASC, production_time ASC, created_at ASC` and
returns the batch's rank among ACTIVE same-item batches (oldest = 1) plus up to 5 older
batches to use first. **This is FIFO. There is no FEFO anywhere in the codebase** — expiry
ordering appears only in the dashboard's "next 10 to expire" widget. (F3.)

### The existing expiry dashboard

`GET /api/kitchen-production/dashboard` -> widgets `expiring_today`, `expiring_tomorrow`,
`expiring_3d`, `expiring_7d`, `expired`, `today_production`, `labels_printed_today`,
`active_batches`, `total_batches`, `today_consumption_qty`, `today_consumption_by_unit`,
plus `expiring_soon[]` and a computed **`fifo_compliance_pct`** (percentage of draw-downs
where no strictly-older active batch still had stock). Pages:
`src/app/kitchen-production/{page,scan,dashboard,reports}/tsx`.

### Supporting tables

- `batch_transactions` (28 rows): `batch_id`, `type` (created|printed|reprinted|scanned|
  consumed|transferred|returned|wasted|expired|disposed), `quantity`, `balance_quantity`,
  `user`, `department`, `remarks`. **This is the audit trail FSSAI FIFO/FEFO should write
  into, not a parallel one.**
- `production_items` (3 rows): the master item — `name` UNIQUE COLLATE NOCASE,
  `shelf_life_hours`, `default_storage_location`, `unit`, `is_active`.
- `production_batch_departments` (0 rows): sidecar `batch_id` PK -> `department_id` /
  `production_department_id` / `label`. Deliberately a sidecar so reports, CSV, labels and
  FIFO queries run against unchanged columns.

**IMPORTANT BOUNDARY, stated in the module's own header (`route.ts:34`):**
*"NOTHING HERE MOVES MATERIAL. Kitchen Production is a separate ledger: no route under
/api/kitchen-production writes raw_materials, department stock, or a requisition."*
FSSAI must respect that — a FIFO/FEFO check must not become a stock movement.

> **FSSAI should reference this by `production_batches.id` and display
> `production_batches.barcode`** (with `batch_number` + `item_name` as the human label).
> Group by `production_item_id` via `itemGroupClause()`, never by `item_name` directly.

---

## 5. DEPARTMENTS and the STATION -> DEPARTMENT MAPPING — READ ONLY

**Table `departments`, PK `id` TEXT, `name` TEXT NOT NULL UNIQUE. 29 live rows, all active.**

```
id | name UNIQUE | code | description | head_chef_user_id (FK users) | is_active
created_at | updated_at | submission_windows | submission_grace_minutes
material_categories TEXT | parent_id TEXT | head_user_id TEXT | area TEXT
recipe_deduction_enabled INT 1
```

**Two-level tree via `parent_id`.** Live: 13 MAIN departments (`parent_id` NULL) — Asian,
Bakery, Bar, Butchery, Chinese, Continental, Housekeeping, Indian, Kitchen, Operations,
Party Bulk, Staff Meals, Tandoor — and 16 SUB departments. e.g. `Kitchen` (id
`f4e0fed0-...`) parents Akan Indian, Akan - Bakery, Akan Continental, Akan Main Kitchen,
Akan Pan Asian, Akan Pizza, Akan Security, Akan Service, Akan Stationery, Akan Tandoori.
`Bar` parents Akan Bar, Akan Perishables Bar. Note the real data contains double spaces
("Akan  Housekeeping", "Akan  Indian") — **match on id, never on name.**

Helpers: `src/lib/dept-hierarchy.ts` — `mainDeptOf`, `userMainDept`, `isMainDeptHead`,
`isAnyMainDeptHead`, `effectiveCategoriesForUser`, `requisitionVisibility`.
`resolveDeptSet(db, deptId)` (`src/lib/dept-stock.ts:169`) = the dept itself plus, when it
is MAIN, all its sub-departments.

**Table `station_departments`, PK `station` TEXT (the station key IS the PK). 14 live rows.**

```
bakery -> Bakery        bar -> Bar           cocktail -> Bar       continental -> Continental
indian -> Indian        kitchen -> Kitchen   liquor -> Bar         mocktail -> Bar
pan-asian -> Asian      pizza -> Continental sushi -> Asian        tandoor -> Tandoor
tandoori -> Tandoor     terracegrill -> Tandoor
```

Many stations map to one department. All `is_active = 1`.

### THE TWO DEPARTMENT CONVENTIONS — the trap that will bite P4

Some tables hold `department_id` (a real `departments.id` UUID). Others hold a free-text
`department` STRING that is **not** an FK and does **not** have to exist in `departments`:

| holds `department_id` (UUID) | rows | holds `department` (free text) | rows |
|---|---|---|---|
| `requisition_items` | **16,353** | `tasks` | 21 |
| `requisitions` | **1,630** | `maintenance_schedules` | 21 |
| `station_departments` | 14 | `batch_transactions` | 28 |
| `users` | 9 | `checklist_templates` | 5 |
| `hr_employees`, `hr_shifts`, `hr_sops`, `hr_tests`, `hr_trainings`, `hr_candidates`, `hr_designations` | 0 (dev) | `daily_checklist_records`, `recurring_task_rules`, `training_sessions` | 0 |
| `closing_stock`, `closing_stock_semi`, `department_materials`, `department_material_transactions`, `material_returns`, `wastages`, `variance_approvals`, `staff_meal_items`, `direct_issue_rules`, `production_batch_departments`, `requisition_issue_ledger` | 0–1 (dev) | | |

Live values of the free-text side: `tasks.department` = 'Maintenance' (21/21);
`maintenance_schedules.department` = 'Maintenance' (21/21); `checklist_templates.department`
= Operations / HR / Store / Bar — **'HR' and 'Store' are NOT rows in `departments`**;
`batch_transactions.department` = '' (28/28). The Task module keeps its OWN department
vocabulary in `task_departments` (10 rows) and `src/lib/tasks.ts:122`
(Operations, Kitchen, Bar, Housekeeping, Maintenance, Store, HR, Accounts, Security,
Administration) — a different list from `departments`.

**REFERENCE COUNT THAT FORBIDS ANY EDIT: 1,630 requisitions + 16,353 requisition items
across 17 distinct department ids reference `departments.id`.** Plus the recipe-deduction
flag (`departments.recipe_deduction_enabled`) sits on these rows and governs whether a sale
takes stock. Production config is the owner's to set in the app. **READ ONLY. Mirror prod
INTO local, never the reverse; any sync must be additive.**

> **FSSAI should reference this by `departments.id` and display `departments.name`.**
> When FSSAI needs to sit beside the Task module it must ALSO carry the free-text
> `department` string that module expects — do not assume the two vocabularies agree.

---

## 6. HR / EMPLOYEE MASTER — and who "Checked By" actually is

**Table `hr_employees`, PK `id` TEXT, `employee_code` TEXT NOT NULL UNIQUE (`EMP-0001`).
0 rows on this dev DB — schema is real, counts are not.**

Fields FSSAI cares about: `full_name` NOT NULL, `photo` (base64 data URI), `phone10`
(bare 10 digits, `+91` implied), `department_id` (departments.id), `sub_department_id`,
`designation_id` (hr_designations.id), `reporting_manager_id` (hr_employees.id),
`home_outlet_id`, `joining_date`, `status`, `exit_date`, **`user_id` TEXT REFERENCES
users(id)** — the optional link to a login.

Schema comments worth quoting: `email` is *"contact only; NOT an identity"*;
`home_outlet_id` is *"employment assignment; users.current_outlet_id is a VIEW preference,
never this"*; `created_by` is *"me.email (house actor convention)"*.

### Display name

**`hr_employees.full_name`.** There is no first/last split, no `display_name`, no
`preferred_name`. `hr_designations.name` is UNIQUE COLLATE NOCASE and is the job title.
The list query orders `ORDER BY e.full_name COLLATE NOCASE, e.id`
(`src/app/api/hr/employees/route.ts:88`).

### Active vs inactive

`hr_employees.status`, an 8-value vocabulary in `src/lib/hr.ts:97`:

```
active | probation | confirmed | notice_period | suspended | resigned | terminated | former
```

Validated on write by `isHrEmployeeStatus()` — a typo'd status is a 400, never a silent
coercion (`route.ts:129-131`). **There is no `is_active` column on `hr_employees`.**
The nearest thing to an official "currently employed" set is
`PAYROLL_ROSTER_STATUSES` (`src/app/api/hr/payroll/route.ts:113`):

```ts
const PAYROLL_ROSTER_STATUSES = ['active','probation','confirmed','notice_period','suspended'] as const;
```

i.e. the first five are on the roster; `resigned | terminated | former` are off it.
`hr_assets` / `users` use a separate `is_active INTEGER` — do not conflate.

### THE DECISION THIS LANE FORCES: "Checked By" must be a `users` row, not an `hr_employees` row.

`GET /api/hr/employees` is gated:

```ts
if (!canManageHr(me)) return Response.json({ error: 'Management access required' }, { status: 403 });
// canManageHr (src/lib/hr.ts:144): role === 'admin' || role === 'manager' || is_head_chef
```

**A tier-`staff` user gets 403 from the employee master.** FSSAI checks are performed by
line staff on a phone. A "Checked By" picker sourced from `hr_employees` is a 403 for the
exact people who use it.

The app's existing people picker is `GET /api/tasks/users` — signed-in-only, no role gate,
deliberately narrow:

```sql
SELECT id, name, email, position, department_id
  FROM users WHERE is_active = 1
 ORDER BY name COLLATE NOCASE ASC, email COLLATE NOCASE ASC
```

Its header: *"Sensitivity: LOW. Deliberately returns ONLY names / emails / position /
department_id — never password_hash, role tiers, permission flags, page access... Do NOT
widen this SELECT."* It powers `UserPicker.tsx` for assignee and `@mention`.

And the **house actor convention for a recorded signature** is the EMAIL STRING, stored
denormalised, not an id. `src/app/api/tasks/checklists/route.ts:123`:

```ts
const actor = me.email || me.name || '';
```

written into `daily_checklist_records.recorded_by`, `tasks.created_by`,
`task_status_history.changed_by`, `maintenance_logs.performed_by`,
`hygiene_audits.auditor`, `audit_events.actor_email`, `goods_receipt_notes.received_by` /
`qc_by` / `qc_kitchen_by` / `qc_store_by`. A denormalised email is the right choice for
compliance evidence: it survives the user row being deleted or renamed.

**`users`** (9 live rows): `id` PK, `email` UNIQUE, `name`, `role`
(`admin|manager|staff`), `is_active`, `department_id`, `is_head_chef`, `is_store_manager`,
`position`, `page_access` (JSON), `visible_department_ids` (JSON), `role_id` -> `roles`,
`section`, `can_approve_requisitions`, `wa_mobile`.
**`roles`** (9 rows) — and the discriminator column is **`base_role`, NOT `tier`**:

```
Administrator admin | Manager manager | Staff staff | Floor Manager manager
Captain staff | Cashier staff | Bar Manager manager | Head Chef manager (is_head_chef=1)
Store Manager manager (is_store_manager=1)
```

> **FSSAI should reference "Checked By" / "Verified By" by `users.email` (stored
> denormalised as the actor string, the house convention) and display `users.name`,
> sourced from `GET /api/tasks/users`.** Link to `hr_employees` only for a management
> report, via `hr_employees.user_id`, and only behind `canManageHr`. If the owner insists
> on the HR master as the source, that is a PRODUCT decision that needs a staff-safe
> read endpoint built for it — it does not exist today.

---

## 7. ASSET MANAGEMENT — THE GAP (see F2)

**`hr_assets`, PK `id` TEXT. 0 rows on this dev DB.**

```
id | name | kind TEXT ''       -- uniform|id_card|device|... (vocab in hr.ts)
tag TEXT ''                    -- asset tag / serial
employee_id TEXT ''            -- '' = in store, unissued
status TEXT 'in_store'         -- in_store|issued|returned|damaged|lost
note | created_at | updated_at
```

Plus `hr_asset_history` (`asset_id`, `employee_id`, `action` =
issued|returned|damaged|lost|repaired, `note`, `acted_by`, `at`).

**What identifies a piece of equipment: nothing suitable.** `name` + `tag`. There is no
location, no department, no equipment class, no make/model, no capacity, no temperature
set-point, no min/max range, no calibration date. **Temperature-controlled units are NOT
distinguishable — there is no attribute that could distinguish them.**

Exhaustive search of the live schema for a plant register:

```
tables matching %asset% or %equip%:  hr_assets, hr_asset_history   (that is all)
columns matching equip|asset|temperat|temp_|chiller|freezer|cold, across all 205 tables:
  goods_receipt_notes -> qc_temperature   (an INTEGER pass/fail flag, not a reading)
  hr_asset_history    -> asset_id
```

The nearest plant-shaped data is `maintenance_schedules.name` (21 live rows, free text):
AC Cleaning, CCTV Check, Chair Fittings, Deep Cleaning, Door Closers, Electrical Audit,
Electrical Panel, Exhaust Cleaning, Fire Extinguishers, **Freezer Service**, Garbage
Disposal, Generator, Lighting, **Pest Control**, Plumbing, **Refrigerator Cleaning**, Table
Fittings, Washrooms, **Water Filter Inspection**, Water Leakage, Water Tank. These are
recurring JOBS, not assets — "Freezer Service" is one row no matter how many freezers exist.
(Note that Pest Control and Water Filter Inspection are already recurring maintenance jobs
AND are FSSAI sub-modules — §9.)

Cold units exist today only as free text on batches:

```
production_batches.storage_location: 'Cold Room 1' (1), 'Cold Room 2' (1),
                                     'Cold Room 3' (2), 'walkin chiller 1' (1), '' (4)
production_items.default_storage_location: 'Cold Room 3' on one of 3 rows
raw_materials.storage_location: '' on 952 of 952
```

**CONCLUSION.** Creating `fssai_equipment` is NOT a §21 violation — there is no equipment
master to duplicate. It should carry at minimum: `id`, `name`, `code`/tag, `kind`
(cold_room | chiller | freezer | blast_chiller | hot_holding | probe | other),
`department_id`, `location_label`, `temp_min_c`, `temp_max_c`, `is_temperature_controlled`,
`is_active`. Seed `location_label` from the distinct `production_batches.storage_location`
values above so existing batches join. It must NOT absorb `hr_assets` (different domain:
people's kit) and must NOT replace `maintenance_schedules` (different domain: recurring
jobs) — but a `fssai_equipment` row SHOULD be linkable to a `maintenance_schedules.id` so
"Freezer Service" can be raised per-unit.

> **FSSAI should reference equipment by a NEW `fssai_equipment.id` and display
> `fssai_equipment.name`** — and should record, in P0's handover, that this is a new master
> because none exists. `hr_assets` is out of scope for equipment entirely.

---

## 8. MAINTENANCE — creating a maintenance task programmatically

Two tables, both 21 live rows:

```
maintenance_schedules: id | name | category 'Maintenance' | frequency 'daily'
  | department 'Maintenance' | assignee_email | next_due_date | last_generated_date
  | is_active | created_at | updated_at
maintenance_logs:      id | schedule_id | task_id | performed_by | performed_at
  | status 'done' | notes | created_at
```

`frequency` live spread: daily 6, weekly 8, monthly 7. `next_due_date` = `2026-07-16`,
`last_generated_date` = `2026-07-15` on the daily rows — the generator stamps both.

Writers: `src/app/api/tasks/maintenance/route.ts:243` (`INSERT INTO tasks`) and `:264` /
`:308` (`INSERT INTO maintenance_logs`), plus `src/lib/task-automation.ts:221` and `:313`.
The shape is the same as the checklist path in §9 below: insert `tasks` with
`source='maintenance'`, then `task_status_history`, then `task_notifications` + push, then
a `maintenance_logs` row carrying the `task_id` back.

Recurrence math is shared, not re-derived — `nextRecurrence(freq, fromISODate, dayOfWeek?,
dayOfMonth?)` in `src/lib/tasks.ts:224`, UTC-safe, strictly-after, month-length-clamped.

> **FSSAI should reference this by `maintenance_schedules.id` and display
> `maintenance_schedules.name`.** Raise maintenance work by inserting a `tasks` row with
> `source='maintenance'` and logging a `maintenance_logs` row — never by writing a parallel
> maintenance table.

---

## 9. TASK MANAGER — the corrective-action rail, already built

**`tasks`, PK `id` TEXT. 21 live rows.** 27 columns:

```
id | title | description | category 'Operations' | department '' | priority 'medium'
status 'draft' | assignee_email | assignee_name | created_by | due_date | due_time
estimated_minutes | parent_task_id | recurring_rule_id | template_id | source 'manual'
checklist_json '[]' | started_at | paused_at | completed_at | approved_at | approved_by
is_archived | sort_order | created_at | updated_at
```

### States — 10 values, ordered, from `src/lib/tasks.ts:29`

```
draft -> assigned -> accepted -> in_progress -> waiting_verification -> completed -> approved
reopened, plus the two off-ramps: on_hold, cancelled
```

Each carries a `label` and a Tailwind badge `color` in `TASK_STATUSES` (`:42`) — FSSAI must
import `statusMeta()` / `priorityMeta()` so the badges match the rest of the app exactly.
Priorities: `low | medium | high | urgent` (`TASK_PRIORITIES`, `:80`).

### Assignment model

Denormalised email + name ON the task row (`assignee_email`, `assignee_name`), with a
`task_assignees` table (0 live rows) for multi-assignee. `@mentions` are parsed out of free
text by `parseMentions()` (`:169`) and fanned into `task_mentions` +
`task_notifications`. Permission gates (`:196`, `:205`):

```ts
canManageTasks(me) = role==='admin' || role==='manager' || is_head_chef || is_store_manager
canApproveTasks(me) = canManageTasks(me)          // same set
```

### THE EXACT PROGRAMMATIC RECIPE — copy this, do not invent one

`src/app/api/tasks/checklists/route.ts:166-215`, inside `db.transaction(() => { ... })`:

```ts
const taskId = generateId();
db.prepare(
  `INSERT INTO tasks
     (id, title, description, category, department, priority, status,
      assignee_email, assignee_name, created_by, due_date,
      source, template_id, checklist_json)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'checklist', ?, '[]')`,
).run(taskId, title, description, tpl.category || 'Hygiene', department, priority, status,
      assigneeEmail, assigneeName, actor, date, templateId);

db.prepare(
  `INSERT INTO task_status_history (id, task_id, from_status, to_status, changed_by, note)
   VALUES (?, ?, '', ?, ?, ?)`,
).run(generateId(), taskId, status, actor, 'Auto-created from checklist fail');

if (assigneeEmail) {
  db.prepare(
    `INSERT INTO task_notifications (id, recipient_email, kind, title, body, task_id, href)
     VALUES (?, ?, 'assignment', ?, ?, ?, '/tasks/my')`,
  ).run(generateId(), assigneeEmail, `Task assigned: ${title}`, description, taskId);
  firePush(db, assigneeEmail, { title: `Task assigned: ${title}`, body: description, url: '/tasks/my' });
}
// then parseMentions(...) -> task_mentions + task_notifications + firePush per token
```

Note the rules encoded there: `status = assigneeEmail ? 'assigned' : 'draft'`; the task is
created only when `result === 'fail'` AND `create_task !== false` AND no task already exists
for that (template, item, date); the created task id is stored back on the record row
(`created_task_id`) so a re-save never double-raises. **FSSAI corrective actions must
reproduce all four of those guards.**

`TASK_CATEGORIES` (`tasks.ts:107`) already includes `Hygiene`, `Compliance`, `Safety`,
`Kitchen`, `Housekeeping`, `Store`, `Bar`, `Maintenance`, `Training` — FSSAI needs no new
category. `task_categories` (13 rows) and `task_departments` (10 rows) are the DB-side
vocabularies. `task_approvals` supports the verification step
(`requested_by`, `approver_email`, `decision` pending|..., `decided_at`).

### AND THE PART THAT MUST REACH THE OWNER (F1)

The FSSAI spec's "twelve sub-modules ship as seeded template rows — a template with
sections, typed questions, a frequency, a department, a responsible role and pass/fail
conditions" describes something that **partially exists**:

```
checklist_templates  (5 rows)  id | name | role | department | category | is_active | ...
checklist_items     (56 rows)  id | template_id | label | sort_order | requires_image | ...
daily_checklist_records (0)    id | template_id | item_id | date | result | comment
                               | image_url | corrective_action | created_task_id
                               | department | recorded_by | created_at
hygiene_audits          (0)    id | area | item | date | result | image_url
                               | corrective_action | created_task_id | score | auditor
```

Live templates: Operations Manager / Floor Manager / HR Manager / Store Manager / Bar
Manager Daily Checklists, seeded 2026-07-14. `CHECKLIST_ROLES` and `HYGIENE_AREAS`
(Restaurant, Washrooms, Kitchen, Bar) are in `tasks.ts:140` / `:148`.

What it LACKS versus the FSSAI spec: typed questions (it has only label + `requires_image`;
FSSAI needs Yes/No, Pass/Fail, Numeric, Temperature, Text, Photo, Multiple Choice,
Signature), a frequency on the template (records are keyed by `date`, implying daily),
sections, pass/fail conditions, a responsible-role FK, and management verification.
`result` is a free-text column defaulting to `'na'` with a `VALID` set enforced in the route.

**This is a P0 decision for the owner, not a build-phase guess.** Either (a) FSSAI's
`fssai_checklist_*` tables supersede these and the old ones are left frozen in place, or
(b) FSSAI extends `checklist_templates` / `checklist_items` additively. Option (a) risks two
checklist UIs in one app (the "native" rule); option (b) touches live rows. **Neither is
this lane's call. It must be asked.**

Also note: **Pest Control and Water Filter Inspection already exist as
`maintenance_schedules` rows** and FSSAI wants both as sub-modules. Same question.

> **FSSAI should reference this by `tasks.id` and display `tasks.title`**, storing the
> raised id back on the FSSAI record (the `created_task_id` pattern) so a re-save cannot
> double-raise.

---

## 10. STORES — `store_locations` and `src/lib/store-engine.ts`

**`store_locations`, PK `id` TEXT, `name` UNIQUE. 1 live row on this dev DB:**

```
id=146b7c9d2694f97229a3dd6ae6c6e474  name='LIQUOR STORE'  code='LIQ'
description='Dedicated liquor store — bottles live here, not in the Central Store'
is_active=1  requires_authorization=1  floor_label=''
```

Columns: `id | name UNIQUE | code | description | is_active | requires_authorization |
created_at | floor_label`. Production has more rows (multi-floor bars are receiving stores).

`src/lib/store-engine.ts` (1,988 lines) is the module. The functions FSSAI will touch:

```ts
listStores(db): StoreLocation[]      // ACTIVE AND INACTIVE — callers filter. ORDER BY name COLLATE NOCASE
getStoreById(db, id)                 // COALESCE(floor_label,'') in the projection
getStoreByName(db, name)             // TRIM(name) = TRIM(?) COLLATE NOCASE
storeCategories(db, storeId): string[]
materialStoreId(db, ...)             // category -> store via store_category_map; only ACTIVE stores claim
userStoreAccess(db, user, storeId): StoreAccess
storeStock(db, storeId): StoreStockRow[]
postLedger(db, entry): string        // the ONLY writer of store_stock_ledger
consolidatedStock(db), storeItemList(db, ...), floorReconciliation(db, ...)
```

**`listStores` returns inactive stores too — FSSAI must filter `is_active` itself.**

`userStoreAccess` (`:254`), the access model, verbatim logic:

```ts
if (!user) return NO_ACCESS;
if (user.role === 'admin') return FULL_ACCESS;
if (user.is_head_chef || user.is_store_manager) return FULL_ACCESS;
if (/bar manager/i.test(user.position) || /bar manager/i.test(user.role_name)) return FULL_ACCESS;
// else: row from store_user_access WHERE store_id=? AND user_id=?
//       -> { can_view, can_procure, can_adjust, can_close_stock }; no row => NO_ACCESS
```

`StoreAccess` = `{ can_view, can_procure, can_adjust, can_close_stock }`, with frozen
`NO_ACCESS` / `FULL_ACCESS` constants (`:60`, `:64`). **It fails CLOSED** — a missing
`store_user_access` row is NO_ACCESS, not read-only. `store_user_access` is 0 rows on this
dev DB (so only the privileged branches are exercised locally); `store_category_map` has 23
live rows. `LEDGER_TXN_TYPES` (`:69`) is the ledger vocabulary.

> **FSSAI should reference this by `store_locations.id` and display `store_locations.name`**
> (falling back to `code` for compact surfaces), gating every read with
> `userStoreAccess(db, me, storeId).can_view`.

---

## 11. DEPT STOCK — `src/lib/dept-stock.ts` scoping helpers

```ts
canSeeAllDeptStock(user: SessionUser): boolean {            // :183
  return user.role === 'admin' || user.role === 'manager'
      || user.is_head_chef || user.is_store_manager;
}

allowedDeptIds(user: SessionUser): Set<string> {            // :189
  const out = new Set<string>();
  if (user.department_id) out.add(user.department_id);
  if (user.visible_department_ids) {
    try { const arr = JSON.parse(user.visible_department_ids);
          if (Array.isArray(arr)) for (const id of arr) if (id) out.add(String(id)); }
    catch { /* garbled grant -> ignore */ }
  }
  return out;
}
```

**THE SHAPE OF THE GATE, and it is asymmetric.** `canSeeAllDeptStock` is a *bypass*.
`allowedDeptIds` returns the set for everyone ELSE, and note its two properties:
(1) it is built from `users.department_id` PLUS the JSON grant `visible_department_ids`;
(2) **a garbled JSON grant is swallowed and the user silently keeps only their own dept** —
it fails closed, which is right, but FSSAI must not interpret an empty set as "no filter".
An empty set means NOTHING is visible.

Also exported and relevant:

```ts
resolveDeptSet(db, deptId): string[]          // :169  dept + its active subs when MAIN
allowedDeptSetExpanded(db, user): string[]    // :293  the above, expanded, for a user
computeDeptStock(db, deptId)                  // :302  { rows, summary } | null
stockOnHandBulk(db, opts)                     // :812
getDeptLedgerCutoverAt(db): string | null     // :209  settings key 'dept_ledger_cutover_at'
DEPT_ITEM_SET_SQL + deptItemSetParams(deptSet)// :270/:285  NOTE: no importers today (the file says so)
```

The canonical usage pattern is: `canSeeAllDeptStock(me) ? <no filter> :
allowedDeptSetExpanded(db, me)` then bind that array. FSSAI queries that show anything
dept-scoped (checks recorded by a kitchen, a department's corrective actions, a
department's temperature logs) must use exactly this pair, not a hand-rolled
`WHERE department_id = me.department_id`, which would drop granted departments.

> **FSSAI should reference this by `departments.id` (as members of the
> `allowedDeptSetExpanded` array) and display `departments.name`.**

---

## 12. SUPPORTING FACTS FSSAI WILL NEED

**Audit trail.** `audit_events` (241 live rows): `id | event_type | entity_type | entity_id
| actor_email | outlet_id | before_json | after_json | note | created_at`.
Writer: `logAuditEvent(db, { event_type, entity_type, entity_id, actor_email?, outlet_id?,
before?, after?, note? })` at `src/lib/db.ts:8285` — *"Never throws — audit failure should
not break the parent operation."* Live `entity_type` values include `purchase_order` (43),
`requisition` (12), `raw_material` (4), `hr_employee` (2), `recipe` (2), `database` (167).
**FSSAI's "permanent audit history" should write `entity_type='fssai_<thing>'` here rather
than building a second audit table.** `grn-reversal.ts:143` exposes `logAuditOrThrow` for
the cases where the audit row IS the transaction.

**Settings.** `settings` is a bare `key TEXT PRIMARY KEY, value TEXT NOT NULL` (60 rows).
`PUT /api/settings` has a `KEY_POLICY` allow-list with per-key owners; any FSSAI setting
must be registered there or a manager-tier generic write can clobber it (this exact gap is
documented live for `department_recipe_deduction_v1` at
`src/app/api/departments/route.ts:16-31`).

**Auth surface FSSAI routes must use.** `src/lib/auth.ts`: `getCurrentUser()`,
`getCurrentOutletId()`, `requireRole('admin'|'manager')`, `isManagement(user)`
(`role==='admin' || role==='manager' || is_head_chef`), `canApproveAsChef`,
`canProcessAsStore`, `canIssueAsStore`, `canApproveAsMgmt`, `canManageKitchenProduction`.
`SessionUser` carries `role`, `role_id`, `role_name`, `position`, `department_id`,
`is_head_chef`, `is_store_manager`, `can_approve_requisitions`, `page_access`,
`visible_department_ids`, `preferred_zones`, `preferred_table_ids`, `section`,
`can_request_discount`, `max_discount_pct`.

**The edge.** `src/proxy.ts` (matcher `'/((?!_next/static|_next/image|favicon.ico).*)'`)
401s every non-public `/api/*` without a session and enforces page access for non-API
routes. A new `/api/fssai` prefix should be added to the CSRF-protected list at
`proxy.ts:80-96` (as `/api/hr` and `/api/tasks` are), and FSSAI client writes must go
through `src/lib/api.ts` or they will 403 there.

**`better-sqlite3` is SYNCHRONOUS.** Never `await` a `.get()` / `.all()` / `.run()`.
Use `db.transaction(() => { ... })` for multi-row writes (the checklist route is the model).
`DB_PATH` is `process.cwd()/fnb-controller.db` — never start a server in the live repo.

---

## 13. WHAT I COULD NOT DETERMINE — stated plainly, to be re-checked

1. **Production row counts for HR, Assets and Stores.** This DB is dev:
   `hr_employees=0`, `hr_designations=0`, `hr_assets=0`, `store_user_access=0`,
   `store_locations=1`. The SCHEMAS are production's, verified against the live file. The
   population is not. Specifically unverified: whether production `hr_employees` rows have
   `user_id` populated (which decides whether an `hr_employees` -> `users` join is usable
   at all for "Checked By"), and how many `store_locations` rows production carries.
2. **Whether production has run the `po_id` boot migration recently.** The backfill is
   `WHERE po_id IS NULL` and idempotent, but it only runs at boot; production's
   `po_id_set` count is unknown. The GRN-join resolution works regardless, which is why it
   is the recommendation.
3. **The owner's intent on the existing checklist/hygiene module (F1) and on Pest Control /
   Water Filter Inspection already existing as maintenance schedules.** A build decision,
   not a fact I can read out of the DB. Must be asked before P1 designs the engine.
4. **Whether `raw_materials.shelf_life_days` and `.storage_location` are empty in
   production too, or only here.** Both are 0/952 and ''/952 on this snapshot. If they are
   equally empty in production, FSSAI FIFO/FEFO on raw materials needs a data-entry phase
   before it can show anything, and P1 must budget for it.
5. **`checklist_items.requires_image` is the only question-type signal that exists.** I
   found no other typed-question machinery anywhere in `src/` — no existing renderer for
   Numeric / Temperature / Multiple Choice / Signature. The mobile runner is new work.
6. **Outlet scoping.** `outlets` has 2 rows and most modules take `outlet_id` (often
   nullable, often `OR outlet_id IS NULL`). I did not map which FSSAI records must be
   outlet-scoped; `getCurrentOutletId()` exists and the batch module's pattern
   (`AND (outlet_id = ? OR outlet_id IS NULL)`) is the house convention.

---

## 14. THE CONTRACT — one line per master

| # | Master | Reference by | Display | Query via |
|---|---|---|---|---|
| 1 | Item Master | `raw_materials.id` | `raw_materials.name` (+`sku`) | `GET /api/inventory`; money via `closing-valuation.ts`; qty via `pack-units.ts` |
| 2 | Vendor Master | `vendors.id` | `vendors.name` | `GET /api/vendors`; mapping via `vendor-mapping.ts`. `store_vendors` is a JSON key, NOT a table |
| 3 | Receiving | `goods_receipt_notes.id` / `goods_receipt_note_items.id` | `grn_number` | PO via `purchases.grn_id -> goods_receipt_notes.po_id`, never `purchases.po_id` alone |
| 3b | Purchase Order | `purchase_orders.id` | `po_number` | `GET /api/purchase-orders` |
| 4 | Batch/FIFO | `production_batches.id` | `barcode` (`PROD######`) + `batch_number` | `production-batch.ts`: `itemGroupClause`, `computeFifo`, `expiryStatus`. FIFO exists, FEFO does not |
| 5 | Departments | `departments.id` | `departments.name` | `dept-hierarchy.ts` / `resolveDeptSet`. READ ONLY. Watch the `department_id` vs free-text `department` split |
| 6 | People | `users.email` (stored) | `users.name` | `GET /api/tasks/users`. `hr_employees.full_name` + `status` only behind `canManageHr` |
| 7 | Equipment | **NEW `fssai_equipment.id`** | `fssai_equipment.name` | **No master exists.** `hr_assets` is staff kit; cold rooms are free text on batches |
| 8 | Maintenance | `maintenance_schedules.id` | `maintenance_schedules.name` | insert `tasks` (`source='maintenance'`) + `maintenance_logs` |
| 9 | Tasks | `tasks.id` | `tasks.title` | the `/api/tasks/checklists` recipe verbatim; store `created_task_id` back |
| 10 | Stores | `store_locations.id` | `store_locations.name` | `store-engine.ts`: `listStores` (filter `is_active` yourself), `userStoreAccess` |
| 11 | Dept scoping | `departments.id` in the allowed set | `departments.name` | `canSeeAllDeptStock(me) ? all : allowedDeptSetExpanded(db, me)` |

---

*End of lane: integration-masters. Read-only phase — no code written, no existing file
modified, no migration run, no server started. Appended to this document; nothing above
this lane's heading was altered.*


---

# FSSAI P0 RECON — LANE: DATABASE CONVENTIONS

**Phase:** P0 (read-only). **Date:** 2026-09-16.
**Worktree:** `/Users/shashankreddy/Desktop/Claude/fnb-fssai`, branch `fssai-compliance`, forked from main @ `4125237`.
**Live repo read (never written):** `/Users/shashankreddy/Desktop/Claude/fnb-controller`.

Every line number refers to the **worktree** copy `src/lib/db.ts` (9,561 lines) unless the text
says *live copy*. §0 explains why those two files differ and why it matters.

Nothing was written except this document. No migration ran. No server was started. The live
database was opened read-only and snapshotted with `VACUUM INTO` (§8).

---

## §0. THE TWO db.ts FILES — READ THIS BEFORE P1 TOUCHES ANYTHING

The worktree and the live repo do **not** hold the same `db.ts`.

```
$ wc -l /Users/shashankreddy/Desktop/Claude/fnb-controller/src/lib/db.ts     # live
   10129
$ wc -l /Users/shashankreddy/Desktop/Claude/fnb-fssai/src/lib/db.ts         # our worktree
    9561
$ diff <worktree> <live> | grep -c "^[<>]"
568
```

The 568 differing lines are the **uncommitted liquor-reconciliation (`lq_*`) work** in the live
repo. Tables present only in the live copy:

```
$ comm -13 <(grep -o "CREATE TABLE IF NOT EXISTS [a-z_0-9]*" <worktree> | sort -u) \
           <(grep -o "CREATE TABLE IF NOT EXISTS [a-z_0-9]*" <live>     | sort -u)
lq_brand_map
lq_portal_checks
lq_retail_flags
lq_wallet_txns
lq_withdrawals
```

Consequences, in order of importance:

1. **Our insertion point is line 8189/8190, not the live file's 8756.** In the worktree,
   `initializeSchema()` ends at:
   ```
   8188	    `);
   8189	  } catch (e) { console.error('hrms schema failed:', e); }
   8190	}
   ```
   The FSSAI block goes **after 8189, before the closing brace on 8190**. In the live copy the
   HRMS catch is at 8251 and the `lq_*` block runs 8251-8756. Do not copy a line number across.

2. **The live DB is already ahead of our db.ts.** The five `lq_*` tables exist in production data
   (§8) but not in our branch's schema code. Expected and harmless — our branch never drops
   anything — but "table exists in the DB" is not proof our branch creates it.

3. **The best migration-safety pattern in this codebase lives in that uncommitted work** (§3.4).
   Reuse the *pattern*. Do **not** import the `lq_*` code into this branch — it is the owner's
   ungated work and copying it here would entangle two unrelated deliverables.

---

## §1. THE STRUCTURE OF initializeSchema()

### 1.1 Where it is and when it runs

`src/lib/db.ts:24-76` — module-level singleton, `DB_PATH` is **`process.cwd()`-relative**:

```ts
24	const DB_PATH = path.join(process.cwd(), 'fnb-controller.db');
25
26	let db: Database.Database | null = null;
27
28	export function getDb(): Database.Database {
29	  if (!db) {
30	    db = new Database(DB_PATH);
31	    db.pragma('journal_mode = WAL');
32	    db.pragma('foreign_keys = ON');
...
59	    db.pragma('cache_size = -32000');
60	    db.pragma('busy_timeout = 5000');
61	    db.pragma('temp_store = MEMORY');
62	    initializeSchema(db);
```

Load-bearing facts:

- `initializeSchema()` runs **once per process**, on the first `getDb()`, guarded only by the
  `if (!db)` memo. A deploy restarts the process, so **"runs on boot" means "runs on every
  deploy"** — the premise of the boot-migration lock (§3.3).
- `foreign_keys = ON` (line 32). FK declarations are **enforced**, not decorative.
- `temp_store = MEMORY` (line 61) matters for §3.4: the shape-guard pattern creates `temp.zz_*`
  tables, and with this pragma they never touch disk.
- `DB_PATH` is `process.cwd()`-relative — **this is why no server may be started in
  `fnb-controller/`**. Running `npm run dev` there opens the real 34 MB production database
  read-write.

### 1.2 Internal organisation

`initializeSchema()` spans **lines 77-8190** (8,113 lines):

| Region | Lines | Shape |
|---|---|---|
| Core founding tables | 78-340 | ONE giant db.exec() template literal, **no try/catch** |
| Everything after | 341-8189 | ~130 independent try/catch blocks, each ending `catch (e) { console.error('<label> failed:', e) }` |

Counts, measured:

```
$ grep -c "db.exec("                   db.ts   ->  364
$ grep -c "catch (e) { console.error"  db.ts   ->  130
$ grep -c "catch (_)"                  db.ts   ->    4
$ grep -c "catch {"                    db.ts   ->   10
```

The **first db.exec() at line 78 is unguarded**. It creates `raw_materials`, `purchases`,
`sub_recipes`, `recipes`, `settings` (207) and the other founding tables. A failure there is the
only schema failure that actually crashes boot. Everything after line 341 fails silently.

### 1.3 Where a new module's block goes

The two most recent modules both appended a single labelled block at the tail with a banner
comment. The Task module banner (`db.ts:5459-5465`) is the template:

```ts
5459	  // ══════════════════════════════════════════════════════════════════════════
5460	  // TASK MANAGEMENT MODULE (2026-07) — purely additive. All 19 tables + seeds
5461	  // live inside ONE labeled try/catch so any failure here never blocks boot and
5462	  // never touches existing tables. Idempotent: CREATE TABLE/INDEX IF NOT EXISTS,
5463	  // INSERT OR IGNORE, existence-guarded seeds.
5464	  // ══════════════════════════════════════════════════════════════════════════
5465	  try {
```

**Recommendation for FSSAI:** append after `db.ts:8189`, same banner form, but **do not use one
giant db.exec()** — §3.2 shows why the Task module's own choice is the thing that would bite us.

### 1.4 Ordering constraints (real, not stylistic)

1. **`settings` must exist before any one-shot flag is read.** Created at line 207 inside the
   unguarded block, so any block after line 341 can rely on it. A `fssai_` block at 8189 is safe.
2. **FK parents before children.** `foreign_keys = ON`. SQLite does not validate FK targets at
   CREATE TABLE time, only at DML time — so a forward reference will not fail the migration, it
   will fail the first insert.
3. **Seeds after their table, in the same block** (pattern at 5767-5785: `INSERT OR IGNORE`
   immediately after the create, inside the same try).
4. **Backfills after the columns they fill**, and one-shot or null-only (§3.3).
5. **A seed that must not re-run needs its flag written inside the same transaction.**
   `db.ts:793-795`: *"The flag is written INSIDE the transaction, so a crash between seed and flag
   leaves neither and the next boot retries cleanly."*

---

## §2. THE TWO PATTERNS

### 2.1 Pattern A — fresh CREATE TABLE IF NOT EXISTS

Canonical example, `db.ts:904-920` (`menu_item_images`):

```ts
904	  try {
905	    db.exec(`
906	      CREATE TABLE IF NOT EXISTS menu_item_images (
907	        id         TEXT PRIMARY KEY,
908	        item_id    TEXT,
909	        mime       TEXT NOT NULL,
910	        width      INTEGER NOT NULL DEFAULT 0,
911	        height     INTEGER NOT NULL DEFAULT 0,
912	        size       INTEGER NOT NULL DEFAULT 0,
913	        data       BLOB NOT NULL,
914	        created_by TEXT NOT NULL DEFAULT '',
915	        created_at TEXT NOT NULL DEFAULT (datetime('now'))
916	      );
917	      CREATE INDEX IF NOT EXISTS idx_menu_item_images_item ON menu_item_images(item_id);
918	      CREATE INDEX IF NOT EXISTS idx_menu_item_images_created ON menu_item_images(created_at);
919	    `);
920	  } catch (e) { console.error('menu_item_images migration failed:', e); }
```

House rules visible in it, confirmed across all 204 live tables (§4): `TEXT PRIMARY KEY`; every
non-PK column NOT NULL DEFAULT-ed; `created_at TEXT NOT NULL DEFAULT (datetime('now'))`; indexes
IF NOT EXISTS, named `idx_<table>_<cols>`, declared in the same statement block under the table;
one labelled catch per block.

### 2.2 Pattern B — additive ALTER TABLE ADD COLUMN behind a has() guard

**The has() helper is not a shared utility.** It is redeclared inline in every block that needs it,
always over a fresh PRAGMA table_info. Canonical form, `db.ts:1001-1013`:

```ts
1001	  try {
1002	    const cols = db.prepare("PRAGMA table_info(raw_materials)").all() as any[];
1003	    const has = (n: string) => cols.some((c: any) => c.name === n);
1004	    const adds: [string, string][] = [
1005	      ['primary_vendor',     "TEXT DEFAULT ''"],
1006	      ['purchase_unit',      "TEXT DEFAULT ''"],
1007	      ['recipe_unit',        "TEXT DEFAULT ''"],
1008	      ['conversion_factor',  "REAL DEFAULT 1"],
1009	      ['yield_percent',      "REAL DEFAULT 100"],
1010	      ['last_purchase_price',"REAL DEFAULT 0"],
1011	      ['last_purchase_date', "TEXT DEFAULT NULL"],
1012	    ];
1013	    for (const [c, t] of adds) if (!has(c)) db.exec(`ALTER TABLE raw_materials ADD COLUMN ${c} ${t}`);
```

One-line-per-column variant, `db.ts:3110-3117` (named `hasG` to avoid shadowing):

```ts
3110	    const grnCols = db.prepare("PRAGMA table_info(goods_receipt_notes)").all() as any[];
3111	    const hasG = (n: string) => grnCols.some((c: any) => c.name === n);
3112	    if (!hasG('qc_quality'))       db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_quality INTEGER NOT NULL DEFAULT 0`);
3113	    if (!hasG('qc_temperature'))   db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_temperature INTEGER NOT NULL DEFAULT 0`);
3114	    if (!hasG('qc_expiry'))        db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_expiry INTEGER NOT NULL DEFAULT 0`);
3115	    if (!hasG('qc_damage'))        db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_damage INTEGER NOT NULL DEFAULT 0`);
3116	    if (!hasG('qc_weight'))        db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_weight INTEGER NOT NULL DEFAULT 0`);
3117	    if (!hasG('qc_invoice_match')) db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN qc_invoice_match INTEGER NOT NULL DEFAULT 0`);
```

**Two traps in Pattern B:**

- `cols` is read **once, before** the ALTERs. Fine as written, because each column is added at most
  once — but a block that ALTERs and then re-consults the stale `cols` will add twice and throw.
  Re-PRAGMA if you need a fresh view.
- A NOT NULL column added by ALTER **must carry a DEFAULT**, or SQLite rejects it on a non-empty
  table. Every example above obeys this.

### 2.3 Which pattern FSSAI uses

All `fssai_` tables are new => **Pattern A**. Pattern B applies only where FSSAI extends an
existing table — per HARD RULE 2 the only candidates are `goods_receipt_notes` (Receiving QC, which
**already has six qc_* columns**, §8.4(3)) and `raw_materials` (which **already has
storage_location and shelf_life_days**, §8.5). Check what exists before proposing a column.

---

## §3. HOW ERRORS ARE SWALLOWED, AND HOW TO PROVE A MIGRATION APPLIED

### 3.1 The exact swallow

No clever machinery — 130 copies of one line. Representative, `db.ts:8189`:

```ts
  } catch (e) { console.error('hrms schema failed:', e); }
```

and `db.ts:920`:

```ts
  } catch (e) { console.error('menu_item_images migration failed:', e); }
```

Four blocks swallow with **no log at all** — `catch (_) { /* table may not exist yet on first run */ }`
(e.g. `db.ts:436`, `db.ts:456`). Ten more use a bare `catch {`.

console.error goes to the systemd journal (`deploy/fnb-controller.service:18-20`):

```
18	# Logging — visible via `journalctl -u fnb-controller`
19	StandardOutput=journal
20	StandardError=journal
```

Evidence exists but is only reachable by SSH-ing to the box. **Nothing surfaces a failed migration
inside the app.** The app boots normally, the page renders, and the first write throws
"no such table".

### 3.2 What a single swallowed error actually costs — MEASURED

A multi-statement exec runs its statements **sequentially**; when one throws, the ones before it
have already committed and the ones after it **never run**. With the whole block in one try, the
log records one line and the module loses every table below the typo.

Proof, run against an in-memory database with this repo's own better-sqlite3:

```
$ node exec-fail-proof.js

--- index on a mistyped column (statement 5 of 9) ---
error  : no such column: recored_at
created: ["fssai_a","fssai_b","fssai_c"]
LOST   : fssai_d, fssai_e

--- syntax typo (statement 3 of 5) ---
error  : near "TABEL": syntax error
created: ["fssai_a","fssai_b"]
LOST   : fssai_c, fssai_d, fssai_e

--- duplicate column in table 2 of 5 ---
error  : duplicate column name: note
created: ["fssai_a"]
LOST   : fssai_b, fssai_c, fssai_d, fssai_e
```

Read the first case carefully: **a typo in an INDEX name — `recored_at` for `recorded_at` —
silently destroyed two later tables.** The Task module put all 20 of its tables in one statement
block (`db.ts:5466-5765`). FSSAI plans nine. One typo in question-type index #3 and sub-modules 4-9
have no storage, with a single journal line as the only trace.

### 3.3 What verification already exists

| Mechanism | File | What it actually proves | Enough for FSSAI? |
|---|---|---|---|
| check-boot-migrations.js | `scripts/check-boot-migrations.js` | **Static lint of db.ts text.** Flags boot-time writes to admin-owned state lacking a one-shot guard. Never opens a database. | No — cannot tell whether a table exists |
| config_fingerprint_log | `db.ts:5428-5457` | SHA-256 of the users/roles permission config each boot; logs transitions | No — permissions only |
| Admin Database console | `src/app/api/admin/database/route.ts` | Admin-only, read-only SQL in a child process; `?view=catalog` returns table list + row counts | **Yes — this is the verification tool** |
| Boot assertion / schema_version | — | **Does not exist.** grep for `process.exit`, `SCHEMA_VERSION`, `schema_version` in db.ts -> no matches | — |
| Health endpoint | — | **Does not exist.** No `src/app/api/health*` | — |

check-boot-migrations.js is wired into `npm test` (`package.json:17`) and `npm run check:boot`
(`package.json:21`). Its header states the rule FSSAI's seeds must obey
(`check-boot-migrations.js:8-23`):

> *"The migration block in src/lib/db.ts runs on EVERY getDb() cold start, and a deploy restarts
> the process — so 'runs on boot' means 'runs on every deploy'. That is fine for a schema change …
> It is NOT fine for anything a human has decided."*

Escape hatches in the order the file itself prefers them (`check-boot-migrations.js:31-49`): make
it one-shot with a settings flag; narrow it to a true NULL-fill; or declare
`// boot-migration-lock: <reason>`.

**This directly constrains the FSSAI checklist-template seed.** Seeding twelve templates on every
boot would re-add a template an admin retired — the identical shape as the `menu_categories`
is_active case the lock already guards (`check-boot-migrations.js:73-80`). Use a one-shot flag.

### 3.4 BEST PRACTICE IN THIS CODEBASE — and it already exists, uncommitted

The strongest answer to "prove the migration applied" is **not** something P1 must invent. The
uncommitted `lq_*` work in the live repo solved exactly this, twice over (live copy
`fnb-controller/src/lib/db.ts`):

**(a) Per-statement execution with the failing table NAMED** — live `db.ts:8589-8593`:

```ts
  for (const stmt of LQ_TABLE_DDL) {
    const named = /CREATE TABLE IF NOT EXISTS (lq_[a-z_]+)/.exec(stmt);
    try { db.exec(stmt); }
    catch (e) { console.error('liquor reconciliation (lq_*) schema failed for ' + (named ? named[1] : '?') + ':', e); }
  }
```

A DDL **array**, not one template literal. One bad statement loses exactly one table, and the log
says which. This alone defeats every failure mode measured in §3.2.

**(b) A SHAPE GUARD, for the thing IF NOT EXISTS cannot do** — live `db.ts:8596-8666`:

> *"IF NOT EXISTS answers 'is there an object with this name', never 'does it have the right
> columns'. A table that already exists in a WRONG shape survives the block above in complete
> silence — no log line, indexes still created, CHECK vocabularies simply absent — and then throws
> at runtime, three deploys away from the cause. Measured on a fixture: a 6-of-16-column
> lq_wallet_txns booted clean, then 'table lq_wallet_txns has no column named bank_match' on the
> first save, with type='NONSENSE' accepted."*

And why it matters **specifically to a phased build**:

> *"This matters most for the phases: the day L2 adds a column to the CREATE TABLE above, dev is a
> fresh DB and works, while testing and production already have the table and never get it."*

Mechanism: re-run each CREATE TABLE text into `temp.zz_<name>`, read the intended columns off the
temp copy with **pragma_table_xinfo** (not table_info — it omits generated columns, which would
make the guard re-ALTER every boot: *"Measured: table_info 25, table_xinfo 26"*), diff against the
real table, and ALTER TABLE ADD COLUMN whatever is missing. Generated columns and
NOT-NULL-without-default columns are **reported, not added**. `dflt_value` comes back without
parentheses and must be re-wrapped. It shouts on drift because CHECK constraints and FKs cannot be
added by ALTER, so a repaired table is only *partly* repaired.

**Recommendation for the FSSAI foundation phase (P1):**

1. Define `FSSAI_TABLE_DDL: string[]` — one CREATE TABLE IF NOT EXISTS fssai_* per entry.
2. Execute per-statement with the table name in the catch (pattern (a)).
3. Add the shape guard over `fssai_` (pattern (b)), **reimplemented in this branch** — do not
   import the `lq_` code.
4. Indexes in their own try, separate from the tables, so one swallowed error cannot hide the other
   half (the live block says so at `db.ts:8668-8669`).
5. After the block, assert and log: count how many expected `fssai_` tables exist and console.error
   loudly if any are missing. No such assertion exists anywhere in the app today; FSSAI is the
   module that needs it, and "inspection-ready records" is exactly what a missing table destroys.
6. Verify by hand, per deploy, through the admin Database console: `?view=catalog`.

---

## §4. NAMING CONVENTIONS — MEASURED ACROSS ALL 204 LIVE TABLES

### 4.1 Primary keys

```
$ sqlite3 "file:<snapshot>?mode=ro" "SELECT CASE
    WHEN sql LIKE '%INTEGER PRIMARY KEY%' THEN 'INTEGER-PK'
    WHEN sql LIKE '%TEXT PRIMARY KEY%'    THEN 'TEXT-PK'
    ELSE 'other/composite' END AS k, COUNT(*)
  FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' GROUP BY k;"
INTEGER-PK|9
TEXT-PK|190
other/composite|5
```

**TEXT PRIMARY KEY holding a UUID is the rule (190 of 204).** Generator, `db.ts:8242-8244`:

```ts
8242	export function generateId(): string {
8243	  return crypto.randomUUID();
8244	}
```

The nine INTEGER PRIMARY KEY AUTOINCREMENT tables are all append-only high-volume logs:
`config_fingerprint_log`, `whatsapp_events_log`, `wa_conversations`, `wa_messages`, `wa_media`,
`wa_ingest_state`, `wa_consent_log`, `wa_report_files`, `wa_report_runs`.

**FSSAI should use TEXT PRIMARY KEY + generateId() throughout.**

### 4.2 Generated human-facing codes — a SEPARATE column, never the PK

Real values from the live database:

```
$ sqlite3 ... "SELECT barcode, batch_number FROM production_batches LIMIT 4;"
PROD000001|CG260707001
PROD000002|CG260708001
PROD000003|M260708001
PROD000004|PT260709001

$ sqlite3 ... "SELECT invoice_id FROM purchases WHERE invoice_id != '' LIMIT 3;"
PINV-2026-0001
PINV-2026-0002
PINV-2026-0003

$ sqlite3 ... "SELECT id FROM goods_receipt_notes LIMIT 2;"
129f5574-3b47-4efe-bcc6-89020753c796     <- the PK is still a UUID
2a3ae5c3-bf15-444c-ab0a-31320032562e
```

`PROD` + 6 digits is minted by max-suffix+1 (`src/app/api/kitchen-production/route.ts:42-50`);
`PINV-<yyyy>-####` by MAX(CAST(substr(...))) per year (`src/lib/grn-reversal.ts:1723-1726`). Both
are **max+1 scans, not counters** — safe on this single-threaded server, with
`production_batches.barcode UNIQUE` as the real guard.

If FSSAI needs a citable record number for an inspector: UUID PK + `record_no TEXT UNIQUE`.

### 4.3 Timestamps — and the txn_date trap

Frequency across all 204 tables (count = number of tables carrying that column name):

```
162  created_at        68  updated_at        26  date
  7  event_date         6  started_at         6  reviewed_at        6  completed_at
  5  sent_at            5  issued_at          4  recorded_at        4  finished_at
  3  txn_date           3  submitted_at       3  received_at        3  expiry_date
  2  voided_at          2  verified_at        2  served_at
```

**The rules:**

- `created_at TEXT NOT NULL DEFAULT (datetime('now'))` — universal (162 tables). **UTC**.
- `updated_at` same declaration, on tables that are edited (68).
- `date TEXT` (YYYY-MM-DD) — the **business date** a record belongs to, distinct from created_at.
  26 tables. This is what an FSSAI daily log is keyed and reported on.
- Event verbs get `<verb>_at`: reviewed_at, verified_at, voided_at, completed_at.

**The txn_date trap, confirmed:** it exists on only **3** tables. `inventory_transactions` uses it,
alongside *both* created_at and recorded_at:

```
$ sqlite3 ... "PRAGMA table_info(inventory_transactions);"
0|id|TEXT   ... 6|created_at|TEXT|1|datetime('now')  ... 17|txn_date|TEXT|1|''
                                                        18|recorded_at|TEXT|1|''
                                                        19|created_by|TEXT|1|''
```

Three different times on one row: txn_date = when the movement happened (backdatable),
recorded_at = when a human entered it, created_at = when the row was written. **FSSAI must not
invent a fourth spelling.** Use `date` for the business date (the 26-table majority) and
`created_at` for the row. Use `recorded_at` **only** if a check may be logged for an earlier date
than it was entered — an owner decision, not a default (§10).

### 4.4 Other column conventions

| Concern | Convention | Evidence |
|---|---|---|
| Soft-delete / retire | `is_active INTEGER NOT NULL DEFAULT 1` | 42 tables |
| Actor | `created_by TEXT NOT NULL DEFAULT ''` — an **email**, not a user id | 41 tables; logAuditEvent uses actor_email |
| Free text | `notes` (37) or `note` (22) | — |
| Ordering | `sort_order INTEGER NOT NULL DEFAULT 0` | 9 tables |
| Workflow state | `status TEXT NOT NULL DEFAULT '<initial>'` with the vocabulary in a trailing `--` comment | 50 tables; e.g. `db.ts:8107` |
| Booleans | `INTEGER NOT NULL DEFAULT 0/1`. No SQLite BOOLEAN anywhere | — |
| **JSON** | **`<thing>_json TEXT NOT NULL DEFAULT '{}'` or `'[]'`** — plain TEXT, JSON.stringify on write. No json_*() SQL functions | 29 columns, all suffixed `_json` |

The `_json` census (the naming rule has no exceptions):

```
audit_events.before_json / .after_json        tasks.checklist_json
hr_attendance_corrections.original_json / .requested_json / .approved_json
hr_shifts.split_json          hr_payroll_items.earnings_json / .deductions_json / .detail_json
knowledge_tests.questions_json                knowledge_test_results.answers_json
hr_test_questions.options_json                hr_test_attempts.answers_json
training_sessions.attendees_json              ct_calls.analysis_json
po_line_stock_snapshots.stores_json / .dept_json   ... (29 total)
```

**FSSAI's typed questions and answers go in `*_json` TEXT columns**, matching
knowledge_tests.questions_json / knowledge_test_results.answers_json — the closest existing
analogue to a typed-question engine.

### 4.5 Foreign keys — the split

```
$ sqlite3 ... "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND sql LIKE '%FOREIGN KEY%';"
56
```

**Which** 56 is the point. Of the prefixed module families, only `store_*` and `lq_*` declare FKs.
**`task_*`, `hr_*`, `ct_*`, `crm_*`, `wa_*` declare none** — they reference by plain TEXT id plus
an index, and say so:

```
7579	        employee_id TEXT NOT NULL,                -- hr_employees.id (no FK by design)
7616	        employee_id    TEXT NOT NULL,               -- hr_employees.id (no FK by design)
```

House rule at `db.ts:7507-7509`: cross-module references are *"plain TEXT + index (the
task_*/ct_* house style)"*.

**FSSAI is a module, not a ledger => follow the module style: no FKs to raw_materials, vendors,
departments, users or hr_employees.** Plain TEXT + index + a `--` comment naming the target. This
also keeps `foreign_keys = ON` from turning a deleted master row into a failed compliance write.

*Rationale for P1:* a food-safety record is evidence. It must survive the deletion of the vendor or
employee it refers to. An FK would either block that deletion or cascade the evidence away.

### 4.6 outlet_id scoping — NOT universal

49 tables carry outlet_id. The original migration (`db.ts:1117-1132`) applied it to seven
transactional tables:

```ts
1117	    const TABLES_NEEDING_OUTLET = [
1118	      'sales', 'purchases', 'purchase_orders', 'parties', 'staff_meals',
1119	      'closing_stock', 'inventory_transactions',
1120	    ];
```

with backfill to a default outlet named 'Main' (`db.ts:1113`) and an `idx_<table>_outlet` index.

Measured — which FSSAI-relevant tables actually have it:

```
tasks  0    task_categories  0    checklist_templates  0    checklist_items  0
daily_checklist_records  0    hygiene_audits  0    hr_documents  0
maintenance_schedules  0      hr_employees  0 (has home_outlet_id)
production_batches  1
```

**The pattern:** money- and stock-movement tables are outlet-scoped; the Task module, the checklist
engine and the HR document vault are **not**.

**OPEN DECISION for the owner, not a default to assume.** One outlet exists in production. If FSSAI
records are ever pulled per-outlet for an inspection, `outlet_id TEXT` + `idx_fssai_<t>_outlet`
costs nothing now and cannot be retrofitted cheaply onto historical evidence later. Recommend
adding it, nullable, and flagging the question.

### 4.7 Table naming

```
40 hr_*    16 ct_*    16 crm_*    10 wa_*    10 task_*    8 store_*
 6 party_*  5 lq_*     4 production_*  3 print_*  ... plus unprefixed founders
```

Every module since the Task module is prefixed. `fssai_` is consistent, and **no fssai object
exists yet** (§8.2) — the namespace is clean.

### 4.8 Settings-key naming

60 rows in `settings`. Migration-flag convention:

```
menu_categories_seed_v1      direct_reviewed_backfill_v1    station_dept_seed_v1
qc_category_seed_v1          phase1_master_backfill_v1      discount_limits_v1
nav_continuity_grants_v1     recipe_costs_resync_v1         price_basis_repair_v1
migration_pack_size_reset_for_non_ml_v1     migration_sales_category_backfilled
```

Config keys are `<module>_<thing>`: hr_day_cutoff, hr_punch_debounce_min,
crm_loyalty_points_per_100, kot_undo_window_seconds, stale_table_auto_close_hours,
purchase_backdate_limit_days.

=> FSSAI one-shot flags: `fssai_<thing>_seed_v1`. FSSAI config keys: `fssai_<thing>`. The `fssai_`
prefix also lets P1 register an OWNED_PREFIXES entry (§7) in one line.

---

## §5. AUDIT PATTERNS ALREADY IN THE APP

The owner's §19 asks for four things: (a) created/modified by + timestamps, (b) original vs changed
value, (c) reason for change, (d) VOID-not-DELETE. All four exist here, in different places.

### 5.1 audit_events — the append-only spine (USE IT, but not sufficient alone)

`db.ts:3930-3952`:

```ts
3930	  // Append-only audit log. No UPDATE, no DELETE — only INSERT.
3931	  // We don't enforce immutability at the SQL level (SQLite triggers could,
3932	  // but it complicates testing); instead `logAuditEvent` is the only insert path
3933	  // and the /audit page is read-only.
...
3936	      CREATE TABLE IF NOT EXISTS audit_events (
3937	        id           TEXT PRIMARY KEY,
3938	        event_type   TEXT NOT NULL,
3939	        entity_type  TEXT NOT NULL,
3940	        entity_id    TEXT NOT NULL,
3941	        actor_email  TEXT NOT NULL DEFAULT '',
3942	        outlet_id    TEXT,
3943	        before_json  TEXT,
3944	        after_json   TEXT,
3945	        note         TEXT DEFAULT '',
3946	        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
3947	      );
3948	      CREATE INDEX IF NOT EXISTS idx_audit_created   ON audit_events(created_at DESC);
3949	      CREATE INDEX IF NOT EXISTS idx_audit_entity    ON audit_events(entity_type, entity_id);
3950	      CREATE INDEX IF NOT EXISTS idx_audit_actor     ON audit_events(actor_email);
```

Writer, `db.ts:8286-8317`:

```ts
8281	/**
8282	 * Log an append-only audit event. Captures who did what to which entity,
8283	 * with optional before/after snapshots for diff'ing.
8284	 * Never throws — audit failure should not break the parent operation.
8285	 */
8286	export function logAuditEvent(
8287	  db: Database.Database,
8288	  params: {
8289	    event_type: string;        // e.g. 'po.approve', 'recipe.edit', 'reset.run', 'purchase.delete'
8290	    entity_type: string;       // 'purchase_order', 'recipe', 'raw_material', 'requisition', ...
8291	    entity_id: string;
8292	    actor_email?: string;
8293	    outlet_id?: string | null;
8294	    before?: any;
8295	    after?: any;
8296	    note?: string;
8297	  }
8298	): void {
...
8314	  } catch (e: any) {
8315	    console.error('[audit] failed to log event:', e?.message, params.event_type);
8316	  }
```

`before`/`after` are JSON.stringify-ed by the helper — pass objects, not strings. event_type
convention: `<entity>.<verb>`, dot-separated, lowercase. 241 rows live.

**Covers §19(a) and (b). Does NOT cover (c) reason or (d) void.**

**Limitation FSSAI must design around:** logAuditEvent **never throws**. If the audit insert fails,
the parent operation succeeds anyway and the only trace is a journal line. For a record whose
purpose is inspection evidence, P1 should decide deliberately whether a compliance write may
succeed with its audit row missing, and say so in writing (§10).

### 5.2 hr_attendance_corrections — THE BEST MODEL FOR FSSAI §19

`db.ts:7665-7686`:

```ts
7665	      -- Corrections follow the variance_approvals pattern: frozen original +
7666	      -- requested + approved JSON, decision metadata, and a partial UNIQUE over
7667	      -- pending so one employee-day can hold only one open request. The
7668	      -- original events are NEVER rewritten — an approved correction appends
7669	      -- source='manual' events and recomputes the summary.
7670	      CREATE TABLE IF NOT EXISTS hr_attendance_corrections (
7671	        id             TEXT PRIMARY KEY,
7672	        employee_id    TEXT NOT NULL,
7673	        date           TEXT NOT NULL,               -- IST business date being corrected
7674	        original_json  TEXT NOT NULL DEFAULT '{}',
7675	        requested_json TEXT NOT NULL DEFAULT '{}',
7676	        reason         TEXT NOT NULL DEFAULT '',
7677	        requested_by   TEXT NOT NULL DEFAULT '',
7678	        status         TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
7679	        reviewed_by    TEXT NOT NULL DEFAULT '',
7680	        reviewed_at    TEXT NOT NULL DEFAULT '',
7681	        review_reason  TEXT NOT NULL DEFAULT '',
7682	        approved_json  TEXT NOT NULL DEFAULT '',
7683	        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
7684	      );
7685	      CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_att_corr_pending
7686	        ON hr_attendance_corrections(employee_id, date) WHERE status = 'pending';
```

**Why this is the one to copy** — it satisfies every clause of §19 in one shape:

| Owner's §19 clause | Column |
|---|---|
| created/modified by + timestamps | requested_by / created_at / reviewed_by / reviewed_at |
| original value | original_json (**frozen at request time**) |
| changed value | requested_json, then approved_json |
| reason for change | reason (requester) **and** review_reason (approver) |
| management verification | status + reviewed_by + reviewed_at |
| never destroys the original | stated at 7668-7669 — an approved correction **appends** |

The **partial unique index** (7685-7686) is a pattern FSSAI needs directly: one open correction per
(subject, date). The same guard prevents two pending corrective actions on one failed check.

It also gives FSSAI the Corrective Action sub-module almost verbatim: a failed check produces a row
with original_json (what was recorded), reason (what went wrong), requested_json (the action
proposed), then reviewed_by/review_reason (management verification).

### 5.3 variance_approvals — the ancestor, live proof the pattern works

```sql
CREATE TABLE variance_approvals (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                     -- 'central' | 'liquor'
  ...
  system_stock REAL NOT NULL DEFAULT 0,     -- what the system had at count time
  physical_stock REAL NOT NULL DEFAULT 0,   -- what was counted
  variance REAL NOT NULL DEFAULT 0,
  counted_by TEXT NOT NULL DEFAULT '',
  count_note TEXT NOT NULL DEFAULT '',      -- optional note from whoever counted
  status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected'
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT NOT NULL DEFAULT '',
  review_reason TEXT NOT NULL DEFAULT '',   -- admin records the reason after asking staff
  outlet_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), auto_applied INTEGER NOT NULL DEFAULT 0, ...
)
```

Note `auto_applied INTEGER` — records that a small variance applied itself without review. FSSAI's
equivalent question ("may a passing check auto-close?") should be recorded the same explicit way
rather than being implicit in the absence of a reviewer.

The trailing `, auto_applied ..., batch_id ..., batch_label ...` on one line is the visible
signature of **Pattern B ALTERs** on a live table — useful to recognise when reading schemas.

### 5.4 VOID-not-DELETE — goods_receipt_notes

`db.ts:3119-3146`:

```ts
3133	    // VOID IS A STATUS VALUE, NOT A COLUMN: goods_receipt_notes.status gains
3134	    // 'void' alongside received/partial/rejected. There is no CHECK constraint
3135	    // on that column (see the CREATE above), so this needs no table rebuild —
3136	    // but it does mean every reader that filters on status must be told about
3137	    // 'void'. A voided GRN keeps its header AND its line items: the bill
3138	    // document survives, struck through, with who voided it and when.
...
3141	    if (!hasG('edited_at'))   db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN edited_at TEXT`);
3142	    if (!hasG('edited_by'))   db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN edited_by TEXT DEFAULT ''`);
3143	    if (!hasG('edit_count'))  db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0`);
3144	    if (!hasG('voided_at'))   db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN voided_at TEXT`);
3145	    if (!hasG('voided_by'))   db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN voided_by TEXT DEFAULT ''`);
3146	    if (!hasG('void_reason')) db.exec(`ALTER TABLE goods_receipt_notes ADD COLUMN void_reason TEXT DEFAULT ''`);
```

The void/soft-delete census across all 204 tables is short — this is the **only** complete
implementation:

```
goods_receipt_notes.voided_at / .voided_by / .void_reason      <- the model
orders.voided_at                                                (status='void', no reason column)
tasks.is_archived                                               (archive, not void)
```

Lines 3124-3131 also answer a question FSSAI will face — *why denormalise onto the row when
audit_events already has it*: audit_events stays the authority for the field-level diff, but a list
view needing a per-row audit lookup would be an N+1 on every page load, so six cheap stamps ride
along. **FSSAI should do both: stamps on the record for the list view, logAuditEvent for the diff.**

### 5.5 error_reports — the dedupe + resolve shape

```sql
CREATE TABLE error_reports (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,               -- hash(source|message|where) for dedup
  ...
  count INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT, resolved_by TEXT NOT NULL DEFAULT '', notified_at TEXT
)
```

digest + count + first_seen/last_seen collapses a repeated event into one row; notified_at prevents
re-alerting. A recurring FSSAI failure (same check failing daily) should collapse the same way
rather than generating 30 identical alerts.

### 5.6 Verdict

| Need | Copy this |
|---|---|
| Every write, who/what/before/after | logAuditEvent -> audit_events (`db.ts:8286`) |
| **Correction with original + reason + approval** | **hr_attendance_corrections (`db.ts:7670-7686`)** |
| One open request per subject/day | partial UNIQUE ... WHERE status='pending' (`db.ts:7685`) |
| Cancel a record without destroying it | goods_receipt_notes void triple (`db.ts:3144-3146`) + status='void' |
| Repeating alert | error_reports digest/count/resolved (§5.5) |

---

## §6. ATTACHMENTS AND BLOBS — AND THE 1 MB CEILING

### 6.1 Three BLOB stores already exist

| Table | Purpose | Client cap | Gate |
|---|---|---|---|
| menu_item_images | dish photos | `400 * 1024` (`api/menu-items/image/route.ts:40`) | any signed-in |
| task_files | task attachments | `src/lib/task-files.ts` | any signed-in |
| hr_documents | HR document vault | `HR_DOC_MAX_BYTES = 5_000_000` (`src/lib/hr-files.ts:18`) | HR role + per-employee |

`hr_documents`, `db.ts:7860-7881`:

```ts
7860	      -- Document vault: bytes as BLOBs in THIS file (contract D4) behind an
7861	      -- HR-gated route with Cache-Control private/no-store. 400k client cap
7862	      -- upstream; scripts/backup-db.sh switched off .dump|gzip in the same
7863	      -- change that shipped this table.
7864	      CREATE TABLE IF NOT EXISTS hr_documents (
7865	        id            TEXT PRIMARY KEY,
7866	        employee_id   TEXT NOT NULL,
7867	        doc_type      TEXT NOT NULL DEFAULT '',    -- aadhaar|pan|address_proof|... (vocab in hr.ts)
7868	        doc_number    TEXT NOT NULL DEFAULT '',    -- masked outside canViewHrDocs
7869	        issue_date    TEXT NOT NULL DEFAULT '',
7870	        expiry_date   TEXT NOT NULL DEFAULT '',    -- expiry alerts key on this
7871	        filename      TEXT NOT NULL DEFAULT '',
7872	        mime          TEXT NOT NULL DEFAULT '',
7873	        size_bytes    INTEGER NOT NULL DEFAULT 0,
7874	        data          BLOB,
7875	        verify_status TEXT NOT NULL DEFAULT 'unverified',
7876	        verified_by   TEXT NOT NULL DEFAULT '',
7877	        uploaded_by   TEXT NOT NULL DEFAULT '',
7878	        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
7879	      );
7880	      CREATE INDEX IF NOT EXISTS idx_hr_docs_emp ON hr_documents(employee_id);
7881	      CREATE INDEX IF NOT EXISTS idx_hr_docs_expiry ON hr_documents(expiry_date);
```

### 6.2 Why BLOBs and not files on disk — already written down

`db.ts:865-872`:

```ts
865	  // WHY A BLOB TABLE AND NOT A FILE ON DISK.
866	  // There is no image host in this system and no asset pipeline. Disk under
867	  // public/ loses the images: NOTHING backs public/ up — deploy/aws/backup-db.sh
868	  // and deploy/configure-backups.sh both snapshot ONLY fnb-controller.db — so a
869	  // box rebuild or a restore-from-backup would bring the menu back with every
870	  // photo permanently gone, and deploy/aws/push.sh runs `rsync -az --delete`
871	  // with no exclusion for public/. A BLOB rides inside every existing backup for
872	  // free, and survives the GCP `sqlite3 .dump` path as an X'..' hex literal.
```

**This settles it for FSSAI photo evidence: BLOBs, not files.** A compliance photo that vanishes on
a box rebuild is worse than no photo — it is evidence that silently stops existing.

### 6.3 Read/write path (copy this shape)

Write — `src/lib/hr-files.ts:45-83`, storeHrDocument(): takes a Buffer, throws over the cap,
computes size_bytes from buffer.length itself, single prepared INSERT.

Read — `src/lib/hr-files.ts:90-108`, readHrDocument(), with the normalisation every BLOB reader in
this app repeats:

```ts
103	  // better-sqlite3 returns BLOBs as Buffer already; normalize just in case.
104	  if (row.data && !Buffer.isBuffer(row.data)) {
105	    row.data = Buffer.from(row.data as unknown as ArrayBuffer);
106	  }
```

Two further rules from the routes:

- **The BLOB never rides the list JSON.** `src/app/api/hr/documents/route.ts:71`: *"Every
  hr_documents column EXCEPT the data BLOB — metadata never bytes."* Bytes come from a separate
  `/[id]/file` route.
- That file route serves with `Cache-Control: private, no-store` (`hr-files.ts:88`).

### 6.4 THE 1 MB CEILING — a live contradiction P1 must not inherit

The repo's checked-in nginx says 25 MB:

```
$ grep -rn "client_max_body_size" deploy/
deploy/nginx.conf:11:    client_max_body_size 25M;
deploy/aws/nginx.conf:19:    client_max_body_size 25M;
```

**The live box is not running that config.** `src/app/crm-calls/database/page.tsx:83-87`, written
after a real probe against production:

```
83	 * And the ceiling is 1 MB, not 25. Probed against production directly: a 900 KB
84	 * body reaches the app (401), 1,100 KB is refused by the proxy (413). The
85	 * repo's deploy/nginx.conf does say client_max_body_size 25M — the live box is
86	 * not running it, which is consistent with those AWS deploy scripts being stale.
87	 * So the app must fit the limit that EXISTS, not the one that is checked in.
```

**And hr-files.ts still believes the checked-in number** (`src/lib/hr-files.ts:10-13`):

```ts
10	// Size gate: Next 16 with a proxy silently truncates request bodies over 10 MB
11	// and nginx allows 25 MB, so neither will save us — WE are the gate. The
12	// 5 MB hard cap below must be enforced client-side, in the route's
13	// Content-Length pre-check, AND here as the last line of defense.
```

=> **HR_DOC_MAX_BYTES = 5_000_000 is not actually reachable in production.** Anything over ~1 MB is
refused by the proxy with a 413 before the route runs. A latent bug in HRMS, mitigated only by
hr_documents having 0 rows (§8.4(5)). **FSSAI must not copy the 5 MB number.**

### 6.5 Concretely, how FSSAI photo upload must work

1. **Compress client-side before upload.** Target **<= 400 KB**, matching the proven-good
   menu_item_images cap — comfortably inside the ~1 MB ceiling with headroom for multipart
   overhead. Phone cameras produce 3-8 MB JPEGs; canvas resize + re-encode is mandatory.
2. **One photo per request.** Never batch. A 3-photo check is three POSTs.
3. **Enforce the cap three times** — client, route Content-Length pre-check, store function (the
   defence-in-depth `hr-files.ts:10-13` prescribes; keep the discipline, fix the number).
4. **Handle 413 explicitly.** `crm-calls/database/page.tsx:98-100` shows the house pattern: halve
   and retry up to MAX_SPLIT_DEPTH. For one photo the analogue is re-compress at lower quality,
   retry once, then tell the user plainly.
5. **Own table, own gate.** `hr-files.ts:3-6`: *"Modelled 1:1 on src/lib/task-files.ts, but writes
   to its OWN table: the task_files read gate is 'any signed-in user', while hr_documents sits
   behind the HR-role + per-employee gate."* FSSAI evidence photos need their own `fssai_photos`
   table so the gate is FSSAI's to set.
6. **Metadata in list responses, bytes from a dedicated route.**
7. **Tell the owner** that raising the live client_max_body_size is a one-line nginx change. Do not
   change it in a build phase — production config, out of scope.

### 6.6 Backups

`scripts/backup-db.sh` was switched from `.dump | gzip` to **VACUUM INTO** because the dump path
hex-doubles BLOBs (`hr-files.ts:6-8`). FSSAI photos ride inside that backup for free. **No FSSAI
change needed** — but nobody may "optimise" the backup script back to `.dump`, and the same
VACUUM INTO is the only safe way to snapshot the live DB (§8.1).

---

## §7. SETTINGS AND KEY_POLICY — HOW A CONFIGURABLE VALUE IS ADDED

### 7.1 The table

`db.ts:207-219` — a two-column KV, inside the **unguarded** founding block:

```ts
207	    CREATE TABLE IF NOT EXISTS settings (
208	      key TEXT PRIMARY KEY,
209	      value TEXT NOT NULL
210	    );
211
212	    -- Insert default settings if not exists
213	    INSERT OR IGNORE INTO settings (key, value) VALUES ('costing_method', 'average');
214	    INSERT OR IGNORE INTO settings (key, value) VALUES ('currency', 'INR');
```

Everything is a **string**; callers parse. 60 rows live.

**There is no updated_at and no updated_by on `settings`.** Who changed a setting, and when, is only
knowable if the writing route logs it — and the generic route does not (§7.3).

### 7.2 KEY_POLICY — the per-key write tiers

`src/app/api/settings/route.ts:13-34`:

```ts
13	/**
14	 * ONE table for every key this generic endpoint treats specially. BOTH halves
15	 * read it — the GET redaction filter and the PUT write gate — so a privileged
16	 * setting can no longer be listed on one side and forgotten on the other. That
17	 * drift is exactly what left po_require_admin_approval UI-restricted with no
18	 * server counterpart for a whole release.
19	 *
20	 *   read:  'admin'  -> non-admins read back null. ...
24	 *   write: 'admin'  -> a manager PUT/POST of this key 403s with `writeError`.
25	 *   owner: '<path>' -> the key belongs to a dedicated route that validates and
26	 *                     masks it; this generic door is shut for EVERYONE, admins
27	 *                     included, so that route stays the single way in.
28	 *   retired: '<why>' -> the behaviour this key switched NO LONGER EXISTS ...
33	 */
34	type KeyPolicy = { read?: 'admin'; write?: 'admin'; writeError?: string; owner?: string; retired?: string };
```

The **floor** for the generic PUT is admin-or-manager (`route.ts:271-273`):

```ts
271	  if (me.role !== 'admin' && me.role !== 'manager') {
272	    return Response.json({ error: 'Manager or admin required to change settings' }, { status: 403 });
273	  }
```

=> **An unregistered key is manager-writable.** The `department_recipe_deduction_v1` comment
(`route.ts:37-47`) records that before its `owner:` entry existed, a manager could zero recipe
deduction for all 29 departments through this endpoint.

Prefix ownership, `route.ts:208-215` — the comment on the `hr_` line is the instruction FSSAI should
follow:

```ts
208	const OWNED_PREFIXES: Array<{ re: RegExp; route: string }> = [
209	  { re: /^wa_/i, route: '/api/whatsapp/config' },
210	  // HRMS keys (hr_day_cutoff, hr_punch_debounce_min, ...) are owned by the HR
211	  // settings route so the manager-writable generic PUT here cannot touch them,
212	  // per docs/HRMS_DECISIONS.md §2.7. Registered BEFORE the first hr_* key
213	  // exists — the gate being decorative-until-registered is the trap.
214	  { re: /^hr_/i, route: '/api/hr/settings' },
215	];
```

**P1 must add `{ re: /^fssai_/i, route: '/api/fssai/settings' }` in the same commit that creates the
first fssai_ key, not later.**

### 7.3 The audit gap in the generic route

PUT /api/settings writes and returns (`route.ts:309-310`):

```ts
309	  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, String(value ?? ''));
310	  return Response.json({ key, value });
```

**No logAuditEvent.** Confirmed by grep: of `api/settings/route.ts`,
`api/settings/hod-only/route.ts` and `api/hr/settings/route.ts`, **only api/hr/settings/route.ts
imports logAuditEvent.** Combined with `settings` having no updated_by/updated_at, a temperature
standard changed through the generic endpoint would leave **no trace of who changed it or when** —
failing the owner's §19 for the very value that decides whether a fridge passes.

### 7.4 The model to copy: /api/hr/settings

Ownership + gates (`src/app/api/hr/settings/route.ts:20-22, 83-86`):

```ts
20	 * OWNERSHIP: the generic /api/settings route registers the `hr_` prefix in
21	 * KEY_POLICY/OWNED_PREFIXES and routes hr_* keys HERE (already wired) — this
22	 * route is the only writer, so the canAdminHr gate below actually holds.
...
83	export async function PUT(request: Request) {
84	  const me = await getCurrentUser();
85	  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
86	  if (!canAdminHr(me)) return Response.json({ error: 'Admin role required' }, { status: 403 });
```

Validate-everything-before-writing-anything (`route.ts:90-91`):

```ts
90	  // Validate EVERYTHING before writing ANYTHING — a half-applied settings PUT
91	  // (cutoff updated, debounce rejected) would silently shift business days.
```

The audited transactional write (`route.ts:124-147`):

```ts
124	    // Before-image reads through the SAME effective getters as GET, so the
125	    // audit trail records the value the engine was actually using (a garbage
126	    // stored value audits as the default it fell back to).
127	    const before = {
128	      hr_day_cutoff: getHrDayCutoff(db),
129	      hr_punch_debounce_min: getHrPunchDebounceMin(db),
130	    };
131
132	    const upsert = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
133	    const write = db.transaction(() => {
134	      if (cutoff !== null) upsert.run('hr_day_cutoff', cutoff);
135	      if (debounce !== null) upsert.run('hr_punch_debounce_min', String(debounce));
...
139	      logAuditEvent(db, {
140	        event_type: 'hr.settings.update',
141	        entity_type: 'hr_settings',
142	        entity_id: 'attendance',
143	        actor_email: me.email,
144	        outlet_id: outletId,
145	        before,
146	        after,
147	      });
```

`route.ts:117`: *"better-sqlite3 is synchronous — resolve every await BEFORE db.transaction."*
getCurrentOutletId() is awaited on line 118, outside the transaction. **An `await` inside a
db.transaction() callback is a bug in this codebase.**

### 7.5 The effective-getter pattern — "never hard-coded" in practice

`src/lib/hr-attendance.ts:206-232`:

```ts
206	/** One settings value or null. Never throws — a settings read must not take
207	 *  the attendance engine down; the defaults below are always safe. */
208	function readSetting(db: Database.Database, key: string): string | null {
209	  try {
210	    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
211	      | { value: string } | undefined;
212	    return row?.value ?? null;
213	  } catch { return null; }
214	}
...
228	/** hr_day_cutoff ('HH:MM'), default '04:00'. Invalid stored values fall back. */
229	export function getHrDayCutoff(db: Database.Database): string {
230	  const v = String(readSetting(db, 'hr_day_cutoff') ?? '').trim();
231	  return cutoffValid(v) ? v : DEFAULT_CUTOFF;
232	}
```

There is **no shared getSetting() helper** — each module writes its own private readSetting (three
exist: `hr-attendance.ts:208`, `smartoffice.ts:64`, `whatsapp.ts:58`), and there are **110** inline
`SELECT value FROM settings WHERE key` call sites across `src/`. FSSAI should add its own
`src/lib/fssai-settings.ts` with typed getters rather than scattering inline reads.

### 7.6 THE RECIPE — adding a configurable FSSAI temperature standard

Seven steps, each mirroring hr_day_cutoff:

1. **Key name:** `fssai_temp_standards` (or `fssai_temp_<equipment_type>`). Value is a JSON string
   (§4.4) — e.g. `{"cold_room":{"min":0,"max":5},"freezer":{"min":-22,"max":-18}}`.
2. **Register the prefix** in OWNED_PREFIXES (`api/settings/route.ts:208`):
   `{ re: /^fssai_/i, route: '/api/fssai/settings' }`. **Before** the first key exists.
3. **Write `src/app/api/fssai/settings/route.ts`** modelled on api/hr/settings/route.ts:
   getCurrentUser() -> 401; an FSSAI admin capability -> 403; validate the whole payload before
   writing anything; db.transaction() around upsert + logAuditEvent
   (event_type: 'fssai.settings.update'); generic 500 bodies, never e.message.
4. **Write typed getters** in `src/lib/fssai-settings.ts` following getHrDayCutoff: never throw,
   always fall back to a documented safe default, validate the stored value.
5. **Every reader goes through the getter.** No inline SELECT in an FSSAI route, and no numeric
   literal for a temperature limit anywhere in the module.
6. **Read the before-image through the same getter** the engine uses
   (`api/hr/settings/route.ts:124-126`).
7. **Who may write:** admin only, per the self-lift reasoning KEY_POLICY applies to
   purchase_backdate_limit_days and closing_variance_bar_* (`route.ts:59-66, 127-151`) — a manager
   who could widen the acceptable fridge range could make a failing fridge pass. Read may stay open
   (managers must know the target), matching those same entries' posture.

**One caution:** SECRET_KEY_RE (`src/lib/secret-keys.ts`) redacts anything that *looks* like a
secret. Avoid FSSAI key names containing `key`, `token`, `secret` or `password` — e.g.
`fssai_temp_key` would be silently admin-only for the wrong reason.

---

## §8. THE LIVE SCHEMA — REAL QUERY, REAL OUTPUT

### 8.1 The snapshot (the only safe way; a plain cp loses the WAL)

```
$ SNAP=<scratchpad>/fssai-recon-snapshot.db
$ sqlite3 "file:/Users/shashankreddy/Desktop/Claude/fnb-controller/fnb-controller.db?mode=ro" \
          "VACUUM INTO '$SNAP'"
SNAPSHOT OK
-rw-r--r--@ 1 shashankreddy  wheel  14696448 Sep 16 19:01 .../fssai-recon-snapshot.db
```

Source was 34,082,816 bytes with a 1,429,672-byte WAL. The snapshot is 14.7 MB because VACUUM INTO
compacts free pages.

**Freshness verified** — WAL content is present, and the live file agrees on the table count:

```
$ sqlite3 "file:$SNAP?mode=ro" "SELECT COUNT(*), MAX(created_at) FROM sessions;"
235|2026-09-15 01:58:14
$ sqlite3 "file:/Users/.../fnb-controller.db?mode=ro" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"
204
```

### 8.2 The count

```
$ sqlite3 "file:$SNAP?mode=ro" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"
204
```

**204 user tables.** The `fssai_` namespace is clean:

```
$ sqlite3 "file:$SNAP?mode=ro" "SELECT type,name FROM sqlite_master WHERE name LIKE '%fssai%';"
(no rows)
$ grep -ril "fssai" /Users/shashankreddy/Desktop/Claude/fnb-fssai/src/
(4 files match only the bill-footer FSSAI licence-number text; no module)
```

### 8.3 Tables whose names suggest FSSAI overlap — WITH ROW COUNTS

Row counts are the point: a table with data is a live feature FSSAI must not disturb; a table with
zero rows is dormant.

```
$ while read t; do n=$(sqlite3 "file:$SNAP?mode=ro" "SELECT COUNT(*) FROM \"$t\";");
    printf "%-40s %s\n" "$t" "$n"; done < <candidates>

audit_events                             241
batch_transactions                        28
butchering_batches                         0
central_cutover_batches                    0
checklist_items                           56
checklist_templates                        5
crm_knowledge                              6
crm_training_responses                     0
crm_training_sessions                      0
daily_checklist_records                    0
error_reports                             35
hr_documents                               0
hr_training_assignments                    0
hr_trainings                               0
hygiene_audits                             0
knowledge_test_results                     0
knowledge_tests                            0
maintenance_logs                          21
maintenance_schedules                     21
party_status_audit                         0
production_batch_departments               0
production_batches                         9
qc_category_checkers                       8
training_sessions                          0
unit_audit_locks                           2
variance_approvals                         0
wastages                                   0
```

### 8.4 What that means — the five findings that matter

**(1) A checklist engine ALREADY EXISTS, and it is the wrong shape for FSSAI.**
`db.ts:5586-5626`:

```ts
5598	      -- 10. checklist_items
5599	      CREATE TABLE IF NOT EXISTS checklist_items (
5600	        id             TEXT PRIMARY KEY,
5601	        template_id    TEXT NOT NULL,
5602	        label          TEXT NOT NULL,
5603	        sort_order     INTEGER NOT NULL DEFAULT 0,
5604	        requires_image INTEGER NOT NULL DEFAULT 0,
5605	        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
5606	      );
```

A question here is a **label and a photo flag — nothing else**. No question type, no numeric bounds,
no unit, no pass/fail condition, no sections. `daily_checklist_records.result` is
`TEXT NOT NULL DEFAULT 'na'`, free-form. It cannot express Numeric, Temperature, Multiple Choice or
Signature, which the FSSAI engine requires.

It is also **live, and belongs to a different feature**: 5 templates, 56 items, all role-based daily
manager checklists —

```
Operations Manager Daily Checklist  (14 items)    Floor Manager Daily Checklist  (12)
HR Manager Daily Checklist          (10)          Store Manager Daily Checklist  (10)
Bar Manager Daily Checklist         (10)
item labels: Restaurant Cleanliness, Washrooms, Dining Area, Kitchen Inspection,
             Store Inspection, Bar Inspection, Fire Safety, Emergency Exit, Music,
             Lighting, AC Temperature, Guest Complaints, ...
```

=> **Do not extend checklist_items with FSSAI's typed-question columns.** That would mix two
features in one table and force a default question type onto 56 rows belonging to someone else's
feature. **This is positive evidence for the settled architecture: separate
fssai_checklist_templates / fssai_checklist_questions tables are correct** — cite this when someone
later asks "why didn't you reuse the checklist engine?"

`daily_checklist_records` has **0 rows** — the existing engine has templates but has never been
filled in. FSSAI is not competing with a working habit; it is filling a vacuum.

**(2) hygiene_audits exists and is EMPTY (0 rows).** `db.ts:5655-5670` — area, item, date, result,
image_url, corrective_action, created_task_id, score, auditor. Conceptually overlaps FSSAI's
Cleaning & Sanitation and Corrective Actions, but it is flat (no template, no typing) and unused.
**Flag to the owner: FSSAI supersedes it.** Do not drop it; decide explicitly whether to leave it
dormant or hide its UI.

**(3) RECEIVING QC IS ALREADY PARTLY BUILT — on goods_receipt_notes.** `db.ts:3109-3117` adds six
boolean QC ticks captured at receive time, labelled *"Phase 1 §4 — receiving QC checklist"*:
qc_quality, qc_temperature, qc_expiry, qc_damage, qc_weight, qc_invoice_match. The GRN header also
carries qc_by; item rows carry quantity_rejected / rejection_reason (`db.ts:3086-3096`).

`qc_category_checkers` (**8 live rows**) routes which department signs off per material category:

```
category_key       category            checker  updated_by
veg                veg                 kitchen  seed:qc_category_seed_v1
vegetables         vegetables          kitchen  seed:qc_category_seed_v1
englishvegetables  english-vegetables  kitchen  seed:qc_category_seed_v1
nonveg             non-veg             kitchen  seed:qc_category_seed_v1
meat               meat                kitchen  seed:qc_category_seed_v1
dairy              dairy               kitchen  seed:qc_category_seed_v1
frozencheese       frozen-cheese       kitchen  seed:qc_category_seed_v1
fruits             fruits              kitchen  seed:qc_category_seed_v1
```

=> **FSSAI's Receiving QC sub-module must EXTEND this, not replace it.** A second receiving-QC
record would be a duplicate master in all but name. Note the seed-flag convention in updated_by:
`seed:qc_category_seed_v1`.

**(4) Batch / FIFO / expiry infrastructure already exists.** `production_batches` (9 rows) carries
barcode (UNIQUE, PROD######), batch_number, production_date, expiry_date, expiry_time, shelf_life,
storage_location, quantity_produced, quantity_consumed, status
(active | consumed | expired | disposed). `batch_transactions` has 28 rows. And `raw_materials`
**already has storage_location and shelf_life_days** (§8.5).

=> FSSAI's FIFO/FEFO sub-module reads these. It must not create a parallel batch or expiry master.

**(5) HRMS IS DEPLOYED BUT EMPTY — load-bearing for FSSAI.**

```
$ sqlite3 "file:$SNAP?mode=ro" "SELECT COUNT(*) FROM hr_employees;"
0
$ sqlite3 "file:$SNAP?mode=ro" "SELECT name, role, is_active FROM users;"
Admin            admin    1        Ganesh            manager  1
Latesh           manager  1        Nihal             admin    1
Shashank Reddy   admin    1        BTL Test Staff    staff    1
ZZ Test Store    admin    1        ZZ Kitchen Staff  staff    1
ZZ R71 Judge     admin    1
```

hr_employees = 0; hr_documents = 0; hr_trainings = 0. **The real staff roster today is `users`
(9 rows, several test accounts).**

=> An FSSAI Personal Hygiene sub-module keyed on hr_employees.id would, on the live database right
now, have **nobody to check**. P4 must resolve this explicitly — either key on `users`, or key on
hr_employees and surface an empty state that tells the owner HRMS needs populating first. Silently
rendering an empty list would look like a bug and would produce an inspection record proving
nothing.

### 8.5 The masters FSSAI must READ (HARD RULE 2) — exact live column names

Verbatim from PRAGMA table_info, so no phase has to guess.

**raw_materials — 952 rows** *(note storage_location, shelf_life_days, is_active)*
```
id, name, category, unit, current_stock, reorder_level, costing_method, average_price,
created_at, updated_at, sku, primary_vendor, purchase_unit, recipe_unit, conversion_factor,
yield_percent, last_purchase_price, last_purchase_date, is_auto_discovered, discovered_source,
pack_size, super_category, brand, tax_percent, cess_percent, standard_purchase_rate,
closing_cadence, is_recipe_item, is_direct_sell, is_semifinished, case_size,
storage_location, shelf_life_days, is_active, priority
```
WARNING: `last_purchase_price` is stored in **mixed bases** — value only via
`src/lib/closing-valuation.ts`. Do not read it directly.

**vendors — 59 rows**
```
id, name, contact_person, phone, email, gstin, address, payment_terms, lead_time_days,
is_active, notes, created_at, updated_at
```
No FSSAI licence-number column exists. If Vendor Compliance needs one, it is a **Pattern B ALTER on
vendors** (§2.2) — not a new vendor table.

**departments — 29 rows** *(production mapping — READ ONLY, HARD RULE 3)*
```
id, name, code, description, head_chef_user_id, is_active, created_at, updated_at,
submission_windows, submission_grace_minutes, material_categories, parent_id, head_user_id,
area, recipe_deduction_enabled
```

**users — 9 rows**
```
id, email, password_hash, name, role, is_active, created_at, last_login_at, current_outlet_id,
department_id, is_head_chef, is_store_manager, position, page_access, visible_department_ids,
role_id, preferred_zones, preferred_table_ids, section, can_approve_requisitions, wa_mobile
```

**roles — 9 rows**
```
id, name, base_role, page_access, is_head_chef, is_store_manager, is_system, is_active,
sort_order, description, created_at, updated_at, can_request_discount, max_discount_pct,
can_approve_requisitions
```

**hr_employees — 0 rows** (see §8.4(5))
```
id, employee_code, full_name, photo, dob, gender, phone10, alt_phone10, email, current_address,
permanent_address, emergency_name, emergency_relation, emergency_phone10, department_id,
sub_department_id, designation_id, grade, reporting_manager_id, employment_type,
employee_category, cost_centre, work_location, home_outlet_id, joining_date, probation_months,
confirmation_date, notice_period_days, status, exit_date, user_id, notes, created_by,
created_at, updated_at
```

**store_locations — 1 row**
```
id, name, code, description, is_active, requires_authorization, created_at, floor_label
```

**goods_receipt_notes** — QC columns already present: qc_quality, qc_temperature, qc_expiry,
qc_damage, qc_weight, qc_invoice_match, qc_by, plus
edited_at/edited_by/edit_count/voided_at/voided_by/void_reason and status (accepts 'void').

---

## §9. THE CONTRACT — WHAT P1 MUST DO, IN ONE PLACE

1. Append the FSSAI block **after `db.ts:8189`, before the `}` on 8190**, with a banner comment in
   the Task-module form (`db.ts:5459-5464`).
2. **`FSSAI_TABLE_DDL: string[]`, executed per statement with the table name in the catch** — not
   one giant statement block. §3.2 measures what the giant form costs.
3. **Add a shape guard over `fssai_`** using pragma_table_xinfo + temp.zz_ (§3.4), reimplemented in
   this branch. Do not import lq_ code.
4. **Indexes in their own try**, separate from the tables.
5. **Add a boot assertion** counting the expected fssai_ tables, shouting if any are missing.
6. TEXT PRIMARY KEY + generateId(). `created_at TEXT NOT NULL DEFAULT (datetime('now'))`. `date TEXT`
   for the business date. `is_active INTEGER DEFAULT 1`. `<thing>_json TEXT`. `created_by TEXT`
   holding an **email**.
7. **No foreign keys to masters** — plain TEXT + index + a `--` comment naming the target
   (task_*/hr_* house style, `db.ts:7579`).
8. **Every seed one-shot behind a `fssai_<thing>_seed_v1` settings flag**, flag written inside the
   same transaction. `npm run check:boot` must stay green.
9. **Corrective actions follow hr_attendance_corrections** (`db.ts:7670-7686`), including the
   partial `UNIQUE ... WHERE status='pending'`.
10. **VOID, never DELETE**: status='void' + voided_at + voided_by + void_reason
    (`db.ts:3144-3146`).
11. **logAuditEvent on every FSSAI write**, `event_type: 'fssai.<entity>.<verb>'`.
12. **Photos as BLOBs in an own fssai_photos table, <= 400 KB, one per request** (§6.5). Never the
    5 MB HRMS number.
13. **Register `{ re: /^fssai_/i, route: '/api/fssai/settings' }` in OWNED_PREFIXES** in the same
    commit as the first fssai_ key, and write the admin-only, validated, audited settings route
    modelled on /api/hr/settings (§7.6).
14. **Extend, never duplicate:** Receiving QC -> goods_receipt_notes + qc_category_checkers;
    FIFO/expiry -> production_batches + raw_materials.shelf_life_days / .storage_location;
    vendor compliance -> ALTER vendors.
15. **No `await` inside a db.transaction() callback** — better-sqlite3 is synchronous
    (`api/hr/settings/route.ts:117`).

---

## §10. OPEN QUESTIONS FOR THE OWNER (do not decide these in a build phase)

1. **outlet_id on FSSAI tables?** The Task module and checklist engine have none; stock tables do.
   One outlet exists today. Cheap now, expensive to retrofit onto historical evidence.
2. **Personal Hygiene keys on hr_employees (0 rows) or users (9 rows)?** §8.4(5).
3. **hygiene_audits (0 rows) — leave dormant, or hide its UI once FSSAI ships?**
4. **May an FSSAI write succeed if its audit row fails?** logAuditEvent never throws by design.
5. **Raise the live nginx client_max_body_size above 1 MB for evidence photos?** Production config;
   owner's call.
6. **Backdating:** may a check be recorded for an earlier date than it was entered (i.e. does FSSAI
   need recorded_at alongside date)? §4.3.

---

## §11. WHAT I COULD NOT DETERMINE

- **Whether the AWS/Lightsail production box logs to the systemd journal at all.** The systemd unit
  in `deploy/` is the GCP path; memory and `crm-calls/database/page.tsx:85-86` both record that the
  AWS deploy scripts are stale. So "a swallowed migration error is visible via journalctl" is
  **verified for GCP testing and unverified for AWS production** — which is exactly why §9(5)'s boot
  assertion should also write something readable from inside the app.
- **The live client_max_body_size value itself.** 1 MB is inferred from a documented probe
  (900 KB -> app, 1,100 KB -> 413), not from reading the live box's nginx config. I did not connect
  to production.
- **Whether the existing checklist engine has any live UI** — I mapped its schema and data but did
  not audit its pages/routes. That belongs to the navigation/UI recon lane.
- **The full text of `docs/HRMS_DECISIONS.md` §2.7 / D4.** I cite the contract as quoted inside
  db.ts and the HR routes; the 30 KB decisions document itself was not read in full and is the
  precedent for an FSSAI_DECISIONS.md.
