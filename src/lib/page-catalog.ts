/**
 * Catalog of access-controlled pages, grouped by section.
 *
 * Single source of truth for:
 *   - Sidebar (filters nav links based on user's page_access)
 *   - Settings → Page Access (the matrix UI uses this list)
 *   - Proxy (route-level access enforcement)
 *
 * Backward compat:
 *   A user with `page_access = null` (no map set) sees EVERYTHING. This keeps
 *   existing users unaffected on rollout. Admin then opts each user into
 *   restricted access by checking specific pages.
 *
 * To add a page: append it to its section (or create a new section).
 */

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

export interface PageSection {
  /** Section heading */
  label: string;
  /** Pages inside this section. Children must be a non-empty list */
  pages: PageEntry[];
}

export const PAGE_CATALOG: PageSection[] = [
  {
    label: 'Core',
    pages: [
      { path: '/',                    label: 'Dashboard' },
    ],
  },
  {
    label: 'Dine-In',
    pages: [
      { path: '/dine-in/floor',       label: 'Order Floor' },
      { path: '/cashier',             label: 'Cashier' },
      // Idle Tables — open orders nobody closed, split into the empty ones a
      // timer may close and the ones with items that only a person may.
      // mgmtOnly because it lists what EVERY open table is worth across the
      // outlet and its buttons settle or write off a bill; that is management
      // work, not a floor surface like Order Floor or Tables. As with every
      // flag here this is not the security boundary — /api/dine-in/stale-tables
      // refuses a non-management caller with its own 403, and settle/void keep
      // their own gates on top.
      { path: '/dine-in/stale-tables', label: 'Idle Tables', mgmtOnly: true },
      { path: '/dine-in/requests',    label: 'Customer Orders & Requests' },
      { path: '/dine-in/discount-approvals', label: 'Discount Approvals' },
      { path: '/dine-in/kitchen',     label: 'Kitchen Display' },
      { path: '/dine-in/kitchen/scan-out', label: 'Kitchen Scan-Out' },
      { path: '/dine-in/offline-print', label: 'KOT & Bill Printers' },
      { path: '/dine-in/tables',      label: 'Tables' },
      { path: '/dine-in/reservations', label: 'Reservations' },
      { path: '/dine-in/party-menus', label: 'Party Menu' },
      { path: '/customers',           label: 'Customers' },
      { path: '/dine-in/order',       label: 'Order Terminal' },
      { path: '/captain',             label: 'Captain (Tablet POS)' },
      { path: '/print/agent',         label: 'Print Agent (Counter)' },
      { path: '/menu-items',          label: 'Menu Items' },
      { path: '/recipes',             label: 'Recipes' },
      { path: '/direct-items',        label: 'Direct Items' },
      { path: '/sales',               label: 'Sales Upload' },
      { path: '/dine-in/reconciliation', label: 'Reconciliation' },
    ],
  },
  {
    label: 'Parties',
    pages: [
      { path: '/party-events',        label: 'Party Events' },
      { path: '/party-requisitions',  label: 'Party Requisitions' },
      { path: '/party-approvals',     label: 'Party Approvals' },
      { path: '/food-consumption',    label: 'Food Consumption' },
      { path: '/party-pnl',           label: 'Party Liquor Consumption' },
      { path: '/parties',             label: 'Party P&L (admin)' },
    ],
  },
  {
    label: 'Requisitions',
    pages: [
      { path: '/requisitions',        label: 'Internal Requisitions' },
    ],
  },
  {
    label: 'Purchasing',
    pages: [
      { path: '/purchases',           label: 'Purchases' },
      { path: '/purchase-orders',     label: 'Purchase Orders' },
      { path: '/grn',                 label: 'Goods Receipt (GRN)' },
      // Pending Quality Checks — the queue a kitchen/bar staffer clears at the
      // delivery bay. A GRN whose lines include a QC-required category is
      // recorded with status 'awaiting_qc' and NO STOCK MOVEMENT; signing it
      // off here is what inwards it, while the vendor is still at the bay and
      // refusing a crate is real leverage.
      //
      // DELIBERATELY NO TIER FLAG, and it must stay that way. The owner's
      // decision 6 is verbatim: "any user with access to the checking
      // department, name and time stamped. NOT HOD-only — at 6am with a truck
      // waiting that guarantees workarounds." hodOnly/mgmtOnly here would put
      // the one screen this feature exists for out of reach of the people who
      // actually look at the goods, and they run BEFORE the null-map grant, so
      // they are a real lock, not a hint.
      //
      // Seeing the queue is not permission to move stock: POST /api/grn/[id]/qc
      // re-derives who may sign from the session (canSignQcFor, department or
      // section membership) and answers 403 with a sentence for everybody else.
      // Reading it is the same bar GET /api/grn already sets for the same
      // documents. It also inherits a /grn grant by prefix, which is correct —
      // whoever can see the receipts should see which of them are held.
      { path: '/grn/qc',              label: 'Pending Quality Checks' },
      { path: '/receiving-variance',  label: 'Receiving Variance' },
      // Returns — the return TICKET queue. One workflow, two kinds of return,
      // forked by an immutable `kind` column on the ticket. Two facts a reader
      // needs before they touch this line or the pages behind it:
      //
      //   1. STOCK MOVES ONLY ON STORE ACCEPT. Raising a ticket moves nothing.
      //      HOD approval moves nothing. The one and only stock write happens
      //      inside the store-verify transaction, and a rejected line leaves
      //      stock exactly where it was. So a grant here is not a grant to move
      //      inventory — the accept step is its own server-side gate.
      //   2. THE TWO KINDS PULL CENTRAL STOCK IN OPPOSITE DIRECTIONS. A VENDOR
      //      return sends goods back OUT of the building against a PO/GRN, so
      //      central stock goes DOWN. An INTERNAL department return sends goods
      //      from a kitchen back to the store, so department stock goes DOWN
      //      and central stock goes UP. There is no single "return" direction.
      //      Anyone reasoning about this page as "returns add stock back" will
      //      invent inventory on the vendor half; anyone reasoning about it as
      //      "returns remove stock" will destroy it on the internal half.
      //
      // Deliberately NOT mgmtOnly, for the same reason as the store cash box
      // below: the storekeeper is the person who physically receives the
      // returned goods over the counter, and Accept/Reject-with-a-reason is
      // that physical moment being recorded. Pushing them out sends returns
      // back to a verbal hand-back that nobody books. Access is still opt-in
      // per user/role here, and the accept route re-checks the store-issue role
      // itself (no admin bypass — accepting goods is a physical act), so this
      // entry widens who can SEE the queue, never who can move stock.
      { path: '/returns',             label: 'Returns' },
      { path: '/vendors',             label: 'Vendors' },
      { path: '/vendors/materials',   label: 'Vendor → Items' },
      { path: '/contracts',           label: 'Contracts' },
      // Store cash box — cash in hand + the debit/credit log (owner req 5).
      // Deliberately NOT mgmtOnly, for the same reason as the Department Closing
      // Sheet above: the storekeeper is the person who hands over the cash, and
      // must be able to see the box and record the payment at the moment it
      // happens — pushing them out returns cash purchases to an untracked
      // notebook, which is the failure this page exists to fix. Access is still
      // opt-in per user/role here, the API re-checks that page access on every
      // read, writes are limited to Management + the Store Manager, and the one
      // category that can conjure or vanish cash ('adjustment') is
      // management-only server-side.
      { path: '/petty-cash',          label: 'Petty Cash (store cash box)' },
    ],
  },
  {
    label: 'Inventory',
    pages: [
      { path: '/inventory',           label: 'Raw Materials' },
      { path: '/settings/categories', label: 'Categories' },
      { path: '/inventory/liquor-store', label: 'Liquor Store' },
      { path: '/inventory/stock-overview', label: 'Stock Overview' },
      // Read-only board: counted stock by storage area x department. Counts are
      // still recorded on /closing-stock — this only makes them comparable.
      { path: '/inventory/closing-overview', label: 'Closing Overview', mgmtOnly: true },
      // Entry-AND-reporting sheet spanning every active department (owner req 5).
      // Deliberately NOT mgmtOnly: it is a counting surface, and a department's
      // own staff must be able to record their counts. The API scopes a
      // non-privileged user to their own + granted departments, and blind-count
      // (system stock / variance) stays admin-only server-side.
      { path: '/inventory/closing-sheet', label: 'Department Closing Sheet' },
      { path: '/inventory/transfers', label: 'Store Transfers' },
      { path: '/inventory/department-stock', label: 'Department Stock' },
      { path: '/inventory/reconciliation', label: 'Sales vs Consumption' },
      { path: '/store-dashboard',     label: 'Store Dashboard — Low Stock' },
      { path: '/store-requisitions',  label: 'Store Requisitions (Issue)' },
      { path: '/closing-stock',       label: 'Closing Stock' },
      { path: '/variance-approvals',  label: 'Variance Approvals', adminOnly: true },
      // Sits beside Variance Approvals because it is the same problem one level
      // up: an approval decides whether ONE count corrects stock, a cutover
      // re-bases EVERY counted material at once and cannot be undone. adminOnly
      // for exactly the reason /variance-approvals is — it is a one-way console
      // that overwrites the central stock figure of hundreds of materials in a
      // single transaction. It also displays the central-store cutover date,
      // which a manager has a legitimate reason to know; the manager-facing home
      // for that date is the label on the variance surfaces, not this console.
      // Widening it later is a one-word change (adminOnly → mgmtOnly), but the
      // API behind it must be widened in the same breath or a manager lands on
      // the page's Admins-only panel.
      { path: '/inventory/central-cutover', label: 'Central Store Cutover', adminOnly: true },
      { path: '/daily-rollup',        label: 'Daily Roll-up', adminOnly: true },
      { path: '/wastage',             label: 'Wastage' },
      { path: '/unit-audit',          label: 'Unit Audit' },
      { path: '/units',               label: 'Unit Registry' },
      { path: '/department-materials', label: 'Dept Materials (Party)' },
    ],
  },
  {
    label: 'Production',
    pages: [
      // hodOnly REMOVED from these two on the owner's instruction (2026-08-31).
      // They now follow the normal page_access grant like any other page, which
      // is what /kitchen-production/scan below has always done.
      //
      // WHAT THIS DOES AND DOES NOT CHANGE — read before restoring the flag.
      // hodOnly is one line in canAccessPage: `if (isHodOnlyPath(pathname) &&
      // !user.is_head_chef) return false`. It gated the PAGE only. It never
      // protected the DATA: every /api/kitchen-production/* handler calls
      // getCurrentUser (identity) and none calls requireRole (authority), and
      // proxy.ts step 2c only proves the SESSION IS VALID for state-changing API
      // calls — it does not check page access. So any signed-in user could
      // already create, print, dispose and consume batches by calling those
      // endpoints directly; the flag only stopped them seeing the screen.
      // Removing it therefore opens no new data path — it stops hiding one that
      // was already open. Gating those routes is the real fix and is tracked
      // separately.
      //
      // Note page_access FAILS OPEN: `if (!user.page_access) return true`, and
      // an empty array means "follow role", not "deny all". So every user with
      // no explicit grant now sees these two pages.
      { path: '/kitchen-production',   label: 'Kitchen Production' },
      { path: '/kitchen-production/dashboard', label: 'Kitchen Production — Dashboard' },
      { path: '/kitchen-production/scan', label: 'Kitchen Production — Scan' },
      { path: '/butchering',          label: 'Butchering' },
    ],
  },
  {
    label: 'Reports',
    pages: [
      { path: '/sales-dashboard',     label: 'Sales Dashboard' },
      { path: '/reports',             label: 'Reports' },
      { path: '/reports/sales',       label: 'Sales Reports', mgmtOnly: true },
      { path: '/reports/purchases',   label: 'Purchase Report', mgmtOnly: true },
      { path: '/reports/purchase-bill-summary', label: 'Purchase Bill Summary', mgmtOnly: true }, // mgmtOnly for the SAME reason as Purchase Report directly above: vendor-level spend, GST and cess, one row per vendor bill. Two traps a future reader will hit: (1) a "bill" here is DERIVED, not stored — purchases holds one row per ITEM, so the report groups on invoice_id > grn_id > vendor|bill_no|date|outlet > vendor|date|outlet, and since ~2,151 of 2,165 rows carry no vendor bill number most rows are a vendor-day consolidation flagged DAY_RUN, not a paper bill. (2) it reads the purchases table ALONE — goods_receipt_note_items / po_vendor_bills restate the SAME money (see the header of src/lib/purchase-log.ts), so joining them back in to "enrich" a PO-receive bill with its GRN tax would double-count; PO-receive purchases rows are deliberately tax-free cost mirrors and are labelled as booked cost, not bill face value. This line is NOT the security boundary: /api/reports/purchase-bill-summary refuses non-management with its own 403.
      { path: '/reports/returns',     label: 'Return Report', mgmtOnly: true },           // mgmtOnly for the SAME vendor-spend reason recorded on the Purchase Report line above: a vendor-return row carries the GRN line's unit price and the credit note the vendor owes us, so this is vendor money, not a counting aid. Two things not to "simplify": (1) it reports BOTH kinds of return in one list and deliberately has NO grand-total field — a vendor return takes stock OUT of the building (central DOWN) while an internal department return puts it back (central UP), and the two are even measured in different unit bases (purchase vs recipe), so a combined figure would be arithmetically meaningless; totals are per source, each printing its basis. (2) PO No. / GRN No. print BLANK on internal rows rather than a nearest match — the department ledger carries no purchase link, so any value there would be fabricated. As with every report line here, this flag is NOT the security boundary: the route behind it refuses non-management with its own 403.
      { path: '/reports/issue-log',   label: 'Purchase to Issue Log', mgmtOnly: true },   // mgmtOnly for the SAME reason as Purchase Report directly above: it joins vendor spend and purchase rates onto material rows. Do NOT "simplify" this to an open page — the store's own issue view (/store-requisitions, /api/store-issued-log) is untouched and still carries no money.
      { path: '/reports/menu-recipe-gap', label: 'Menu Items Without Recipe', mgmtOnly: true }, // mgmtOnly: ranks the un-costed menu by actual SALES VALUE (revenue on the page), and its review-gated bulk attach rewrites the food cost of every FUTURE sale of a dish. Not a staff surface.
      { path: '/menu-engineering',    label: 'Menu Engineering', hodOnly: true },
      { path: '/variance-report',     label: 'Variance Report' },
      // Department variance — issued-to-a-department vs what recipe consumption
      // says that department used, measured against its physical count. Sits
      // beside the central variance surface above because it answers the other
      // half of the same question: the central report stops at the store door,
      // this one starts there.
      //
      // mgmtOnly, NOT open: /api/department-variance answers 403 'Management
      // only' to anyone outside isManagement() (admin | manager | HOD), so a
      // staff-tier grant here would hand someone a page that loads and then
      // fails — mgmtOnly is what makes the catalog agree with the route. Do NOT
      // "simplify" this to match /variance-report directly above (which is
      // open): that report is a store-side counting aid, while this one names a
      // KITCHEN against a difference, and the difference is un-interpretable
      // until recipes are attached (18 of 628 menu items today) and stations are
      // mapped. A number that reads as an accusation belongs in front of the
      // people who know why it is a data gap.
      { path: '/department-variance', label: 'Department Variance', mgmtOnly: true },
      { path: '/department-consumption', label: 'Dept Consumption' },
      { path: '/staff-meals',         label: 'Staff Meals' },
      { path: '/dine-in/kot-analytics', label: 'KOT Data Points' },
      { path: '/dine-in/captain-performance', label: 'Captain Response Times' },
      { path: '/kitchen-production/reports', label: 'Production Reports', hodOnly: true },
      { path: '/audit',               label: 'Audit' },
      { path: '/eod',                 label: 'End-of-Day' },
      { path: '/outlets',             label: 'Outlets' },
    ],
  },
  {
    // Task Management — checklists, maintenance, hygiene, training, approvals,
    // reporting. Additive module. No hodOnly: dept staff need My Tasks etc.;
    // page + API handlers gate management surfaces (canManageTasks) themselves.
    label: 'Task Management',
    pages: [
      { path: '/tasks',                label: 'Dashboard' },
      { path: '/tasks/my',             label: 'My Tasks' },
      { path: '/tasks/checklists',     label: 'Daily Checklists' },
      { path: '/tasks/board',          label: 'Task Board' },
      { path: '/tasks/maintenance',    label: 'Maintenance' },
      { path: '/tasks/hygiene',        label: 'Hygiene Audits' },
      { path: '/tasks/training',       label: 'Training Tasks' },
      { path: '/tasks/knowledge-tests', label: 'Knowledge Tests' },
      { path: '/tasks/approvals',      label: 'Approvals' },
      { path: '/tasks/reports',        label: 'Reports' },
      { path: '/tasks/calendar',       label: 'Calendar' },
      { path: '/tasks/templates',      label: 'Templates' },
      { path: '/tasks/departments',    label: 'Departments' },
      { path: '/tasks/notifications',  label: 'Notifications' },
      { path: '/tasks/settings',       label: 'Settings' },
    ],
  },
  {
    // CRM — Call-to-Table: TeleCMI telephony guest CRM (screen-pop, missed-call
    // recovery queue, guest 360, call log). Grant to GRE/front-office users.
    // Settings is admin-only (server-gated too). See docs/CRM_DECISIONS.md.
    label: 'CRM',
    pages: [
      { path: '/crm-calls',          label: 'CRM Dashboard' },
      { path: '/crm-calls/whats-on', label: "What's On (GRE board)" },
      { path: '/crm-calls/live',     label: 'Live Calls' },
      { path: '/crm-calls/recovery', label: 'Recovery Queue' },
      // Missed-call attribution — the analytics companion to the Recovery
      // Queue: misses grouped by the ring group that rang, plus how many were
      // recovered and how fast. mgmtOnly because it ranks TEAMS on a
      // performance measure; a screen that grades a shift's work belongs to
      // whoever runs the shift, not to the shift. The page states in plain
      // words that telephony data cannot attribute a missed call to an
      // individual GRE — nobody answered it, so the CDR records the ring group
      // and no agent — so do NOT "improve" it into a per-person scoreboard.
      // As with the other report lines in this catalog, the flag is not the
      // security boundary: /api/crm-calls/missed-attribution answers 403
      // 'Management only' to anyone outside isManagement() on its own.
      { path: '/crm-calls/missed-attribution', label: 'Missed-Call Attribution', mgmtOnly: true },
      { path: '/crm-calls/guests',   label: 'Guests (unified 360)' },
      // Reservation Database — the Reservego CSV import and the customer master
      // it builds (ct_guests + ct_bookings, extended in place; no parallel
      // tables). mgmtOnly for the same reason as Win-back below: every row on
      // the Customers tab is one guest's phone, email and LIFETIME SPEND, and
      // the Import tab is the door that rewrites all of it in a single upload
      // of ~106,000 rows. That is an owner surface, not a floor one.
      //
      // As with every line in this catalog the flag is not the security
      // boundary — each /api/crm/reservations/* route authenticates on its own
      // — but it is what stops the proxy waving through a legacy user whose
      // page_access is null (canAccessPage FAILS OPEN for those).
      { path: '/crm-calls/database', label: 'Reservation Database', adminOnly: true },
      // Win-back: lapsed-guest segment → WhatsApp campaign → attribution.
      // mgmtOnly — it exposes per-guest spend and it is the door that sends
      // marketing to guests. See src/lib/ct/winback.ts.
      { path: '/crm-calls/win-back', label: 'Win-back Campaigns', mgmtOnly: true },
      { path: '/crm-calls/log',      label: 'Call Log' },
      { path: '/crm-calls/topics',   label: 'Topic Alerts' },
      { path: '/crm-calls/bookings', label: 'CRM Bookings' },
      { path: '/crm-calls/settings', label: 'CRM Call Settings', mgmtOnly: true },
      // Telephony Console — TeleCMI account balance, agent extensions/passwords
      // and outbound caller-ID. adminOnly (NOT mgmtOnly): every control here
      // spends real money or rewires who can answer the restaurant's phone, and
      // the routes behind it require the app secret. A manager or HOD must not
      // reach it even with an explicit page_access grant.
      { path: '/crm-calls/telephony', label: 'Telephony Console (TeleCMI)', adminOnly: true },
    ],
  },
  {
    // AI Training — AI assistant / analyst / training / quizzes for the Front
    // Office & GRE team (ported from the standalone Flask app; was "AKAN CRM",
    // renamed to avoid a second "CRM" heading). Grant per user/role like any
    // other page. Quiz Links + CRM Settings are HOD/admin surfaces.
    label: 'AI Training',
    pages: [
      { path: '/crm/assistant',  label: 'AI Assistant' },
      { path: '/crm/analyst',    label: 'AI Analyst — Data', hodOnly: true },
      { path: '/crm/digest',     label: 'Daily Digest',      hodOnly: true },
      // NOT hodOnly: store managers raise POs too — the page + API gate on
      // admin/HOD/store-manager themselves.
      { path: '/crm/reorder',    label: 'Smart Reorder' },
      // Legacy loyalty desk — folded into the unified CRM › Guests 360 (loyalty
      // is surfaced there by phone). Kept accessible (deep links / points admin)
      // but off the sidebar; the page + API gate on admin/manager-tier/HOD.
      { path: '/crm/guests',     label: 'Guests & Loyalty (legacy → CRM › Guests)' },
      { path: '/crm/training',   label: 'Training' },
      { path: '/crm/quiz',       label: 'Quiz' },
      { path: '/crm/quiz-links', label: 'Staff Quiz Links', hodOnly: true },
      { path: '/crm/settings',   label: 'CRM Settings',     hodOnly: true },
    ],
  },
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
    // Employee records are PII (phone, address, DOB) — mgmtOnly per
    // docs/HRMS_DECISIONS.md §2.2. Settings is adminOnly. Future salary/payroll/bank/
    // disciplinary pages MUST be adminOnly (tier flags run BEFORE grants, so
    // the documented '/hr' prefix-grant leak cannot open them).
    //
    // Owner ruling 2026-08-16 (§8.3): staff self-service is DEFERRED and will
    // live under the RESERVED root /my-hr — never register other features there.
    label: 'HR',
    pages: [
      { path: '/hr',           label: 'HR Dashboard', mgmtOnly: true },
      { path: '/hr/employees', label: 'Employees',    mgmtOnly: true },
      // Phase 2 — attendance engine. Register + timeline + corrections queue
      // live on one page; geofences and the biometric mapping/import are the
      // config surfaces behind attendance and stay adminOnly like /hr/settings.
      { path: '/hr/attendance', label: 'Attendance',           mgmtOnly: true },
      { path: '/hr/geofences',  label: 'Geofences',            adminOnly: true },
      { path: '/hr/biometric',  label: 'Biometric & Import',   adminOnly: true },
      // Phases 3-7 (owner ordered all phases 2026-08-16). Money, identity and
      // disciplinary surfaces are adminOnly — the only flag that holds against
      // the NULL-page_access fail-open; team-facing operations are mgmtOnly.
      { path: '/hr/shifts',      label: 'Shifts',               mgmtOnly: true },
      { path: '/hr/roster',      label: 'Roster',               mgmtOnly: true },
      { path: '/hr/leave',       label: 'Leave',                mgmtOnly: true },
      { path: '/hr/payroll',     label: 'Payroll & Advances',   adminOnly: true },
      { path: '/hr/documents',   label: 'Employee Documents',   adminOnly: true },
      { path: '/hr/sops',        label: 'SOP Library',          mgmtOnly: true },
      { path: '/hr/training',    label: 'Training',             mgmtOnly: true },
      { path: '/hr/tests',       label: 'Knowledge Tests',      mgmtOnly: true },
      { path: '/hr/performance', label: 'Performance',          mgmtOnly: true },
      { path: '/hr/assets',      label: 'Employee Assets',      mgmtOnly: true },
      { path: '/hr/recruitment', label: 'Recruitment',          mgmtOnly: true },
      { path: '/hr/exits',       label: 'Disciplinary & Exits', adminOnly: true },
      { path: '/hr/reports',     label: 'HR Reports',           mgmtOnly: true },
      { path: '/hr/settings',  label: 'HR Settings',  adminOnly: true },
    ],
  },
  {
    label: 'Admin',
    pages: [
      { path: '/departments',         label: 'Departments' },
      { path: '/users',               label: 'Users' },
      { path: '/settings/dashboard',  label: 'Settings — Dashboard' },
      { path: '/settings/purchasing', label: 'Settings — Purchasing' },
      // Settings — Returns. A separate page rather than a new section on
      // Settings — Purchasing directly above, because that page is committed
      // code and already carries its own warning against re-adding a control
      // for a retired key; this module is additive and does not edit it.
      //
      // It holds ONE control: how many days a PO stays open for VENDOR returns
      // (owner req 75). Read at ticket-CREATION time as a refusal, measured
      // from the GRN date. Default is 0 = NO LIMIT, which is exactly today's
      // behaviour — nothing anywhere closes a PO on its own. There is no
      // "closed" PO status, no cron and no boot migration, so a deploy can
      // never retroactively shut a real approved PO.
      //
      // adminOnly, and it must stay that way: lowering this number silently
      // makes older POs un-returnable for everybody, and the refusal surfaces
      // at the store counter with the goods already in hand, not here. Same
      // reasoning that keeps the Station → Department map admin-write below.
      // Note this catalog entry is the page-level lock only — a KEY_POLICY
      // entry is what would make the SETTING WRITE admin-only server-side, and
      // that lives in the committed settings route (see handoff).
      { path: '/settings/returns',    label: 'Settings — Returns', adminOnly: true },
      { path: '/settings/roles',      label: 'Settings — Roles' },
      { path: '/settings/print-design', label: 'Settings — Print Design' },
      { path: '/settings/stores',     label: 'Settings — Store Locations' },
      // Direct-issue routing: which categories/materials bypass central stock at
      // receipt and land straight on a department's ledger (Kitchen / Bar).
      // adminOnly matches the API — /api/settings/direct-issue writes are
      // requireRole('admin'), so a lower tier seeing the page would only meet
      // 403s. Remember the drift trap: this row's twin lives in Sidebar.tsx.
      { path: '/settings/direct-issue', label: 'Settings — Direct Issue Routing', adminOnly: true },
      // Station → Department map. Recipe consumption leaves the DEPARTMENT, not
      // central, so every sold line has to answer "which kitchen cooked this?"
      // from order_items.station — free text, and the department names do not
      // string-match it ('Akan  Indian' has TWO spaces, station 'tandoor' vs
      // 'Akan Tandoori', 'Akan - Bakery' is hyphenated). This page is where that
      // map is owner-edited.
      //
      // adminOnly, and it must stay that way: a wrong row here silently debits
      // the WRONG kitchen's books, and it does not announce itself — it surfaces
      // weeks later as an unexplained difference against a chef. Same reasoning
      // that kept the old requisition_deduct_at_issue flip admin-write.
      //
      // This entry is the ONLY page-level lock on the surface: GET
      // /api/settings/station-departments is deliberately un-tiered (it answers
      // can_edit so managers could read the map), and only PUT re-checks
      // role === 'admin'. So do NOT downgrade this to mgmtOnly on the grounds
      // that "the API allows managers" — the API allows managers to LOOK, not to
      // change, and there is no read-only rendering of this page. Losing the
      // adminOnly here would put a live dropdown in front of a manager whose
      // every save 403s. If manager read is ever wanted, build the read-only
      // view first, then loosen this.
      { path: '/settings/station-departments', label: 'Settings — Station → Department Map', adminOnly: true },
      // Quality Check Categories — which categories hold a delivery at the bay
      // until kitchen or bar signs. A veg/dairy/meat category set here means the
      // goods do NOT enter stock on receipt; "No check" means they inward
      // exactly as they always did.
      //
      // adminOnly, and it must stay that way, for the same reason the Station →
      // Department map above is: a wrong row does not announce itself. Turn a
      // perishable category off and deliveries silently stop being checked —
      // which is the failure this whole feature exists to end — and turn a
      // grocery category on and a storekeeper is stuck at 6am with a truck and
      // nobody in the building who can sign. Both surface days later, far from
      // this screen.
      //
      // The catalog flag is the page-level lock only. GET and PUT
      // /api/grn/qc/categories are BOTH requireRole('admin') server-side, which
      // is the real gate; this entry is what stops the proxy waving through a
      // legacy user whose page_access is null (canAccessPage fails open four
      // ways — only the tier flags run before those grants).
      { path: '/settings/qc-categories', label: 'Settings — Quality Check Categories', adminOnly: true },
      { path: '/settings/page-access', label: 'Settings — Page Access' },
      // Impact Preview — read-only report that answers "if we stop letting a
      // parent page carry its siblings, who loses which pages?". Simulation
      // only: it compares canAccessPage() against canAccessPageStrict() (see the
      // block comment further down this file) and enforces NOTHING.
      //
      // adminOnly, and it must stay that way: it prints every role's and every
      // user's page map side by side — a complete map of who can reach what,
      // which is exactly the reconnaissance a restricted user should not have.
      // The route behind it (requireRole('admin')) is the real lock; this entry
      // is what stops the proxy waving through a legacy null-map user.
      { path: '/admin/page-access-impact', label: 'Page Access - Impact Preview', adminOnly: true },
      { path: '/settings/integrations', label: 'Settings — Integrations' },
      { path: '/settings/integrations/whatsapp', label: 'Settings — WhatsApp' },
      { path: '/settings/qr-standees', label: 'Settings — QR Standees' },
      { path: '/settings/customer-menu', label: 'Settings — Menu Design' },
      { path: '/settings/errors', label: 'Settings — App Errors', adminOnly: true },
      { path: '/admin/data-hygiene',  label: 'Admin — Data Hygiene' },
      { path: '/admin/reset',         label: 'Admin — Reset' },
      // adminOnly is NOT the only gate, and must not be treated as one:
      // canAccessPage() FAILS OPEN for a legacy user whose page_access is null,
      // so this entry is what stops the proxy waving them through — but the
      // route's own requireRole('admin') is the real lock and must stay.
      { path: '/admin/database',      label: 'Admin — Database (read-only)', adminOnly: true },
    ],
  },
];

