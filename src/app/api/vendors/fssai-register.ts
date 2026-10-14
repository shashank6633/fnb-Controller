/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import {
  isISODate, daysBetweenISO, fssaiDocState, fssaiDocStateMeta, FSSAI_DOC_REMINDER_DAYS,
} from '@/lib/fssai';

/**
 * THE APPROVED-VENDOR REGISTER — shared by GET/PATCH /api/vendors and by
 * /api/fssai/receiving, which is where its warning is shown.
 *
 * The Hyderabad checklist line is "Approved vendor list maintained". The owner's
 * ruling: a register that WARNS at receiving and NEVER BLOCKS.
 *
 * ── WHERE EACH FACT LIVES ───────────────────────────────────────────────────
 *   approval, who, when, what they supply, why  → vendors.fssai_* (db.ts, additive)
 *   FSSAI licence number + expiry               → fssai_documents, doc_type
 *                                                 'supplier_licence', vendor_id
 * The licence is READ from the documents cupboard and never copied onto the
 * vendor, so there is one licence record with one renewal chain and one scan —
 * not two that drift apart.
 *
 * ── WHAT FIRES THE WARNING, AND WHAT DOES NOT ───────────────────────────────
 *   fssai_approval = 'not_approved'                       → warn
 *   the vendor's current supplier licence expired before
 *   the delivery date                                     → warn
 *   '' (not reviewed yet — every existing vendor)         → nothing
 *   no licence on file                                    → nothing at receiving
 *                                                           (shown on the register)
 * "Nothing" is deliberate: every vendor in the file starts as '' with no licence
 * document, so the first day this ships every delivery behaves exactly as before.
 * The warning is display-only — it writes nothing and refuses nothing.
 */

/** The five additive columns on `vendors`. Stripped from ordinary replies. */
export const VENDOR_REGISTER_COLUMNS = [
  'fssai_approval', 'fssai_approval_by', 'fssai_approval_at', 'fssai_supplies', 'fssai_approval_note',
] as const;

export type VendorApproval = '' | 'approved' | 'not_approved';

export const VENDOR_APPROVALS: readonly { key: VendorApproval; label: string }[] = [
  { key: '',             label: 'Not reviewed yet' },
  { key: 'approved',     label: 'Approved' },
  { key: 'not_approved', label: 'Not approved' },
] as const;

export function isVendorApproval(v: unknown): v is VendorApproval {
  return VENDOR_APPROVALS.some((a) => a.key === v);
}

export function vendorApprovalLabel(v: unknown): string {
  return VENDOR_APPROVALS.find((a) => a.key === String(v ?? ''))?.label || 'Not reviewed yet';
}

/**
 * Remove the register columns from a vendors row IN PLACE. Deleting keys keeps
 * the order of every other key, so `SELECT *` / `SELECT v.*, …` replies come out
 * byte-identical to what they were before the columns existed.
 */
export function stripVendorRegister<T>(row: T): T {
  if (row && typeof row === 'object') {
    for (const c of VENDOR_REGISTER_COLUMNS) delete (row as any)[c];
  }
  return row;
}

/** Did db.ts's register block actually add the columns? */
export function vendorRegisterReady(db: Database.Database): boolean {
  try {
    const cols = (db.prepare('PRAGMA table_info(vendors)').all() as any[]).map((c) => String(c.name));
    return VENDOR_REGISTER_COLUMNS.every((c) => cols.includes(c));
  } catch {
    return false;
  }
}

