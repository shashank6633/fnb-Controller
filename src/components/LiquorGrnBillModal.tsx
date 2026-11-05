'use client';

/**
 * TGBCL LIQUOR BILL — the Goods Receipt door for a liquor indent.
 *
 * OWNER RULINGS #83 / #84. A TGBCL liquor bill is typed on Goods Receipt like
 * any vendor bill (a GRN number, and a PINV of its own series), and on save its
 * bottles post STRAIGHT into the store location the categories are mapped to
 * (Settings → Store Locations), the way Direct Issue routes perishables to the
 * Kitchen. They never enter Central Store stock, and they never move a
 * material's average price — recipe and pour cost stay on the store's rate paid.
 *
 * WHAT THIS FORM SENDS, AND WHO DOES THE ARITHMETIC. The form sends the RAW
 * entry — cases / bottles / loose, the ₹ per bottle (or per case, flagged), or
 * the line amount when the line came from the TGBCL CSV — and POST /api/grn
 * (liquor branch, src/lib/liquor-grn.ts) converts, prices and posts. Every
 * figure computed here is a PREVIEW of that arithmetic (procure-bill's own:
 * ₹ per bottle ÷ pack, amount ÷ recipe qty), shown so the bill can be checked
 * against the paper before saving, and never posted back.
 *
 * WHAT IS NOT ON THIS FORM, ON PURPOSE. No GST, cess, excise, TCS or MRP fields
 * per line (GST is zero on liquor; the four TGBCL charges are bill-level and
 * live in the charges panel). No petty-cash option, no kitchen QC ticks, no
 * back-correction mode, no bill hand-over question: the store rail has no
 * cash-box entry, a liquor bill is never held for QC, a correction is an
 * Adjustment on Inventory → Liquor Store, and the hand-over register covers
 * Central Store bills only.
 *
 * Discount and delivery per line are RECORDED ONLY, exactly as Liquor Store
 * New Bill recorded them: never taken off the rate and never out of Net Indent.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Wine, X, Loader2, Plus, Trash2, Save, Upload, Download, ReceiptText,
  AlertTriangle, CheckCircle2, Info,
} from 'lucide-react';
import { api } from '@/lib/api';
import { todayIST } from '@/lib/format-date';
import MaterialTypeahead, { type MaterialLite } from '@/components/MaterialTypeahead';
import {
  packFactor, caseFactor, entryMode, tripleToRecipe, toPurchaseQty, fmtQtyNum, fmtBreakdown,
  type PackMeta,
} from '@/lib/pack-units';
// THE duplicate rule — one material = one line — imports nothing, so a client
// component may use it (see its own header). The server refuses the same repeat.
import { duplicateLineGroups } from '@/lib/line-dedupe';
import {
  parseLiquorBillCsv, liquorBillTemplateCsv, liquorBalanceCsv,
  type LiquorCsvRow, type LiquorBalanceRow,
} from '@/lib/liquor-bill-csv';

/* ── Wire shapes (POST/GET /api/grn liquor contract) ──────────────────────── */

interface StoreOpt {
  id: string; name: string; code?: string;
  can_view: boolean; can_procure: boolean;
  categories: unknown[];
  recent_suppliers: string[];
}
interface Mat extends MaterialLite, PackMeta {
  id: string; name: string; sku?: string; category?: string;
  unit?: string; purchase_unit?: string | null; pack_size?: number | null; case_size?: number | null;
}
interface Vendor { id: string; name: string; is_active?: number | boolean }

/** A line as the form holds it — raw strings, blank = 0. */
interface LLine {
  key: number;
  material_id: string;
  cases: string; bottles: string; loose: string;
  /** 'rate' = ₹ per bottle (or per case when perCase); 'amount' = the line
   *  amount as printed on the indent (CSV lines that carried no rate). */
  basis: 'rate' | 'amount';
  price: string; perCase: boolean; amount: string;
  discount: string; delivery: string;
  batch: string; expiry: string;
  /** Sheet row this line came from (1-based), and the file, for the line's
   *  own caption — a balance re-upload restarts the row numbers. */
  csvRow?: number; csvFile?: string;
  /** The server's notes on a matched CSV line (e.g. "CGST/SGST … not recorded"). */
  notes?: string[];
  /** Is the recorded-only discount / delivery panel open? */
  extrasOpen?: boolean;
}
/** A skipped CSV row as POST /api/grn/liquor-match reports it. */
interface SkippedRow {
  row: number; item_name: string; sku: string;
  kind: 'missing' | 'not_found' | 'wrong_store' | 'invalid' | 'duplicate' | 'other_bill' | string;
  reason: string;
}

/** POST /api/grn's 201 for a liquor bill (the fields this form reads). */
interface SavedLine {
  material_id: string; material_name: string; ledger_id?: string;
  recipe_qty?: number; purchase_qty?: number; rate_per_bottle?: number; unit_cost?: number; line_total?: number;
}
interface SavedBill {
  grn_number: string; invoice_id?: string; store?: { id: string; name: string };
  posted?: number; lines?: SavedLine[]; invoice_value?: number;
  bill_charges?: { net_indent_value?: number };
}
/** One matched sheet row as POST /api/grn/liquor-match returns it. */
interface MatchedLine {
  row?: number; material_id: string; cases?: number; bottles?: number; loose?: number;
  unit_price?: number | null; amount?: number | null; discount?: number; delivery_charges?: number;
  batch_no?: string; expiry_date?: string; notes?: unknown[];
}
const errText = (e: unknown, fallback: string) =>
  (e instanceof Error && e.message) ? e.message : (typeof e === 'string' && e ? e : fallback);

/** What the Enter Vendor Bill form hands over when its liquor lines are moved
 *  here (the "two receipts" path for a mixed paper bill). */