/** Flat list of all paths (handy for "select all" / proxy matching). */
export const ALL_PAGE_PATHS: string[] = PAGE_CATALOG.flatMap(s => s.pages.map(p => p.path));

/**
 * Is `pathname` under an HOD-only catalog entry? Uses LONGEST-prefix match so a
 * non-restricted child (e.g. /kitchen-production/scan) can sit under a
 * restricted parent (/kitchen-production) without inheriting the lock.
 */
function bestEntry(pathname: string): PageEntry | null {
  let best: PageEntry | null = null;
  for (const section of PAGE_CATALOG) {
    for (const p of section.pages) {
      if (pathname === p.path || pathname.startsWith(p.path + '/')) {
        if (!best || p.path.length > best.path.length) best = p;
      }
    }
  }
  return best;
}
export function isHodOnlyPath(pathname: string): boolean {
  return !!bestEntry(pathname)?.hodOnly;
}
/** Is `pathname` under a management-only catalog entry (admin/manager/HOD)? */
export function isMgmtOnlyPath(pathname: string): boolean {
  return !!bestEntry(pathname)?.mgmtOnly;
}
/** Is `pathname` under an admin-only catalog entry (role === 'admin' only)? */
export function isAdminOnlyPath(pathname: string): boolean {
  return !!bestEntry(pathname)?.adminOnly;
}

