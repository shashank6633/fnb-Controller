'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WhatsApp TEMPLATE STUDIO — the operator face of src/lib/wa-template-authoring.ts.
 *
 * Lives inside Settings → Integrations → WhatsApp → Templates (a tab, not a new
 * page: templates already had a home there, and splitting "local templates" from
 * "Meta templates" across two screens would leave an admin guessing which list
 * their notification actually reads).
 *
 * WHAT IT HAS TO GET RIGHT
 *   • THE REJECTION REASON IS THE POINT. When Meta refuses a template it says
 *     why, and that sentence is the only thing that tells an admin what to fix.
 *     It is rendered VERBATIM, inline on the row, never behind a click.
 *   • HONEST STATUS. A chip says what the lifecycle actually knows, including
 *     "never checked" — a green tick on an unverified guess is worse than no
 *     tick at all. The last-checked time sits next to every managed status.
 *   • {{n}} NUMBERING SURVIVES EDITING. Meta's body variables are positional and
 *     must run 1..n with no gaps; deleting the middle one has to renumber the
 *     text AND carry each variable's name/example with it, or the message that
 *     reaches the guest has the wrong words in the wrong holes.
 *   • EXAMPLES ARE MANDATORY. Meta rejects a submission whose placeholders have
 *     no example values, and the rejection does not say which one was missing —
 *     so the example field is required here, before the review cycle is spent.
 *   • CONSEQUENCES BEFORE ACTIONS. Submit, edit-at-Meta and delete each state
 *     what Meta will and will not allow afterwards, and delete lists the
 *     campaigns that depend on the template first.
 *
 * The server is the authority for every rule this screen shows. Validation is
 * re-run by the API (validate_only / submit) and the broadcast gate re-checks
 * status at create AND on every drain pass — this component's job is to stop an
 * admin walking into those refusals blind.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus, Pencil, Trash2, Eye, Send, Loader2, RefreshCw, AlertTriangle, X,
  CheckCircle2, Clock, Ban, HelpCircle, ChevronDown, ChevronRight, Info,
  MessageSquare, Link2, Phone, CornerUpLeft, ShieldAlert, Undo2,
} from 'lucide-react';
import { api } from '@/lib/api';

/* ═══════════════════════ types (mirror the API) ═══════════════════════ */

export interface WaTemplate {
  id: string; name: string; category: string; language: string;
  body: string; is_active: number; created_at: string; updated_at: string;
  send_as_template?: number;
  provider_template_name?: string;
  provider_language?: string;
  param_order?: string;
  /* lifecycle (additive; '' on every pre-existing row) */
  meta_template_id?: string;
  meta_status?: string;
  meta_category?: string;
  meta_components?: string;
  meta_rejected_reason?: string;
  meta_last_error?: string;
  meta_submitted_at?: string;
  meta_status_checked_at?: string;
  var_spec?: string;
}

interface CampaignRef { id: string; name: string; state: string }