function hasDocumentsTable(db: Database.Database): boolean {
  try {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='fssai_documents'`).get();
  } catch {
    return false;
  }
}

export interface VendorLicence {
  document_id: string;
  reference_no: string;
  issuer: string;
  valid_from: string;
  expiry_date: string;
  version: number;
  /** Derived on every read against `todayISO` — never stored. */
  state: 'no_expiry' | 'valid' | 'expiring' | 'expired';
  state_label: string;
  /** Negative = lapsed that many days ago. null = no expiry date recorded. */
  days_to_expiry: number | null;
  /** How many OTHER current supplier licences this vendor has on file. */
  other_current: number;
}

/**
 * The current supplier licence for each vendor, read from fssai_documents.
 *
 * "Current" = doc_type 'supplier_licence', is_active = 1 (not superseded by a
 * renewal), voided_at = '' (not voided). When a vendor has more than one, the one
 * with the LATEST expiry date stands for them — they are covered on a day if any
 * current licence covers it — and a dated licence beats one with no date, because
 * an undated one cannot be judged either way. `other_current` says how many more
 * there are, so the register never hides a second document.
 */
export function supplierLicencesByVendor(
  db: Database.Database,
  todayISO: string,
  vendorIds?: string[],
): Map<string, VendorLicence> {
  const out = new Map<string, VendorLicence>();
  if (!hasDocumentsTable(db)) return out;
  const ids = vendorIds ? [...new Set(vendorIds.filter(Boolean))] : null;
  if (ids && ids.length === 0) return out;

  const rows: any[] = [];
  const base = `SELECT id, vendor_id, reference_no, issuer, valid_from, expiry_date, reminder_days, version, created_at
                  FROM fssai_documents
                 WHERE doc_type = 'supplier_licence' AND is_active = 1 AND voided_at = '' AND vendor_id <> ''`;
  if (ids) {
    // Chunked: SQLite's bound-parameter limit is far above any vendor list, but
    // there is no reason to find out the hard way.
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      rows.push(...(db.prepare(`${base} AND vendor_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as any[]));
    }
  } else {
    rows.push(...(db.prepare(base).all() as any[]));
  }

  const byVendor = new Map<string, any[]>();
  for (const r of rows) {
    const k = String(r.vendor_id);
    if (!byVendor.has(k)) byVendor.set(k, []);
    byVendor.get(k)!.push(r);
  }
  for (const [vendorId, list] of byVendor) {
    list.sort((a, b) => {
      const ea = String(a.expiry_date || '');
      const eb = String(b.expiry_date || '');
      if (!!ea !== !!eb) return ea ? -1 : 1;            // dated first
      if (ea !== eb) return ea < eb ? 1 : -1;           // latest expiry first
      return String(b.created_at || '') < String(a.created_at || '') ? -1 : 1; // newest filed first
    });
    const best = list[0];
    const expiry = String(best.expiry_date || '');
    const reminder = Number.isFinite(Number(best.reminder_days)) ? Number(best.reminder_days) : FSSAI_DOC_REMINDER_DAYS;
    const state = fssaiDocState(expiry, todayISO, reminder);
    const days = isISODate(expiry) ? daysBetweenISO(todayISO, expiry) : NaN;
    out.set(vendorId, {
      document_id: String(best.id),
      reference_no: String(best.reference_no || ''),
      issuer: String(best.issuer || ''),
      valid_from: String(best.valid_from || ''),
      expiry_date: expiry,
      version: Number(best.version) || 1,
      state,
      state_label: fssaiDocStateMeta(state).label,
      days_to_expiry: Number.isFinite(days) ? days : null,
      other_current: list.length - 1,
    });
  }
  return out;
}

/** One vendor as the register shows it: the vendor, its approval, its licence. */
export function shapeRegisterRow(row: any, licence: VendorLicence | null) {
  const approval = (isVendorApproval(row.fssai_approval) ? row.fssai_approval : '') as VendorApproval;
  const licenceExpired = !!licence && licence.state === 'expired';
  return {
    id: String(row.id),
    name: String(row.name || ''),
    contact_person: String(row.contact_person || ''),
    phone: String(row.phone || ''),
    gstin: String(row.gstin || ''),
    is_active: Number(row.is_active) ? 1 : 0,
    approval,
    approval_label: vendorApprovalLabel(approval),
    approval_by: String(row.fssai_approval_by || ''),
    approval_at: String(row.fssai_approval_at || ''),
    approval_note: String(row.fssai_approval_note || ''),
    supplies: String(row.fssai_supplies || ''),
    licence,
    /** Exactly what receiving would say about a delivery from them TODAY. */
    would_warn: approval === 'not_approved' || licenceExpired,
  };
}

export interface VendorRegisterWarning {
  vendor_id: string;
  vendor_name: string;
  /** Why — one or both. */
  codes: Array<'not_approved' | 'licence_expired'>;
  approval: VendorApproval;
  approval_label: string;
  approval_by: string;
  approval_at: string;
  approval_note: string;
  licence_no: string;
  licence_expiry: string;
  licence_document_id: string;
  /** The delivery day the licence was judged against. */
  on_date: string;
  message: string;
  /** Said every time, so nobody reads the warning as a refusal. */
  never_blocks: string;
}