/**
 * Pages that EVERY signed-in user can access regardless of their access map.
 *
 * Only /login here. The Dashboard `/` is intentionally NOT included anymore
 * so admins can restrict it per user (e.g. bar staff who shouldn't see
 * cross-restaurant KPIs).
 *
 * To avoid redirect loops when a user can't see `/`, proxy.ts redirects them
 * to the first allowed path from their page_access array (see firstAllowedPath
 * helper below).
 */
export const ALWAYS_ALLOWED: string[] = ['/login', '/launch'];

/**
 * Pick a landing path for a user whose page_access map exists and does NOT
 * include `/`. Returns the first allowed path in their map (in catalog order
 * so the UX is predictable), or '/login' as a final fallback.
 */
/**
 * Role-aware landing for a freshly-opened session. The Captain APK (and any PWA
 * install) opens /launch, and the post-login redirect resolves through here, so
 * ONE app drops each user on their natural home:
 *   management → dashboard, GRE → Recovery Queue, captain → POS, kitchen → KDS…
 * Picks the FIRST preferred candidate the user can actually access, then falls
 * back to firstAllowedPath() so nobody lands on a page that immediately
 * re-blocks them. Purely a routing convenience — every page still enforces its
 * own access; this never grants anything.
 */
export function homePathFor(user: { role?: string; page_access?: string | null; is_head_chef?: boolean } | null): string {
  if (!user) return '/login';
  const isMgmt = user.role === 'admin' || user.role === 'manager' || user.is_head_chef;
  // Legacy full-access (null map) NON-management users: canAccessPage grants
  // them everything via backward-compat, so the pref list below would land them
  // on /captain (the POS) via that backdoor. Send them to the dashboard '/'
  // instead — a genuine captain has an EXPLICIT /captain grant (or captain-tier
  // role) and so has a non-null map, unaffected by this.
  if (!user.page_access && !isMgmt) return '/';
  const prefs: string[] = [];
  // Management wants the whole-outlet dashboard first.
  if (isMgmt) prefs.push('/');

  // ── A CASHIER OUTRANKS A CAPTAIN ─────────────────────────────────────────
  // The owner's rule: "For Cashier Login Home Page Should be Cashier page."
  //
  // The two roles cannot be told apart by TIER — Captain and Cashier are both
  // base_role 'staff' — and the seeded Cashier bundle CONTAINS '/captain'
  // (measured on this database: ["/dine-in/floor","/dine-in/tables",
  // "/dine-in/order","/captain","/dine-in/reservations","/cashier"]), so with
  // '/captain' first in the list below every cashier matched it and landed on
  // the tablet POS instead of the till.
  //
  // What DOES separate them is the '/cashier' grant itself: the Captain bundle
  // is ["/captain"] and holds no cashier page, and '/cashier' is the app's
  // existing definition of a till operator (tillCapable() in
  // src/lib/settle-authority.ts gates settle on exactly this grant). So a
  // cashier is homed at the till and a captain — who has no such grant — is
  // untouched and still lands on /captain.
  //
  // The grant is read STRICTLY: an explicit, parseable, non-empty array that
  // lists the page. canAccessPage() deliberately answers "yes" for a null /
  // empty / garbled map (its documented backward compat), and under that
  // forgiving reading every legacy full-access user would look like a cashier
  // and be pulled off their current home. Path matching mirrors the last line
  // of canAccessPage (exact, or a prefix ending at a '/' boundary) so a map
  // that opens the cashier PAGE is what opens this home, never one without the
  // other. This repeats tillCapable() rather than importing it: that module
  // pulls in db.ts/better-sqlite3, and page-catalog is bundled into client
  // components (Sidebar, /customers, /settings/page-access), so importing it
  // here would drag the database into the browser bundle.
  //
  // Management keeps the dashboard ONLY when they can actually open it. '/' is
  // pushed above for management, but prefs are resolved through canAccessPage,
  // so that entry wins only if '/' is genuinely reachable. An admin always is.
  // A manager or HOD whose EXPLICIT map omits '/' but includes '/cashier' now
  // homes to the till instead — correct for someone whose map says they work a
  // till, but it is a behaviour change, not the no-op the old comment claimed.
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

  // Then role homes, most-specific first. A GRE has CRM but not Captain access
  // (and vice-versa), so each lands correctly; someone with both of THOSE two
  // is POS-primary (a cashier already jumped the queue above).
  prefs.push(
    '/captain',              // captains → tablet POS
    '/crm-calls/recovery',   // GREs → missed-call recovery home base
    '/crm-calls',            // (CRM without recovery grant)
    '/dine-in/kitchen',      // kitchen → KDS
    '/dine-in/floor',        // floor staff → order floor
    // SHADOWED, and kept deliberately. An explicit '/cashier' grant is pushed
    // ahead of '/captain' above, and any map loose enough to reach this entry
    // (null, '[]', garbled) also passes canAccessPage('/captain'), which sits
    // first. So no input reaches it today. It stays as the floor: if the strict
    // grant test above is ever narrowed, a till user still lands somewhere sane
    // rather than on the POS.
    '/cashier',
    '/requisitions',
    '/tasks/my',
    '/',                     // anyone with dashboard access
  );
  for (const p of prefs) if (canAccessPage(p, user)) return p;
  // Fallback: first catalog page (display order) the user can ACTUALLY open,
  // decided by canAccessPage — the SAME authority the proxy enforces, so
  // homePathFor can never return a page the proxy then bounces (no loop). A
  // user with no openable page → '/login' (LaunchPage shows a friendly notice).
  for (const section of PAGE_CATALOG) {
    for (const pg of section.pages) if (canAccessPage(pg.path, user)) return pg.path;
  }
  return '/login';
}

