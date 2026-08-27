import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, canIssueAsStore } from '@/lib/auth';
import { applyPartyFulfillment } from '@/lib/party-fulfillment';
import { applyIssueDelta } from '@/lib/issue-stock';
import { isDeptReversalBlocked } from '@/lib/dept-ledger';

/**
 * A replayed POST carrying a client_token it already spent collides on
 * requisition_issue_ledger's partial unique index (db.ts:1271). better-sqlite3
 * rolls the WHOLE transaction back, so nothing was applied twice — the honest
 * answer is 200 "you already did this", not a 500.
 *
 * SQLite words the failure with the COLUMNS, not the index name
 * ("UNIQUE constraint failed: requisition_issue_ledger.client_token,
 * requisition_issue_ledger.req_item_id"), so match on that and keep the index
 * name as a fallback. Deliberately narrow: any other constraint failure is a
 * real bug and must keep surfacing as a 500.
 */
function isIssueTokenReplay(e: any): boolean {
  const code = String(e?.code || '');
  const msg = String(e?.message || '');
  if (!code.startsWith('SQLITE_CONSTRAINT')) return false;
  return msg.includes('uq_req_issue_token_item')
    || msg.includes('requisition_issue_ledger.client_token');
}

/**
 * Per-item store issue endpoint — the workhorse of /store-requisitions.
 *
 * Unlike POST /store-process (which is one-shot: issue everything + raise a PO
 * + mark fulfilled), this endpoint lets the store manager act on items
 * INCREMENTALLY: issue what's on hand now, defer what's not, come back later
 * to clear deferred items. Every action is timestamped + actor-stamped + logged
 * to audit_events for an iron-clad chain of custody.
 *
 * Body: {
 *   lines: [
 *     {
 *       id: string,                    // requisition_item id
 *       action: 'issue' | 'defer' | 'undo' | 'reject' | 'unreject',
 *       quantity?: number,             // for 'issue': how much was handed over now
 *       defer_until?: string,          // for 'defer': ISO datetime the store will issue later
 *       reason?: string,               // for 'defer'/'reject': free-text "out of cold storage" / "discontinued"
 *     }
 *   ],
 *   note?: string,                     // optional req-level note (e.g. "Bar pickup at 7pm")
 * }
 *
 * Effects per action:
 *   issue    → quantity_issued += qty (append to issue_history JSON);
 *              issued_at=now, issued_by=me; clears the deferred fields ONLY
 *              when the line is now fully satisfied (see THE DEFER RULE below).
 *              Stock moves only through applyIssueDelta, which now deducts
 *              UNCONDITIONALLY: the old deduct-at-issue setting is gone and no
 *              switch is consulted. Central loses the gram here, the receiving
 *              department gains it, and recipe consumption at KOT-complete
 *              takes it out of the DEPARTMENT — not out of central a second
 *              time.
 *   defer    → deferred_until + defer_reason set. quantity_issued unchanged.
 *   undo     → clears issued/deferred fields. Use to fix mistakes.
 *              (Does NOT clear a store rejection — use 'unreject' for that.)
 *   reject   → store-rejects the OUTSTANDING balance: store_rejected=1,
 *              store_reject_reason=reason, deferred fields cleared. What was
 *              ALREADY issued STAYS issued — quantity_issued, issued_at,
 *              issued_by and issue_history are untouched and NO stock moves in
 *              either direction (delta 0). Use 'undo' to reverse a hand-over;
 *              the two must not overlap. On a line that issued nothing this is
 *              byte-identical to the old behaviour, and so is a reject on a
 *              PARTY requisition (carved out — see the branch). DISTINCT from
 *              the chef's is_rejected — this is the store saying it cannot
 *              fulfil the REST of the line.
 *   unreject → clears store_rejected + store_reject_reason (line becomes issuable again).
 *
 * Parent requisition status auto-advances to 'fulfilled' when every
 * non-rejected item has quantity_issued >= effective_qty (chef_approved_qty
 * if set, else quantity_requested). A line rejected by the chef (is_rejected)
 * OR by the store (store_rejected) counts as "done" and is not required to be
 * issued. Otherwise stays 'mgmt_approved' / 'chef_approved' / 'store_processed'
 * so it remains in the store queue.
 *
 * ── 'fulfilled' IS REVERSIBLE, AND SINCE 2026-08-26 IT IS UN-REJECTABLE TOO.
 *    IT IS STILL NOT ISSUABLE. ────────────────────────────────────────────────
 * The status gate accepts 'fulfilled' for 'undo', 'reject' and 'unreject' only,
 * and only when EVERY line in the batch is one of those three. This is not a
 * loosening for convenience: the auto-advance below fires the instant the last
 * line is satisfied, so the ordinary mistake — the storekeeper issues the final
 * line, the requisition flips to 'fulfilled', he immediately sees the quantity
 * was wrong — had NO in-app correction, while store-requisitions/page.tsx still
 * rendered the Undo button for it. 1,620 of the 1,630 requisitions in this
 * database are 'fulfilled', so without this the spec's partial-reversal
 * requirement is unmet for 99% of them.
 *
 * 'unreject' JOINED THAT LIST ON 2026-08-26 BY EXPLICIT OWNER DECISION, AND
 * THIS PARAGRAPH REPLACES THE ONE THAT RECORDED THE OPPOSITE. The superseded
 * reasoning was: "'issue', 'defer' and 'unreject' stay blocked on 'fulfilled' —
 * all three push a finished requisition FORWARD, and re-opening one by adding
 * to it (rather than by correcting it) is a different decision that nobody has
 * taken." It is kept here verbatim because it was sound at the time and is the
 * thing a future reader will otherwise re-derive. Two things changed under it:
 *   1. The owner has now taken that decision, on the date above, after the dead
 *      end below was demonstrated end-to-end on live data.
 *   2. Since the Option-A reject stopped un-issuing what was physically handed
 *      over, an unreject is no longer purely "forward". A store-rejected line
 *      can now carry REAL issued stock, and refusing the unreject STRANDS it:
 *      the goods sit in the department against a line nobody can correct.
 * An unreject moves NO stock at all (see its branch), so admitting it cannot
 * make the two rails disagree. What it does is put the line back in play — and
 * when its quantity is short of effective, the DEMOTION in the auto-advance
 * below takes the requisition back to 'store_processed', which is precisely the
 * correction being asked for.
 *
 * 'issue' AND 'defer' STAY BLOCKED ON 'fulfilled'. Those two genuinely do add
 * to a finished requisition, and nobody has taken that decision. Mixing either
 * of them with an admitted action in one batch refuses the WHOLE batch: the
 * batch is judged as a whole, deliberately, so a stray 'issue' entry cannot
 * ride in on an unreject's widened window.
 *
 * AND THE UNREJECT MUST HAVE SOMETHING TO UNREJECT (2026-08-27). The window
 * above opened for ONE reason — a store-rejected line stranding real issued
 * stock — so the admission asks for exactly that line and nothing less: a batch
 * whose entry to 'fulfilled' depends on 'unreject' is admitted only when one of
 * the line ids it names IS, right now, store_rejected on THIS requisition (and
 * not chef-rejected, which the loop skips first). Without that clause the verb
 * alone was the whole key, and 'unreject' on a bogus id — or on a line nobody
 * had rejected — cleared the gate, applied nothing, and still ran the
 * auto-advance below: a 'fulfilled' requisition demoted to 'store_processed'
 * with fulfilled_at/fulfilled_by destroyed and store_note overwritten, on
 * `applied: 0`. Measured on a copy of the live db 2026-08-27.
 *
 * THIS CLAUSE CANNOT REGRESS ANYTHING, and that is why it is safe to add here:
 * it narrows the admission the 2026-08-26 decision ADDED, and touches no other.
 * A batch with no 'unreject' in it never evaluates the clause, so 'undo'-only
 * and 'reject'-only on 'fulfilled' answer exactly as they did before either
 * change — the 1,620 fulfilled requisitions are untouched. Formally: the
 * admitted set is now (pre-2026-08-26 set) ⊆ (with-clause set) ⊆ (2026-08-26
 * set), so no request that used to return 200 can return 400.
 *
 * WHAT IT DOES NOT CLOSE, stated plainly so nobody reads more into it. The
 * auto-advance below runs whether or not the loop applied anything, so a batch
 * that matches no line STILL demotes a finished requisition. That is
 * PRE-EXISTING, not a side effect of the widened window: 'undo' and 'reject'
 * with an unknown line id do it too and always did (both measured, same day,
 * same fixture — 200 {applied:0}, fulfilled → store_processed, fulfilled_at
 * cleared, store_note overwritten). Gating the status writes on the batch
 * having applied something would change 'undo'/'reject' behaviour on every one
 * of those 1,620 rows, which is a decision for the owner and not a repair to
 * make by side effect from here. All this clause does is refuse to be the third
 * door. The same is true of the race: if a line is unrejected by someone else
 * between this pre-flight read and the transaction, the batch is admitted and
 * the unreject branch no-ops — landing back on the pre-existing behaviour, no
 * worse than it.
 *
 * TWO SETS, NOT ONE, AND THE SPLIT IS LOAD-BEARING. REVERSAL_ACTIONS is still
 * exactly {undo, reject}, because that is what the word REVERSAL means here —
 * the two gestures that pull goods back — and it now feeds ONE thing: the
 * wording of the PARTY refusal. The finished-window admission reads its own
 * FINISHED_WINDOW_ACTIONS. Folding 'unreject' into REVERSAL_ACTIONS would have
 * re-worded the party refusal ("Cannot reverse a fulfilled party requisition")
 * for a gesture that reverses nothing, and party's window must not move in any
 * direction — see the party paragraph below.
 *
 * ONE CONSEQUENCE OF THE OPTION-A REJECT, KNOWN AND ACCEPTED. It moves no gram
 * wrongly; do not "fix" it by re-zeroing the column, which is the bug this rail
 * was repaired for.
 *   On a line with NOTHING OUTSTANDING (already issued in full) a reject
 *   cancels nothing and keeps everything. It is no longer the full reversal it
 *   used to be in the widened 'fulfilled' window above — 'undo' is.
 *
 * THE DEAD END, NOW CLOSED — recorded because the fix above only makes sense
 * against it. It read: because store_rejected counts as "done" in the
 * auto-advance, rejecting the last open line flips the requisition to
 * 'fulfilled'; 'unreject' was then refused by the status gate, and 'undo' is
 * skipped by the store-rejected guard below and answers
 * {success:true, applied:0} — silently. A line that kept real issued stock had
 * no in-app path back; the GOODS stayed recoverable (the department ledger row
 * stands, so return-stock.ts works) but the LINE could not be corrected.
 * Admitting 'unreject' to the finished window is the fix: unreject, then undo.
 *
 * THE STORE-REJECTED GUARD BELOW IS PER-ENTRY, NOT PER-BATCH, and this
 * paragraph says so because an earlier draft of it claimed the opposite. The
 * guard (`cur.store_rejected && action !== 'unreject'` → skip) reads the line as
 * it stands AT THAT ENTRY, from the re-read a few lines above it. So it stops
 * a bare 'undo' on a rejected line — which is what it is for, and what makes
 * "unreject first, then undo" the shape of the correction — but it does NOT
 * stop the two arriving as `[{unreject},{undo}]` in ONE body: the second entry
 * re-reads a line the first has already cleared and proceeds. Measured
 * 2026-08-27: 200 {applied:2}, store_rejected 1→0 and quantity_issued 200→0 in
 * a single request.
 *
 * That is LEFT AS IT IS, on purpose, and the wording is what changed instead.
 * The data outcome is right — the 'undo' goes through applyIssueDelta with
 * every clamp intact, so no gram is manufactured — and no screen sends such a
 * batch: unrejectLine posts exactly one entry (store-requisitions/page.tsx),
 * and the only multi-entry body the page builds is the half-transfer
 * [issue, defer], which the window above refuses on 'fulfilled' outright.
 * Making the guard order-independent would also change how a
 * 'store_processed' requisition answers the same body, which is pre-existing
 * behaviour on a status this decision never touched. A comment asserting a
 * safety property the code does not hold is worth less than no comment: this
 * is what the code does.
 *
 * PARTY REQUISITIONS ARE EXCLUDED FROM THE WIDENED WINDOW, on purpose. Their
 * stock moves on the party rail (applyPartyFulfillment), which applyIssueDelta
 * skips entirely and which is one-shot via its 'party_consumption' ledger row.
 * A reversal there would zero quantity_issued while the party transfer stayed
 * on the books, and the transfer could never re-fire. Provable no-op today:
 * both party requisitions are 'submitted', neither is 'fulfilled', so this
 * carve-out changes nothing that exists — it stops a future divergence. Do not
 * "tidy" it away; parties are out of scope for department stock by decision.
 *
 * PRE-CUTOVER REQUISITIONS UNDO WITHOUT MOVING STOCK, and that is correct.
 * The 14,149 imported issued lines have no requisition_issue_ledger row, so
 * applyIssueDelta's credit clamp gives back exactly what this rail took —
 * nothing. Undoing one of those 1,620 historic fulfilled requisitions zeroes
 * quantity_issued and returns no grams to central, because no gram ever left it
 * through this rail. That is the no-backfill rule, not a bug; "fixing" it by
 * dropping the clamp manufactures stock (the measured ALMOND bug).
 *
 * ── THE DEFER RULE (half-transfer) ─────────────────────────────────────────
 * An 'issue' used to blank deferred_until + defer_reason unconditionally, so
 * "requested 4, issue 2, defer the other 2" was impossible on ONE line: the
 * issue destroyed the defer the moment it landed. An issue now clears the
 * defer ONLY when the line is fully satisfied:
 *
 *     newQty >= (chef_approved_qty ?? quantity_requested)
 *
 * — character-for-character the predicate the auto-advance below uses, on
 * purpose. If the two ever disagreed, a line could satisfy the auto-advance's
 * qty test while still carrying a deferred_until, and its `!deferred_until`
 * clause would keep the requisition out of 'fulfilled' forever. A line that is
 * not deferred is unaffected: the partial UPDATE simply leaves an already-NULL
 * deferred_until and an already-empty defer_reason alone.
 *
 * ── STOCK ──────────────────────────────────────────────────────────────────
 * Every write to quantity_issued here is mirrored to applyIssueDelta()
 * (src/lib/issue-stock.ts), THE single writer of requisition stock. Per its
 * caller contract this route: reads the before-quantity INSIDE the transaction
 * immediately before the UPDATE (undo — and a reject on a line that issued
 * nothing, or on the party rail — zeroes the column and blanks issue_history in
 * one statement, so read it late and the pre-image is gone),
 * and calls the helper inside this route's own transaction so its writes roll
 * back with ours. The helper owns the party skip, the liquor carve-out, the
 * unit conversion, the inventory_transactions row, the ledger row, the
 * department credit AND the negative-balance guard; none of that is duplicated
 * here.
 *
 * That last one is why "roll back with ours" is load-bearing rather than tidy:
 * a reversal the department cannot honour THROWS out of applyIssueDelta, and
 * the only thing standing between that throw and a half-committed batch is this
 * route's own transaction. Do not wrap a per-line try/catch around the helper
 * to "keep the rest of the batch going" — quantity_issued is already written by
 * then, so the surviving lines would be committed against stock that never came
 * back. The batch is atomic; the catch below only improves the MESSAGE.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    // STRICT: only the store person (is_store_manager) issues stock — deliberately
    // no admin bypass. Issuing is a physical handover at the store; admin issuing
    // from a desk left requisitions stuck half-processed in the issue queue.
    if (!canIssueAsStore(me)) {
      return Response.json({ error: 'Only the Store person can issue items to a department.' }, { status: 403 });
    }

    const { id } = await params;
    const db = getDb();
    const r = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const note: string = body?.note || '';
    const lines = Array.isArray(body?.lines) ? body.lines : [];

    // THE STATUS GATE IS NOW ACTION-AWARE, so it has to read the body first.
    // That reordering is deliberate and its only visible effect is on a POST
    // with zero lines against a dead status: the empty-lines 400 below used to
    // be unreachable there. The status refusal still wins — the gate sits ahead
    // of that check, exactly where it sat before.
    // TWO SETS, KEPT APART ON PURPOSE — see "TWO SETS, NOT ONE" in the header.
    //
    // REVERSAL_ACTIONS = the gestures that pull goods BACK. Unchanged, and its
    // one remaining consumer is the party refusal's wording below. Removing
    // either entry turns a 200 into a 400 for the 1,620 fulfilled requisitions
    // in this database.
    const REVERSAL_ACTIONS = new Set(['undo', 'reject']);
    // FINISHED_WINDOW_ACTIONS = the gestures a FINISHED ('fulfilled')
    // requisition admits. REVERSAL_ACTIONS plus 'unreject' (owner decision,
    // 2026-08-26). 'issue' and 'defer' are deliberately absent: they add to a
    // finished requisition, which is still nobody's decision.
    const FINISHED_WINDOW_ACTIONS = new Set(['undo', 'reject', 'unreject']);
    const actions: string[] = lines.map((ln: { action?: unknown }) => String(ln?.action || '').toLowerCase());
    // EVERY line, not SOME. A batch clears the finished window as a whole or
    // not at all; `[].every()` is true, hence the length guard. One 'issue' or
    // 'defer' anywhere in the batch fails this and refuses the batch entire.
    // See "'fulfilled' IS REVERSIBLE" above.
    // THE VERB IS NOT THE WHOLE KEY — see "AND THE UNREJECT MUST HAVE SOMETHING
    // TO UNREJECT" in the header. Only asked when the batch actually contains an
    // 'unreject'; a pure {undo, reject} batch never reaches this query and is
    // admitted exactly as it was before either 2026-08 change.
    const hasUnreject = actions.includes('unreject');
    const unrejectIds: string[] = hasUnreject
      ? lines
          .filter((ln: { action?: unknown }) => String(ln?.action || '').toLowerCase() === 'unreject')
          .map((ln: { id?: unknown }) => String(ln?.id ?? ''))
          .filter((s: string) => s !== '')
      : [];
    // store_rejected = 1 AND NOT chef-rejected, matching the loop below exactly:
    // it skips is_rejected lines BEFORE it reaches the unreject branch, so a
    // chef-rejected line is not something this route can unreject and must not
    // buy entry to the finished window.
    const unrejectHasTarget = unrejectIds.length > 0 && Number((db.prepare(`
      SELECT COUNT(*) AS c FROM requisition_items
      WHERE req_id = ? AND COALESCE(store_rejected, 0) = 1 AND COALESCE(is_rejected, 0) = 0
        AND id IN (${unrejectIds.map(() => '?').join(',')})
    `).get(id, ...unrejectIds) as { c?: number }).c || 0) > 0;
    const finishedOnly = actions.length > 0
      && actions.every(a => FINISHED_WINDOW_ACTIONS.has(a))
      && (!hasUnreject || unrejectHasTarget);
    // Strictly "is this batch a reversal?", which an unreject is not. Read ONLY
    // by partyBlocked below, so that a party unreject-on-fulfilled keeps the
    // generic status refusal it has always had rather than being told it cannot
    // "reverse" something it was never going to reverse.
    const reversalOnly = actions.length > 0 && actions.every(a => REVERSAL_ACTIONS.has(a));
    const isParty = String(r.purpose || '') === 'party';

    // Allow store actions on every "post-approval, pre-final" state, plus the
    // final one when the batch is purely a correction. ONE set object, shared
    // with the in-transaction re-check below so the two can never drift apart —
    // if they disagreed, a reversal could clear the pre-flight gate and then be
    // refused by the re-check (or worse, the reverse).
    const okStatuses = new Set(['mgmt_approved', 'chef_approved', 'store_processed']);
    // `finishedOnly`, not `reversalOnly` — the ONLY behavioural change of the
    // 2026-08-26 decision. `!isParty` is untouched, so the party window is
    // byte-identical to what it was: a party requisition never gains
    // 'fulfilled' here, for any action, exactly as before.
    if (finishedOnly && !isParty) okStatuses.add('fulfilled');
    if (!okStatuses.has(r.status)) {
      // Name the party carve-out rather than hiding it behind the generic
      // status message — otherwise the storekeeper goes looking for a status
      // problem that is not there.
      // reversalOnly, NOT finishedOnly. This message explains why a REVERSAL is
      // refused on the party rail; a party 'unreject' on a fulfilled req is
      // refused too, but by the ordinary status rule and with the ordinary
      // message — the same 400 it has always returned. Party gains nothing and
      // loses nothing from the 2026-08-26 decision.
      const partyBlocked = reversalOnly && isParty && r.status === 'fulfilled';
      return Response.json({
        error: partyBlocked
          ? 'Cannot reverse a fulfilled party requisition here — its stock moved on the party '
            + 'rail (store → department at fulfilment), which this screen does not unwind. '
            + 'Adjust it from the department reconcile screen.'
          : `Cannot issue items — current status: ${r.status}`,
      }, { status: 400 });
    }

    if (lines.length === 0) return Response.json({ error: 'No lines submitted' }, { status: 400 });
    // Optional per-gesture idempotency token. One token covers the whole batch:
    // the unique index is (client_token, req_item_id), so distinct lines of the
    // same POST never collide with each other, only with a REPLAY of themselves.
    const clientToken: string | null =
      typeof body?.client_token === 'string' && body.client_token.trim()
        ? body.client_token.trim()
        : null;

    const allItems = db.prepare(`
      SELECT ri.*, rm.name AS material_name
      FROM requisition_items ri
      JOIN raw_materials rm ON rm.id = ri.material_id
      WHERE ri.req_id = ?
    `).all(id) as any[];
    const itemMap = new Map<string, any>();
    for (const it of allItems) itemMap.set(it.id, it);

    // THE LIVE PRE-IMAGE. allItems/itemMap above is a snapshot taken before
    // `await req.json()` yielded; it is used ONLY to prove a line belongs to
    // THIS requisition and to name the material in the audit trail. Every
    // mutable field is re-read from here INSIDE the transaction, immediately
    // before the UPDATE that changes it.
    const selLine = db.prepare(`
      SELECT id, quantity_issued, issue_history, is_rejected, store_rejected,
             store_reject_reason, deferred_until, defer_reason,
             quantity_requested, chef_approved_qty
      FROM requisition_items
      WHERE id = ? AND req_id = ?
    `);

    // Fully-satisfied issue: clears the defer. See THE DEFER RULE in the header.
    const updIssue = db.prepare(`
      UPDATE requisition_items
      SET quantity_issued = ?, issued_at = ?, issued_by = ?,
          deferred_until = NULL, defer_reason = '',
          issue_history = ?
      WHERE id = ?
    `);
    // Partial issue: identical, minus the defer wipe. On a line with no defer
    // this writes exactly the same row as updIssue (deferred_until is already
    // NULL and defer_reason already '' — updDefer sets the two together and
    // undo/reject clear the two together, so they are never half-set).
    const updIssuePartial = db.prepare(`
      UPDATE requisition_items
      SET quantity_issued = ?, issued_at = ?, issued_by = ?,
          issue_history = ?
      WHERE id = ?
    `);
    const updDefer = db.prepare(`
      UPDATE requisition_items
      SET deferred_until = ?, defer_reason = ?
      WHERE id = ?
    `);
    const updUndo = db.prepare(`
      UPDATE requisition_items
      SET quantity_issued = 0, issued_at = NULL, issued_by = NULL,
          deferred_until = NULL, defer_reason = '',
          issue_history = '[]'
      WHERE id = ?
    `);
    // Store-side rejection. Distinct from the chef's is_rejected.
    //
    // TWO STATEMENTS, AND THE SPLIT IS THE WHOLE FIX. A reject cancels the
    // OUTSTANDING balance; it does NOT un-hand-over what the storekeeper has
    // already physically carried to the kitchen. REQ-2026-0620: 240 eggs asked,
    // ~200 handed over, reject pressed to kill the last 40 — the old single
    // statement zeroed all 240 and applyIssueDelta credited 200 eggs back into a
    // store that does not hold them while debiting a kitchen that does.
    // 'undo' already means "reverse everything"; reject must not overlap it.
    //
    // updReject: nothing was handed over (or the party rail owns the line — see
    // the reject branch). Byte-identical to the pre-fix statement, kept verbatim
    // so a 0-issued reject writes the same row it always did.
    const updReject = db.prepare(`
      UPDATE requisition_items
      SET store_rejected = 1, store_reject_reason = ?,
          quantity_issued = 0, issued_at = NULL, issued_by = NULL,
          deferred_until = NULL, defer_reason = '',
          issue_history = '[]'
      WHERE id = ?
    `);
    // updRejectKeep: something WAS handed over. quantity_issued, issued_at,
    // issued_by and issue_history are LEFT ALONE — they are the evidence that
    // the goods moved, and the ledger row that moved them is still standing.
    // The defer pair IS cleared, exactly as before: a deferred_until was the
    // store's promise to deliver the remainder later, and that promise is
    // precisely what the reject cancels. (The auto-advance never reads it on a
    // rejected line — store_rejected short-circuits below — so this is for the
    // screens and for defer-due-check.)
    const updRejectKeep = db.prepare(`
      UPDATE requisition_items
      SET store_rejected = 1, store_reject_reason = ?,
          deferred_until = NULL, defer_reason = ''
      WHERE id = ?
    `);
    const updUnreject = db.prepare(`
      UPDATE requisition_items
      SET store_rejected = 0, store_reject_reason = ''
      WHERE id = ?
    `);

    const auditPerLine: any[] = [];
    const nowIso = new Date().toISOString();
    // Carried out of the rolled-back transaction. A plain `let` narrowed to
    // null would defeat the check below, because TS does not track assignments
    // made inside a closure.
    const abort: { statusConflict?: string } = {};
    // Same trick, different failure: a DeptReversalBlocked knows the material
    // and the department but NOT which requisition line asked. In a three-line
    // batch that is the only thing the storekeeper needs, so the line being
    // worked on is stamped here and read after the rollback.
    const failing: { lineId?: string; material?: string } = {};

    const txn = db.transaction(() => {
      // TOCTOU. The status read at the top of this handler happened BEFORE
      // `await req.json()` yielded the event loop, so two concurrent POSTs both
      // cleared that guard and both issued — the second one against a
      // requisition the first had already driven to 'fulfilled'. Re-assert it
      // here. better-sqlite3 is synchronous and there is no `await` anywhere
      // inside this transaction, so from this SELECT to the last UPDATE no other
      // request can interleave: the check and the writes are one atomic step.
      const rNow = db.prepare('SELECT status FROM requisitions WHERE id = ?').get(id) as any;
      if (!rNow || !okStatuses.has(rNow.status)) {
        abort.statusConflict = String(rNow?.status ?? 'unknown');
        throw new Error('req_status_changed');
      }

      for (const ln of lines) {
        const it = itemMap.get(ln.id);
        if (!it) continue;                          // unknown line — skip silently
        // Stamped BEFORE any work on this line, so whatever throws below is
        // attributable. Overwritten each iteration on purpose: the last line
        // touched is the one that threw, because a throw ends the loop.
        failing.lineId = it.id;
        failing.material = it.material_name;
        // STALE SNAPSHOT. itemMap was read before the transaction opened, so
        // two 'issue' entries for the SAME line id in one POST both computed
        // their new total from the same base and the second UPDATE silently
        // swallowed the first (same for issue_history). Re-read the line here.
        const cur = selLine.get(ln.id, id) as any;
        if (!cur) continue;                         // vanished mid-flight
        if (cur.is_rejected) continue;              // chef rejected — never issue
        const action = String(ln.action || '').toLowerCase();
        const before = {
          quantity_issued: cur.quantity_issued || 0,
          deferred_until:  cur.deferred_until,
          defer_reason:    cur.defer_reason,
          store_rejected:  cur.store_rejected || 0,
          store_reject_reason: cur.store_reject_reason || '',
        };
        // A store-rejected line accepts only 'unreject' — clear the rejection
        // first before issuing/deferring/undoing it again.
        if (cur.store_rejected && action !== 'unreject') continue;
        if (action === 'issue') {
          const addQty = Number(ln.quantity);
          if (!Number.isFinite(addQty) || addQty <= 0) continue;
          const beforeQty = Number(cur.quantity_issued) || 0;   // in-txn pre-image
          const newQty = beforeQty + addQty;
          const history = (() => {
            try { return JSON.parse(cur.issue_history || '[]'); } catch { return []; }
          })();
          history.push({ qty: addQty, at: nowIso, by: me.email, note: ln.note || '' });
          // THE DEFER RULE — half-transfer. Same expression as the auto-advance
          // below; see the header for why they must stay identical.
          const eff = (cur.chef_approved_qty != null
            ? Number(cur.chef_approved_qty)
            : Number(cur.quantity_requested)) || 0;
          const fullySatisfied = newQty >= eff;
          const stmt = fullySatisfied ? updIssue : updIssuePartial;
          stmt.run(newQty, nowIso, me.email, JSON.stringify(history), cur.id);
          applyIssueDelta(db, {
            reqItemId: cur.id, beforeLineQty: beforeQty, afterLineQty: newQty,
            reason: 'issue', actor: me.email, clientToken,
          });
          auditPerLine.push({ id: it.id, material: it.material_name, action, before, after: {
            quantity_issued: newQty, issued_at: nowIso, issued_by: me.email, added: addQty,
          }});
        } else if (action === 'defer') {
          const until = String(ln.defer_until || '').trim();
          const reason = String(ln.reason || '').trim();
          if (!until) continue;
          // NO STOCK EFFECT. defer touches neither quantity_issued nor stock —
          // it only records when the store will hand the rest over.
          updDefer.run(until, reason, cur.id);
          auditPerLine.push({ id: it.id, material: it.material_name, action, before, after: {
            deferred_until: until, defer_reason: reason,
          }});
        } else if (action === 'undo') {
          // Capture the pre-image FIRST: updUndo zeroes quantity_issued and
          // blanks issue_history in the same statement.
          const beforeQty = Number(cur.quantity_issued) || 0;
          updUndo.run(cur.id);
          applyIssueDelta(db, {
            reqItemId: cur.id, beforeLineQty: beforeQty, afterLineQty: 0,
            reason: 'undo', actor: me.email, clientToken,
          });
          auditPerLine.push({ id: it.id, material: it.material_name, action, before, after: {
            quantity_issued: 0, issued_at: null, issued_by: null,
          }});
        } else if (action === 'reject') {
          const reason = String(ln.reason || '').trim();
          // Same pre-image rule as undo — updReject still zeroes the column on
          // the nothing-issued path.
          const beforeQty = Number(cur.quantity_issued) || 0;
          // OPTION A: cancel the OUTSTANDING balance, keep what already moved.
          //
          // PARTY IS CARVED OUT, deliberately. A party requisition at
          // mgmt_approved / chef_approved / store_processed IS admitted by this
          // route, and if the reject is the gesture that completes it the
          // auto-advance below fires applyPartyFulfillment — which selects every
          // line with NO store_rejected filter (party-fulfillment.ts:63-70) and
          // transfers each one with quantity_issued > 0. Keeping the quantity
          // there would move real grams that do not move today, on a rail this
          // change is not allowed to touch. So a party reject keeps the old
          // zeroing behaviour exactly, stock-neutral as it already was
          // (applyIssueDelta leaves stockQty at 0 for party — issue-stock.ts:340).
          // The grams a part-issued party line handed over are booked nowhere
          // today; that is a separate, pre-existing hole and a separate owner
          // decision, NOT something to fix by side effect here.
          const keepIssued = !isParty && beforeQty > 0;
          const keptQty = keepIssued ? beforeQty : 0;
          (keepIssued ? updRejectKeep : updReject).run(reason, cur.id);
          // Called on BOTH paths so this file's "every write to quantity_issued
          // is mirrored to applyIssueDelta" contract stays literally true. On
          // the keep path before === after, so deltaLine is 0 and the zero-delta
          // gate (issue-stock.ts:316) returns before any clamp, any stock write,
          // any inventory_transactions row, any ledger row, any department
          // credit and any client_token burn: a kept reject moves no stock in
          // either direction, ever. The zeroing paths pass the same
          // beforeQty -> 0 they always did.
          applyIssueDelta(db, {
            reqItemId: cur.id, beforeLineQty: beforeQty, afterLineQty: keptQty,
            reason: 'store_reject', actor: me.email, clientToken,
          });
          // keptQty, not a hardcoded 0. audit_events is the chain of custody;
          // an after-image claiming 0 issued on a line that kept 200 would be a
          // false record on the one surface that must never lie.
          auditPerLine.push({ id: it.id, material: it.material_name, action, before, after: {
            store_rejected: 1, store_reject_reason: reason, quantity_issued: keptQty,
          }});
        } else if (action === 'unreject') {
          // NOTHING TO CLEAR IS NOT AN ACTION. Without this the branch ran
          // updUnreject on a line whose store_rejected was already 0, counted
          // toward `applied`, and pushed a req_item.store_unreject event whose
          // before AND after both read store_rejected: 0 — a custody entry for a
          // change of custody that did not happen, on the one surface this file
          // calls the chain of custody. Measured 2026-08-27: 200 {applied:1} on
          // a line left byte-identical. `continue`, not a silent fall-through,
          // so it is also not counted: `applied` is what the storekeeper reads
          // back as "how many lines did that touch".
          //
          // The admission rule above already refuses most of these at the door
          // on a 'fulfilled' requisition. This is the same rule stated where the
          // write happens, and it is what covers the statuses that rule never
          // gated (a 'store_processed' requisition admits every action) and the
          // race the pre-flight read cannot see. It also ends the token replay:
          // 'unreject' burns no client_token, so a re-POST used to write a
          // second identical audit event; the second one now finds the line
          // already clear and does nothing.
          if (!cur.store_rejected) continue;
          // EXPLICITLY NO STOCK MOVEMENT. unreject clears store_rejected +
          // store_reject_reason and NOTHING else — in particular it does not
          // touch quantity_issued, so before === after by construction whatever
          // the value is, and the correct delta is 0. applyIssueDelta is
          // therefore not called; calling it would be harmless (the zero-delta
          // gate at issue-stock.ts:316 returns ahead of every write) but it
          // would say nothing.
          //
          // THE VALUE IS NO LONGER NECESSARILY 0. Since reject stopped
          // un-issuing what was physically handed over, a line can sit
          // store_rejected carrying quantity_issued = 200 of 240. Unrejecting it
          // restores exactly that state: 200 issued, 40 outstanding, issuable
          // again — and the 200 never left the ledger, so there is nothing to
          // put back. Do NOT "restore" quantity_issued from issue_history here
          // and do NOT treat the line as fresh: the next 'issue' is INCREMENTAL
          // (newQty = beforeQty + addQty), so issuing the remaining 40 lands on
          // 240, which is the point.
          updUnreject.run(cur.id);
          auditPerLine.push({ id: it.id, material: it.material_name, action, before, after: {
            store_rejected: 0, store_reject_reason: '',
          }});
        }
      }

      // --- Auto-advance parent status if fully fulfilled.
      // Treat is_rejected items as "complete" (chef said no).
      // Treat store_rejected items as "complete" too (store said it can't fulfil).
      // Treat items with deferred_until in the future as still-open (don't fulfill).
      const fresh = db.prepare(`
        SELECT id, is_rejected, store_rejected, quantity_requested, chef_approved_qty, quantity_issued, deferred_until
        FROM requisition_items WHERE req_id = ?
      `).all(id) as any[];
      const allDone = fresh.every(it => {
        if (it.is_rejected) return true;
        if (it.store_rejected) return true;
        const eff = (it.chef_approved_qty != null ? Number(it.chef_approved_qty) : Number(it.quantity_requested)) || 0;
        const got = Number(it.quantity_issued) || 0;
        return got >= eff && !it.deferred_until;     // deferred = still pending even if qty matches
      });

      if (allDone) {
        db.prepare(`
          UPDATE requisitions
          SET status = 'fulfilled',
              fulfilled_at = COALESCE(fulfilled_at, datetime('now')),
              fulfilled_by = COALESCE(fulfilled_by, ?),
              store_processed_at = COALESCE(store_processed_at, datetime('now')),
              store_processed_by = COALESCE(store_processed_by, ?),
              store_note = CASE WHEN ? != '' THEN ? ELSE store_note END,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(me.email, me.email, note, note, id);
        // Party path also TRANSFERS store → department (store deduction + dept
        // credit). The helper is idempotent via the party_consumption ledger row,
        // so re-fulfilment or the store-process path can never double-transfer.
        if (r.purpose === 'party') {
          applyPartyFulfillment(db, id, me.email);
        }
      } else {
        // Mark in-progress so the queue knows it's been touched.
        // rNow, not r: r.status was read before the body parse yielded.
        if (rNow.status === 'fulfilled') {
          // THE DEMOTION. A reversal took a line back below its effective
          // quantity, so the requisition is no longer finished and must return
          // to the store queue — leaving it 'fulfilled' would hide an item the
          // kitchen is still owed on the one screen meant to surface it.
          //
          // fulfilled_at / fulfilled_by are CLEARED, not kept. Both re-fulfilment
          // paths stamp them through COALESCE (here, and store-process:591), so
          // a leftover timestamp would survive the round trip and the eventual
          // re-fulfilment would report the FIRST attempt's time forever. It also
          // reads as a lie meanwhile: /requisitions renders "Fulfilled: <date>"
          // on the strength of the column alone, whatever the status says.
          // Nothing is lost — the reversal itself is in audit_events and in
          // requisition_issue_ledger, which is where the history belongs.
          //
          // store_processed_at/by are NOT cleared: the store genuinely did
          // process this requisition, and COALESCE backfills the pair for the
          // imported rows that never had one.
          db.prepare(`
            UPDATE requisitions
            SET status = 'store_processed',
                fulfilled_at = NULL,
                fulfilled_by = NULL,
                store_processed_at = COALESCE(store_processed_at, datetime('now')),
                store_processed_by = COALESCE(store_processed_by, ?),
                store_note = CASE WHEN ? != '' THEN ? ELSE store_note END,
                updated_at = datetime('now')
            WHERE id = ?
          `).run(me.email, note, note, id);
        } else if (rNow.status === 'mgmt_approved' || rNow.status === 'chef_approved') {
          db.prepare(`
            UPDATE requisitions
            SET status = 'store_processed',
                store_processed_at = COALESCE(store_processed_at, datetime('now')),
                store_processed_by = COALESCE(store_processed_by, ?),
                store_note = CASE WHEN ? != '' THEN ? ELSE store_note END,
                updated_at = datetime('now')
            WHERE id = ?
          `).run(me.email, note, note, id);
        } else if (note) {
          db.prepare(`UPDATE requisitions SET store_note = ?, updated_at = datetime('now') WHERE id = ?`).run(note, id);
        }
      }
    });
    try {
      txn();
    } catch (e: any) {
      // Lost the status race — the requisition moved on between the guard above
      // and the write lock. Nothing was written (the throw rolled the whole
      // transaction back); answer with the same 400 the pre-flight guard gives.
      if (abort.statusConflict) {
        return Response.json(
          { error: `Cannot issue items — current status: ${abort.statusConflict}` },
          { status: 400 },
        );
      }
      // THE DEPARTMENT WILL NOT GIVE THE GOODS BACK. assertReversible() throws
      // instead of clamping, and that throw is what rolled this whole batch
      // back. THE ROLLBACK IS THE CORRECT ANSWER AND IS NOT WHAT IS BEING
      // SOFTENED HERE — every caller writes quantity_issued BEFORE calling
      // applyIssueDelta, so a partial commit would leave a line reading "0
      // issued" against grams that never came back. All lines of the batch,
      // including the ones that succeeded before this one, are unchanged.
      //
      // What was missing is WHICH line refused. The error names the material
      // and the department; `failing` supplies the requisition line, so a
      // three-line undo points at the offending row instead of failing blind.
      //
      // 400, matching this route's other operator-answerable refusals (the
      // status conflict above) rather than the 409 the department-materials
      // reconcile route uses. The client does not branch on the number — it
      // keys off `code` (store-requisitions/page.tsx:232) and renders `blocked`
      // inline against the named line instead of an alert.
      if (isDeptReversalBlocked(e)) {
        console.warn('[req store-issue] reversal blocked:', e.message);
        return Response.json({
          error: e.message,
          code: e.code,
          blocked: [{
            // Fall back to the sole submitted line rather than an empty id: a
            // single-line undo is the common case and the client can still
            // place the message without it, but naming it is free.
            line_id: failing.lineId || (lines.length === 1 ? String(lines[0]?.id || '') : ''),
            material: e.materialName || failing.material || '',
            department: e.departmentName,
            requested: e.requested,
            available: e.available,
            consumed_since: e.consumedSince,
            message: e.message,
          }],
          applied: 0,
        }, { status: 400 });
      }
      // Replayed gesture token. Also fully rolled back, so the earlier POST's
      // effect is the only one that exists — report success, not failure.
      // Falls through to the audit skip below deliberately: those events were
      // written by the original POST.
      if (isIssueTokenReplay(e)) {
        const now = db.prepare('SELECT status FROM requisitions WHERE id = ?').get(id) as any;
        return Response.json({ success: true, replayed: true, status: now?.status, applied: 0 });
      }
      throw e;
    }

    // Audit: log each per-line action so /audit timeline shows the chain of custody.
    try {
      for (const a of auditPerLine) {
        logAuditEvent(db, {
          event_type: `req_item.store_${a.action}`,
          entity_type: 'requisition_item',
          entity_id: a.id,
          actor_email: me.email,
          before: a.before,
          after: a.after,
          note: `${a.material}: ${a.action}`,
        });
      }
      logAuditEvent(db, {
        event_type: 'requisition.store_issue_batch',
        entity_type: 'requisition',
        entity_id: id,
        actor_email: me.email,
        after: { actions: auditPerLine.length, note },
        note,
      });
    } catch { /* never block on audit */ }

    // Re-read final status for response
    const after = db.prepare('SELECT status FROM requisitions WHERE id = ?').get(id) as any;
    return Response.json({ success: true, status: after?.status, applied: auditPerLine.length });
  } catch (e: any) {
    console.error('[req store-issue]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