const NEVER_BLOCKS =
  'This is a warning, not a stop: the receipt can still be completed. Say in the remarks what was done about it.';

/**
 * A lookup for the receiving screens. Caches per vendor for the life of one
 * request, so a list of 200 deliveries costs one query per distinct supplier.
 *
 * `forVendor` returns null — and the caller adds NOTHING to its reply — when
 * there is nothing to say. That null is what keeps an ordinary receipt
 * byte-identical to the one before this register existed.
 */
export function vendorWarningLookup(db: Database.Database, todayISO: string) {
  const ready = vendorRegisterReady(db);
  const vendorCache = new Map<string, any | null>();
  const licenceCache = new Map<string, VendorLicence | null>();
  const nameCache = new Map<string, string>();

  const vendorRow = (id: string) => {
    if (!vendorCache.has(id)) {
      vendorCache.set(id, (db.prepare(
        `SELECT id, name, fssai_approval, fssai_approval_by, fssai_approval_at, fssai_approval_note
           FROM vendors WHERE id = ?`,
      ).get(id) as any) || null);
    }
    return vendorCache.get(id);
  };
  const licenceFor = (id: string) => {
    if (!licenceCache.has(id)) licenceCache.set(id, supplierLicencesByVendor(db, todayISO, [id]).get(id) || null);
    return licenceCache.get(id) || null;
  };
  /** A typed-in supplier with no vendor id: matched on the house join key, and
   *  only when exactly ONE vendor carries that name. */
  const idForName = (name: string) => {
    const k = name.trim().toLowerCase();
    if (!k) return '';
    if (!nameCache.has(k)) {
      const hits = db.prepare(`SELECT id FROM vendors WHERE LOWER(TRIM(name)) = ? LIMIT 2`).all(k) as any[];
      nameCache.set(k, hits.length === 1 ? String(hits[0].id) : '');
    }
    return nameCache.get(k) || '';
  };

  return {
    ready,
    forVendor(vendorIdIn: string, vendorNameIn: string, onDateIn: string): VendorRegisterWarning | null {
      if (!ready) return null;
      const vendorId = String(vendorIdIn || '') || idForName(String(vendorNameIn || ''));
      if (!vendorId) return null;
      const v = vendorRow(vendorId);
      if (!v) return null;
      const onDate = isISODate(onDateIn) ? onDateIn : todayISO;
      const approval = (isVendorApproval(v.fssai_approval) ? v.fssai_approval : '') as VendorApproval;
      const lic = licenceFor(vendorId);
      const codes: VendorRegisterWarning['codes'] = [];
      if (approval === 'not_approved') codes.push('not_approved');
      // The licence is judged against the DELIVERY day: a licence valid up to and
      // including its expiry date covered a delivery on that date.
      if (lic && isISODate(lic.expiry_date) && lic.expiry_date < onDate) codes.push('licence_expired');
      if (!codes.length) return null;

      const name = String(v.name || vendorNameIn || 'This supplier');
      const parts: string[] = [];
      if (codes.includes('not_approved')) {
        const note = String(v.fssai_approval_note || '').trim();
        parts.push(`${name} is marked NOT APPROVED on the approved vendor list${note ? ` (“${note}”)` : ''}.`);
      }
      if (codes.includes('licence_expired') && lic) {
        parts.push(`${codes.length > 1 ? 'Their' : `${name}'s`} FSSAI licence${lic.reference_no ? ` ${lic.reference_no}` : ''} expired on ${lic.expiry_date}${onDate !== todayISO ? `, before this delivery on ${onDate}` : ''}.`);
      }
      return {
        vendor_id: vendorId,
        vendor_name: name,
        codes,
        approval,
        approval_label: vendorApprovalLabel(approval),
        approval_by: String(v.fssai_approval_by || ''),
        approval_at: String(v.fssai_approval_at || ''),
        approval_note: String(v.fssai_approval_note || ''),
        licence_no: lic?.reference_no || '',
        licence_expiry: lic?.expiry_date || '',
        licence_document_id: lic?.document_id || '',
        on_date: onDate,
        message: parts.join(' '),
        never_blocks: NEVER_BLOCKS,
      };
    },
  };
}