export function firstAllowedPath(user: { role?: string; page_access?: string | null; is_head_chef?: boolean } | null): string {
  if (!user) return '/login';
  if (user.role === 'admin') return '/';
  if (!user.page_access) return '/';                     // null map = full access → /
  let allowed: string[] = [];
  try { allowed = JSON.parse(user.page_access); }
  catch { return '/'; }
  if (!Array.isArray(allowed) || allowed.length === 0) return '/';
  // Iterate the catalog in display order so the redirect lands somewhere the
  // user "naturally" starts (Dashboard if allowed, else first dine-in/parties
  // page they have, etc.). Skip HOD-only pages the user can't actually open, so
  // a non-HOD isn't redirected to a page that immediately re-blocks them.
  for (const section of PAGE_CATALOG) {
    for (const p of section.pages) {
      if (allowed.includes(p.path)
        && !(p.hodOnly && !user.is_head_chef)
        && !(p.mgmtOnly && !(user.role === 'manager' || user.is_head_chef))
        && !(p.adminOnly && user.role !== 'admin')) return p.path;
    }
  }
  return '/login';
}

/**
 * Returns true if the given user can access the given path.
 *   - admin → always true
 *   - page_access null/empty → always true (backward compat)
 *   - otherwise → must be in the user's allowed set OR in ALWAYS_ALLOWED
 *
 * Path matching is prefix-based for nested routes (e.g. /requisitions/123
 * matches /requisitions). API paths under /api/* are NOT page-level
 * controlled — those have their own auth checks.
 */
