import type Database from 'better-sqlite3';
import type { SessionUser } from '@/lib/auth';
import {
  deptSendableFor, transferCountedSince,
  type DeptTransferWithLines, type DeptSendable,
} from '@/lib/dept-ledger';
import { packFactor, fmtQtyNum, type PackMeta } from '@/lib/pack-units';
import { isStoreMappedMaterial } from '@/lib/store-engine';
import { presentTransfer, disputeActionsFor, type DeptLite } from './access';

/**
 * A SEND-BACK IS OFFERED ONLY WHEN THE LEDGER WILL TAKE IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * access.ts permissionsFor() decides WHO may send a transfer back and HOW MUCH
 * the one tap moves (reverse_prefill): can_reverse = posted && the prefill
 * moves something. It does not ask whether the original RECEIVER still holds
 * that much — and the reverse is an ordinary send from the receiver, refused
 * 409 'insufficient' when it does not. Measured (the-real-case, owner-day
 * re-verify): the morning after the night count, a finished Kitchen → Akan
 * Tandoori transfer drew "Send it back…" → "Yes, send back 3 kg CHICKEN CURRY
 * CUT + 1 kg HX OD PRAWNS" for admin, the manager, the Kitchen HOD and the
 * Tandoori HOD, and every press got 409 "Akan Tandoori holds only 0.5 kg". The
 * same with an open claim whose material became store-mapped (bell-equals-page:
 * "Send back 0.5 kg" for admin, refused 409 'store_mapped').
 *
 * So every document the screen reads (the list, the single GET, the reverse
 * POST's reply) goes through presentChecked(), which asks the writer's own
 * questions with the writer's own functions — the ones access.ts
 * prefillPassesLedger() asks for the "waiting on you" badge:
 *   · the department it goes back to exists and is switched on, and the
 *     original receiver exists (dept-ledger resolveEnds);
 *   · each material still exists and is not store-mapped NOW
 *     (store-engine isStoreMappedMaterial — what the writer's storeRailBlock
 *     calls; a map that cannot be read refuses, as the writer does);
 *   · the original receiver can send each material's prefilled total by
 *     dept-ledger deptSendableFor() — the figure the writer refuses on. Lines
 *     of one material are summed, as the writer posts them one after another.
 * When the one tap would be refused, `permissions.can_reverse` becomes false
 * (no button) and `permissions.reverse_refused` says why and what to do
 * instead. With a claim open, the take-back's verdict is access.ts's own
 * (disputeActionsFor().take_back), so the button and the badge cannot disagree.
 *
 * `permissions.take_back_refused` is that verdict for the DOCUMENT, whoever
 * reads it: a claim whose take-back the ledger would refuse must not read
 * "they take it back". null = no open claim, the take-back would go through,
 * or the disputed lines were counted since they moved (reverse_blocked and the
 * line's own words cover that).
 *
 * Reads only. Moves nothing, writes nothing.
 */

const EPS = 1e-9;
const r6 = (n: number) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/** One sendable figure per (department, material) per request. */
export type SendableCache = Map<string, DeptSendable>;

function sendableOf(db: Database.Database, cache: SendableCache, deptId: string, materialId: string): DeptSendable {
  const k = `${deptId}\u0000${materialId}`;
  let s = cache.get(k);
  if (!s) { s = deptSendableFor(db, deptId, materialId); cache.set(k, s); }
  return s;
}

/** "3 kg" / "1 kg (1,000 g)" — the purchase unit first, the recipe figure only
 *  when it converts. `down` rounds DOWN (a figure someone may then type into
 *  the send tray must never be more than the server accepts). */
function fmtQ(recipe: number, meta: PackMeta, down = false): string {
  const pf = packFactor(meta);
  const pu = String(meta.purchase_unit || meta.unit || '').trim();
  const ru = String(meta.unit || '').trim();
  const cut = (v: number) => (down ? Math.floor(v * 1000 + 1e-6) / 1000 : Math.round(v * 1000) / 1000);
  const lead = `${fmtQtyNum(cut(recipe / pf))} ${pu}`.trim();
  // unit-lock: the PURCHASE figure leads (`lead` = recipe ÷ packFactor(), in the
  // purchase unit); the recipe total only follows it, in brackets, when it converts.
  return pf > 1 ? `${lead} (${fmtQtyNum(cut(recipe))} ${ru})` : lead;
}

