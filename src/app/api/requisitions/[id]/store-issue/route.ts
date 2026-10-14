import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, canIssueAsStore } from '@/lib/auth';
import { applyPartyFulfillment } from '@/lib/party-fulfillment';
import {
  applyIssueDelta, checkCentralIssue, isCentralStockShort,
  isIssueGestureRecorded, isIssueTokenReplayError,
  issueLineQtyToRecord, rescoreHeldIssue, scoreHeldAtTurn, lineIssueComplete,
  zeroEntriesSentence,
} from '@/lib/issue-stock';
import { isDeptReversalBlocked } from '@/lib/dept-ledger';

/**
 * A replayed POST carrying a client_token it already spent is answered 200
 * "you already did this", never a 400 and never a 500: nothing was applied a
 * second time, so a failure is a lie about what happened.
 *
 * TWO SPELLINGS OF THE SAME FACT, AND BOTH ARE NEEDED.
 *
 *  1. IssueTokenReplay, thrown by applyIssueDelta BEFORE either of its guards
 *     can refuse. This is the one that actually fires in ordinary use, and it
 *     exists because of a measured trap: with the central floor in front of the
 *     ledger insert, a replayed tight-stock issue (asks 5, central held 2,
 *     issued 2 and deferred the rest) was answered 400 "nothing was issued and
 *     the requisition is unchanged" WHEN THE HAND-OVER HAD COMPLETED. The floor
 *     was right about the balance — the first POST had taken it to zero — and
 *     backwards about the gesture. See the ordering note in issue-stock.ts.
 *
 *  2. The unique index uq_req_issue_token_item on requisition_issue_ledger
 *     (client_token, req_item_id), which is still in place and is still the
 *     LAST word: it is the only layer that is atomic against a first POST that
 *     has not committed yet. better-sqlite3 rolls the WHOLE transaction back,
 *     so again nothing was applied twice.
 *     SQLite words the failure with the COLUMNS, not the index name
 *     ("UNIQUE constraint failed: requisition_issue_ledger.client_token,
 *     requisition_issue_ledger.req_item_id"), so match on that and keep the
 *     index name as a fallback. Deliberately narrow: any other constraint
 *     failure is a real bug and must keep surfacing as a 500.
 */