export function canAccessPage(
  pathname: string,
  user: { role?: string; page_access?: string | null; is_head_chef?: boolean } | null,
): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (ALWAYS_ALLOWED.some(p => pathname === p)) return true;

  // HOD-only pages: a non-admin must be an HOD (is_head_chef), whatever their
  // page_access map says. MUST run before the null-map backward-compat grant
  // below, so legacy full-access staff are still locked out of these pages.
  if (isHodOnlyPath(pathname) && !user.is_head_chef) return false;

  // Management-only pages (customer PII): a non-admin must be a Manager or an
  // HOD. Also runs before the null-map grant so legacy full-access staff can't
  // reach the Customers page.
  if (isMgmtOnlyPath(pathname) && !(user.role === 'manager' || user.is_head_chef)) return false;

  // Admin-only pages (App Errors console): a non-admin is blocked outright,
  // whatever their page_access map says — runs before the null-map grant so
  // legacy full-access staff can't reach it either. (Admins already returned
  // true above, so this only ever affects non-admins.)
  if (isAdminOnlyPath(pathname)) return false;

  // No explicit map → grant everything (backward compat)
  if (!user.page_access) return true;

  let allowed: string[];
  try { allowed = JSON.parse(user.page_access); }
  catch { return true; }   // garbled value → don't lock out
  if (!Array.isArray(allowed) || allowed.length === 0) return true;

  // Exact match OR prefix match on a controlled page (so /vendors/123 works
  // when /vendors is allowed). To avoid /audit allowing /audit-log we require
  // the next char to be '/' or end-of-string.
  return allowed.some(p => pathname === p || pathname.startsWith(p + '/'));
}