interface VarRow { index: number; name: string; example: string }
interface Btn { type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER'; text: string; url: string; phone_number: string }

interface Editor {
  id?: string;
  /** 'meta' = authoring for Meta approval; 'local' = today's free-form row. */
  mode: 'local' | 'meta';
  name: string;
  category: string;        // local vocabulary (notification|marketing|approval|general)
  language: string;        // Meta language code in meta mode; local label otherwise
  metaCategory: string;    // MARKETING | UTILITY | AUTHENTICATION
  body: string;
  header: string;
  headerExample: string;
  footer: string;
  buttons: Btn[];
  vars: VarRow[];
  isActive: boolean;
  sendAsTemplate: boolean;
  providerTemplateName: string;
  providerLanguage: string;
  paramOrder: string;
  /* read-only lifecycle context for the row being edited */
  metaStatus: string;
  metaTemplateId: string;
  rejectedReason: string;
  lastError: string;
}

/* ═══════════════════════ status vocabulary ═══════════════════════ */

const LOCAL_ONLY = '__local__';

const STATUS: Record<string, { label: string; chip: string; hint: string }> = {
  [LOCAL_ONLY]: {
    label: 'Local only',
    chip: 'bg-stone-100 text-stone-700 border-stone-300',
    hint: "Not registered with WhatsApp from here. It is used for plain replies inside the guest's 24-hour reply window, or sent under a template name you typed in yourself. Fill in the Meta category field in the editor to send it for approval.",
  },
  draft: {
    label: 'Draft',
    chip: 'bg-slate-100 text-slate-700 border-slate-300',
    hint: 'Authored here and never sent to Meta. Broadcasts refuse it — submit it and wait for approval.',
  },
  pending: {
    label: 'Pending review',
    chip: 'bg-amber-100 text-amber-900 border-amber-300',
    hint: 'Sent to WhatsApp and waiting. Approval usually takes minutes but can take much longer. You can still use it — if WhatsApp has not approved it yet it turns the message down itself, so no guest is contacted and nothing is charged.',
  },
  approved: {
    label: 'Approved',
    chip: 'bg-emerald-100 text-emerald-800 border-emerald-300',
    hint: 'Meta has approved this template. It can be used for broadcasts and proactive notifications — until Meta pauses it on quality signals.',
  },
  rejected: {
    label: 'Rejected',
    chip: 'bg-red-100 text-red-800 border-red-300',
    hint: 'Meta refused it. Its reason is shown verbatim below — fix that and resubmit.',
  },
  paused: {
    label: 'Paused by Meta',
    chip: 'bg-orange-100 text-orange-900 border-orange-300',
    hint: 'WhatsApp has put this on hold — that usually happens when guests block or report messages. It will not go out while it is on hold, so sort out the reason before you rely on it.',
  },
  disabled: {
    label: 'Disabled',
    chip: 'bg-zinc-200 text-zinc-800 border-zinc-400',
    hint: 'WhatsApp has switched this off, or it has been deleted there. It will not go out until it is approved again.',
  },
  unknown_at_meta: {
    label: 'Not at Meta',
    chip: 'bg-rose-100 text-rose-800 border-rose-300',
    hint: "Submitted from here, but Meta's template list does not contain it. It may have been deleted at Meta, or submitted against a different WhatsApp Business Account.",
  },
};

const statusKey = (t: WaTemplate) => (String(t.meta_status || '').trim() || LOCAL_ONLY);
const isManaged = (t: WaTemplate) => statusKey(t) !== LOCAL_ONLY;

/**
 * THE SERVER BROKE AND DID NOT SAY WHY.
 *
 * Every call on this screen reads `j.error` first — the API's own plain sentence,
 * which is usually the whole point of the refusal. This is only the fallback for a
 * response that carries no readable error at all (a crash, a proxy page, a dropped
 * connection). "HTTP 500" is not something a restaurant owner can act on, so the
 * status code goes to the console for us and he gets words he can use.
 *
 * It deliberately does NOT say "nothing was saved". The same fallback covers
 * sending a template to WhatsApp and refreshing every status — either may well
 * have landed before the response broke — and a false all-clear is the exact class
 * of claim this screen was just cleaned of. Say what to do instead: look.
 */
function serverTrouble(status: number, what: string): string {
  console.error(`[WhatsApp templates] ${what} failed with HTTP ${status}`);
  return 'Something went wrong at our end. Reload this page to see where things stand, then try again.';
}

const META_CATEGORY_NOTE: Record<string, string> = {
  MARKETING: 'Offers, invitations, anything promotional. Roughly 7× the price of UTILITY per conversation — and the only category a broadcast may use.',
  UTILITY: 'A follow-up to something the guest did: an order update, a booking confirmation, a receipt. Cheapest, but Meta rejects promotional wording here.',
  AUTHENTICATION: 'One-time passcodes only. Meta enforces a fixed shape and will reject ordinary text.',
};

/* ═══════════════════════ small helpers ═══════════════════════ */

/** UTC 'YYYY-MM-DD HH:MM:SS' (what the lifecycle stores) → IST, readable. */
function istDateTime(s: string | null | undefined): string {
  if (!s) return '—';
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(s);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

const LIMIT_BODY = 1024;
const LIMIT_HEADER = 60;
const LIMIT_FOOTER = 60;
const LIMIT_BUTTON = 25;

const NAME_RE = /^[a-z0-9_]{1,512}$/;
const LANG_RE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

/** Variable names a BROADCAST can actually fill. Anything else is fine for a
 *  notification template but gets dropped by the campaign wizard. */
const BROADCAST_FILLABLE = ['name', 'venue', 'phone'];

/* ── {{n}} machinery — the part that must stay correct ──────────────────── */

const TOKEN_G = /\{\{\s*(\d+)\s*\}\}/g;

function usedIndices(body: string): number[] {
  const set = new Set<number>();
  for (const m of String(body || '').matchAll(TOKEN_G)) set.add(Number(m[1]));
  return [...set].sort((a, b) => a - b);
}

/** Variable ROWS follow the body: one per {{n}} the text actually uses, keeping
 *  whatever name/example that number already carried. */
function reconcileVars(body: string, vars: VarRow[]): VarRow[] {
  const by = new Map(vars.map(v => [v.index, v]));
  return usedIndices(body).map(i => ({
    index: i,
    name: by.get(i)?.name ?? '',
    example: by.get(i)?.example ?? '',
  }));
}

/**
 * Renumber every placeholder to its ORDER OF FIRST APPEARANCE, carrying each
 * variable's name and example along with it.
 *
 * This is the one function that keeps {{n}} honest. Meta requires 1..n with no
 * gaps; deleting the middle variable of three, or inserting one before the
 * others, would otherwise leave {{1}},{{3}} (a rejection) or leave {{2}}'s
 * example attached to what is now {{3}} — the wrong word in the wrong hole,
 * which Meta happily approves and the guest reads.
 */
function normalizeVars(body: string, vars: VarRow[]): { body: string; vars: VarRow[] } {
  const order: number[] = [];
  for (const m of String(body || '').matchAll(TOKEN_G)) {
    const n = Number(m[1]);
    if (!order.includes(n)) order.push(n);
  }
  const remap = new Map<number, number>();
  order.forEach((old, i) => remap.set(old, i + 1));
  const nextBody = String(body || '').replace(TOKEN_G, (whole, d) => {
    const to = remap.get(Number(d));
    return to ? `{{${to}}}` : whole;
  });
  const by = new Map(vars.map(v => [v.index, v]));
  const nextVars = order.map((old, i) => ({
    index: i + 1,
    name: by.get(old)?.name ?? '',
    example: by.get(old)?.example ?? '',
  }));
  return { body: nextBody, vars: nextVars };
}

/** Insert the next placeholder at the caret, then renumber by appearance. */
function insertVariable(body: string, caret: number, vars: VarRow[]) {
  const next = (usedIndices(body).pop() ?? 0) + 1;
  const at = Math.max(0, Math.min(caret, body.length));
  const merged = body.slice(0, at) + `{{${next}}}` + body.slice(at);
  const out = normalizeVars(merged, [...vars, { index: next, name: '', example: '' }]);
  const close = out.body.indexOf('}}', at);
  return { ...out, caret: close >= 0 ? close + 2 : out.body.length };
}

/** Remove one placeholder (and the space that led into it), then renumber. */
function removeVariable(body: string, vars: VarRow[], idx: number) {
  const stripped = String(body || '').replace(new RegExp(`[ \\t]*\\{\\{\\s*${idx}\\s*\\}\\}`, 'g'), '');
  return normalizeVars(stripped, vars.filter(v => v.index !== idx));
}

/** Body with every {{n}} replaced by its example — what the guest will read. */
function renderWithExamples(body: string, vars: VarRow[]): string {
  const by = new Map(vars.map(v => [v.index, v.example]));
  return String(body || '').replace(TOKEN_G, (whole, d) => {
    const ex = by.get(Number(d));
    return ex ? ex : whole;
  });
}

/* ── WhatsApp's own *bold* / _italic_ / ~strike~, rendered as nodes ─────── */

function waText(s: string): React.ReactNode[] {
  const parts = String(s).split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g);
  return parts.map((p, i) => {
    if (p.length > 2 && p.startsWith('*') && p.endsWith('*')) return <b key={i}>{p.slice(1, -1)}</b>;
    if (p.length > 2 && p.startsWith('_') && p.endsWith('_')) return <i key={i}>{p.slice(1, -1)}</i>;
    if (p.length > 2 && p.startsWith('~') && p.endsWith('~')) return <s key={i}>{p.slice(1, -1)}</s>;
    return <span key={i}>{p}</span>;
  });
}

/* ═══════════════════════ presentational bits ═══════════════════════ */

function StatusChip({ t }: { t: WaTemplate }) {
  const k = statusKey(t);
  const s = STATUS[k] || { label: k, chip: 'bg-stone-100 text-stone-700 border-stone-300', hint: `Status "${k}" reported by Meta.` };
  return (
    <span title={s.hint}
          className={`text-[10px] px-1.5 py-0.5 rounded-full border inline-flex items-center gap-1 ${s.chip}`}>
      {k === 'approved' ? <CheckCircle2 size={9} />
        : k === 'pending' ? <Clock size={9} />
        : k === 'rejected' || k === 'unknown_at_meta' ? <Ban size={9} />
        : k === 'paused' || k === 'disabled' ? <AlertTriangle size={9} />
        : <HelpCircle size={9} />}
      {s.label}
    </span>
  );
}

function CharCount({ n, max }: { n: number; max: number }) {
  const over = n > max;
  return (
    <span className={`text-[10px] tabular-nums ${over ? 'text-red-600 font-semibold' : n > max * 0.9 ? 'text-amber-700' : 'text-[#8B7355]'}`}>
      {n}/{max}{over ? ' — Meta will refuse this' : ''}
    </span>
  );
}

/** The guest's view: an INCOMING WhatsApp bubble (white, left), because that is
 *  what the person receiving the template actually sees on their phone. */
function WhatsAppPreview({
  header, body, footer, buttons,
}: { header: string; body: string; footer: string; buttons: Btn[] }) {
  const time = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
  return (
    <div className="rounded-xl p-3 bg-[#E5DDD5] border border-[#D6CCC2]">
      <div className="max-w-[19rem] rounded-lg rounded-tl-none bg-white shadow-sm overflow-hidden">
        <div className="px-2.5 pt-2 pb-1.5">
          {header.trim() && (
            <div className="text-[13px] font-semibold text-[#111B21] mb-1 break-words whitespace-pre-wrap">
              {waText(header)}
            </div>
          )}
          <div className="text-[13px] leading-snug text-[#111B21] break-words whitespace-pre-wrap">
            {body.trim() ? waText(body) : <span className="italic text-[#8696A0]">Your message text appears here.</span>}
          </div>
          {footer.trim() && (
            <div className="text-[11px] text-[#8696A0] mt-1.5 break-words whitespace-pre-wrap">{waText(footer)}</div>
          )}
          <div className="text-[10px] text-[#8696A0] text-right mt-0.5">{time}</div>
        </div>
        {buttons.length > 0 && (
          <div className="border-t border-[#E9EDEF]">
            {buttons.map((b, i) => (
              <div key={i}
                   className={`flex items-center justify-center gap-1.5 py-2 text-[13px] text-[#027EB5] ${i ? 'border-t border-[#E9EDEF]' : ''}`}>
                {b.type === 'URL' ? <Link2 size={12} /> : b.type === 'PHONE_NUMBER' ? <Phone size={12} /> : <CornerUpLeft size={12} />}
                {b.text.trim() || <span className="italic text-[#8696A0]">Button text</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="text-[10px] text-[#5B5148] mt-2">
        Rendered with your example values — this is what the guest reads. Meta shows the same
        preview to its reviewer, which is why the examples have to be realistic.
      </p>
    </div>
  );
}

/* ═══════════════════════ the studio ═══════════════════════ */

export default function TemplateStudio({ onError, onOk }: {
  onError: (m: string | null) => void;
  onOk: (m: string | null) => void;
}) {
  const [templates, setTemplates] = useState<WaTemplate[]>([]);
  const [usage, setUsage] = useState<Record<string, CampaignRef[]>>({});
  const [syncedAt, setSyncedAt] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncReport, setSyncReport] = useState<any>(null);
  /** The dry run: Meta's real answer, nothing written. See syncPreflight(). */
  const [preflight, setPreflight] = useState<any>(null);
  const [checking, setChecking] = useState(false);
  const [editing, setEditing] = useState<Editor | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; errors: string[] } | null>(null);
  const [submitErrors, setSubmitErrors] = useState<string[]>([]);
  const [alsoMeta, setAlsoMeta] = useState(false);
  const [confirm, setConfirm] = useState<null | { kind: 'submit' | 'resubmit' | 'edit_at_meta' | 'delete'; tpl: WaTemplate }>(null);
  /**
   * A SAVE THAT WOULD CHANGE WHAT THE BLANKS MEAN, held for confirmation.
   *
   * Re-ordering the variables of a template Meta has already approved leaves the
   * approval, the name and the status exactly as they are and changes what every
   * guest reads. The server refuses such a save until it is confirmed and names
   * the campaigns it would change; this is where the owner sees that.
   */
  const [meaningWarn, setMeaningWarn] = useState<null | {
    message: string; from: string[]; to: string[]; campaigns: CampaignRef[];
  }>(null);
  /** The refresh was rolled back because it would have stopped everything. */
  const [stopAll, setStopAll] = useState<null | { message: string; stopped: any[] }>(null);
  const [undoable, setUndoable] = useState<{ available: boolean; taken_at: string }>({ available: false, taken_at: '' });

  const reload = useCallback(async () => {
    try {
      const r = await fetch('/api/whatsapp/templates');
      const j = await r.json().catch(() => ({}));
      if (j?.error) { onError(j.error); return; }
      setTemplates(Array.isArray(j.templates) ? j.templates : []);
      setUsage(j.usage && typeof j.usage === 'object' ? j.usage : {});
      setSyncedAt(String(j.synced_at || ''));
    } catch {
      onError('Could not load templates.');
    } finally { setLoaded(true); }
  }, [onError]);

  /* CAN THE LAST REFRESH STILL BE PUT BACK? Asked on load as well as after a
   * refresh, so the way out survives a page reload — the owner may only realise
   * something stopped after he goes looking at Broadcasts. */
  useEffect(() => {
    fetch('/api/whatsapp/templates/sync')
      .then(r => r.json())
      .then(d => { if (d?.undo) setUndoable({ available: !!d.undo.available, taken_at: String(d.undo.taken_at || '') }); })
      .catch(() => {});
  }, []);

  useEffect(() => { reload(); }, [reload]);

  /* campaigns that depend on a template, by both names it can be reached by */
  const campaignsFor = useCallback((t: WaTemplate) => {
    const byName = usage[t.name] || [];
    const prov = String(t.provider_template_name || '').trim();
    const byProvider = prov && prov !== t.name ? (usage[prov] || []) : [];
    return { byName, byProvider };
  }, [usage]);

  /* ── open the editor ── */
  const openNew = () => {
    setCheckResult(null);
    setEditing({
      mode: 'meta', name: '', category: 'marketing', language: 'en',
      metaCategory: 'MARKETING', body: '', header: '', headerExample: '', footer: '',
      buttons: [], vars: [], isActive: true,
      sendAsTemplate: true, providerTemplateName: '', providerLanguage: '', paramOrder: '',
      metaStatus: '', metaTemplateId: '', rejectedReason: '', lastError: '',
    });
    setPreviewId(null);
  };

  const openEdit = (t: WaTemplate) => {
    // header / footer / buttons live in meta_components between edits — read
    // them back so an edit does not silently drop the parts the body cannot hold.
    let header = '', headerExample = '', footer = '';
    const buttons: Btn[] = [];
    try {
      const comps = JSON.parse(String(t.meta_components || '[]'));
      if (Array.isArray(comps)) {
        for (const c of comps) {
          const type = String(c?.type || '').toUpperCase();
          if (type === 'HEADER' && String(c?.format || 'TEXT').toUpperCase() === 'TEXT') {
            header = String(c?.text || '');
            const ex = c?.example?.header_text;
            if (Array.isArray(ex) && ex.length) headerExample = String(ex[0] ?? '');
          } else if (type === 'FOOTER') {
            footer = String(c?.text || '');
          } else if (type === 'BUTTONS' && Array.isArray(c?.buttons)) {
            for (const b of c.buttons) {
              buttons.push({
                type: (String(b?.type || 'QUICK_REPLY').toUpperCase() as Btn['type']),
                text: String(b?.text || ''),
                url: String(b?.url || ''),
                phone_number: String(b?.phone_number || ''),
              });
            }
          }
        }
      }
    } catch { /* unreadable components — edit from the body alone */ }

    let vars: VarRow[] = [];
    try {
      const parsed = JSON.parse(String(t.var_spec || '[]'));
      if (Array.isArray(parsed)) {
        vars = parsed
          .map((v: any) => ({ index: Number(v?.index), name: String(v?.name ?? ''), example: String(v?.example ?? '') }))
          .filter((v: VarRow) => Number.isFinite(v.index));
      }
    } catch { /* fall through to reconcile */ }
    vars = reconcileVars(t.body || '', vars);

    const metaCat = String(t.meta_category || '').trim().toUpperCase();
    setCheckResult(null);
    setEditing({
      id: t.id,
      mode: metaCat ? 'meta' : 'local',
      name: t.name,
      category: t.category || 'general',
      language: (metaCat ? (t.provider_language || t.language) : t.language) || 'en',
      metaCategory: metaCat || 'MARKETING',
      body: t.body || '',
      header, headerExample, footer, buttons, vars,
      isActive: t.is_active !== 0,
      sendAsTemplate: !!t.send_as_template,
      providerTemplateName: String(t.provider_template_name || ''),
      providerLanguage: String(t.provider_language || ''),
      paramOrder: String(t.param_order || ''),
      metaStatus: String(t.meta_status || ''),
      metaTemplateId: String(t.meta_template_id || ''),
      rejectedReason: String(t.meta_rejected_reason || ''),
      lastError: String(t.meta_last_error || ''),
    });
    setPreviewId(null);
  };

  /* ── save ── */
  const save = async (opts: { confirmMeaning?: boolean } = {}): Promise<string | null> => {
    if (!editing) return null;
    setBusy(true); onError(null); onOk(null);
    if (!opts.confirmMeaning) setMeaningWarn(null);
    try {
      const isNew = !editing.id;
      const base: any = {
        id: editing.id,
        name: editing.name.trim(),
        category: editing.category || 'general',
        body: editing.body,
        is_active: editing.isActive,
      };
      let payload: any;
      if (editing.mode === 'meta') {
        payload = {
          ...base,
          language: editing.language.trim(),
          meta_category: editing.metaCategory,
          // A managed template's identity at Meta IS its name, so the provider
          // routing columns are derived here, never typed twice.
          provider_template_name: editing.name.trim(),
          provider_language: editing.language.trim(),
          send_as_template: editing.sendAsTemplate ? 1 : 0,
          header: editing.header,
          header_example: editing.headerExample,
          footer: editing.footer,
          buttons: editing.buttons.map(b => ({
            type: b.type, text: b.text,
            ...(b.type === 'URL' ? { url: b.url } : {}),
            ...(b.type === 'PHONE_NUMBER' ? { phone_number: b.phone_number } : {}),
          })),
          var_spec: editing.vars,
          // param_order is DERIVED server-side from var_spec — never sent here,
          // so the wizard and the submitted template cannot disagree.
        };
      } else {
        // Legacy free-form row: EXACTLY the payload this screen always sent.
        payload = {
          ...base,
          language: editing.language.trim() || 'en',
          send_as_template: editing.sendAsTemplate ? 1 : 0,
          provider_template_name: editing.providerTemplateName.trim(),
          provider_language: editing.providerLanguage.trim(),
          param_order: editing.paramOrder.trim(),
        };
      }
      if (opts.confirmMeaning) payload.confirm_meaning_change = true;
      const r = await api('/api/whatsapp/templates', { method: isNew ? 'POST' : 'PUT', body: payload });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        /* THE MEANING OF THE BLANKS WOULD CHANGE — not an error to dismiss, a
         * decision to take with the consequences in front of you. */
        if (r.status === 409 && j?.needs_confirmation && j?.meaning_change) {
          setMeaningWarn({
            message: String(j.error || ''),
            from: Array.isArray(j.meaning_change?.from) ? j.meaning_change.from : [],
            to: Array.isArray(j.meaning_change?.to) ? j.meaning_change.to : [],
            campaigns: Array.isArray(j.campaigns) ? j.campaigns : [],
          });
          return null;
        }
        onError([j.error, ...(Array.isArray(j.errors) ? j.errors : [])].filter(Boolean).join(' • ') || serverTrouble(r.status, 'saving the template'));
        return null;
      }
      setMeaningWarn(null);
      onOk(j?.warning
        ? `✓ ${j.warning}`
        : isNew
          ? (editing.mode === 'meta' ? '✓ Saved as a draft here. Nothing has been sent to Meta yet.' : '✓ Template created.')
          : '✓ Template saved.');
      await reload();
      return String(j?.template?.id || editing.id || '');
    } finally { setBusy(false); }
  };

  /* ── validate without writing anything ── */
  const check = async () => {
    if (!editing) return;
    setBusy(true); onError(null); onOk(null); setCheckResult(null);
    try {
      const r = await api('/api/whatsapp/templates', {
        method: 'POST',
        body: {
          validate_only: true,
          name: editing.name.trim(),
          body: editing.body,
          language: editing.language.trim(),
          meta_category: editing.metaCategory,
          provider_language: editing.language.trim(),
          header: editing.header,
          header_example: editing.headerExample,
          footer: editing.footer,
          buttons: editing.buttons.map(b => ({
            type: b.type, text: b.text,
            ...(b.type === 'URL' ? { url: b.url } : {}),
            ...(b.type === 'PHONE_NUMBER' ? { phone_number: b.phone_number } : {}),
          })),
          var_spec: editing.vars,
        },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok && !Array.isArray(j?.errors)) { onError(j.error || serverTrouble(r.status, 'checking the template')); return; }
      setCheckResult({ ok: !!j.ok, errors: Array.isArray(j.errors) ? j.errors : [] });
    } finally { setBusy(false); }
  };

  /* ── submit / edit at Meta ── */
  const doSubmit = async (t: WaTemplate, mode: 'submit' | 'edit') => {
    setBusy(true); onError(null); onOk(null); setSubmitErrors([]);
    try {
      const r = await api('/api/whatsapp/templates/submit', { method: 'POST', body: { id: t.id, mode } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        onError(j.error || serverTrouble(r.status, 'sending the template to WhatsApp'));
        if (Array.isArray(j.errors)) setSubmitErrors(j.errors);
        return;
      }
      onOk(j.note || '✓ Sent to Meta.');
      setConfirm(null);
      await reload();
    } finally { setBusy(false); }
  };

  /* ── STEP 1: what would a refresh do? Reads Meta, writes nothing. ──
   *
   * Every template here can be used today for one reason: Meta's list has never
   * been pulled, so nothing can prove a name is unapproved. The first refresh
   * takes that reason away from all of them at once — so the answer is shown
   * BEFORE anything is written, with the affected templates named. */
  const checkFirst = async () => {
    setChecking(true); onError(null); onOk(null); setSyncReport(null); setPreflight(null); setStopAll(null);
    try {
      const r = await api('/api/whatsapp/templates/sync?preview=1', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) { onError(j.error || serverTrouble(r.status, 'the pre-check with WhatsApp')); return; }
      setPreflight(j);
    } finally { setChecking(false); }
  };

  /* ── STEP 2: the real refresh (writes statuses + adoptions) ──
   *
   * `confirmStops` is NOT passed on the first press even though the card has just
   * named the losses: the refresh re-reads Meta, and the answer it writes is the
   * one it gets THEN. If that answer would stop every message this venue can
   * send, it rolls itself back and says so — including when the card, reading a
   * list a minute older, showed something milder. The second press is the one that
   * carries the confirmation. */
  const sync = async (confirmStops = false) => {
    setSyncing(true); onError(null); onOk(null); setSyncReport(null); setStopAll(null);
    try {
      const r = await api('/api/whatsapp/templates/sync', {
        method: 'POST', body: { confirm_stops: !!confirmStops },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        if (r.status === 409 && j?.needs_confirmation) {
          setPreflight(null);
          setStopAll({ message: String(j.error || ''), stopped: Array.isArray(j.stopped) ? j.stopped : [] });
          return;
        }
        onError(j.error || serverTrouble(r.status, 'the status refresh'));
        return;
      }
      setPreflight(null);
      setSyncReport(j);
      setUndoable({ available: !!j.undo_available, taken_at: String(j.checked_at || '') });
      onOk(`✓ Checked ${j.fetched} template(s) at Meta.`);
      await reload();
    } finally { setSyncing(false); }
  };

  /* ── PUT IT BACK. The refresh is the one press here that changes what the whole
   * venue can send, and until this existed nothing in the app could reverse it. */
  const undoSync = async () => {
    setSyncing(true); onError(null); onOk(null);
    try {
      const r = await api('/api/whatsapp/templates/sync?undo=1', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) { onError(j.error || serverTrouble(r.status, 'putting the last refresh back')); return; }
      setSyncReport(null);
      setUndoable({ available: false, taken_at: '' });
      onOk(`✓ ${j.note || 'Put back.'}`);
      await reload();
    } finally { setSyncing(false); }
  };

  /* ── delete ── */
  const doDelete = async (t: WaTemplate) => {
    setBusy(true); onError(null); onOk(null);
    try {
      const r = await api(`/api/whatsapp/templates?id=${encodeURIComponent(t.id)}${alsoMeta ? '&at_meta=1' : ''}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { onError([j.error, j.note].filter(Boolean).join(' ') || serverTrouble(r.status, 'deleting the template')); return; }
      onOk(j.note ? `✓ Deleted. ${j.note}` : '✓ Template deleted.');
      setConfirm(null); setAlsoMeta(false);
      await reload();
    } finally { setBusy(false); }
  };

  const toggleActive = async (t: WaTemplate) => {
    setBusy(true); onError(null);
    try {
      const r = await api('/api/whatsapp/templates', { method: 'PUT', body: { id: t.id, is_active: !t.is_active } });
      if (!r.ok) { const j = await r.json().catch(() => ({})); onError(j.error || serverTrouble(r.status, 'switching the template on or off')); return; }
      await reload();
    } finally { setBusy(false); }
  };

  const managedCount = templates.filter(isManaged).length;

  return (
    <div className="space-y-4">
      {/* ── header + sync ─────────────────────────────────────────────── */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-[#2D1B0E]">Message templates</h2>
          <div className="ml-auto flex items-center gap-1.5 flex-wrap">
            <button onClick={checkFirst} disabled={checking || syncing}
                    title="Ask Meta what it holds for every template here, and show what a refresh would change — nothing is saved by this"
                    className="inline-flex items-center gap-1 px-2.5 py-1 border border-[#D4B896] rounded text-xs text-[#6B5744] hover:bg-[#FFF1E3] disabled:opacity-50">
              {checking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh status
            </button>
            <button onClick={openNew}
                    className="inline-flex items-center gap-1 px-2.5 py-1 bg-[#af4408] hover:bg-[#933807] text-white text-xs rounded">
              <Plus size={12} /> New template
            </button>
          </div>
        </div>

        {/* WHAT THIS SCREEN IS ALLOWED TO CLAIM.
            The 2026-09-15 ruling made WhatsApp's answer ADVISORY: not approved, still
            under review, turned down, on hold, or absent from the list all return
            ok:true with a warning. So a subtitle promising that "broadcasts refuse
            anything Meta has not approved" describes a design this app no longer has.
            The one message still held back is a draft — never sent for approval — and
            that is this app's own record of an unfinished action, not WhatsApp's
            opinion, so it is named rather than hidden. */}
        <p className="text-xs text-[#8B7355]">
          A template is the only message WhatsApp will deliver to a guest outside the 24-hour reply
          window — and WhatsApp has to approve it first. Write it here, send it for approval, and watch
          what WhatsApp says about it. What WhatsApp says does not stop you sending: if it has not
          approved a message it turns that message down itself, so no guest is contacted and nothing is
          charged. What this app does hold back is a message you have never sent for approval at all,
          and a campaign whose wording does not match what WhatsApp actually holds.
        </p>

        <div className={`text-[11px] rounded p-2 border ${syncedAt ? 'bg-[#FFF8F0] border-[#E8D5C4] text-[#6B5744]' : 'bg-amber-50 border-amber-200 text-amber-900'}`}>
          {syncedAt ? (
            <>
              <b>Statuses last checked with Meta:</b> {istDateTime(syncedAt)}.
              {managedCount === 0 && ' No template here is registered with Meta yet.'}
            </>
          ) : (
            <>
              <AlertTriangle size={11} className="inline mr-1" />
              {/* THE SENTENCE MOST LIKELY TO STOP HIM PRESSING THE BUTTON.
                  wa_templates_last_sync_at is empty on the live database, so this is the
                  block actually on screen. It used to say a message WhatsApp does not
                  have "can no longer be used" — which is what the button did before the
                  advisory redesign, and has not been true since. Measured: flipping all
                  11 rows to unknown_at_meta / pending / paused / rejected changed the
                  count of sendable templates by zero. The only thing a check can stop is
                  a campaign whose SHAPE no longer fits what WhatsApp holds (a picture
                  heading, a different number of blanks), and the preview names those. */}
              <b>Nobody has asked WhatsApp yet what it holds.</b> Press <b>Refresh status</b> once and
              this screen can tell you, in plain words, what WhatsApp says about each message below —
              approved, still being reviewed, turned down, on hold, or not on its list at all. What
              WhatsApp says about a message never takes it away from you: whatever it says, you can
              still send it, and if WhatsApp refuses it, no guest is contacted and nothing is charged.
              {' '}<b>Refresh status</b> shows you what would change first, names anything that would
              stop, saves nothing until you say continue, and can be put back afterwards.
            </>
          )}
        </div>

        {preflight && (
          <PreflightCard report={preflight} busy={syncing}
                         onCancel={() => setPreflight(null)} onConfirm={() => sync(false)} />
        )}

        {/* EVERYTHING WOULD HAVE STOPPED, so nothing was changed. The second
            press is a separate, explicit decision. */}
        {stopAll && (
          <div className="rounded-lg border-2 border-red-400 bg-red-50 p-3 space-y-2">
            <div className="flex items-center gap-1.5">
              <ShieldAlert size={14} className="text-red-600" />
              <span className="text-sm font-semibold text-[#2D1B0E]">Nothing has been changed</span>
            </div>
            <p className="text-[11px] text-red-900">{stopAll.message}</p>
            {stopAll.stopped.length > 0 && (
              <ul className="text-[11px] text-red-900/90 space-y-0.5">
                {stopAll.stopped.map((s: any, i: number) => (
                  <li key={i}><code className="font-mono">{s.name}</code> — {s.reason}</li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2 pt-1">
              <button onClick={() => sync(true)} disabled={syncing}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs rounded disabled:opacity-50">
                {syncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Yes — apply it anyway
              </button>
              <button onClick={() => setStopAll(null)} disabled={syncing}
                      className="px-3 py-1.5 border border-[#D4B896] rounded text-xs text-[#6B5744] hover:bg-[#FFF1E3] disabled:opacity-50">
                Leave everything as it is
              </button>
            </div>
          </div>
        )}

        {syncReport && (
          <SyncReport report={syncReport} onClose={() => setSyncReport(null)}
                      canUndo={undoable.available} busy={syncing} onUndo={undoSync} />
        )}

        {/* The way back stays offered after a reload, not only in the report. */}
        {!syncReport && undoable.available && (
          <div className="text-[11px] rounded p-2 border border-[#E8D5C4] bg-[#FFF8F0] text-[#6B5744] flex items-center gap-2 flex-wrap">
            <span>The last status check{undoable.taken_at ? ` (${istDateTime(undoable.taken_at)})` : ''} can still be put back exactly as it was.</span>
            <button onClick={undoSync} disabled={syncing}
                    className="ml-auto inline-flex items-center gap-1 px-2 py-1 border border-[#D4B896] rounded text-[11px] text-[#6B5744] hover:bg-[#FFF1E3] disabled:opacity-50">
              {syncing ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />} Put it back the way it was
            </button>
          </div>
        )}

        {loaded && templates.length === 0 && !editing && (
          <div className="text-xs text-[#8B7355] bg-[#FFF8F0] border border-dashed border-[#D4B896] rounded p-4 text-center">
            No templates yet. Create the first one — you can author and save it before the provider is live.
          </div>
        )}

        {/* ── list ────────────────────────────────────────────────────── */}
        <div className="space-y-2">
          {templates.map(t => {
            const k = statusKey(t);
            const reason = String(t.meta_rejected_reason || '').trim();
            const lastErr = String(t.meta_last_error || '').trim();
            const { byName, byProvider } = campaignsFor(t);
            const metaId = String(t.meta_template_id || '').trim();
            /**
             * A REJECTED template STILL OCCUPIES ITS NAME on the WABA — Meta
             * lists it with status REJECTED rather than removing it. So a
             * "resubmit" has to go through Meta's EDIT endpoint; creating it
             * again is refused outright as a duplicate name (error 2388024),
             * which is precisely the wall this screen exists to keep an admin
             * out of. Only a rejection carrying NO Meta id can be created
             * afresh — that is a submission that never landed at Meta at all.
             */
            const resubmitAsEdit = k === 'rejected' && !!metaId;
            const canSubmit = !!String(t.meta_category || '').trim() && (k === LOCAL_ONLY || k === 'draft' || k === 'rejected');
            // 'Resubmit' already IS the edit for a rejected row — showing both
            // would be two buttons making the same call under different copy.
            const canEditAtMeta = !!metaId && isManaged(t) && k !== 'draft' && !resubmitAsEdit;
            return (
              <div key={t.id} data-tpl={t.name} className="border border-[#E8D5C4] rounded-lg p-2.5 space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-[#2D1B0E] font-mono break-all">{t.name}</span>
                  <StatusChip t={t} />
                  <span className="text-[10px] text-[#8B7355] uppercase">{t.provider_language || t.language}</span>
                  {!!String(t.meta_category || '').trim() && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-800 border border-violet-300"
                          title={META_CATEGORY_NOTE[String(t.meta_category).toUpperCase()] || ''}>
                      {String(t.meta_category).toUpperCase()}
                    </span>
                  )}
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-700 border border-stone-300"
                        title="This venue's own label — it decides ordering in the broadcast picker. Not Meta's category.">
                    {t.category}
                  </span>
                  {isManaged(t) && (
                    <span className="text-[10px] text-[#8B7355]" title="When this status was last confirmed with Meta">
                      checked {istDateTime(t.meta_status_checked_at)}
                    </span>
                  )}
                </div>

                {/* Meta's own words, verbatim, inline — the whole point of the screen */}
                {k === 'rejected' && (
                  <div className="text-[11px] rounded p-2 bg-red-50 border border-red-200 text-red-800">
                    <div className="font-semibold flex items-center gap-1"><Ban size={11} /> Meta rejected this template</div>
                    <div className="mt-0.5">
                      {reason
                        ? <>Reason, verbatim from Meta: <b className="font-mono break-words">{reason}</b></>
                        : <>Meta returned no reason text with the rejection. Its usual causes are a promotional body in a UTILITY template, a missing or unrealistic example value, or a variable at the very start or end of the body.</>}
                    </div>
                    <div className="mt-1 text-red-700">
                      Edit it to fix that, then <b>Resubmit</b> — the correction replaces the rejected version
                      under the same name and goes back into review.
                    </div>
                  </div>
                )}
                {(k === 'paused' || k === 'disabled') && reason && (
                  <div className="text-[11px] rounded p-2 bg-orange-50 border border-orange-200 text-orange-900">
                    Meta&apos;s note, verbatim: <b className="font-mono break-words">{reason}</b>
                  </div>
                )}
                {lastErr && (
                  <div className="text-[11px] rounded p-2 bg-amber-50 border border-amber-200 text-amber-900">
                    Last error from Meta, verbatim: <b className="font-mono break-words">{lastErr}</b>
                  </div>
                )}
                {k === 'unknown_at_meta' && (
                  <div className="text-[11px] rounded p-2 bg-rose-50 border border-rose-200 text-rose-800">
                    Submitted from here, but absent from Meta&apos;s list at the last check. It may have been
                    deleted at Meta, or submitted against a different WhatsApp Business Account.
                  </div>
                )}

                <div className="text-[11px] text-[#6B5744] whitespace-pre-wrap break-words">{t.body}</div>

                {(byName.length > 0 || byProvider.length > 0) && (
                  <div className="text-[10px] text-[#6B5744]">
                    In use by {byName.length + byProvider.length} unfinished campaign(s):{' '}
                    {[...byName, ...byProvider].map(c => `${c.name} (${c.state})`).join(', ')}
                  </div>
                )}

                <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                  <label className="inline-flex items-center gap-1 text-[10px] text-[#6B5744] cursor-pointer">
                    <input type="checkbox" checked={!!t.is_active} onChange={() => toggleActive(t)} disabled={busy} />
                    active
                  </label>
                  <div className="ml-auto flex items-center gap-1">
                    {canSubmit && (
                      <button onClick={() => { setSubmitErrors([]); setConfirm({ kind: resubmitAsEdit ? 'resubmit' : 'submit', tpl: t }); }}
                              title={resubmitAsEdit
                                ? 'Send the corrected wording back to Meta for another review'
                                : 'Send to Meta for approval'}
                              className="inline-flex items-center gap-1 px-2 py-1 border border-emerald-600 text-emerald-700 hover:bg-emerald-50 rounded text-[11px]">
                        <Send size={11} /> {k === 'rejected' ? 'Resubmit' : 'Submit to Meta'}
                      </button>
                    )}
                    {canEditAtMeta && (
                      <button onClick={() => { setSubmitErrors([]); setConfirm({ kind: 'edit_at_meta', tpl: t }); }}
                              title="Push the local wording to Meta — this resets the template to PENDING"
                              className="inline-flex items-center gap-1 px-2 py-1 border border-amber-500 text-amber-800 hover:bg-amber-50 rounded text-[11px]">
                        <RefreshCw size={11} /> Update at Meta
                      </button>
                    )}
                    <button onClick={() => setPreviewId(previewId === t.id ? null : t.id)} title="Preview"
                            className="p-1 text-[#6B5744] hover:text-[#2D1B0E]"><Eye size={13} /></button>
                    <button onClick={() => openEdit(t)} title="Edit"
                            className="p-1 text-[#6B5744] hover:text-[#2D1B0E]"><Pencil size={13} /></button>
                    <button onClick={() => { setAlsoMeta(false); setConfirm({ kind: 'delete', tpl: t }); }} title="Delete"
                            className="p-1 text-red-500 hover:text-red-700"><Trash2 size={13} /></button>
                  </div>
                </div>

                {previewId === t.id && <RowPreview t={t} />}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── editor ───────────────────────────────────────────────────── */}
      {editing && (
        <TemplateEditor
          editing={editing}
          setEditing={setEditing}
          busy={busy}
          checkResult={checkResult}
          setCheckResult={setCheckResult}
          onCheck={check}
          onCancel={() => { setEditing(null); setCheckResult(null); }}
          onSave={async () => { const id = await save(); if (id) { setEditing(null); setCheckResult(null); } }}
        />
      )}

      {/* ── a save that would change what every guest reads ──────────────── */}
      {meaningWarn && (
        <ConfirmCard
          tone="red"
          title="This changes what the blanks of an approved message mean"
          busy={busy}
          errors={[]}
          confirmLabel="Save the new order anyway"
          onCancel={() => setMeaningWarn(null)}
          onConfirm={async () => {
            const id = await save({ confirmMeaning: true });
            if (id) { setEditing(null); setCheckResult(null); setMeaningWarn(null); }
          }}
        >
          <p>{meaningWarn.message}</p>
          <p>
            <b>Blank order now:</b> {meaningWarn.from.length ? meaningWarn.from.join(', then ') : 'nothing recorded'}
            {' → '}
            <b>after saving:</b> {meaningWarn.to.length ? meaningWarn.to.join(', then ') : 'nothing recorded'}
          </p>
          {meaningWarn.campaigns.length > 0 && (
            <div>
              <b>Campaigns that would start saying something different:</b>
              <ul className="list-disc pl-4">
                {meaningWarn.campaigns.map((c, i) => <li key={i}>{c.name} ({c.state})</li>)}
              </ul>
            </div>
          )}
          <p>
            Meta is <b>not</b> told by this save — its own record still describes the old wording. If the
            message really changed at Meta, use <b>Edit at Meta</b> so both records move together.
          </p>
        </ConfirmCard>
      )}

      {/* ── confirmations ─────────────────────────────────────────────── */}
      {confirm?.kind === 'submit' && (
        <ConfirmCard
          tone="emerald"
          title={`Submit "${confirm.tpl.name}" to Meta for approval?`}
          busy={busy}
          errors={submitErrors}
          confirmLabel="Submit to Meta"
          onCancel={() => { setConfirm(null); setSubmitErrors([]); }}
          onConfirm={() => doSubmit(confirm.tpl, 'submit')}
        >
          <ul className="list-disc pl-4 space-y-1">
            <li><b>Review takes minutes, sometimes much longer.</b> Until Meta approves it, this template cannot be used by a broadcast or a proactive notification.</li>
            <li><b>The name can never be changed.</b> Meta identifies a template by (name, language); to use a different name you create a different template.</li>
            <li><b>The wording can only be changed by another review.</b> An approved template that you edit goes back to PENDING, and Meta rate-limits edits.</li>
            <li><b>Meta may reclassify the category.</b> This submission allows that rather than being hard-rejected on a category judgement — and a MARKETING reclassification costs roughly 7× UTILITY per conversation.</li>
            <li>If Meta refuses it, its reason is shown on this screen word for word.</li>
          </ul>
        </ConfirmCard>
      )}

      {confirm?.kind === 'resubmit' && (
        <ConfirmCard
          tone="emerald"
          title={`Resubmit "${confirm.tpl.name}" to Meta?`}
          busy={busy}
          errors={submitErrors}
          confirmLabel="Resubmit to Meta"
          onCancel={() => { setConfirm(null); setSubmitErrors([]); }}
          onConfirm={() => doSubmit(confirm.tpl, 'edit')}
        >
          <ul className="list-disc pl-4 space-y-1">
            <li><b>This replaces the rejected version at Meta.</b> A rejected template keeps its name on your WhatsApp Business Account, so the correction is sent as an update to it — submitting it as a new template would be refused as a duplicate name.</li>
            <li><b>It goes back to PENDING review.</b> It stays unusable for broadcasts and proactive notifications until Meta approves it.</li>
            <li><b>Meta rate-limits template edits.</b> Several corrections in a short window are refused by Meta, not by us.</li>
            <li><b>Send the fix, not the same text.</b> Meta re-reads the whole template; resubmitting what it already refused earns the same refusal.</li>
            <li>If it is refused again, the new reason replaces the one shown now — word for word.</li>
          </ul>
        </ConfirmCard>
      )}

      {confirm?.kind === 'edit_at_meta' && (
        <ConfirmCard
          tone="amber"
          title={`Push the local wording of "${confirm.tpl.name}" to Meta?`}
          busy={busy}
          errors={submitErrors}
          confirmLabel="Update at Meta"
          onCancel={() => { setConfirm(null); setSubmitErrors([]); }}
          onConfirm={() => doSubmit(confirm.tpl, 'edit')}
        >
          <ul className="list-disc pl-4 space-y-1">
            <li><b>This resets the template to PENDING at Meta.</b> It stops being usable the moment Meta accepts the edit, until it is approved again.</li>
            <li><b>Any campaign mid-send would halt.</b> The request is refused outright while an unfinished campaign uses this template.</li>
            <li><b>Meta rate-limits template edits.</b> Repeated edits in a short window are refused by Meta, not by us.</li>
            <li>The name and language are not editable — only the components (header, body, footer, buttons).</li>
          </ul>
        </ConfirmCard>
      )}

      {confirm?.kind === 'delete' && (() => {
        const t = confirm.tpl;
        const { byName, byProvider } = campaignsFor(t);
        const managed = isManaged(t);
        return (
          <ConfirmCard
            tone="red"
            title={`Delete "${t.name}"?`}
            busy={busy}
            errors={[]}
            confirmLabel={alsoMeta ? 'Delete here AND at Meta' : 'Delete locally'}
            confirmDisabled={byName.length > 0}
            onCancel={() => { setConfirm(null); setAlsoMeta(false); }}
            onConfirm={() => doDelete(t)}
          >
            <div className="space-y-2">
              <div>
                <div className="font-semibold text-[#2D1B0E]">Campaigns using this template</div>
                {byName.length === 0 && byProvider.length === 0 ? (
                  <p className="text-[#6B5744]">None. No unfinished campaign sends from this template.</p>
                ) : (
                  <>
                    {byName.length > 0 && (
                      <div className="mt-1 rounded p-2 bg-red-50 border border-red-200 text-red-800">
                        <b>{byName.length} unfinished campaign(s) depend on it — deletion is refused:</b>
                        <ul className="list-disc pl-4 mt-0.5">
                          {byName.map(c => <li key={c.id}>{c.name} <span className="uppercase text-[10px]">({c.state})</span></li>)}
                        </ul>
                        <div className="mt-1">Cancel or finish them first. Deleting now would leave them pointing at a template that no longer exists — and a sending campaign would fail every remaining recipient one at a time.</div>
                      </div>
                    )}
                    {byProvider.length > 0 && (
                      <div className="mt-1 text-[#6B5744]">
                        Also referenced by this row&apos;s provider name (<code>{t.provider_template_name}</code>):{' '}
                        {byProvider.map(c => `${c.name} (${c.state})`).join(', ')}.
                      </div>
                    )}
                  </>
                )}
              </div>

              {managed && (
                <label className="flex items-start gap-2 cursor-pointer rounded p-2 border border-red-200 bg-red-50">
                  <input type="checkbox" checked={alsoMeta} onChange={e => setAlsoMeta(e.target.checked)} className="mt-0.5" />
                  <span>
                    <span className="font-semibold text-red-800">Also delete it at Meta</span>
                    <span className="block text-red-700 mt-0.5">
                      Meta deletes <b>by name</b>, which removes <b>every language</b> of &quot;{t.name}&quot;. This cannot be undone,
                      and re-creating the row here will not bring it back — it would have to be submitted and approved again.
                    </span>
                  </span>
                </label>
              )}
              {managed && !alsoMeta && (
                <p className="text-[#6B5744]">
                  Deleting the local row only. &quot;{t.name}&quot; stays at Meta and will reappear here on the next status refresh.
                </p>
              )}
              {!managed && (
                <p className="text-[#6B5744]">
                  This row was never registered with Meta from here, so only the local copy is removed.
                </p>
              )}
            </div>
          </ConfirmCard>
        );
      })()}
    </div>
  );
}

/* ═══════════════════════ row preview ═══════════════════════ */

function RowPreview({ t }: { t: WaTemplate }) {
  let header = '', footer = '', headerEx = '';
  const buttons: Btn[] = [];
  try {
    const comps = JSON.parse(String(t.meta_components || '[]'));
    if (Array.isArray(comps)) {
      for (const c of comps) {
        const type = String(c?.type || '').toUpperCase();
        if (type === 'HEADER') {
          header = String(c?.text || '');
          const ex = c?.example?.header_text;
          if (Array.isArray(ex) && ex.length) headerEx = String(ex[0] ?? '');
        } else if (type === 'FOOTER') {
          footer = String(c?.text || '');
        } else if (type === 'BUTTONS' && Array.isArray(c?.buttons)) {
          for (const b of c.buttons) {
            buttons.push({
              type: String(b?.type || 'QUICK_REPLY').toUpperCase() as Btn['type'],
              text: String(b?.text || ''), url: String(b?.url || ''), phone_number: String(b?.phone_number || ''),
            });
          }
        }
      }
    }
  } catch { /* unreadable components — show the body alone */ }

  let vars: VarRow[] = [];
  try {
    const parsed = JSON.parse(String(t.var_spec || '[]'));
    if (Array.isArray(parsed)) {
      vars = parsed.map((v: any) => ({ index: Number(v?.index), name: String(v?.name ?? ''), example: String(v?.example ?? '') }));
    }
  } catch { /* no var spec — placeholders stay visible in the preview */ }

  return (
    <div className="pt-1">
      <WhatsAppPreview
        header={headerEx ? header.replace(/\{\{\s*1\s*\}\}/g, headerEx) : header}
        body={renderWithExamples(t.body || '', vars)}
        footer={footer}
        buttons={buttons}
      />
    </div>
  );
}

/* ═════════════ before you refresh: the dry run, nothing written ═════════════ */

/**
 * WHAT WILL "REFRESH STATUS" DO TO WHAT I CAN SEND?
 *
 * Asked of WhatsApp and answered per template BEFORE anything is written.
 *
 * The card promises nothing it cannot keep. It does not say "these keep working
 * whatever we find": it names every template that stops.
 *
 * TWO CLAIMS THIS CARD IS NOT ALLOWED TO MAKE, both measured:
 *
 *  1. "Meta's answer decides what can be sent." It does not, and has not since
 *     the 2026-09-15 ruling. Not approved / under review / turned down / on hold /
 *     absent from the list are ADVISORY — sendabilityFrom returns ok:true with a
 *     warning for every one of them. Flipping all 11 live rows through those four
 *     statuses changed the number of sendable templates by zero. What a refresh
 *     CAN still stop is a campaign whose shape no longer fits what WhatsApp holds
 *     (a picture heading, a different number of blanks) — those are real, they are
 *     the entries in at_risk, and they are named below rather than promised away.
 *
 *  2. "Nothing you use would stop working" when nothing could be measured. The
 *     server sets measured:false when the sendability probe could not answer; the
 *     row lists are then empty BECAUSE the check failed, not because all is well.
 *     An empty list read as an all-clear is exactly the false clean bill of health
 *     the flag exists to prevent, so the headline, the border and the button all
 *     have to know about it — not only the caveat box further down.
 */
function PreflightCard({ report, busy, onCancel, onConfirm }: {
  report: any; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const rows: any[] = Array.isArray(report?.rows) ? report.rows : [];
  const atRisk: any[] = Array.isArray(report?.at_risk) ? report.at_risk : [];
  const campsAtRisk: any[] = Array.isArray(report?.campaigns_at_risk) ? report.campaigns_at_risk : [];
  const newAtMeta: any[] = Array.isArray(report?.new_at_meta) ? report.new_at_meta : [];
  const gains = rows.filter(r => r.verdict === 'starts_working');
  const keeps = rows.filter(r => r.verdict === 'keeps_working');
  const stillNo = rows.filter(r => r.verdict === 'still_unusable');
  const totalLoss = !!report?.total_loss;
  const measured = report?.measured !== false;

  /* THE HEADLINE IS THE CLAIM. A caveat underneath does not undo a bold sentence
     above it, so an unmeasured check gets its own tone end to end: amber card,
     amber icon, a headline that says the check could not answer, and a button
     that reads "Continue anyway" rather than a green "Continue".
     ORDER MATTERS: a named casualty outranks an unknown. If anything at all came
     back in at_risk it stays RED even when the measurement also failed, because
     the safer of the two claims must win — and the amber caveat below still says
     the list may be short. Only an EMPTY list on a failed measurement is amber. */
  const tone = atRisk.length ? 'bad' : !measured ? 'unknown' : 'good';

  return (
    <div className={`rounded-lg border-2 p-3 space-y-2 ${
      tone === 'bad' ? 'border-red-300 bg-red-50/40'
        : tone === 'unknown' ? 'border-amber-300 bg-amber-50/40'
        : 'border-emerald-300 bg-emerald-50/40'}`}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <ShieldAlert size={14} className={
          tone === 'bad' ? 'text-red-600' : tone === 'unknown' ? 'text-amber-600' : 'text-emerald-600'} />
        <span className="text-sm font-semibold text-[#2D1B0E]">
          {atRisk.length
            ? (measured
                ? `${atRisk.length} of your ${rows.length} message${rows.length === 1 ? '' : 's'} would stop working`
                : `At least ${atRisk.length} message${atRisk.length === 1 ? '' : 's'} would stop working — and this check could not work out the rest`)
            : measured
              ? `Nothing you use would stop working`
              : `This check could not work out what would stop working`}
        </span>
        <span className="text-[10px] text-[#8B7355] ml-auto">Nothing has been saved yet · WhatsApp answered with {report?.fetched ?? 0} template(s)</span>
      </div>

      <p className="text-[11px] text-[#5B5148]">
        {report?.first_check
          ? <>This is the <b>first time</b> this app has asked WhatsApp what it holds. What WhatsApp says about a message never takes it away from you — not approved, still being reviewed, turned down, on hold, or not on its list at all: you can still send it, and if WhatsApp refuses it, no guest is contacted and nothing is charged. The only thing this check can stop is a campaign whose wording no longer fits what WhatsApp actually holds — a picture heading a broadcast has no file for, or a different number of blanks. Anything like that is named below, before anything is saved.</>
          : <>What WhatsApp says about each message is shown beside it. It is information, not a lock — you decide what to send, and if WhatsApp turns a message down, no guest is contacted and nothing is charged. The only thing this check can stop is a campaign whose wording no longer fits what WhatsApp holds — a picture heading a broadcast has no file for, or a different number of blanks. Anything like that is named below, before anything is saved.</>}
      </p>

      {!measured && (
        <div className="rounded p-2 bg-amber-50 border border-amber-200 text-amber-900 text-[11px]">
          <AlertTriangle size={11} className="inline mr-1" />
          <b>Nothing below was worked out — the check itself did not answer.</b> Any list that
          follows is empty because of that, not because all is well. Leave everything as it is and
          try again in a minute; if you do continue, check Broadcasts afterwards and put it back if
          anything looks wrong.
        </div>
      )}

      {totalLoss && (
        <div className="rounded p-2 bg-red-100 border border-red-300 text-red-900 text-[11px]">
          <ShieldAlert size={11} className="inline mr-1" />
          <b>This would stop EVERY message this venue can send.</b> That is usually a sign that the
          WhatsApp Business Account ID or the access token on this page belongs to a different Meta
          account than the one these messages were approved on — worth checking before you continue.
          The refresh itself will also refuse to apply an answer this drastic until you confirm it a
          second time, and it can be put back afterwards.
        </div>
      )}

      {atRisk.length > 0 && (
        <div className="rounded p-2 bg-red-50 border border-red-200 text-red-800 text-[11px] space-y-1">
          <b>These stop if you continue:</b>
          <ul className="space-y-1">
            {atRisk.map((r, i) => (
              <li key={i} className="border-t border-red-200 pt-1 first:border-0 first:pt-0">
                <code className="font-mono">{r.name}</code>{' '}
                <span className="text-[10px] px-1 py-0.5 rounded-full bg-red-100 border border-red-300">
                  {r.verdict === 'stops_everything' ? 'stops completely' : 'no longer usable for campaigns'}
                </span>
                <div className="text-red-900/90">{r.note}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {campsAtRisk.length > 0 && (
        <div className="rounded p-2 bg-red-50 border border-red-200 text-red-800 text-[11px] space-y-1">
          <b>Campaigns that could not be started afterwards:</b>
          <ul className="space-y-1">
            {campsAtRisk.map((c, i) => (
              <li key={i} className="border-t border-red-200 pt-1 first:border-0 first:pt-0">
                {c.name} <span className="text-[10px]">({c.state})</span>
                <div className="text-red-900/90">{c.reason}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {gains.length > 0 && (
        <div className="rounded p-2 bg-emerald-50 border border-emerald-200 text-emerald-900 text-[11px]">
          <b>These start working:</b>{' '}
          {gains.map((r, i) => <span key={i}><code>{r.name}</code>{i < gains.length - 1 ? ', ' : ''}</span>)}
        </div>
      )}

      {keeps.length > 0 && (
        <div className="text-[11px] text-[#5B5148]">
          {/* Every gate a campaign passes through was asked of this row, before and
              after — not only approval. That is what the word "unaffected" rests
              on here; with approval alone it was a false claim for a template Meta
              holds approved with a picture heading. */}
          <b>Unaffected</b> (checked against everything a campaign has to pass, before and after):{' '}
          {keeps.map((r, i) => <span key={i}><code>{r.name}</code>{i < keeps.length - 1 ? ', ' : ''}</span>)}
        </div>
      )}

      {stillNo.length > 0 && (
        <div className="text-[11px] text-[#8B7355]">
          Already unusable, before and after:{' '}
          {stillNo.map((r, i) => <span key={i}><code>{r.name}</code>{i < stillNo.length - 1 ? ', ' : ''}</span>)}
        </div>
      )}

      {newAtMeta.length > 0 && (
        <div className="text-[11px] text-[#5B5148]">
          <b>New from WhatsApp</b> (added to this list if you continue):{' '}
          {newAtMeta.map((r, i) => <span key={i}><code>{r.name}</code> ({r.status || 'unknown'}){i < newAtMeta.length - 1 ? ', ' : ''}</span>)}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button onClick={onConfirm} disabled={busy}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-white text-xs rounded disabled:opacity-50 ${
                  tone === 'bad' ? 'bg-red-600 hover:bg-red-700'
                    : tone === 'unknown' ? 'bg-amber-600 hover:bg-amber-700'
                    : 'bg-emerald-600 hover:bg-emerald-700'}`}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {tone === 'good' ? 'Continue' : 'Continue anyway'}
        </button>
        <button onClick={onCancel} disabled={busy}
                className="px-3 py-1.5 border border-[#D4B896] rounded text-xs text-[#6B5744] hover:bg-[#FFF1E3] disabled:opacity-50">
          Leave everything as it is
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════ sync report ═══════════════════════ */

function SyncReport({ report, onClose, canUndo, busy, onUndo }: {
  report: any; onClose: () => void; canUndo?: boolean; busy?: boolean; onUndo?: () => void;
}) {
  const updated: any[] = Array.isArray(report?.updated) ? report.updated : [];
  const adopted: any[] = Array.isArray(report?.adopted) ? report.adopted : [];
  /**
   * WHAT ACTUALLY STOPPED — the server's `stopped`, which is the send gate's own
   * before/after answer for each template.
   *
   * It is NOT `regressed`. That list is filled only where a status moved out of
   * 'approved', and on a first check no row can: every pre-existing row starts
   * at '' and goes straight to whatever Meta says. MEASURED with Meta holding one
   * template paused, one pending and one approved-as-a-service-message — all
   * three lost their campaigns, and `regressed` came back empty while the report
   * printed eight cheerful lines. `stopped` answers on the first check and on the
   * hundredth, because it asks the question the operator is actually asking.
   */
  const stopped: any[] = Array.isArray(report?.stopped) ? report.stopped : [];
  const campsStopped: any[] = Array.isArray(report?.campaigns_stopped) ? report.campaigns_stopped : [];
  const conflicts: any[] = Array.isArray(report?.name_conflicts) ? report.name_conflicts : [];
  const missing: any[] = Array.isArray(report?.missing_at_meta) ? report.missing_at_meta : [];
  const measured = report?.measured !== false;
  const nothing = !updated.length && !adopted.length && !stopped.length && !campsStopped.length
    && !conflicts.length && !missing.length;

  return (
    <div className="text-[11px] rounded border border-[#E8D5C4] bg-[#FFF8F0] p-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-[#2D1B0E]">Meta returned {report?.fetched ?? 0} template(s)</span>
        <button onClick={onClose} aria-label="Close this report" className="ml-auto p-0.5 text-[#8B7355] hover:text-[#2D1B0E]"><X size={12} /></button>
      </div>
      {nothing && measured && <div className="text-[#6B5744]">Nothing changed — every status here already matched Meta.</div>}
      {!measured && (
        <div className="rounded p-1.5 bg-amber-50 border border-amber-200 text-amber-900">
          <AlertTriangle size={11} className="inline mr-1" />
          <b>This app could not work out what the refresh changed about sending.</b> The statuses were
          reconciled normally, but the list of what stopped may be incomplete — check Broadcasts, and
          put this back if anything looks wrong.
        </div>
      )}
      {(canUndo && onUndo) && (
        <div className="flex items-center gap-2 flex-wrap border-t border-[#E8D5C4] pt-1.5">
          <span className="text-[#8B7355]">Not what you expected?</span>
          <button onClick={onUndo} disabled={!!busy}
                  className="inline-flex items-center gap-1 px-2 py-1 border border-[#D4B896] rounded text-[11px] text-[#6B5744] hover:bg-[#FFF1E3] disabled:opacity-50">
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />} Put it back the way it was
          </button>
        </div>
      )}
      {campsStopped.length > 0 && (
        <div className="rounded p-1.5 bg-red-50 border border-red-200 text-red-800 space-y-1">
          <b>These campaigns can no longer be started:</b>
          <ul className="space-y-1">
            {campsStopped.map((c, i) => (
              <li key={i} className="border-t border-red-200 pt-1 first:border-0 first:pt-0">
                {c.name} <span className="text-[10px]">({c.state})</span>
                <div className="text-red-900/90">{c.reason}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {stopped.length > 0 && (
        <div className="rounded p-1.5 bg-red-50 border border-red-200 text-red-800 space-y-1">
          <b>These can no longer send:</b>
          <ul className="space-y-1">
            {stopped.map((s, i) => (
              <li key={i} className="border-t border-red-200 pt-1 first:border-0 first:pt-0">
                <code className="font-mono">{s.name}</code>{' '}
                <span className="text-[10px] px-1 py-0.5 rounded-full bg-red-100 border border-red-300">
                  {s.scope === 'everything' ? 'stopped completely' : 'no longer usable for campaigns'}
                </span>
                <div className="text-red-900/90">{s.reason}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {updated.length > 0 && (
        <div className="text-[#6B5744]">
          <b>Status changed:</b>{' '}
          {updated.map((u, i) => <span key={i}><code>{u.name}</code> {u.from || 'local'} → {u.to}{i < updated.length - 1 ? ', ' : ''}</span>)}
        </div>
      )}
      {adopted.length > 0 && (
        <div className="text-[#6B5744]">
          <b>Brought in from WhatsApp</b> (already approved there, not known here until now):{' '}
          {adopted.map((a, i) => <span key={i}><code>{a.name}</code> ({a.language}, {a.status}){i < adopted.length - 1 ? ', ' : ''}</span>)}
        </div>
      )}
      {missing.length > 0 && (
        <div className="rounded p-1.5 bg-rose-50 border border-rose-200 text-rose-800">
          <b>Submitted here but absent at Meta:</b> {missing.map((m: any) => m.name).join(', ')}
        </div>
      )}
      {conflicts.length > 0 && (
        <div className="rounded p-1.5 bg-amber-50 border border-amber-200 text-amber-900">
          <b>Same name, different language:</b>
          <ul className="list-disc pl-4">
            {conflicts.map((c, i) => (
              <li key={i}>
                Meta has <code>{c.name}</code> in {c.meta_language}; the local row of that name is {c.local_language || '—'}.
                Local names are unique, so that row was left untouched — rename one if you need both languages.
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════ confirmation card ═══════════════════════ */

function ConfirmCard({
  tone, title, children, errors, busy, confirmLabel, confirmDisabled, onCancel, onConfirm,
}: {
  tone: 'emerald' | 'amber' | 'red';
  title: string;
  children: React.ReactNode;
  errors: string[];
  busy: boolean;
  confirmLabel: string;
  confirmDisabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ring = tone === 'red' ? 'border-red-300' : tone === 'amber' ? 'border-amber-300' : 'border-emerald-300';
  const btn = tone === 'red' ? 'bg-red-600 hover:bg-red-700' : tone === 'amber' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700';
  return (
    <div className={`bg-white border-2 rounded-xl p-4 space-y-3 ${ring}`}>
      <h3 className="text-sm font-semibold text-[#2D1B0E] flex items-center gap-1.5">
        <ShieldAlert size={15} className={tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : 'text-emerald-600'} />
        {title}
      </h3>
      <div className="text-[11px] text-[#6B5744] space-y-1">{children}</div>
      {errors.length > 0 && (
        <div className="text-[11px] rounded p-2 bg-red-50 border border-red-200 text-red-800 space-y-0.5">
          <b>Not sent — fix these first:</b>
          <ul className="list-disc pl-4">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button onClick={onCancel} className="text-xs text-[#6B5744]">Cancel</button>
        <button onClick={onConfirm} disabled={busy || confirmDisabled}
                className={`ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-white text-sm rounded disabled:opacity-50 ${btn}`}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} {confirmLabel}
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════ the editor ═══════════════════════ */

function TemplateEditor({
  editing, setEditing, busy, checkResult, setCheckResult, onCheck, onCancel, onSave,
}: {
  editing: Editor;
  setEditing: (e: Editor) => void;
  busy: boolean;
  checkResult: { ok: boolean; errors: string[] } | null;
  setCheckResult: (r: { ok: boolean; errors: string[] } | null) => void;
  onCheck: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const isMeta = editing.mode === 'meta';
  const managed = !!editing.metaStatus;
  const set = (patch: Partial<Editor>) => { setCheckResult(null); setEditing({ ...editing, ...patch }); };

  /* body edits reconcile the variable rows without rewriting the operator's text */
  const onBody = (next: string) => set({ body: next, vars: reconcileVars(next, editing.vars) });

  const addVar = () => {
    const el = bodyRef.current;
    const caret = el ? (el.selectionStart ?? editing.body.length) : editing.body.length;
    const out = insertVariable(editing.body, caret, editing.vars);
    set({ body: out.body, vars: out.vars });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(out.caret, out.caret);
    });
  };

  const dropVar = (idx: number) => {
    const out = removeVariable(editing.body, editing.vars, idx);
    set({ body: out.body, vars: out.vars });
  };

  const renumber = () => {
    const out = normalizeVars(editing.body, editing.vars);
    set({ body: out.body, vars: out.vars });
  };

  const used = usedIndices(editing.body);
  const numberingBroken = used.length > 0 && used.some((n, i) => n !== i + 1);

  const nameOk = NAME_RE.test(editing.name.trim());
  const langOk = LANG_RE.test(editing.language.trim());
  const missingExamples = editing.vars.filter(v => !v.example.trim()).map(v => v.index);
  const missingNames = editing.vars.filter(v => !v.name.trim()).map(v => v.index);

  const previewHeader = editing.headerExample
    ? editing.header.replace(/\{\{\s*1\s*\}\}/g, editing.headerExample)
    : editing.header;
  const previewBody = renderWithExamples(editing.body, editing.vars);

  const saveDisabled = busy
    || !editing.name.trim()
    || !editing.body.trim()
    || (isMeta && (!nameOk || !langOk))
    || (!isMeta && editing.sendAsTemplate && !editing.providerTemplateName.trim());

  return (
    <div className="bg-white border border-[#af4408]/40 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-[#2D1B0E]">{editing.id ? 'Edit template' : 'New template'}</h3>
        {managed && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-amber-100 text-amber-900 border-amber-300">
            registered with Meta — {editing.metaStatus}
          </span>
        )}
      </div>

      {/* mode */}
      {!managed ? (
        <div className="flex flex-wrap gap-1.5">
          {(['meta', 'local'] as const).map(m => (
            <button key={m} onClick={() => set({ mode: m })}
                    className={`px-2.5 py-1 rounded-full text-[11px] border ${
                      editing.mode === m
                        ? 'bg-[#af4408] text-white border-[#af4408]'
                        : 'bg-white text-[#6B5744] border-[#D4B896] hover:bg-[#FFF1E3]'}`}>
              {m === 'meta' ? 'Meta template (submit for approval)' : 'Local free-form body'}
            </button>
          ))}
        </div>
      ) : (
        <div className="text-[11px] rounded p-2 bg-amber-50 border border-amber-200 text-amber-900">
          This template is registered with Meta. Its <b>name cannot be changed</b> — Meta identifies it by
          (name, language), and renaming it here would orphan the approved template. Saving edits the{' '}
          <b>local draft only</b>: Meta keeps serving the version it approved until you press <b>Update at Meta</b>,
          which sends it back through review.
        </div>
      )}

      {/* identity */}
      <div className="grid sm:grid-cols-3 gap-3">
        <label className="block text-xs text-[#6B5744]">
          Name
          <input value={editing.name} disabled={managed}
                 onChange={e => set({ name: e.target.value })}
                 placeholder="e.g. akan_offer_july"
                 className={`mt-1 w-full px-3 py-2 border rounded bg-[#FFF1E3] text-sm font-mono disabled:opacity-60 disabled:cursor-not-allowed ${
                   isMeta && editing.name && !nameOk ? 'border-red-400' : 'border-[#D4B896]'}`} />
          {isMeta && editing.name && !nameOk && (
            <span className="block text-[10px] text-red-600 mt-1">
              Lowercase letters, digits and underscores only, up to 512 characters — Meta&apos;s naming rule.
            </span>
          )}
        </label>

        {isMeta ? (
          <label className="block text-xs text-[#6B5744]">
            Meta category
            <select value={editing.metaCategory} onChange={e => set({ metaCategory: e.target.value })}
                    className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm">
              <option value="MARKETING">MARKETING</option>
              <option value="UTILITY">UTILITY</option>
              <option value="AUTHENTICATION">AUTHENTICATION</option>
            </select>
            <span className="block text-[10px] text-[#8B7355] mt-1">{META_CATEGORY_NOTE[editing.metaCategory]}</span>
          </label>
        ) : (
          <label className="block text-xs text-[#6B5744]">
            Category
            <select value={editing.category} onChange={e => set({ category: e.target.value })}
                    className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm">
              <option value="notification">notification</option>
              <option value="marketing">marketing</option>
              <option value="approval">approval</option>
              <option value="general">general</option>
            </select>
          </label>
        )}

        <label className="block text-xs text-[#6B5744]">
          Language
          <input value={editing.language} onChange={e => set({ language: e.target.value })}
                 placeholder={isMeta ? 'en or en_US' : 'en / te / hi'}
                 className={`mt-1 w-full px-3 py-2 border rounded bg-[#FFF1E3] text-sm font-mono ${
                   isMeta && editing.language && !langOk ? 'border-red-400' : 'border-[#D4B896]'}`} />
          {isMeta && editing.language && !langOk && (
            <span className="block text-[10px] text-red-600 mt-1">
              A Meta language code, like <code>en</code> or <code>en_US</code>. The wrong code fails at
              send time as a &quot;template not found&quot; error that reads like a name problem.
            </span>
          )}
        </label>
      </div>

      {isMeta && (
        <label className="block text-xs text-[#6B5744]">
          Local label (ordering only)
          <select value={editing.category} onChange={e => set({ category: e.target.value })}
                  className="mt-1 w-full sm:w-56 px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm">
            <option value="marketing">marketing</option>
            <option value="notification">notification</option>
            <option value="approval">approval</option>
            <option value="general">general</option>
          </select>
          <span className="block text-[10px] text-[#8B7355] mt-1">
            This venue&apos;s own label — the broadcast picker lists <b>marketing</b> first. It is not sent to Meta.
          </span>
        </label>
      )}

      {isMeta && (
        <>
          {/* HEADER */}
          <div className="border-t border-[#E8D5C4] pt-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-[#2D1B0E]">Header</span>
              <span className="text-[10px] text-[#8B7355]">optional · one line of text · at most one variable</span>
              <span className="ml-auto"><CharCount n={editing.header.length} max={LIMIT_HEADER} /></span>
            </div>
            <input value={editing.header} onChange={e => set({ header: e.target.value })}
                   aria-label="Template header"
                   placeholder="e.g. A table is waiting at {{1}}"
                   className="w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm" />
            {/\{\{\s*\d+\s*\}\}/.test(editing.header) && (
              <label className="block text-xs text-[#6B5744]">
                Example value for the header&apos;s {'{{1}}'} <span className="text-red-600">*</span>
                <input value={editing.headerExample} onChange={e => set({ headerExample: e.target.value })}
                       placeholder="AKAN"
                       className={`mt-1 w-full px-3 py-2 border rounded bg-[#FFF1E3] text-sm ${editing.headerExample.trim() ? 'border-[#D4B896]' : 'border-red-400'}`} />
              </label>
            )}
          </div>

          {/* BODY */}
          <div className="border-t border-[#E8D5C4] pt-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-[#2D1B0E]">Body <span className="text-red-600">*</span></span>
              <button onClick={addVar}
                      className="inline-flex items-center gap-1 px-2 py-0.5 border border-[#D4B896] rounded text-[11px] text-[#6B5744] hover:bg-[#FFF1E3]">
                <Plus size={11} /> Insert variable
              </button>
              <span className="ml-auto"><CharCount n={editing.body.length} max={LIMIT_BODY} /></span>
            </div>
            <textarea ref={bodyRef} value={editing.body} onChange={e => onBody(e.target.value)} rows={5}
                      aria-label="Template body"
                      placeholder={'Hi {{1}}, we miss you at {{2}}! Show this message this week for a complimentary dessert.'}
                      className="w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm font-mono" />
            <p className="text-[10px] text-[#8B7355]">
              Variables are positional — <code>{'{{1}}'}</code>, <code>{'{{2}}'}</code>, … — and Meta refuses a body that{' '}
              <b>starts</b> or <b>ends</b> with one, or that puts two of them side by side.
            </p>

            {numberingBroken && (
              <div className="text-[11px] rounded p-2 bg-amber-50 border border-amber-200 text-amber-900 flex items-start gap-2">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span className="flex-1">
                  The numbering is {used.map(n => `{{${n}}}`).join(', ')} — Meta needs 1, 2, 3 … with no gaps.
                </span>
                <button onClick={renumber} className="shrink-0 px-2 py-0.5 border border-amber-400 rounded text-[11px] hover:bg-amber-100">
                  Renumber
                </button>
              </div>
            )}

            {/* variables */}
            {editing.vars.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-[#2D1B0E]">Variables</div>
                {editing.vars.map(v => (
                  <div key={v.index} data-var={v.index}
                       className="grid grid-cols-[3rem_1fr] sm:grid-cols-[3rem_1fr_1fr_2rem] gap-1.5 items-start">
                    <span className="text-xs font-mono text-[#8B7355] pt-2">{`{{${v.index}}}`}</span>
                    <input value={v.name} list="wa-var-names"
                           aria-label={`Variable ${v.index} name`}
                           onChange={e => set({ vars: editing.vars.map(x => x.index === v.index ? { ...x, name: e.target.value } : x) })}
                           placeholder="what it holds (name, venue, …)"
                           className={`w-full px-2.5 py-1.5 border rounded bg-[#FFF1E3] text-xs font-mono ${v.name.trim() ? 'border-[#D4B896]' : 'border-red-400'}`} />
                    <input value={v.example}
                           aria-label={`Variable ${v.index} example value`}
                           onChange={e => set({ vars: editing.vars.map(x => x.index === v.index ? { ...x, example: e.target.value } : x) })}
                           placeholder="example value Meta will see"
                           className={`w-full px-2.5 py-1.5 border rounded bg-[#FFF1E3] text-xs ${v.example.trim() ? 'border-[#D4B896]' : 'border-red-400'}`} />
                    <button onClick={() => dropVar(v.index)} title={`Remove {{${v.index}}} and renumber the rest`}
                            aria-label={`Remove variable ${v.index}`}
                            className="p-1.5 text-red-500 hover:text-red-700 justify-self-start">
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <datalist id="wa-var-names">
                  {['name', 'venue', 'phone', 'date', 'time', 'amount', 'item', 'table', 'offer'].map(n => <option key={n} value={n} />)}
                </datalist>
                <p className="text-[10px] text-[#8B7355]">
                  Every variable needs a <b>name</b> (so a campaign knows what to put there) and an{' '}
                  <b>example value</b> — Meta rejects a submission whose placeholders carry no examples, and its
                  rejection does not say which one was missing. A <b>broadcast</b> can only fill{' '}
                  {BROADCAST_FILLABLE.map(v => <code key={v} className="mx-0.5">{v}</code>)} — any other name is fine for
                  a notification template but is dropped by the campaign wizard.
                </p>
                {(missingExamples.length > 0 || missingNames.length > 0) && (
                  <p className="text-[10px] text-red-600">
                    {missingExamples.length > 0 && <>Missing example{missingExamples.length > 1 ? 's' : ''} for {missingExamples.map(n => `{{${n}}}`).join(', ')}. </>}
                    {missingNames.length > 0 && <>Missing name{missingNames.length > 1 ? 's' : ''} for {missingNames.map(n => `{{${n}}}`).join(', ')}.</>}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* FOOTER */}
          <div className="border-t border-[#E8D5C4] pt-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-[#2D1B0E]">Footer</span>
              <span className="text-[10px] text-[#8B7355]">optional · no variables allowed</span>
              <span className="ml-auto"><CharCount n={editing.footer.length} max={LIMIT_FOOTER} /></span>
            </div>
            <input value={editing.footer} onChange={e => set({ footer: e.target.value })}
                   aria-label="Template footer"
                   placeholder="e.g. Reply STOP to opt out"
                   className="w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm" />
            {/\{\{\s*\d+\s*\}\}/.test(editing.footer) && (
              <p className="text-[10px] text-red-600">A footer may not contain variables — Meta refuses it.</p>
            )}
          </div>

          {/* BUTTONS */}
          <div className="border-t border-[#E8D5C4] pt-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-[#2D1B0E]">Buttons</span>
              <span className="text-[10px] text-[#8B7355]">optional</span>
              <button onClick={() => set({ buttons: [...editing.buttons, { type: 'QUICK_REPLY', text: '', url: '', phone_number: '' }] })}
                      className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 border border-[#D4B896] rounded text-[11px] text-[#6B5744] hover:bg-[#FFF1E3]">
                <Plus size={11} /> Add button
              </button>
            </div>
            {editing.buttons.map((b, i) => (
              <div key={i} className="border border-[#E8D5C4] rounded p-2 space-y-1.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <select value={b.type}
                          aria-label={`Button ${i + 1} type`}
                          onChange={e => set({ buttons: editing.buttons.map((x, j) => j === i ? { ...x, type: e.target.value as Btn['type'] } : x) })}
                          className="px-2 py-1 border border-[#D4B896] rounded bg-[#FFF1E3] text-xs">
                    <option value="QUICK_REPLY">Quick reply</option>
                    <option value="URL">Open a link</option>
                    <option value="PHONE_NUMBER">Call a number</option>
                  </select>
                  <input value={b.text}
                         aria-label={`Button ${i + 1} text`}
                         onChange={e => set({ buttons: editing.buttons.map((x, j) => j === i ? { ...x, text: e.target.value } : x) })}
                         placeholder="Button text"
                         className="flex-1 min-w-[8rem] px-2 py-1 border border-[#D4B896] rounded bg-[#FFF1E3] text-xs" />
                  <CharCount n={b.text.length} max={LIMIT_BUTTON} />
                  <button onClick={() => set({ buttons: editing.buttons.filter((_, j) => j !== i) })}
                          aria-label={`Remove button ${i + 1}`}
                          className="p-1 text-red-500 hover:text-red-700"><Trash2 size={12} /></button>
                </div>
                {b.type === 'URL' && (
                  <input value={b.url}
                         aria-label={`Button ${i + 1} URL`}
                         onChange={e => set({ buttons: editing.buttons.map((x, j) => j === i ? { ...x, url: e.target.value } : x) })}
                         placeholder="https://…"
                         className="w-full px-2 py-1 border border-[#D4B896] rounded bg-[#FFF1E3] text-xs font-mono" />
                )}
                {b.type === 'PHONE_NUMBER' && (
                  <input value={b.phone_number}
                         aria-label={`Button ${i + 1} phone number`}
                         onChange={e => set({ buttons: editing.buttons.map((x, j) => j === i ? { ...x, phone_number: e.target.value } : x) })}
                         placeholder="+91…"
                         className="w-full px-2 py-1 border border-[#D4B896] rounded bg-[#FFF1E3] text-xs font-mono" />
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {!isMeta && (
        <label className="block text-xs text-[#6B5744]">
          Body — use <code className="bg-[#FFF1E3] px-1 rounded">{'{{name}}'}</code>-style placeholders
          <textarea value={editing.body} onChange={e => set({ body: e.target.value })} rows={4}
                    placeholder={'Hi {{name}}, thanks for dining at {{outlet}}! Your bill of ₹{{amount}} is settled.'}
                    className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm font-mono" />
        </label>
      )}

      {/* PREVIEW */}
      <div className="border-t border-[#E8D5C4] pt-3 space-y-1.5">
        <div className="text-xs font-semibold text-[#2D1B0E] flex items-center gap-1.5">
          <MessageSquare size={13} /> What the guest sees
        </div>
        <WhatsAppPreview
          header={isMeta ? previewHeader : ''}
          body={isMeta ? previewBody : editing.body}
          footer={isMeta ? editing.footer : ''}
          buttons={isMeta ? editing.buttons : []}
        />
      </div>

      {/* provider routing (local mode keeps today's fields; meta mode derives them) */}
      <div className="border-t border-[#E8D5C4] pt-3 space-y-2">
        <button onClick={() => setShowAdvanced(v => !v)}
                className="inline-flex items-center gap-1 text-xs font-medium text-[#6B5744] hover:text-[#2D1B0E]">
          {showAdvanced ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Delivery routing
        </button>
        {showAdvanced && (
          <div className="space-y-3">
            <label className="flex items-start gap-2 cursor-pointer text-xs text-[#6B5744]">
              <input type="checkbox" checked={editing.sendAsTemplate}
                     onChange={e => set({ sendAsTemplate: e.target.checked })} className="mt-0.5" />
              <span>
                <span className="font-medium text-[#2D1B0E]">Send as approved template</span>
                <span className="block text-[10px] text-[#8B7355] mt-0.5">
                  Routes proactive notifications through the provider&apos;s approved-template API (delivers anytime).
                  When off, the plain body is sent as free-form text, which Meta delivers only inside the guest&apos;s
                  24-hour reply window.
                </span>
              </span>
            </label>
            {isMeta ? (
              <div className="text-[11px] text-[#6B5744] bg-[#FFF8F0] border border-[#E8D5C4] rounded p-2">
                The name and language sent to WhatsApp come from the fields above — WhatsApp knows a message by its
                name and language together, so there is nothing to type twice. The order the variables go in is taken
                from the variable list above, which is what keeps the campaign screen and the approved message
                agreeing about what <code>{'{{1}}'}</code> means.
              </div>
            ) : (
              <div className="space-y-3 pl-1">
                <div className="grid sm:grid-cols-2 gap-3">
                  <label className="block text-xs text-[#6B5744]">
                    Provider template name
                    <input value={editing.providerTemplateName}
                           onChange={e => set({ providerTemplateName: e.target.value })}
                           placeholder="exact name approved on Meta / Interakt"
                           className={`mt-1 w-full px-3 py-2 border rounded bg-[#FFF1E3] text-sm font-mono ${
                             editing.sendAsTemplate && !editing.providerTemplateName.trim() ? 'border-red-400' : 'border-[#D4B896]'}`} />
                    {editing.sendAsTemplate && !editing.providerTemplateName.trim() && (
                      <span className="block text-[10px] text-red-600 mt-1">
                        Required when &ldquo;Send as approved template&rdquo; is on — without it the row falls back to
                        free-form text and never delivers as a template.
                      </span>
                    )}
                  </label>
                  <label className="block text-xs text-[#6B5744]">
                    Provider language
                    <input value={editing.providerLanguage}
                           onChange={e => set({ providerLanguage: e.target.value })}
                           placeholder="en_US (Meta) / en (Interakt)"
                           className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm font-mono" />
                  </label>
                </div>
                <label className="block text-xs text-[#6B5744]">
                  Order of the variables — their names in <code className="bg-[#FFF1E3] px-1 rounded">{'{{1}},{{2}}…'}</code> order
                  <input value={editing.paramOrder} onChange={e => set({ paramOrder: e.target.value })}
                         placeholder="e.g. req_number, department, approved_by"
                         className="mt-1 w-full px-3 py-2 border border-[#D4B896] rounded bg-[#FFF1E3] text-sm font-mono" />
                </label>
              </div>
            )}
          </div>
        )}
      </div>

      {/* validation verdict */}
      {checkResult && (
        <div className={`text-[11px] rounded p-2 border ${checkResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
          {checkResult.ok ? (
            <><CheckCircle2 size={11} className="inline mr-1" /> No problems found against Meta&apos;s rules. Meta&apos;s reviewer can still refuse it on content — this only proves the shape is right.</>
          ) : (
            <>
              <b>{checkResult.errors.length} problem(s) Meta would reject:</b>
              <ul className="list-disc pl-4 mt-0.5 space-y-0.5">{checkResult.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <label className="inline-flex items-center gap-1.5 text-xs text-[#6B5744] cursor-pointer">
          <input type="checkbox" checked={editing.isActive} onChange={e => set({ isActive: e.target.checked })} />
          Active
        </label>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <button onClick={onCancel} className="text-xs text-[#6B5744]">Cancel</button>
          {isMeta && (
            <button onClick={onCheck} disabled={busy}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#D4B896] text-[#6B5744] hover:bg-[#FFF1E3] text-sm rounded disabled:opacity-50">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Info size={12} />} Check against Meta&apos;s rules
            </button>
          )}
          <button onClick={onSave} disabled={saveDisabled}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#af4408] hover:bg-[#933807] text-white text-sm rounded disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            {isMeta ? 'Save draft' : 'Save template'}
          </button>
        </div>
      </div>
      {isMeta && (
        <p className="text-[10px] text-[#8B7355]">
          Saving stores the draft here. Nothing reaches Meta until you press <b>Submit to Meta</b> on the row.
        </p>
      )}
    </div>
  );
}