function listJoin(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

type Line = DeptTransferWithLines['lines'][number];
const metaOfLine = (l: Line): PackMeta => ({ unit: l.unit, purchase_unit: l.purchase_unit, pack_size: l.pack_factor });

interface PlanLine { line: Line; qty: number }

interface Scan {
  ok: boolean;
  /** The whole document refused: an end missing or switched off. */
  ends: string;
  /** One sentence per material the writer refuses before any quantity. */
  rail: string[];
  /** Materials planned beyond what the original receiver can send. */
  short: Array<{ name: string; can: number; meta: PackMeta; s: DeptSendable; lines: Line[] }>;
  /** Materials that pass every check. */
  fine: number;
}

/** The writer's checks, in the writer's order, over one planned send-back. */
function scanPlan(
  db: Database.Database, doc: DeptTransferWithLines, all: Map<string, DeptLite>, plan: PlanLine[], cache: SendableCache,
): Scan {
  const out: Scan = { ok: true, ends: '', rail: [], short: [], fine: 0 };
  const backTo = all.get(doc.from_department_id);
  if (!all.get(doc.to_department_id)) {
    return { ...out, ok: false, ends: `${doc.to_department_name} no longer exists, so nothing on ${doc.transfer_no} can be sent back from it.` };
  }
  if (!backTo) {
    return { ...out, ok: false, ends: `${doc.from_department_name} no longer exists, so nothing on ${doc.transfer_no} can go back to it.` };
  }
  if (!Number(backTo.is_active)) {
    return {
      ...out, ok: false,
      ends: `${doc.from_department_name} is switched off in Settings → Departments, so nothing on ${doc.transfer_no} can go back to it until it is switched on again.`,
    };
  }
  const byMat = new Map<string, { want: number; lines: Line[] }>();
  for (const p of plan) {
    const g = byMat.get(p.line.material_id) || { want: 0, lines: [] };
    g.want += p.qty;
    g.lines.push(p.line);
    byMat.set(p.line.material_id, g);
  }
  for (const [materialId, g] of byMat) {
    const name = g.lines[0].material_name;
    let mat: { unit: string; purchase_unit: string; pack_size: number } | undefined;
    let mapped = false;
    try {
      mat = db.prepare('SELECT unit, purchase_unit, pack_size FROM raw_materials WHERE id = ?').get(materialId) as typeof mat;
      if (mat) mapped = isStoreMappedMaterial(db, materialId);
    } catch {
      out.ok = false;
      out.rail.push(`Could not check whether ${name} belongs to a store location, so a send-back would be refused rather than guessed — look again in a minute.`);
      continue;
    }
    if (!mat) {
      out.ok = false;
      out.rail.push(`${name} no longer exists in Raw Materials.`);
      continue;
    }
    if (mapped) {
      out.ok = false;
      out.rail.push(`${name} is now a store-location (liquor) material: it moves with Store Transfers, never between departments.`);
      continue;
    }
    const s = sendableOf(db, cache, doc.to_department_id, materialId);
    if (r6(g.want) > s.available + EPS) {
      out.ok = false;
      // Today's pack meta: the figure the send tray offers for it.
      out.short.push({
        name, can: Math.max(0, r6(s.available)),
        meta: { unit: mat.unit, purchase_unit: mat.purchase_unit, pack_size: mat.pack_size }, s, lines: g.lines,
      });
    } else {
      out.fine++;
    }
  }
  return out;
}

/** What a sendable figure rests on, as a leading clause. */
function basisClause(s: DeptSendable): string {
  if (s.basis !== 'counted') return 'By its ledger (it has never been counted)';
  // A count older than the department-ledger cutover: the figure is the lower
  // of two readings (dept-ledger deptSendable), so name neither.
  if (s.sinceAnchor != null) return 'By its books';
  return 'By its last count and the movements since';
}

/** "By its last count and the movements since, Akan Tandoori can send only 0.5 kg of A and 0.6 kg (600 g) of B now." */
function shortSentence(sender: string, short: Scan['short']): string {
  const clauses = new Set(short.map((x) => basisClause(x.s)));
  const shared = clauses.size === 1 ? [...clauses][0] : '';
  const anyHeld = short.some((x) => x.can > EPS);
  const parts = short.map((x) => {
    const amt = x.can > EPS ? `${fmtQ(x.can, x.meta, true)} of ${x.name}` : `none of ${x.name}`;
    return shared ? amt : `${amt} (${basisClause(x.s).replace(/^By/, 'by')})`;
  });
  return `${shared ? `${shared}, ` : ''}${sender} can send ${anyHeld ? 'only ' : ''}${listJoin(parts)} now.`;
}

const planText = (plan: PlanLine[]) => listJoin(plan.map((p) => `${fmtQ(p.qty, metaOfLine(p.line))} ${p.line.material_name}`));

/** A STANDING send-back (no claim open — goods returned off the receiver's shelf) the ledger would refuse. */
function standingWords(db: Database.Database, doc: DeptTransferWithLines, plan: PlanLine[], sc: Scan): string {
  const T = doc.to_department_name;
  const F = doc.from_department_name;
  if (sc.ends) return sc.ends;
  const out: string[] = [`${doc.transfer_no} cannot be sent back as it stands (${planText(plan)}).`, ...sc.rail];
  if (sc.short.length > 0) out.push(shortSentence(T, sc.short));
  if (sc.fine > 0 || sc.short.some((x) => x.can > EPS)) {
    out.push(`To return part of it, send that part from ${T} to ${F} as a new transfer.`);
  }
  if (sc.short.length > 0) {
    out.push(`If more is on ${T}'s shelf than its books show, record a count for ${T} first.`);
    // Only where the RECEIVER counted since the send and the SENDER did not: a
    // count that left out goods that never arrived took them off the
    // receiver's books, while the sender's books still say they left.
    const counted = sc.short
      .filter((x) => x.lines.some((l) => {
        const c = transferCountedSince(db, l.out_txn_id, l.in_txn_id);
        return !!c?.receiver && !c.sender;
      }))
      .map((x) => x.name);
    if (counted.length > 0) {
      out.push(`${T} has counted ${listJoin(counted)} since ${doc.transfer_no} was sent: if that count left out goods ` +
        `that never arrived, they are still at ${F} — record a count for ${F}.`);
    }
  }
  return out.join(' ');
}

const CLOSE_WHO = 'The person who flagged it, a manager or an admin can close the dispute with a note.';

/** The take-back of an OPEN claim the ledger would refuse — words for whoever reads the card. */
function disputedWords(doc: DeptTransferWithLines, plan: PlanLine[], sc: Scan): string {
  if (sc.ends) return `${sc.ends} Nothing has moved. ${CLOSE_WHO}`;
  const T = doc.to_department_name;
  const out: string[] = [`The disputed ${planText(plan)} cannot be taken back to ${doc.from_department_name} as things stand.`, ...sc.rail];
  if (sc.short.length > 0) out.push(shortSentence(T, sc.short));
  out.push('Nothing has moved.');
  if (sc.short.length > 0) out.push(`Record a count for ${T} so its books show what is on its shelf.`);
  out.push(CLOSE_WHO);
  return out.join(' ');
}

/**
 * The counted-since words (dept-ledger deptTransferCountedSinceMessage — the
 * screen's reverse_blocked and the reverse's 409 'counted_since') end "…once
 * both have counted it, <receiver>'s head can close it too." The HOD posted to
 * Kitchen may send from Akan Tandoori too (ruling #40), so he reads that as
 * himself — and the close refuses him (access.ts canDismissDispute: never
 * anyone who may also send from the SENDING end). Both places say so, for
 * every reader, and stay word-for-word the same.
 */
export function whoClosesCounted(text: string, doc: Pick<DeptTransferWithLines, 'to_department_name' | 'from_department_name'>): string {
  const tail = `${doc.to_department_name}'s head can close it too.`;
  return text.endsWith(tail)
    ? `${text.slice(0, -tail.length)}${doc.to_department_name}'s own head can close it too — not someone who also heads ${doc.from_department_name}.`
    : text;
}

/** presentTransfer(), with the one-tap send-back / take-back checked against the ledger. */
export function presentChecked(
  user: SessionUser, doc: DeptTransferWithLines, all: Map<string, DeptLite>, db: Database.Database,
  cache: SendableCache = new Map(),
) {
  const shown = presentTransfer(user, doc, all, db);
  const p = shown.permissions;
  const anyOpen = doc.lines.some((l) => l.qty_open_disputed > EPS);
  const byLine = new Map(doc.lines.map((l) => [l.id, l]));

  let canReverse = p.can_reverse;
  let reverseRefused: string | null = null;
  if (p.can_reverse) {
    const plan: PlanLine[] = [];
    for (const x of p.reverse_prefill) {
      const line = byLine.get(x.line_id);
      if (line) plan.push({ line, qty: x.quantity });
    }
    const sc = scanPlan(db, doc, all, plan, cache);
    // With a claim open THE verdict is access.ts's own (the badge's), so the
    // button and "waiting on you" cannot disagree; the scan gives the words.
    const ok = anyOpen ? disputeActionsFor(db, user, doc, all).take_back : sc.ok;
    if (!ok) {
      canReverse = false;
      reverseRefused = !anyOpen
        ? standingWords(db, doc, plan, sc)
        : sc.ok
          ? `Taking back the disputed amount would be refused as things stand. Nothing has moved. ${CLOSE_WHO}`
          : disputedWords(doc, plan, sc);
    }
  }

  // The document's verdict on taking back its open claim — for every reader.
  let takeBackRefused: string | null = null;
  if (doc.status === 'posted' && anyOpen) {
    if (p.can_reverse) {
      takeBackRefused = canReverse ? null : reverseRefused;
    } else {
      const plan: PlanLine[] = doc.lines
        .filter((l) => l.qty_open_disputed > EPS && !l.counted_since)
        .map((l) => ({ line: l, qty: l.qty_open_disputed }));
      if (plan.length > 0) {
        const sc = scanPlan(db, doc, all, plan, cache);
        if (!sc.ok) takeBackRefused = disputedWords(doc, plan, sc);
      }
    }
  }

  const reverseBlocked = typeof p.reverse_blocked === 'string' ? whoClosesCounted(p.reverse_blocked, doc) : p.reverse_blocked;

  return {
    ...shown,
    permissions: {
      ...p,
      reverse_blocked: reverseBlocked,
      can_reverse: canReverse,
      /** Why this person's one-tap send-back / take-back (reverse_prefill) is
       *  not offered: the ledger would refuse it. Says what to do instead.
       *  null = offered (can_reverse), or there is no one-tap for this person. */
      reverse_refused: reverseRefused,
      /** With a claim open: why it cannot be taken back as things stand, for
       *  whoever reads the document. null = no open claim, it can be, or the
       *  disputed lines were counted since they moved (reverse_blocked). */
      take_back_refused: takeBackRefused,
    },
  };
}