/* ───────────────────────────────────────────────────────────────────────────
 * STRICT PATH MATCHING — MEASURED, **NOT YET ENFORCED**. DO NOT WIRE UP.
 *
 * WHY IT EXISTS
 * The last line of canAccessPage() above matches a grant by PREFIX. That half
 * of the rule is load-bearing: it is what lets a DETAIL route inherit its list
 * page, so /vendors/123 opens for someone granted /vendors. Nothing in the
 * catalog describes detail routes, so without it every record page in the app
 * would 403.
 *
 * The problem is that many catalog parents are ALSO the URL prefix of their
 * SIBLING catalog pages. /tasks is the Task Dashboard *and* the prefix of the
 * 14 other Task Management pages, so ticking the dashboard silently hands over
 * the whole module. Across the catalog 8 parents carry 43 such grants:
 *   /tasks +14, /crm-calls +10, /inventory +7, /reports +6,
 *   /kitchen-production +3, /dine-in/kitchen +1, /vendors +1,
 *   /settings/integrations +1
 * proxy.ts imports canAccessPage rather than duplicating it, so this is real
 * server-side reach, not just a sidebar that shows too much.
 *
 * WHY IT IS NOT ENFORCED YET
 * Switching the proxy to this function TIGHTENS access. Any role configured
 * while the leak was live may have been given a parent instead of the pages
 * actually intended, and flipping it would strip those pages from staff
 * mid-service. The owner tops up the missing grants FIRST — informed by
 * GET /api/admin/page-access-impact, which reports the per-user / per-role
 * difference between these two functions — and only then do we switch.
 *
 * So: canAccessPage() above is untouched and remains the single enforcement
 * authority. This function is read by the impact report and by nothing else.
 * If you are here to "finish the fix", the fix is a one-line swap in
 * canAccessPage — but do not make it until the owner says the top-ups are done.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * Every path that is a catalog page in its own right. Built ONCE at module
 * load (not per call) — canAccessPageStrict is called ~130× per user by the
 * impact report and would otherwise rebuild this on every check.
 */