export interface LiquorBillPrefill {
  vendor?: string; vendor_id?: string; invoice_number?: string; date?: string;
  lines?: Array<{ material_id: string; cases?: number; bottles?: number; price?: number; perCase?: boolean }>;
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** Client mirror of store-engine's catNorm(): lower-case, strip spaces /
 *  hyphens / underscores — the same key the /grn page's catKey uses. */
const catKey = (s: unknown) => String(s || '').trim().toLowerCase().replace(/[\s\-_]/g, '');
const n0 = (s?: string) => { const v = Number(s); return s != null && s !== '' && Number.isFinite(v) ? v : 0; };
const r2 = (v: number) => Math.round((Number(v) || 0) * 100) / 100;
const inr = (v: unknown) =>
  '₹' + (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** The unit every quantity on this form READS in — the PURCHASE unit, falling
 *  back to the recipe unit only when the material has none. */
const puOf = (m: PackMeta | null | undefined) => String(m?.purchase_unit || m?.unit || '').trim() || 'units';
/** Subtract n days from a YYYY-MM-DD string (UTC math avoids DST/local drift). */
const isoMinusDays = (iso: string, n: number): string => {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
};
const storeCatName = (c: unknown): string =>
  typeof c === 'string' ? c : String((c as { category?: unknown })?.category ?? '');

let keySeq = 1;
const newLine = (patch: Partial<LLine> = {}): LLine => ({
  key: keySeq++, material_id: '', cases: '', bottles: '', loose: '',
  basis: 'rate', price: '', perCase: false, amount: '',
  discount: '', delivery: '', batch: '', expiry: '', ...patch,
});
const lineIsBlank = (l: LLine) =>
  !l.material_id && !l.cases && !l.bottles && !l.loose && !l.price && !l.amount;

const inputCls = 'w-full px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0] focus:outline-none focus:border-[#af4408]';
const L = ({ children }: { children: React.ReactNode }) => (
  <label className="block text-[10px] uppercase tracking-wide text-[#8B7355] mb-0.5">{children}</label>
);

function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

/* ── Cases + Bottles + loose (bar counting convention) ─────────────────────
   COPIED from the Liquor Store page (0d32f2b, CBLEntry). Degrades with the
   material: case_size ≤ 1 → Bottles + loose; pack_size ≤ 1 → one plain box in
   the purchase unit. The live line LEADS with the purchase unit —
   "2 cs + 3 btl = 27 BTL" — with the exact recipe figure it will post as the
   declared hint "(= 20,250 ml)", because the cs/btl breakdown rounds to whole
   units and the ledger carries the unrounded total. */
function CBLEntry({ mat, line, onChange }: {
  mat: Mat | null; line: LLine; onChange: (p: Partial<LLine>) => void;
}) {
  const mode = mat ? entryMode(mat) : 'plain';
  const pu = puOf(mat);
  const ru = String(mat?.unit || 'units');
  const recipe = mat ? tripleToRecipe(n0(line.cases), n0(line.bottles), n0(line.loose), mat) : n0(line.bottles);
  const touched = line.cases !== '' || line.bottles !== '' || line.loose !== '';
  if (mode === 'plain') {
    return (
      <div>
        <L>Qty ({pu})</L>
        <input type="number" min={0} step="any" inputMode="decimal" value={line.bottles}
               onChange={e => onChange({ bottles: e.target.value })}
               placeholder="e.g. 2" className={inputCls} />
      </div>
    );
  }
  const showCases = mode === 'cbl' || mode === 'cb';
  const showLoose = mode === 'cbl' || mode === 'bl';
  const cols = (showCases ? 1 : 0) + 1 + (showLoose ? 1 : 0);
  const pf = mat ? packFactor(mat) : 1;
  return (
    <div>
      <div className={`grid gap-2 ${cols === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {showCases && (
          <div>
            <L>Cases</L>
            <input type="number" min={0} step="any" inputMode="decimal" value={line.cases}
                   onChange={e => onChange({ cases: e.target.value })}
                   placeholder="0" className={inputCls}
                   title={mat ? `1 case = ${fmtQtyNum(caseFactor(mat))} ${pu}` : undefined} />
          </div>
        )}
        <div>
          <L>{pu}</L>
          <input type="number" min={0} step="any" inputMode="decimal" value={line.bottles}
                 onChange={e => onChange({ bottles: e.target.value })}
                 placeholder="0" className={inputCls}
                 title={mat && pf > 1 ? `1 ${pu} = ${fmtQtyNum(pf)} ${ru}` : undefined} />
        </div>
        {showLoose && (
          <div>
            <L>Loose ({ru})</L>
            <input type="number" min={0} step="any" inputMode="decimal" value={line.loose}
                   onChange={e => onChange({ loose: e.target.value })}
                   placeholder="0" className={inputCls} />
          </div>
        )}
      </div>
      {mat && touched && (
        <div className="mt-1 text-[11px] text-[#6B5744] bg-[#FFF1E3] border border-[#E8D5C4] rounded px-2 py-1">
          {/* unit-lock: exact-balance-ledger — bar entry preview, purchase-lead.
              The LEAD is the purchase basis (cs + bottles, then the bottle
              total); the Loose box's own value is in the unit its input is
              labelled with right above, and the trailing "(= … ml)" is the exact
              recipe figure this entry posts, labelled as such. */}
          {showCases ? `${n0(line.cases)} cs + ` : ''}
          {`${n0(line.bottles)} ${pu.toLowerCase()}`}
          {showLoose && n0(line.loose) ? ` + ${n0(line.loose)} ${ru}` : ''}
          {' = '}<b>{fmtQtyNum(toPurchaseQty(recipe, mat))} {pu}</b>
          {pf > 1 && <span className="text-[#8B7355]"> (= {fmtQtyNum(recipe)} {ru})</span>}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   THE MODAL
   ══════════════════════════════════════════════════════════════════════════ */

export default function LiquorGrnBillModal({ onClose, onSaved, prefill }: {
  onClose: () => void;
  /** The bill was saved: close and refresh the register behind. */
  onSaved: () => void;
  prefill?: LiquorBillPrefill | null;
}) {
  /* ── reference data ── */
  const [stores, setStores] = useState<StoreOpt[] | null>(null);
  const [storesErr, setStoresErr] = useState('');
  const [materials, setMaterials] = useState<Mat[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [backdateLimit, setBackdateLimit] = useState(3);
  const [isAdmin, setIsAdmin] = useState(false);

  /* ── the bill ── */
  const [storeId, setStoreId] = useState('');
  const [supplier, setSupplier] = useState(prefill?.vendor || '');
  const [vendorId, setVendorId] = useState(prefill?.vendor_id || '');
  const [indent, setIndent] = useState(prefill?.invoice_number || '');
  const [date, setDate] = useState(prefill?.date || todayIST());
  /** Has the user set the receipt date themselves? A sheet's date fills it
   *  only while it is still the form's own default. */
  const [dateTouched, setDateTouched] = useState(!!prefill?.date);
  const [invoiceDate, setInvoiceDate] = useState('');
  const [notes, setNotes] = useState('');
  const [charges, setCharges] = useState({ mrp: '', excise: '', cess: '', tcs: '' });
  const [lines, setLines] = useState<LLine[]>(() => {
    const pre = (prefill?.lines || []).filter(l => l.material_id).map(l => newLine({
      material_id: l.material_id,
      cases: l.cases ? String(l.cases) : '',
      bottles: l.bottles ? String(l.bottles) : '',
      price: l.price ? String(l.price) : '',
      perCase: !!l.perCase,
    }));
    return pre.length ? pre : [newLine()];
  });

  /* ── CSV state ── */
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvNote, setCsvNote] = useState<null | {
    fileName: string; parsed: number; matched: number; unitNotes: string[]; loose1000: string[];
  }>(null);
  /** The un-matched rows of the LAST file uploaded, each with its original
   *  sheet row (for the balance download). Replaced by the next upload — a
   *  balance file carries the rows that are still open. */
  const [unmatched, setUnmatched] = useState<Array<SkippedRow & { src: LiquorCsvRow | null }>>([]);
  const [skipOk, setSkipOk] = useState(false);
  /** The server's duplicate-indent message, when the indent is already on the
   *  store rail. Known as soon as a TGBCL CSV is matched (liquor-match runs the
   *  same guard the save does) — shown then, before anything else is typed —
   *  and from the save's own 409 otherwise. Cleared when the indent is edited. */
  const [indentTaken, setIndentTaken] = useState<string>('');
  const fileRef = useRef<HTMLInputElement>(null);
  /** The scrolling body — brought back to the top whenever something is
   *  refused, because Save sits at the bottom and the sentence is at the top. */
  const bodyRef = useRef<HTMLDivElement>(null);
  const toTop = () => { try { bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); } catch { /* cosmetic */ } };
  const fail = (msg: string) => { setErr(msg); toTop(); };

  /* ── save state ── */
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<SavedBill | null>(null);

  /* ── load ── */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/grn?liquor_option=1', { credentials: 'same-origin' });
        const j = await r.json().catch(() => null);
        if (!alive) return;
        if (!r.ok || !j) { setStoresErr(j?.error || `Could not read the store locations (HTTP ${r.status}).`); setStores([]); return; }
        const list: StoreOpt[] = (Array.isArray(j.stores) ? j.stores : []).filter((s: StoreOpt) => s && s.can_procure);
        setStores(list);
        if (list.length >= 1) setStoreId(list[0].id);
      } catch (e: unknown) {
        if (alive) { setStoresErr(errText(e, 'Could not read the store locations.')); setStores([]); }
      }
    })();
    fetch('/api/inventory?scope=all').then(r => r.json()).then(d => { if (alive) setMaterials(d.materials || []); }).catch(() => {});
    fetch('/api/vendors').then(r => r.json())
      .then(d => { if (alive) setVendors((d.vendors || []).filter((v: Vendor) => v.is_active)); })
      .catch(() => {});
    (async () => {
      try {
        const [sRes, mRes] = await Promise.all([
          fetch('/api/settings?key=purchase_backdate_limit_days'),
          fetch('/api/auth/me'),
        ]);
        const sJson = await sRes.json().catch(() => null);
        const raw = sJson?.value;
        const n = Math.max(0, Math.floor(Number(raw)));
        if (alive) setBackdateLimit(Number.isFinite(n) && raw != null && raw !== '' ? n : 3);
        const mJson = await mRes.json().catch(() => null);
        if (alive) setIsAdmin(mJson?.user?.role === 'admin');
      } catch { /* keep defaults; the server still enforces */ }
    })();
    return () => { alive = false; };
  }, []);

  const store = useMemo(() => (stores || []).find(s => s.id === storeId) || null, [stores, storeId]);
  const storeName = store?.name || 'its store location';
  /** The materials this store's categories cover — the only ones a liquor bill
   *  may carry (the server re-checks materialStoreId per line). */
  const storeMaterials = useMemo(() => {
    if (!store) return [] as Mat[];
    const keys = new Set(store.categories.map(c => catKey(storeCatName(c))).filter(Boolean));
    return materials.filter(m => keys.has(catKey(m.category)));
  }, [store, materials]);
  const matById = useMemo(() => new Map(storeMaterials.map(m => [m.id, m])), [storeMaterials]);

  // A non-admin's window comes from the same setting the Enter Vendor Bill form
  // reads; the server is the real guard. Nobody — admins included — may date a
  // liquor bill after today.
  const today = todayIST();
  const dateMin = isAdmin ? undefined : isoMinusDays(today, backdateLimit);
  const dateMax = today;

  /* ── line economics (PREVIEW of the server's arithmetic, never posted) ── */
  const lineCalc = (l: LLine) => {
    const mat = matById.get(l.material_id) || null;
    if (!mat) return { mat: null as Mat | null, recipe: 0, total: 0, perBottle: 0, priced: false };
    const recipe = tripleToRecipe(n0(l.cases), n0(l.bottles), n0(l.loose), mat);
    const pf = packFactor(mat), cf = caseFactor(mat);
    if (l.basis === 'amount') {
      const amt = n0(l.amount);
      // rate-basis: purchase — amount ÷ recipe qty is ₹/recipe-unit; × pack is
      // ₹ per purchase unit (per bottle), the figure printed beside the line.
      const perBottle = recipe > 0 ? (amt / recipe) * pf : 0;
      return { mat, recipe, total: amt, perBottle, priced: amt > 0 };
    }
    // rate-basis: purchase — the typed rate is ₹ per PURCHASE unit (bottle), or
    // ₹ per case ÷ case factor; ÷ pack gives ₹/recipe-unit, × recipe qty is ₹.
    const perBottle = l.perCase ? n0(l.price) / cf : n0(l.price);
    const unitCost = pf > 1 ? perBottle / pf : perBottle;
    return { mat, recipe, total: recipe * unitCost, perBottle, priced: n0(l.price) > 0 };
  };
  const calcs = lines.map(lineCalc);
  const invoiceValue = r2(calcs.reduce((s, c) => s + c.total, 0));
  const chargesTotal = n0(charges.mrp) + n0(charges.excise) + n0(charges.cess) + n0(charges.tcs);
  const netIndent = r2(invoiceValue + chargesTotal);
  const recordedDiscount = r2(lines.reduce((s, l) => s + n0(l.discount), 0));
  const recordedDelivery = r2(lines.reduce((s, l) => s + n0(l.delivery), 0));
  const filled = lines.filter(l => !lineIsBlank(l));
  const dupGroups = useMemo(
    () => duplicateLineGroups(lines.map(l => ({ material_id: l.material_id }))).map(g => ({
      name: matById.get(g.key)?.name || g.key, lineNos: g.lineNos,
    })),
    [lines, matById],
  );

  const setLine = (key: number, p: Partial<LLine>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...p } : l)));
  const removeLine = (key: number) => setLines(ls => {
    const next = ls.filter(l => l.key !== key);
    return next.length ? next : [newLine()];
  });

  /* ── store change: lines belong to one store ── */
  const changeStore = (id: string) => {
    if (id === storeId) return;
    if (filled.length > 0 && !window.confirm('Changing the store clears the lines on this bill — every item belongs to one store. Continue?')) return;
    setStoreId(id); setLines([newLine()]); setUnmatched([]); setSkipOk(false); setCsvNote(null); setIndentTaken('');
  };

  /* ── CSV upload ──────────────────────────────────────────────────────────
     Parse here (forgiving column names), match on the server (the same
     forgiving procure-bulk matching: SKU first, then name; the store mapping;
     cases/bottles/loose ≥ 0; a rate or an amount), APPEND the matched lines. */
  const onFile = async (f: File | null) => {
    if (!f) return;
    setErr('');
    if (!store) { fail('Pick the store first.'); return; }
    let parsed: LiquorCsvRow[];
    try {
      parsed = parseLiquorBillCsv(await f.text());
    } catch (e: unknown) { fail(`Could not read ${f.name}: ${errText(e, 'unreadable file')}`); return; }
    if (parsed.length === 0) { fail(`No data rows in ${f.name} — check it has a header row and at least one line.`); return; }

    // Only BLANK header fields and BLANK charges are filled from the sheet —
    // whatever the user already typed is a deliberate choice and wins.
    const first = (k: keyof LiquorCsvRow) => {
      const hit = parsed.find(r => String(r[k] ?? '').trim() !== '');
      return hit ? String(hit[k]).trim() : '';
    };
    const firstCharge = (k: 'mrp_round_off' | 'excise_turnover_tax' | 'special_excise_cess' | 'tcs') => {
      const hit = parsed.find(r => String(r[k] || '').trim() !== '' && n0(r[k]) !== 0);
      return hit ? String(hit[k]).trim() : '';
    };
    const ref = indent.trim() || first('inward_no');
    if (!indent.trim() && ref) setIndent(ref);
    const sheetSupplier = first('supplier_name');
    if (!supplier.trim() && sheetSupplier) setSupplier(sheetSupplier);
    const sheetDate = first('date');
    if (!dateTouched && sheetDate) setDate(sheetDate);
    setCharges(c => ({
      mrp: c.mrp.trim() || firstCharge('mrp_round_off'),
      excise: c.excise.trim() || firstCharge('excise_turnover_tax'),
      cess: c.cess.trim() || firstCharge('special_excise_cess'),
      tcs: c.tcs.trim() || firstCharge('tcs'),
    }));

    setCsvBusy(true);
    try {
      const r = await api('/api/grn/liquor-match', {
        method: 'POST',
        body: {
          store_id: store.id,
          invoice_ref: ref,
          exclude_material_ids: lines.map(l => l.material_id).filter(Boolean),
          rows: parsed.map(p => ({
            item_name: p.item_name, sku: p.sku, cases: p.cases, bottles: p.bottles, loose: p.loose,
            unit_price: p.unit_price, per_case: p.per_case, amount: p.amount,
            discount: p.discount, delivery_charges: p.delivery_charges, cgst: p.cgst, sgst: p.sgst,
            batch_no: p.batch_no, expiry_date: p.expiry_date, inward_no: p.inward_no, date: p.date,
          })),
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { fail(j?.error || `Could not match ${f.name} (HTTP ${r.status}).`); return; }
      const matchedLines: MatchedLine[] = Array.isArray(j.lines) ? j.lines : [];
      const added = matchedLines.map(m => {
        // THE SHEET'S OWN RATE, NOT A RE-DIVIDED ONE. A rate-priced row keeps the
        // figure and the per-case flag exactly as the sheet stated them, so the
        // save prices it with the same division procure-bulk did (₹/case ÷ case
        // factor ÷ pack) instead of from a per-bottle figure rounded here — on a
        // 1,000 ₹/case rate over 12 bottles that rounding is paise per line.
        const src = parsed[Number(m.row) - 1] || null;
        const rated = m.unit_price != null && Number(m.unit_price) > 0;
        const srcRated = !!src && n0(src.unit_price) > 0;
        return newLine({
          material_id: String(m.material_id),
          cases: m.cases ? String(m.cases) : '',
          bottles: m.bottles ? String(m.bottles) : '',
          loose: m.loose ? String(m.loose) : '',
          basis: rated ? 'rate' : 'amount',
          price: rated ? (srcRated ? String(src!.unit_price) : String(m.unit_price)) : '',
          perCase: rated && srcRated ? !!src!.per_case : false,
          amount: rated ? '' : (src && n0(src.amount) > 0 ? String(src.amount) : String(m.amount ?? '')),
          discount: Number(m.discount) ? String(m.discount) : '',
          delivery: Number(m.delivery_charges) ? String(m.delivery_charges) : '',
          batch: String(m.batch_no || ''), expiry: String(m.expiry_date || ''),
          csvRow: Number(m.row) || undefined, csvFile: f.name,
          notes: Array.isArray(m.notes) ? m.notes.map(String) : [],
          extrasOpen: !!(Number(m.discount) || Number(m.delivery_charges)),
        });
      });
      // APPEND — a balance file adds to the bill. The single untouched blank
      // starter line is replaced rather than left dangling above the sheet.
      setLines(ls => {
        const kept = ls.filter(l => !lineIsBlank(l));
        const next = [...kept, ...added];
        return next.length ? next : [newLine()];
      });
      const skipped: SkippedRow[] = Array.isArray(j.skipped_rows) ? j.skipped_rows : [];
      setUnmatched(skipped.map(s => ({ ...s, src: parsed[Number(s.row) - 1] || null })));
      setSkipOk(false);
      setIndentTaken(j?.indent_taken?.message ? String(j.indent_taken.message) : '');
      setCsvNote({
        fileName: f.name, parsed: parsed.length, matched: added.length,
        unitNotes: parsed.filter(p => p.unit_note && !/LOOSE/.test(p.unit_note)).map(p => `${p.item_name || p.sku}: ${p.unit_note}`),
        loose1000: parsed.filter(p => p.unit_note && /LOOSE/.test(p.unit_note)).map(p => `${p.item_name || p.sku}: ${p.unit_note}`),
      });
    } catch (e: unknown) {
      fail(errText(e, `Could not match ${f.name}.`));
    } finally {
      setCsvBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const downloadBalance = () => {
    const rows: LiquorBalanceRow[] = unmatched.map(s => ({
      row: s.src || {
        item_name: s.item_name, sku: s.sku, cases: '', bottles: '', loose: '', unit_price: '', amount: '',
        per_case: false, batch_no: '', expiry_date: '', date: '', discount: '', cgst: '', sgst: '',
        delivery_charges: '', mrp_round_off: '', excise_turnover_tax: '', special_excise_cess: '', tcs: '',
        inward_no: '', category_name: '', supplier_name: '', po_qty: '', purchase_unit: '',
        total_inward_amount: '', unit_note: '',
      },
      reason: s.reason,
    }));
    if (!rows.length) return;
    downloadText(`unmatched-liquor-rows-${indent.trim() || 'bill'}.csv`, liquorBalanceCsv(rows));
  };

  /* ── save ── */
  const save = async () => {
    setErr('');
    if (!store) { fail('Pick the store this bill is for.'); return; }
    if (!indent.trim()) { fail(`Enter the indent / invoice number — it is how ${storeName}, its reports and the duplicate check find the bill.`); return; }
    if (!supplier.trim() && !vendorId) { fail(`Enter the supplier — ${storeName}'s reports group bills by it.`); return; }
    if (date > today) { fail(`A liquor bill can't be dated ${date} — that is after today. Use the day the bottles arrived.`); return; }
    if (filled.length === 0) { fail('Add at least one line.'); return; }
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (lineIsBlank(l)) continue;
      const c = calcs[i];
      const no = `Line ${i + 1}${c.mat ? ` (${c.mat.name})` : ''}`;
      if (!c.mat) { fail(`${no}: pick the item.`); return; }
      if ([l.cases, l.bottles, l.loose].some(v => v !== '' && !(Number(v) >= 0))) { fail(`${no}: quantities must be 0 or more.`); return; }
      if (!(c.recipe > 0)) { fail(`${no}: enter a quantity — cases, bottles and/or loose.`); return; }
      if (!c.priced) { fail(`${no}: enter the rate per bottle (or per case) or the line amount.`); return; }
    }
    if (dupGroups.length > 0) {
      const g = dupGroups[0];
      fail(`${g.name} is on line ${g.lineNos.join(' and line ')}. One item = one line on a bill — put the full quantity on one line.`);
      return;
    }
    if (unmatched.length > 0 && !skipOk) {
      fail(`${unmatched.length} row${unmatched.length === 1 ? '' : 's'} of the sheet did not match — fix and upload them, add them by hand, or tick "Save without the ${unmatched.length} un-matched row${unmatched.length === 1 ? '' : 's'}" below.`);
      return;
    }
    setBusy(true);
    try {
      const payload = {
        liquor: true,
        store_id: store.id,
        date, vendor: supplier.trim(), vendor_id: vendorId || null,
        invoice_number: indent.trim(), invoice_date: invoiceDate, notes,
        liquor_charges: {
          mrp_rounding: n0(charges.mrp), excise_turnover_tax: n0(charges.excise),
          special_excise_cess: n0(charges.cess), tcs: n0(charges.tcs),
        },
        items: lines.filter(l => !lineIsBlank(l)).map(l => ({
          material_id: l.material_id,
          cases: n0(l.cases), bottles: n0(l.bottles), loose: n0(l.loose),
          ...(l.basis === 'amount'
            ? { amount: n0(l.amount) }
            : { unit_price: n0(l.price), ...(l.perCase ? { per_case: true } : {}) }),
          ...(n0(l.discount) ? { discount: n0(l.discount) } : {}),
          ...(n0(l.delivery) ? { delivery_charges: n0(l.delivery) } : {}),
          ...(l.batch.trim() ? { batch_no: l.batch.trim() } : {}),
          ...(l.expiry ? { expiry_date: l.expiry } : {}),
        })),
      };
      const r = await api('/api/grn', { method: 'POST', body: payload });
      const j = await r.json().catch(() => ({}));
      // Every refusal is shown VERBATIM — the server's sentence names the line,
      // the store and the remedy. A duplicate indent (409) is a hard refusal:
      // there is no "save anyway", so no confirm is offered.
      if (!r.ok) {
        // A duplicate indent is shown ONCE, in its own panel under the indent
        // box (the field it is about); every other refusal in the error banner.
        if (j?.duplicate_indent && j?.error) { setIndentTaken(String(j.error)); setErr(''); }
        else fail(j?.error || `Could not save this bill (HTTP ${r.status}).`);
        toTop();
        return;
      }
      setResult(j);
    } catch (e: unknown) {
      fail(errText(e, 'Could not save this bill.'));
    } finally { setBusy(false); }
  };

  /* ── render ── */
  const noStores = stores !== null && stores.length === 0;
  const kindTone = (k: string) =>
    k === 'wrong_store' || k === 'other_bill' ? 'text-blue-700'
      : k === 'duplicate' ? 'text-amber-700' : 'text-red-700';

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-start justify-center p-2 sm:p-4 overflow-y-auto">
      <div style={{ maxHeight: 'calc(100vh - 1rem)' }}
           className="bg-white rounded-xl border border-[#E8D5C4] w-full max-w-4xl shadow-xl flex flex-col overflow-hidden">
        <div className="px-4 sm:px-5 py-3 border-b border-[#E8D5C4] flex flex-nowrap items-center justify-between gap-2 shrink-0">
          <div className="min-w-0">
            <h2 className="font-bold text-[#2D1B0E] flex flex-nowrap items-center gap-2">
              <Wine className="w-5 h-5 text-[#af4408] shrink-0" />
              <span className="truncate">{result ? `Saved — ${result.grn_number}` : 'TGBCL Liquor Bill — Goods Receipt'}</span>
            </h2>
            {!result && (
              <p className="text-[11px] text-[#8B7355] mt-0.5">
                One TGBCL indent. The bottles post straight into <b>{storeName}</b> at the rate paid — never into Central Store
                stock, and no material’s average price moves.
              </p>
            )}
          </div>
          <button onClick={result ? onSaved : onClose} aria-label="Close" className="shrink-0"><X className="w-5 h-5 text-[#8B7355]" /></button>
        </div>

        <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-5 space-y-3 text-xs">
          {result ? (
            /* ── SAVED ── */
            <div className="space-y-3">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900 space-y-1.5">
                <div className="font-semibold flex items-center gap-1.5 text-sm">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  {result.grn_number}{result.invoice_id ? ` · ${result.invoice_id}` : ''} saved.
                </div>
                <div className="text-[12px] leading-snug">
                  {(() => {
                    const n = Number(result.posted) || (Array.isArray(result.lines) ? result.lines.length : 0);
                    const sName = result.store?.name || storeName;
                    return (
                      <>
                        {n} line{n === 1 ? '' : 's'} posted to <b>{sName}</b> — Invoice <b>{inr(result.invoice_value)}</b>
                        {' '}· Net Indent <b>{inr(result.bill_charges?.net_indent_value ?? result.invoice_value)}</b>.
                        {' '}Central Store stock and costs are unchanged. The bill shows on <b>Inventory → Liquor Store</b> (stock,
                        ledger, purchase and inward registers); the central Purchase Report does not list liquor bills yet.
                      </>
                    );
                  })()}
                </div>
              </div>
              {Array.isArray(result.lines) && result.lines.length > 0 && (
                <div className="border border-[#E8D5C4] rounded-lg overflow-x-auto">
                  <table className="w-full text-[11px] min-w-[420px]">
                    <thead className="bg-[#FFF1E3] text-[#6B5744]">
                      <tr>
                        <th className="text-left px-2 py-1 font-medium">Item</th>
                        <th className="text-right px-2 py-1 font-medium">Received</th>
                        <th className="text-right px-2 py-1 font-medium">Rate</th>
                        <th className="text-right px-2 py-1 font-medium">Line total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F0E4D6]">
                      {result.lines.map(ln => {
                        const m = matById.get(String(ln.material_id)) || null;
                        const pu = puOf(m);
                        const lead = m ? fmtBreakdown(Number(ln.recipe_qty) || 0, m) : null;
                        return (
                          <tr key={String(ln.ledger_id || ln.material_id)}>
                            <td className="px-2 py-1 text-[#2D1B0E]">{ln.material_name}</td>
                            <td className="px-2 py-1 text-right font-mono">
                              {lead || `${fmtQtyNum(Number(ln.purchase_qty) || 0)} ${pu}`}
                            </td>
                            <td className="px-2 py-1 text-right font-mono">{inr(ln.rate_per_bottle)} / {pu}</td>
                            <td className="px-2 py-1 text-right font-mono">{inr(ln.line_total)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : stores === null ? (
            <div className="text-[#8B7355]"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading the store locations…</div>
          ) : noStores ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 space-y-1">
              <div className="font-semibold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> No store you can receive into</div>
              <div>
                {storesErr || <>A TGBCL liquor bill posts into a store location you are allowed to receive into (Settings → Store Locations →
                user access, ‘procure’). You have none, so this bill cannot be entered from your login.</>}
              </div>
            </div>
          ) : (
            <>
              {err && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-[12px] text-red-700 flex items-start gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-px" /> <span className="whitespace-pre-line">{err}</span>
                </div>
              )}

              {/* ── header ── */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <div>
                  <L>Store</L>
                  {(stores || []).length > 1 ? (
                    <select value={storeId} onChange={e => changeStore(e.target.value)} className={inputCls}>
                      {(stores || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  ) : (
                    <div className="px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#F3EEE7] text-[#2D1B0E] font-semibold">{storeName}</div>
                  )}
                </div>
                <div>
                  <L>Indent / invoice no. <span className="text-red-600">*</span></L>
                  <input value={indent} onChange={e => { setIndent(e.target.value); if (indentTaken) setIndentTaken(''); }}
                         placeholder="the indent number on the TGBCL bill" className={inputCls} />
                </div>
                <div>
                  <L>Receipt date</L>
                  <input type="date" value={date} min={dateMin} max={dateMax}
                         onChange={e => { setDate(e.target.value); setDateTouched(true); }} className={inputCls} />
                  <div className="text-[10px] text-[#8B7355] mt-0.5">
                    The day the bottles arrived.{!isAdmin && <> Backdating limited to {backdateLimit} day(s) (admins exempt).</>} Never after today.
                  </div>
                </div>
                <div>
                  <L>Supplier <span className="text-red-600">*</span></L>
                  <input value={supplier} onChange={e => setSupplier(e.target.value)} list="liq-grn-suppliers"
                         placeholder="e.g. TGBCL depot" className={inputCls} />
                  <datalist id="liq-grn-suppliers">
                    {(store?.recent_suppliers || []).map(s => <option key={s} value={s} />)}
                  </datalist>
                </div>
                <div>
                  <L>Vendor (optional)</L>
                  <select value={vendorId} className={inputCls}
                          onChange={e => {
                            const id = e.target.value;
                            setVendorId(id);
                            const v = vendors.find(x => String(x.id) === id);
                            if (v && !supplier.trim()) setSupplier(v.name);
                          }}>
                    <option value="">—</option>
                    {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                  <div className="text-[10px] text-[#8B7355] mt-0.5">Links the bill to the vendor master. The supplier name above is what the reports print.</div>
                </div>
                <div>
                  <L>Invoice date (optional)</L>
                  <input type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} className={inputCls} />
                </div>
              </div>

              {indentTaken && (
                <div className="rounded-lg border border-red-300 bg-red-50 p-2.5 text-[12px] text-red-800 flex items-start gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                  <span><b>This indent cannot be saved again.</b> {indentTaken}</span>
                </div>
              )}

              {/* ── TGBCL CSV ── */}
              <div className="border border-[#E8D5C4] rounded-lg p-2.5 bg-[#FFF8F0]/60 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <label className={`px-3 py-1.5 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded-lg text-xs font-medium flex items-center gap-1.5 ${csvBusy || !store ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}>
                    {csvBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Upload TGBCL CSV
                    <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
                           onChange={e => void onFile(e.target.files?.[0] || null)} />
                  </label>
                  <button type="button" onClick={() => downloadText('tgbcl-liquor-bill-template.csv', liquorBillTemplateCsv(today))}
                          className="px-3 py-1.5 bg-white border border-[#E8D5C4] hover:bg-[#FFF1E3] text-[#6B5744] rounded-lg text-xs font-medium flex items-center gap-1.5">
                    <Download className="w-3.5 h-3.5" /> Template
                  </button>
                  <span className="text-[10px] text-[#8B7355] flex-1 min-w-[12rem]">
                    One file = one indent. Items match by <code>sku</code>, then <code>item_name</code>; quantity as
                    {' '}<code>cases</code> / <code>bottles</code> / <code>loose</code> (or <code>inward_qty</code> + <code>purchase_unit</code>);
                    price as <code>unit_price</code> per bottle (<code>per_case=1</code> for a case rate) or the line <code>amount</code>.
                    Matched lines are ADDED to the bill below; a blank indent, supplier, date or charge is filled from the sheet.
                  </span>
                </div>
                {csvNote && (
                  <div className="text-[11px] text-[#6B5744] space-y-1">
                    <div>
                      <b>{csvNote.fileName}</b>: {csvNote.parsed} row{csvNote.parsed === 1 ? '' : 's'} read — <b>{csvNote.matched}</b> added to the bill
                      {unmatched.length > 0 && <>, <b className="text-red-700">{unmatched.length} not matched</b></>}.
                    </div>
                    {csvNote.unitNotes.length > 0 && (
                      <div className="text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                        {csvNote.unitNotes.length} row(s) gave a quantity without a usable <code>purchase_unit</code> and were read as <b>bottles</b>:
                        {' '}{csvNote.unitNotes.slice(0, 3).join(' · ')}{csvNote.unitNotes.length > 3 ? ' …' : ''}. Check those lines below.
                      </div>
                    )}
                    {csvNote.loose1000.length > 0 && (
                      <div className="text-red-800 bg-red-50 border border-red-200 rounded px-2 py-1 font-medium">
                        ⚠ {csvNote.loose1000.length} row(s) would post ~1000× small: {csvNote.loose1000.slice(0, 3).join(' · ')}
                      </div>
                    )}
                  </div>
                )}
                {unmatched.length > 0 && (
                  <div className="border border-red-200 rounded-lg bg-white">
                    <div className="px-2.5 py-1.5 flex flex-wrap items-center justify-between gap-2 border-b border-red-100">
                      <span className="text-[11px] font-semibold text-red-800">
                        {unmatched.length} row{unmatched.length === 1 ? '' : 's'} not on this bill — fix and upload them again, or add them by hand:
                      </span>
                      <button type="button" onClick={downloadBalance}
                              className="px-2.5 py-1 bg-white border border-[#af4408] text-[#af4408] hover:bg-[#af4408]/10 rounded text-[11px] font-medium flex items-center gap-1">
                        <Download className="w-3 h-3" /> Download un-matched rows (CSV)
                      </button>
                    </div>
                    <div className="max-h-44 overflow-y-auto divide-y divide-[#F0E4D6]">
                      {unmatched.map((s, i) => (
                        <div key={i} className="px-2.5 py-1 text-[11px]">
                          <span className="text-[#8B7355]">Row {s.row}:</span>{' '}
                          <span className="font-medium text-[#2D1B0E]">{s.item_name || s.sku || '(no name)'}</span>{' — '}
                          <span className={kindTone(String(s.kind))}>{s.reason}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* ── lines ── */}
              {dupGroups.length > 0 && (
                <div className="border border-amber-400 rounded-lg bg-amber-50 p-2 text-[11px] text-amber-900">
                  <b>The same item is on more than one line:</b>{' '}
                  {dupGroups.map(g => `${g.name} (line ${g.lineNos.join(' and line ')})`).join('; ')}. One item = one line — put the full quantity on one line.
                </div>
              )}
              <div className="space-y-2">
                {lines.map((l, i) => {
                  const c = calcs[i];
                  const mat = c.mat;
                  const cf = mat ? caseFactor(mat) : 1;
                  const pu = puOf(mat);
                  return (
                    <div key={l.key} className="border border-[#E8D5C4] rounded-lg p-2.5 space-y-2 bg-[#FFFDF9]">
                      <div className="flex flex-nowrap items-center gap-2">
                        <span className="text-[10px] font-semibold text-[#8B7355] shrink-0">#{i + 1}</span>
                        <div className="flex-1 min-w-0">
                          <MaterialTypeahead materials={storeMaterials as MaterialLite[]} value={l.material_id}
                                             purchaseBasis inactive="hide" showStock={false} compact
                                             excludeIds={lines.filter(x => x.key !== l.key).map(x => x.material_id).filter(Boolean)}
                                             excludeMode="disable"
                                             onPick={id => setLine(l.key, { material_id: id, cases: '', bottles: '', loose: '', perCase: false })}
                                             placeholder={`${storeName} item — name, SKU or category…`} />
                        </div>
                        {l.csvRow ? <span className="shrink-0 text-[9px] text-[#8B7355]" title={`Row ${l.csvRow} of ${l.csvFile || 'the uploaded sheet'}`}>CSV row {l.csvRow}</span> : null}
                        <button onClick={() => removeLine(l.key)} className="shrink-0 text-[#8B7355] hover:text-red-700" title="Remove line" aria-label="Remove line">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <CBLEntry mat={mat} line={l} onChange={p => setLine(l.key, p)} />
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
                        {l.basis === 'amount' ? (
                          <div>
                            <L>Line amount ₹</L>
                            <input type="number" min={0} step="any" inputMode="decimal" value={l.amount}
                                   onChange={e => setLine(l.key, { amount: e.target.value })} placeholder="0" className={inputCls} />
                            <button type="button" onClick={() => setLine(l.key, { basis: 'rate', amount: '' })}
                                    className="text-[10px] text-[#af4408] hover:underline mt-0.5">enter a rate instead</button>
                          </div>
                        ) : (
                          <div>
                            <L>₹ / {l.perCase ? 'case' : pu}</L>
                            <div className="flex gap-1">
                              <input type="number" min={0} step="any" inputMode="decimal" value={l.price}
                                     onChange={e => setLine(l.key, { price: e.target.value })} placeholder="0" className={inputCls} />
                              {cf > 1 && (
                                <button type="button" onClick={() => setLine(l.key, { perCase: !l.perCase })}
                                        title={`Toggle the rate between per ${pu} and per case (1 case = ${fmtQtyNum(cf)} ${pu})`}
                                        className={`shrink-0 px-1.5 rounded border text-[10px] font-medium ${l.perCase
                                          ? 'bg-[#af4408] border-[#af4408] text-white' : 'bg-white border-[#E8D5C4] text-[#6B5744]'}`}>
                                  /cs
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                        <div>
                          <L>Batch no.</L>
                          <input value={l.batch} onChange={e => setLine(l.key, { batch: e.target.value })} placeholder="optional" className={inputCls} />
                        </div>
                        <div>
                          <L>Expiry</L>
                          <input type="date" value={l.expiry} onChange={e => setLine(l.key, { expiry: e.target.value })} className={inputCls} />
                        </div>
                        <div className="text-right">
                          <L>Line total</L>
                          <div className="px-2 py-1.5 text-sm font-semibold text-[#2D1B0E] font-mono">
                            {c.recipe > 0 && c.priced ? inr(c.total) : '—'}
                          </div>
                          {l.basis === 'amount' && c.recipe > 0 && c.priced && (
                            <div className="text-[9px] text-[#8B7355]">≈ {inr(c.perBottle)} / {pu}</div>
                          )}
                          {l.basis === 'rate' && l.perCase && c.priced && (
                            <div className="text-[9px] text-[#8B7355]">= {inr(c.perBottle)} / {pu}</div>
                          )}
                        </div>
                      </div>
                      {(l.notes || []).length > 0 && (
                        <div className="text-[10px] text-amber-800">{(l.notes || []).join(' · ')}</div>
                      )}
                      <button type="button" onClick={() => setLine(l.key, { extrasOpen: !l.extrasOpen })}
                              className="text-[10px] text-[#af4408] hover:underline">
                        {l.extrasOpen ? '− Hide discount / delivery' : '+ Discount / delivery (recorded only)'}
                      </button>
                      {l.extrasOpen && (
                        <div className="grid grid-cols-2 gap-2 pt-1 border-t border-[#F0E4D6]">
                          <div>
                            <L>Discount ₹</L>
                            <input type="number" min={0} step="any" inputMode="decimal" value={l.discount}
                                   onChange={e => setLine(l.key, { discount: e.target.value })} placeholder="0" className={inputCls} />
                          </div>
                          <div>
                            <L>Delivery ₹</L>
                            <input type="number" min={0} step="any" inputMode="decimal" value={l.delivery}
                                   onChange={e => setLine(l.key, { delivery: e.target.value })} placeholder="0" className={inputCls} />
                          </div>
                          <div className="col-span-2 text-[10px] text-[#8B7355]">
                            Recorded on the {storeName} ledger row only — they do not change the rate per bottle, the line total, the
                            Invoice Value or the Net Indent (the same as Liquor Store New Bill).
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                <button type="button" onClick={() => setLines(ls => [...ls, newLine()])}
                        className="w-full px-3 py-2 border border-dashed border-[#D4B896] hover:border-[#af4408] hover:text-[#af4408] text-[#6B5744] rounded-lg text-sm font-medium flex items-center justify-center gap-1.5">
                  <Plus className="w-4 h-4" /> Add line
                </button>
              </div>

              {/* ── TGBCL charges — the same four the Liquor Store recorded ── */}
              <div className="border border-[#E8D5C4] rounded-lg p-3 bg-[#FFF8F0] space-y-2">
                <div className="text-[11px] font-semibold text-[#6B5744] flex items-center gap-1.5">
                  <ReceiptText className="w-3.5 h-3.5 text-[#af4408]" />
                  TGBCL charges — enter from the bill (each varies bill-to-bill, nothing is calculated)
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div>
                    <L>MRP Rounding Off</L>
                    <input type="number" step="any" inputMode="decimal" value={charges.mrp}
                           onChange={e => setCharges(c => ({ ...c, mrp: e.target.value }))} placeholder="0" className={inputCls} />
                    <div className="text-[9px] text-[#8B7355] mt-0.5">can be negative</div>
                  </div>
                  <div>
                    <L>Bar Excise Turnover Tax</L>
                    <input type="number" min={0} step="any" inputMode="decimal" value={charges.excise}
                           onChange={e => setCharges(c => ({ ...c, excise: e.target.value }))} placeholder="0" className={inputCls} />
                  </div>
                  <div>
                    <L>Special Excise Cess</L>
                    <input type="number" min={0} step="any" inputMode="decimal" value={charges.cess}
                           onChange={e => setCharges(c => ({ ...c, cess: e.target.value }))} placeholder="0" className={inputCls} />
                  </div>
                  <div>
                    <L>TCS</L>
                    <input type="number" min={0} step="any" inputMode="decimal" value={charges.tcs}
                           onChange={e => setCharges(c => ({ ...c, tcs: e.target.value }))} placeholder="0" className={inputCls} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs pt-1.5 border-t border-[#F0E4D6]">
                  <span className="text-[#6B5744]">Invoice Value (Σ lines) <b className="text-[#2D1B0E] font-mono">{inr(invoiceValue)}</b></span>
                  <span className="text-[#6B5744]">+ charges <b className="text-[#2D1B0E] font-mono">{inr(chargesTotal)}</b></span>
                  <span className="text-[#6B5744]">Net Indent Value <b className="text-[#af4408] text-sm font-mono">{inr(netIndent)}</b></span>
                </div>
                {(recordedDiscount > 0 || recordedDelivery > 0) && (
                  <div className="text-[10px] text-[#8B7355] flex items-start gap-1">
                    <Info className="w-3 h-3 shrink-0 mt-px" />
                    <span>
                      Also recorded on the lines, outside the Net Indent: discount {inr(recordedDiscount)}
                      {recordedDelivery > 0 ? <>, delivery {inr(recordedDelivery)}</> : null}. The {storeName} inward register takes each
                      line’s discount off and adds its delivery in its Total Inward column, so its total can differ from the Net Indent by
                      those amounts.
                    </span>
                  </div>
                )}
                <div className="text-[10px] text-[#8B7355]">No GST on liquor — none is recorded on these lines.</div>
              </div>

              <div>
                <L>Notes</L>
                <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="optional"
                          className="w-full px-2 py-1.5 border border-[#E8D5C4] rounded text-sm bg-[#FFF8F0]" />
              </div>

              {unmatched.length > 0 && (
                <label className="flex items-start gap-2 text-[12px] text-red-800 bg-red-50 border border-red-200 rounded-lg p-2.5 cursor-pointer">
                  <input type="checkbox" checked={skipOk} onChange={e => setSkipOk(e.target.checked)} className="mt-0.5 accent-red-700" />
                  <span>Save without the {unmatched.length} un-matched row{unmatched.length === 1 ? '' : 's'} — they will NOT be on this bill.</span>
                </label>
              )}
            </>
          )}
        </div>

        <div className="px-4 sm:px-5 py-3 border-t border-[#E8D5C4] flex flex-wrap items-center justify-end gap-2 shrink-0 bg-white">
          {result ? (
            <>
              <a href="/inventory/liquor-store"
                 className="px-3 py-1.5 text-sm rounded-lg border border-[#E8D5C4] text-[#6B5744] hover:border-[#af4408] hover:text-[#af4408] flex items-center gap-1.5">
                <Wine className="w-4 h-4" /> Open Liquor Store
              </a>
              <button onClick={onSaved} className="px-3 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white text-sm rounded-lg">Done</button>
            </>
          ) : (
            <>
              {!noStores && stores !== null && (
                <span className="mr-auto text-[12px] text-[#6B5744]">
                  {filled.length} line{filled.length === 1 ? '' : 's'} · Net Indent <b className="text-[#af4408] font-mono">{inr(netIndent)}</b>
                </span>
              )}
              <button onClick={onClose} disabled={busy} className="px-3 py-1.5 text-sm text-[#6B5744] disabled:opacity-50">Cancel</button>
              {!noStores && stores !== null && (
                <button onClick={save} disabled={busy || csvBusy || !store || (unmatched.length > 0 && !skipOk)}
                        title={unmatched.length > 0 && !skipOk
                          ? 'Some sheet rows did not match — tick "Save without …" to save the bill without them.'
                          : `Record this TGBCL bill and post the bottles into ${storeName}`}
                        className="px-4 py-1.5 bg-[#af4408] hover:bg-[#8a3506] text-white rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {busy ? 'Saving…' : `Save & post to ${storeName}`}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