function isIssueTokenReplay(e: any): boolean {
  if (isIssueTokenReplayError(e)) return true;
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
 * non-rejected item is issued in full — lineIssueComplete (src/lib/issue-stock.ts):
 * quantity_issued >= effective_qty (chef_approved_qty if set, else
 * quantity_requested), or the desk shows the two as the same figure (round 7:
 * a line the shown-figure rule took in full, 14.8425 kg recorded of 14.843
 * approved, is done). A line rejected by the chef (is_rejected)
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
 *     lineIssueComplete({ ...line, quantity_issued: newQty })
 *
 * — the SAME FUNCTION the auto-advance below calls, on purpose (it was the
 * same expression typed twice until round 7). If the two ever disagreed, a line could satisfy the auto-advance's
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
 *
 * ── AND CENTRAL CANNOT GO NEGATIVE EITHER (THE OVER-ISSUE CLAMP) ───────────
 * An 'issue' for more than the central store holds is REFUSED. It used to
 * succeed silently and drive raw_materials.current_stock negative; nothing on
 * the path said no, in this route or in the helper.
 *
 * The refusal is asked TWICE, and the two are not redundant:
 *   - BEFORE the transaction (the pre-flight block below), so the short line is
 *     HELD — dropped from the write loop and named on the response — while
 *     every other line of the batch is handed over. "Issue the 5, hold the 1",
 *     the owner's call. Only when NOT ONE 'issue' entry survives the floor is
 *     the whole gesture refused with nothing written, which is what keeps the
 *     single-line issue-and-defer modal replayable with its typed numbers.
 *   - INSIDE applyIssueDelta (assertCentralIssue), which throws and unwinds this
 *     route's transaction. That is the bound that actually holds — it covers the
 *     race the pre-flight cannot see, and it covers any future caller.
 * A PARTIAL issue of what the store genuinely holds still works; both the
 * refusal and the held row carry that number, in the line's own unit, as
 * max_issue_qty.
 *
 * ROUND 6, TWO THINGS THE STOREKEEPER READS WERE FALSE, AND ARE NOT NOW:
 *   - THE SHOWN FIGURE. Typing the "In store" figure (14.843 kg over 14,842.5 g)
 *     is accepted and takes the whole balance — planCentralDebit's shown-figure
 *     rule — and the line RECORDS what left the shelf: quantity_issued,
 *     issue_history and the audit row all carry issueLineQtyToRecord()'s figure,
 *     not the typed one, whenever the two differ (the typed figure rides along
 *     as `asked`). Never below zero, never phantom stock.
 *   - THE STALE CAP. A held row's cap was scored BEFORE the gesture ran, so a
 *     later line of the same material spent part of it and typing the printed
 *     cap back was refused. The rows are now re-scored inside the transaction
 *     after every write (rescoreHeldIssue), so the 200 prints what is left.
 *
 * ROUND 7, THREE MORE:
 *   - THE STUCK LINE. The shown figure took the whole shelf and recorded
 *     14.8425 kg of 14.843 approved; `issued >= approved` then held the line
 *     0.0005 kg outstanding forever. lineIssueComplete closes it.
 *   - SIBLING CAPS. Two held rows of one material each printed the whole pool;
 *     they now share it in row order (scoreHeldAtTurn / rescoreHeldIssue's
 *     siblingRecipe), so the caps add up to the shelf.
 *   - THE PARTY RAIL'S RECORD. A party line's transfer can take the balance
 *     instead of the typed figure; the line, the ledger and the audit row now
 *     say what it took (applyPartyFulfillment's `recorded`).
 *
 * AND NEITHER LAYER MAY ANSWER FOR A REPLAY. Both of them sit in front of the
 * ledger insert that used to be the only thing aware of client_token, so a
 * re-POST of an already-recorded gesture was answered "nothing was issued and
 * the requisition is unchanged" on the very tight-stock case the token exists
 * for. The replay is now recognised ahead of both — in the pre-flight loop's
 * filters and, structurally, inside applyIssueDelta — and answered 200 as it
 * always was. See isIssueTokenReplay above.
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
    // line_unit + the material's pack meta ride along for lineIssueComplete
    // (round 7) — the defer rule's "fully satisfied" reads what the desk SHOWS.
    // LEFT JOIN, so a line whose material row is gone is still read exactly as
    // before (its meta is NULL and only the exact comparison applies).
    const selLine = db.prepare(`
      SELECT ri.id, ri.quantity_issued, ri.issue_history, ri.is_rejected, ri.store_rejected,
             ri.store_reject_reason, ri.deferred_until, ri.defer_reason,
             ri.quantity_requested, ri.chef_approved_qty,
             ri.unit AS line_unit, rm.unit, rm.purchase_unit, rm.pack_size
      FROM requisition_items ri
      LEFT JOIN raw_materials rm ON rm.id = ri.material_id
      WHERE ri.id = ? AND ri.req_id = ?
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

    // ── THE CENTRAL FLOOR, ASKED BEFORE THE TRANSACTION OPENS ───────────────
    // No issue may take raw_materials.current_stock below zero. The bound that
    // makes that structural lives on the single writer (assertCentralIssue in
    // src/lib/issue-stock.ts, which throws inside this route's transaction);
    // this is the same rule — literally the same function — asked early, so the
    // lines that CAN be handed over are not held hostage by the one that cannot.
    //
    // ── ISSUE THE 5, HOLD THE 1 (the owner's call) ──────────────────────────
    // A batch where ONE material is short used to answer 400 with applied:0:
    // every line kept quantity_issued 0, no requisition_issue_ledger rows, no
    // inventory_transactions, and the materials the storekeeper was holding in
    // his hands stayed on the shelf. Measured on a copy of the live db — SALT
    // 2 kg, MIRCHI 3 kg (1,000 g on hand), EGGS 100 pcs, CHICKEN 5 kg — one
    // short line cost the other three their hand-over. The storekeeper's only
    // answer was to retype the batch without the short line, which is work this
    // route can do for him.
    //
    // SO A SHORT LINE IS HELD, NOT FATAL. Its entry is dropped from the write
    // loop (`heldEntries` below) and every other entry runs exactly as it would
    // have on its own. The held line keeps the quantity_issued it already had,
    // so it stays outstanding on the requisition and in the store queue — the
    // department is still owed it — and the response names it with the obeyable
    // quantity, so issuing what the store really holds is one more gesture.
    //
    // WHY HELD RATHER THAN CLAMPED TO WHAT IS THERE. Writing 1 kg where the
    // storekeeper typed 3 would commit a hand-over that did not happen, on the
    // row the department is owed against. The verdict stays per line and binary
    // — `c.ok` from checkCentralIssue, the one place that decides what is
    // issuable — and nothing here invents a second notion of "short".
    // store-process/route.ts:779 makes the same point about the per-line vendor
    // verdict that drives its own drop-the-line rule.
    //
    // NOTHING LEFT TO ISSUE IS STILL REFUSED WHOLE, in the envelope and the
    // words it has always had. If not one 'issue' entry survives the floor there
    // is no hand-over to protect: the requisition is left untouched rather than
    // written to, every short line is named, and the modal keeps the typed
    // numbers so one corrected figure replays the gesture. The single-line
    // issue-and-defer gesture (store-requisitions/page.tsx:676) is exactly this
    // case, and it is unchanged — a 'defer' entry is never scored here, so a
    // short issue beside it leaves nothing issuable.
    //
    // A PARTIAL ISSUE REMAINS FULLY AVAILABLE, which is the point of a per-line
    // cap rather than a per-line veto: the message carries max_issue_qty in the
    // LINE's own unit, and issuing that amount passes. Only the part the store
    // does not hold is refused.
    //
    // THE FILTERS BELOW MIRROR THE WRITE LOOP ENTRY FOR ENTRY — unknown line,
    // vanished line, chef-rejected, store-rejected-and-not-unrejecting, and the
    // finite/positive quantity test. A pre-flight that scored a line the loop
    // skips would refuse a batch that moves no stock at all.
    //
    // ONE FILTER IS NOT IN THE WRITE LOOP, AND IS STILL THE SAME RULE: a line
    // whose gesture this token has ALREADY recorded. The loop does call the
    // helper for it — and the helper throws IssueTokenReplay before debiting,
    // which unwinds the batch and is answered 200 in the catch below. So it is
    // a line that moves no stock, which is exactly what this filter list is for.
    // It is spelled out at its own entry below because it is the regression this
    // round exists to fix.
    const centralShort: {
      code: 'central_stock_short';
      line_id: string;
      material: string; material_id: string; req_item_id: string;
      /** PURCHASE basis — the unit every store surface leads with. */
      requested: number; available: number; purchase_unit: string;
      /** LINE basis — what this line's Issue box may hold on a retry. */
      max_issue_qty: number; line_unit: string;
      message: string;
    }[] = [];
    /**
     * INDICES INTO `lines` the write loop must not run, keyed by ENTRY and not
     * by line id on purpose: one POST can carry two entries for the same line
     * (the issue-and-defer gesture is exactly that), and only the entry the
     * floor refused is dropped. The write loop walks the same array by the same
     * index, so the two can never drift apart.
     */
    const heldEntries = new Set<number>();
    /**
     * Entry index → its row in `centralShort`, so the transaction can re-score
     * the row's FIGURES after the gesture has run (rescoreHeldIssue). The hold
     * decision itself is the pre-flight's and is never revisited.
     */
    const heldRowOf = new Map<number, (typeof centralShort)[number]>();
    /** 'issue' entries the floor cleared. 0 with a held line ⇒ refuse whole. */
    let issuableEntries = 0;
    {
      // Accumulated per MATERIAL, in the batch's own order, so two entries for
      // one line — which this route documents and has measured — and two lines
      // of one material are both scored the way the floor will see them.
      const claimed = new Map<string, number>();
      // What earlier HELD rows of the same material are given first, for the
      // FIGURES only (round 7 — scoreHeldAtTurn). Never read by the decision:
      // a held line runs nothing, so it must not hold a later line that fits.
      const heldShare = new Map<string, { recipe: number; lines: number }>();
      for (let li = 0; li < lines.length; li++) {
        const ln = lines[li];
        if (!itemMap.get(ln.id)) continue;
        const cur = selLine.get(ln.id, id) as any;
        if (!cur) continue;
        if (cur.is_rejected) continue;
        const action = String(ln.action || '').toLowerCase();
        if (cur.store_rejected && action !== 'unreject') continue;
        // 'defer' and 'unreject' write no quantity at all; the loop calls the
        // helper for neither, so there is no delta to bound.
        if (action !== 'issue' && action !== 'undo' && action !== 'reject') continue;
        // ── A REPLAY IS NOT A STOCK PROBLEM, SO IT IS NOT SCORED ────────────
        // THE DEFECT THIS CLOSES, MEASURED. Requisition asks 5, central holds
        // exactly 2, the storekeeper issues 2 and defers the rest, and the same
        // gesture arrives twice (a dropped response on the venue LAN — the one
        // case the token exists for). The first POST took central to 0, so this
        // pre-flight then scored the REPLAY against an empty store and refused
        // it 400 "nothing was issued and the requisition is unchanged" — the
        // opposite of the truth, about a hand-over that had completed. On
        // 3be09af the same second POST answered 200, applied=0.
        //
        // A gesture already in requisition_issue_ledger under this token moves
        // no stock on this POST: applyIssueDelta throws IssueTokenReplay before
        // it debits anything, the transaction unwinds, and the catch below
        // answers 200 like the unique index always made it. There is therefore
        // no delta for a floor to bound — scoring it would refuse a no-op.
        //
        // SKIPPING IS WHAT 3be09af DID, exactly: it had no pre-flight at all,
        // so no replayed line was ever weighed against a balance. Note what is
        // deliberately NOT done here — the batch is not short-circuited and no
        // 200 is minted at this point. Whether a row actually gets written (and
        // so whether this IS a replay) is applyIssueDelta's decision, made from
        // the final delta inside the transaction; deciding it here would start
        // refusing the zero-delta cases the base tree let through (a replayed
        // token arriving on a defer-only POST, or on a reject that keeps what
        // was handed over — both measured identical to base).
        //
        // ONE DELIBERATE DIFFERENCE FROM 3be09af, AND IT IS A BETTER ANSWER,
        // not an oversight. A batch that mixes a replayed line with a FRESH line
        // that is genuinely short is refused here naming the fresh line, where
        // base answered "you already did this". Both write nothing and leave
        // byte-identical state (measured), but base's sentence was false about
        // the line that actually could not be satisfied. No shipped client can
        // produce the case — the only tokened POST is the single-line
        // issue-and-defer gesture at store-requisitions/page.tsx:676.
        if (isIssueGestureRecorded(db, clientToken, String(cur.id))) continue;
        const beforeQty = Number(cur.quantity_issued) || 0;
        let afterQty = beforeQty;
        if (action === 'issue') {
          const addQty = Number(ln.quantity);
          if (!Number.isFinite(addQty) || addQty <= 0) continue;
          afterQty = beforeQty + addQty;
        } else if (action === 'undo') {
          afterQty = 0;
        } else {
          // reject: keeps what was handed over unless the party rail owns the
          // line — the same keepIssued expression the loop uses below.
          afterQty = (!isParty && beforeQty > 0) ? beforeQty : 0;
        }
        const matId = String(itemMap.get(ln.id)?.material_id || '');
        const already = claimed.get(matId) || 0;
        const c = checkCentralIssue(db, {
          reqItemId: String(cur.id),
          beforeLineQty: beforeQty,
          afterLineQty: afterQty,
          alreadyClaimedRecipe: already,
        });
        // ── WHAT A HELD LINE CLAIMS: NOTHING ────────────────────────────────
        // netRecipe, not requestedRecipe: an undo in the same batch credits
        // stock back, and that headroom is real for a later issue of the same
        // material.
        //
        // AND ONLY WHEN THE LINE IS ACTUALLY GOING TO RUN. A held line is
        // dropped from the write loop, so it removes nothing from central and
        // must not eat the headroom a later line of the same material draws on
        // — accumulating its full request (what the whole-batch refusal did,
        // harmlessly, because nothing ran afterwards) would cascade one short
        // line into holding every later line of that material. 0 of the 1,630
        // live requisitions name one material twice, so this changes no
        // measured case; it stops the day one does from being wrong.
        if (c.ok) {
          claimed.set(matId, already + c.netRecipe);
          // 'issue' is the only action that hands goods OVER (an 'undo' or
          // 'reject' is a credit or a no-op — see afterQty above), so it is the
          // only one whose survival makes a partial hand-over worth protecting.
          if (action === 'issue') issuableEntries++;
          continue;
        }
        heldEntries.add(li);
        // ── HELD ROWS OF ONE MATERIAL SHARE THE POOL (round 7) ──────────────
        // Each held row used to print the whole remaining pool as its cap, so
        // two short MANGO lines over 1 kg both said "Issue 1 kg or less" and
        // typing both back held one of them. The first held row is given what
        // it can take, the next what is left — the caps add up to what is
        // there. With no earlier held sibling this is `c`, byte for byte.
        const share = heldShare.get(matId);
        const h = share
          ? scoreHeldAtTurn(db, {
              reqItemId: String(cur.id), beforeLineQty: beforeQty, afterLineQty: afterQty,
              alreadyClaimedRecipe: already, siblingRecipe: share.recipe, siblingLines: share.lines,
            })
          : c;
        heldShare.set(matId, {
          recipe: (share?.recipe || 0) + Math.max(0, Number(h.debitRecipe) || 0),
          lines: (share?.lines || 0) + 1,
        });
        const row = {
          code: 'central_stock_short' as const,
          line_id: String(ln.id ?? ''),
          material: h.materialName, material_id: h.materialId, req_item_id: h.reqItemId,
          requested: h.requestedPurchase, available: h.availablePurchase,
          purchase_unit: h.purchaseUnit,
          max_issue_qty: h.maxIssueLineQty, line_unit: h.lineUnit,
          message: h.message,
        };
        centralShort.push(row);
        heldRowOf.set(li, row);
      }
    }
    // NOTHING LEFT TO HAND OVER ⇒ THE WHOLE GESTURE IS REFUSED, unchanged in
    // wording, envelope and status from the day the floor was added. Every
    // 'issue' entry in the batch is short, so there is no partial hand-over to
    // protect and writing the defers/unrejects that rode along with it would
    // record half a gesture the storekeeper never completed.
    if (centralShort.length > 0 && issuableEntries === 0) {
      // Same envelope the department-reversal refusal uses — `code` + `blocked`
      // — because the client already keys off those and renders the message
      // inline against the named line instead of an alert
      // (store-requisitions/page.tsx:232).
      return Response.json({
        error: `${centralShort.length} line${centralShort.length === 1 ? '' : 's'} `
          + `${centralShort.length === 1 ? 'asks' : 'ask'} for more than the central store holds, `
          + `so nothing was issued and the requisition is unchanged. `
          + centralShort.map(s => s.message).join(' '),
        code: 'central_stock_short',
        blocked: centralShort,
        applied: 0,
      }, { status: 400 });
    }

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
    // 'issue' entries sent at 0 (a box typed to 0 on Issue All / Issue
    // Selected). The loop skips them — nothing is issued on them — so the held
    // sentence below must not say "everything else was issued" over them
    // (round 7 verifier: MIRCHI held + SALT at 0 + EGGS).
    const zeroEntryNames: string[] = [];

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

      for (let li = 0; li < lines.length; li++) {
        const ln = lines[li];
        // ── A HELD ENTRY IS NOT RUN ─────────────────────────────────────────
        // The floor refused this one entry before the transaction opened
        // (centralShort above) and at least one other 'issue' entry survived,
        // so the gesture proceeds without it: no quantity_issued, no
        // issue_history, no applyIssueDelta call, no ledger row, no audit row
        // and no contribution to `applied`. The line keeps whatever it already
        // held, which is what leaves it outstanding in the store queue.
        //
        // FIRST, BEFORE `failing` IS STAMPED. A line this loop never touches
        // must not be named as the one that threw.
        if (heldEntries.has(li)) continue;
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
          if (!Number.isFinite(addQty) || addQty <= 0) {
            zeroEntryNames.push(String(it.material_name || 'a line'));
            continue;
          }
          const beforeQty = Number(cur.quantity_issued) || 0;   // in-txn pre-image
          // WHAT LEFT THE SHELF, NOT WHAT WAS TYPED (round 6). Identical to
          // beforeQty + addQty on every ordinary issue (`shelf.changed` false, the
          // sum untouched); different only when the typed figure was the balance's
          // shown figure and the shown-figure rule took the balance itself — then
          // every record below says that balance. Asked here, inside the
          // transaction and immediately before the UPDATE, so applyIssueDelta's
          // floor reads the same balance and takes exactly this.
          const shelf = issueLineQtyToRecord(db, {
            reqItemId: cur.id, beforeLineQty: beforeQty, afterLineQty: beforeQty + addQty,
          });
          const newQty = shelf.afterLineQty;
          const addedQty = shelf.changed ? newQty - beforeQty : addQty;
          const history = (() => {
            try { return JSON.parse(cur.issue_history || '[]'); } catch { return []; }
          })();
          history.push({
            qty: addedQty, at: nowIso, by: me.email, note: ln.note || '',
            ...(shelf.changed ? { asked: addQty } : {}),
          });
          // THE DEFER RULE — half-transfer. The SAME FUNCTION as the
          // auto-advance below (lineIssueComplete); see the header for why they
          // must agree. Round 7: a line taken in full by the shown figure
          // (14.8425 kg recorded of 14.843 approved — the store emptied itself
          // into it) is complete, so its defer is cleared with it.
          const fullySatisfied = lineIssueComplete({ ...cur, quantity_issued: newQty });
          const stmt = fullySatisfied ? updIssue : updIssuePartial;
          stmt.run(newQty, nowIso, me.email, JSON.stringify(history), cur.id);
          applyIssueDelta(db, {
            reqItemId: cur.id, beforeLineQty: beforeQty, afterLineQty: newQty,
            reason: 'issue', actor: me.email, clientToken,
          });
          auditPerLine.push({ id: it.id, material: it.material_name, action, before, after: {
            quantity_issued: newQty, issued_at: nowIso, issued_by: me.email, added: addedQty,
            ...(shelf.changed ? { asked: addQty } : {}),
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
      // lineIssueComplete (round 7) — the defer rule's own predicate, so the
      // two cannot disagree. It is the old `issued >= effective` OR the desk
      // shows the two as one figure: a line the shown figure took in full
      // (MANGO 14.8425 kg recorded of 14.843 approved) closes instead of
      // sitting 0.0005 kg outstanding forever behind a "holds none" retry.
      const fresh = db.prepare(`
        SELECT ri.id, ri.is_rejected, ri.store_rejected, ri.quantity_requested, ri.chef_approved_qty,
               ri.quantity_issued, ri.deferred_until,
               ri.unit AS line_unit, rm.unit, rm.purchase_unit, rm.pack_size
        FROM requisition_items ri
        LEFT JOIN raw_materials rm ON rm.id = ri.material_id
        WHERE ri.req_id = ?
      `).all(id) as any[];
      const allDone = fresh.every(it => {
        if (it.is_rejected) return true;
        if (it.store_rejected) return true;
        return lineIssueComplete(it) && !it.deferred_until;     // deferred = still pending even if qty matches
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
          const pf = applyPartyFulfillment(db, id, me.email);
          // THE AUDIT ROW SAYS WHAT LEFT THE SHELF TOO (round 7). The transfer
          // corrected these lines to what it took (14.843 kg typed over
          // 14,842.5 g → 14.8425 kg); the per-line after-images below were
          // written before it ran and still carry the typed figure. Bring the
          // LAST issue entry for each such line into line with the row, the
          // shape the internal rail writes: quantity_issued what moved, `added`
          // what this gesture moved, `asked` what was typed.
          for (const rec of pf.recorded) {
            for (let k = auditPerLine.length - 1; k >= 0; k--) {
              const a = auditPerLine[k];
              if (a.id !== rec.req_item_id || a.action !== 'issue') continue;
              const typedAdded = Number(a.after?.added) || 0;
              a.after = {
                ...a.after,
                quantity_issued: rec.recorded_line_qty,
                // 1e-9 line units, as recordPartyShelfTake snaps the history entry.
                added: Math.round((typedAdded + (rec.recorded_line_qty - rec.asked_line_qty)) * 1e9) / 1e9,
                asked: a.after?.asked != null ? a.after.asked : typedAdded,
              };
              break;
            }
          }
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

      // ── THE HELD ROWS' FIGURES, AFTER THE GESTURE (round 6) ───────────────
      // The pre-flight scored each held entry in write order, BEFORE any line
      // ran — so a later line of the same material that then issued had already
      // spent part of the cap it printed (1 kg held, 0.4 kg of the same material
      // issued after it, the 200 said "issue 1 kg or less" and 1 kg was then
      // refused with 0.6 kg left). Re-scored HERE, last in the transaction,
      // against current_stock as this gesture leaves it, so the cap on the 200
      // is the figure the storekeeper's next POST will meet. Only the figures
      // move; the hold stands — the floor runs in order and would have refused
      // the line at its turn.
      //
      // AND SIBLING HELD ROWS SHARE WHAT IS LEFT, in row order (round 7): the
      // first held row of a material is given what it can take, the next what
      // remains, so the caps on this 200 add up to the shelf and every one of
      // them is accepted when typed back together (rescoreHeldIssue's
      // siblingRecipe; the running sum is each row's own debitRecipe).
      const heldShareAfter = new Map<string, { recipe: number; lines: number }>();
      for (const [li, row] of heldRowOf) {
        const ln = lines[li];
        const cur = selLine.get(ln.id, id) as any;
        if (!cur) continue;
        const beforeQty = Number(cur.quantity_issued) || 0;
        const addQty = Number(ln.quantity) || 0;
        const share = heldShareAfter.get(String(row.material_id));
        const c = rescoreHeldIssue(db, {
          reqItemId: String(cur.id), beforeLineQty: beforeQty, afterLineQty: beforeQty + addQty,
          siblingRecipe: share?.recipe || 0, siblingLines: share?.lines || 0,
        });
        if (!c.debits) continue;
        heldShareAfter.set(String(row.material_id), {
          recipe: (share?.recipe || 0) + Math.max(0, Number(c.debitRecipe) || 0),
          lines: (share?.lines || 0) + 1,
        });
        row.requested = c.requestedPurchase;
        row.available = c.availablePurchase;
        row.max_issue_qty = c.maxIssueLineQty;
        row.message = c.message;
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
      // THE CENTRAL STORE WILL NOT GIVE THE GOODS. The mirror of the block
      // above, on the other direction: assertCentralIssue() throws rather than
      // debiting past zero, and that throw rolled this whole batch back. The
      // pre-flight already refused this before the transaction opened, so
      // reaching here means the balance moved between that read and the write
      // lock — a concurrent issue, a receipt reversal, a closing count. Same
      // envelope, same 400, so the client renders it against the named line
      // exactly as it renders the reversal block; `failing.lineId` supplies the
      // batch entry, since the error knows the requisition line but not which
      // submitted row named it.
      if (isCentralStockShort(e)) {
        console.warn('[req store-issue] central stock short:', e.message);
        return Response.json({
          error: e.message,
          code: e.code,
          blocked: [{
            code: 'central_stock_short',
            line_id: failing.lineId || (lines.length === 1 ? String(lines[0]?.id || '') : ''),
            material: e.materialName, material_id: e.materialId, req_item_id: e.reqItemId,
            requested: e.requestedPurchase, available: e.availablePurchase,
            purchase_unit: e.purchaseUnit,
            max_issue_qty: e.maxIssueLineQty, line_unit: e.lineUnit,
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
    // ── WHAT WAS HELD BACK, ON THE SAME RESPONSE THAT CONFIRMS THE REST ─────
    // `held`, not `blocked`: this is a 200 and the hand-over DID happen, so a
    // reader must not mistake it for the refusal. The ROW shape is identical to
    // `blocked` (code, line_id, material, requested/available in purchase
    // units, max_issue_qty in the line's own unit, the sentence), so the
    // client's existing reader can be pointed at it without a second format —
    // store-requisitions/page.tsx:251 readBlockedReversals is keyed on exactly
    // these fields. Until a client does, the held line staying outstanding in
    // the store queue is the visible signal, and `held_message` is the sentence
    // to print beside it.
    const out: Record<string, unknown> = {
      success: true, status: after?.status, applied: auditPerLine.length,
    };
    if (centralShort.length > 0) {
      const n = centralShort.length;
      out.held = centralShort;
      out.held_message =
        `${n} line${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} NOT issued and `
        + `${n === 1 ? 'stays' : 'stay'} outstanding — the central store does not hold the quantity asked. `
        + centralShort.map(s => s.message).join(' ')
        + zeroEntriesSentence(zeroEntryNames)
        + ` Everything else in this gesture was issued.`;
    }
    return Response.json(out);
  } catch (e: any) {
    console.error('[req store-issue]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