const CATALOG_PATH_SET: ReadonlySet<string> = new Set(ALL_PAGE_PATHS);

/** True when `pathname` is itself an entry in PAGE_CATALOG (exact match). */
export function isCatalogPath(pathname: string): boolean {
  return CATALOG_PATH_SET.has(pathname);
}

/**
 * Nearest PROPER catalog ancestor of `pathname`, walking path segments up.
 *   /vendors/123      → /vendors
 *   /tasks/board/9    → /tasks/board   (nearest wins, NOT /tasks)
 *   /foo/bar          → null           (no catalog page above it)
 *
 * '/' is deliberately never returned. It is the Dashboard page, not a
 * namespace root, and the prefix test in canAccessPage cannot match it either
 * ('/' + '/' = '//', which no real pathname starts with). Treating it as
 * everyone's ancestor would make a Dashboard grant a grant to every
 * un-cataloged route in the app.
 */
function nearestCatalogAncestor(pathname: string): string | null {
  let cut = pathname.lastIndexOf('/');
  while (cut > 0) {
    const parent = pathname.slice(0, cut);
    if (CATALOG_PATH_SET.has(parent)) return parent;
    cut = parent.lastIndexOf('/');
  }
  return null;
}

/**
 * The strict twin of canAccessPage(). **NOT ENFORCED ANYWHERE** — see the block
 * comment above before you change that.
 *
 * Every gate before the path-list match is IDENTICAL to canAccessPage and is
 * duplicated here verbatim rather than refactored out of it: null user → false,
 * admin → true, ALWAYS_ALLOWED → true, hodOnly / mgmtOnly / adminOnly tier
 * gates, null map → true, unparseable map → true, empty array → true. A little
 * duplication is the right trade here — canAccessPage gates the whole app and
 * must not be touched to add a function nothing calls yet.
 *
 * ONLY the final match differs:
 *   1. exact match in the map                        → allowed
 *   2. pathname is ITSELF a catalog page             → DENIED. This is the fix:
 *      a distinct page needs its own grant, so /tasks no longer carries
 *      /tasks/settings.
 *   3. otherwise it is a detail route → find its nearest catalog ancestor and
 *      require THAT to be granted. /vendors/123 still opens for /vendors.
 *   4. no catalog ancestor at all → fall back to the old prefix test, so an
 *      un-cataloged route can never become unreachable by accident.
 *
 * The result is always a SUBSET of canAccessPage: rules 1 and 4 are identical
 * to it, rule 2 only removes, and rule 3's ancestor is itself a prefix. That is
 * what makes "lost = now − strict" in the impact report meaningful.
 */
export function canAccessPageStrict(
  pathname: string,
  user: { role?: string; page_access?: string | null; is_head_chef?: boolean } | null,
): boolean {
  // ── Gates below are copied verbatim from canAccessPage. Keep them in sync.
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (ALWAYS_ALLOWED.some(p => pathname === p)) return true;
  if (isHodOnlyPath(pathname) && !user.is_head_chef) return false;
  if (isMgmtOnlyPath(pathname) && !(user.role === 'manager' || user.is_head_chef)) return false;
  if (isAdminOnlyPath(pathname)) return false;
  if (!user.page_access) return true;

  let allowed: string[];
  try { allowed = JSON.parse(user.page_access); }
  catch { return true; }   // garbled value → don't lock out
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  // ── End of the verbatim section. Only what follows differs.

  // 1. Explicitly granted.
  if (allowed.includes(pathname)) return true;

  // 2. A page that stands on its own in the catalog needs its own grant —
  //    it does NOT inherit from a parent that merely shares its URL prefix.
  if (CATALOG_PATH_SET.has(pathname)) return false;

  // 3. Detail route: inherit from the nearest catalog page above it, and only
  //    that one. /tasks/board/9 asks for /tasks/board, never /tasks.
  const ancestor = nearestCatalogAncestor(pathname);
  if (ancestor) return allowed.includes(ancestor);

  // 4. Nothing in the catalog sits above this path. Behave exactly as today
  //    rather than inventing a denial for a route nobody has classified.
  return allowed.some(p => pathname === p || pathname.startsWith(p + '/'));
}
