'use client';

/**
 * WHAT THE CONTRACTOR APPLIED (#78) — the editor, and the table that shows and
 * prints it.
 *
 * The three states come from the server and are never collapsed on screen:
 * a list, "nothing was applied" (said in words), or NOT RECORDED. An empty list
 * is shown as "not recorded" in red — never as "none" — because every visit
 * filed before this editor existed carries an empty list.
 *
 * The field list is imported from the server's own normaliser
 * (src/app/api/fssai/pest/_pest/chemicals.ts, which is kept free of database
 * imports for exactly this), so the form and the validation cannot disagree.
 */

import { Plus, Trash2 } from 'lucide-react';
import {
  PEST_CHEMICAL_FIELDS, PEST_CHEMICAL_METHODS, PEST_CHEMICALS_MAX_ROWS,
  type PestChemical, type PestChemicalsState,
} from '@/app/api/fssai/pest/_pest/chemicals';
import { FSSAI_PEST_TYPES } from '@/lib/fssai';
import { INPUT, LABEL, BTN_PLAIN, PT, PTH } from './pest-ui';

export type ChemRow = PestChemical;

export function blankChem(): ChemRow {
  return {
    name: '', active_ingredient: '', licence_no: '', batch: '', expiry: '', dilution: '',
    qty: '', uom: '', method: '', target_pest: '', area: '',
  };
}

export interface ChemValue {
  rows: ChemRow[];
  none: boolean;
  noneNote: string;
}

export function emptyChemValue(): ChemValue {
  return { rows: [blankChem()], none: false, noneNote: '' };
}

/** The body fields the API reads, from the editor's value. */
export function chemBody(v: ChemValue): { chemicals: ChemRow[]; chemicals_none: boolean; chemicals_none_note: string } {
  return {
    chemicals: v.none ? [] : v.rows,
    chemicals_none: v.none,
    chemicals_none_note: v.none ? v.noneNote : '',
  };
}

const fieldLabel = (k: keyof ChemRow) => PEST_CHEMICAL_FIELDS.find((f) => f.key === k)?.label || k;
const fieldMax = (k: keyof ChemRow) => PEST_CHEMICAL_FIELDS.find((f) => f.key === k)?.max || 200;

export function ChemicalsEditor({ value, onChange }: { value: ChemValue; onChange: (v: ChemValue) => void }) {
  const set = (i: number, k: keyof ChemRow, val: string) => {
    const rows = value.rows.map((r, j) => (j === i ? { ...r, [k]: val.slice(0, fieldMax(k)) } : r));
    onChange({ ...value, rows });
  };
  const input = (i: number, k: keyof ChemRow, extra: Record<string, unknown> = {}) => (
    <label className="block min-w-0">
      <span className={LABEL}>{fieldLabel(k)}{k === 'name' ? <span className="text-[#af4408]"> *</span> : null}</span>
      <input value={value.rows[i][k]} onChange={(e) => set(i, k, e.target.value)} className={INPUT} {...extra} />
    </label>
  );
  return (
    <div className="space-y-3">
      <label className="inline-flex flex-nowrap items-center gap-2 text-sm">
        <input
          type="checkbox" checked={value.none}
          onChange={(e) => onChange({ ...value, none: e.target.checked })}
          className="w-4 h-4 accent-[#af4408]"
        />
        Nothing was applied on this visit
      </label>
      {value.none ? (
        <label className="block">
          <span className={LABEL}>Why nothing was applied <span className="text-[#af4408]">*</span></span>
          <input
            value={value.noneNote} onChange={(e) => onChange({ ...value, noneNote: e.target.value.slice(0, 400) })}
            placeholder="Inspection only — monitoring points checked, no treatment needed" className={INPUT}
          />
        </label>
      ) : (
        <>
          <datalist id="pest-chem-methods">{PEST_CHEMICAL_METHODS.map((m) => <option key={m} value={m} />)}</datalist>
          <datalist id="pest-chem-targets">{FSSAI_PEST_TYPES.map((p) => <option key={p.key} value={p.label} />)}</datalist>
          {value.rows.map((r, i) => (
            <div key={i} className="border border-[#E8D5C4] rounded-lg p-3 space-y-2 bg-[#FFFCF8]">
              <div className="flex flex-nowrap items-center justify-between gap-2">
                <p className="text-xs font-semibold text-[#6B5744]">Product {i + 1}</p>
                <button
                  type="button"
                  onClick={() => onChange({ ...value, rows: value.rows.length > 1 ? value.rows.filter((_, j) => j !== i) : [blankChem()] })}
                  className="text-xs text-red-700 inline-flex flex-nowrap items-center gap-1"
                  aria-label={`Clear product ${i + 1}`}
                >
                  <Trash2 size={12} /> Clear
                </button>
              </div>
              <div className="grid sm:grid-cols-3 gap-2">
                {input(i, 'name', { placeholder: 'As printed on the container' })}
                {input(i, 'active_ingredient', { placeholder: 'e.g. Imidacloprid 2.15%' })}
                {input(i, 'licence_no', { placeholder: 'CIR-…' })}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {input(i, 'batch')}
                {input(i, 'expiry', { type: 'date' })}
                {input(i, 'dilution', { placeholder: '5 ml / L' })}
                {input(i, 'method', { list: 'pest-chem-methods' })}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {input(i, 'qty', { inputMode: 'decimal' })}
                {input(i, 'uom', { placeholder: 'ml, g, L' })}
                {input(i, 'target_pest', { list: 'pest-chem-targets' })}
                {input(i, 'area', { placeholder: 'Where it went down' })}
              </div>
            </div>
          ))}
          {value.rows.length < PEST_CHEMICALS_MAX_ROWS && (
            <button type="button" onClick={() => onChange({ ...value, rows: [...value.rows, blankChem()] })} className={BTN_PLAIN}>
              <Plus size={15} /> Add another product
            </button>
          )}
          <p className="text-[11px] text-[#8B7355]">
            Copy these from the technician&apos;s job sheet or the containers. The CIB&amp;RC registration number is printed on
            every pesticide label — an inspector asks for it. A blank line is ignored.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The chemicals of one visit, on screen and on paper. `print` switches to the
 * bordered paper style.
 */
export function ChemicalsTable({
  state, rows, noneNote, print, visitDate,
}: { state: PestChemicalsState | string; rows: ChemRow[]; noneNote?: string; print?: boolean; visitDate?: string }) {
  if (state === 'none_applied') {
    return <p className={print ? '' : 'text-sm'}>Nothing applied — {noneNote || 'no reason given'}</p>;
  }
  if (state !== 'listed' || !rows.length) {
    return (
      <p className={print ? 'font-semibold' : 'text-sm font-semibold text-red-700'}>
        NOT RECORDED — this visit does not say what was applied.
      </p>
    );
  }
  const th = print ? PTH : 'text-left font-semibold px-2 py-1.5';
  const td = print ? PT : 'px-2 py-1.5 align-top';
  return (
    <div className={print ? '' : 'overflow-x-auto'}>
      <table className={print ? 'w-full border-collapse' : 'w-full text-xs'}>
        <thead className={print ? '' : 'bg-[#FFF1E3] text-[#6B5744]'}>
          <tr>
            <th className={th}>Product</th>
            <th className={th}>Active ingredient</th>
            <th className={th}>CIB&amp;RC reg. no.</th>
            <th className={th}>Batch</th>
            <th className={th}>Expiry</th>
            <th className={th}>Dilution</th>
            <th className={th}>Qty</th>
            <th className={th}>Method</th>
            <th className={th}>Target</th>
            <th className={th}>Where applied</th>
          </tr>
        </thead>
        <tbody className={print ? '' : 'divide-y divide-[#E8D5C4]'}>
          {rows.map((c, i) => (
            <tr key={i}>
              <td className={td}>{c.name}</td>
              <td className={td}>{c.active_ingredient}</td>
              <td className={td}>{c.licence_no || <span className={print ? '' : 'text-red-700'}>not given</span>}</td>
              <td className={td}>{c.batch}</td>
              <td className={td}>
                {c.expiry}
                {/* Past its expiry ON THE DAY it was used — recorded as used (the
                    record says what happened), and flagged on screen and paper. */}
                {c.expiry && visitDate && c.expiry < visitDate
                  ? <span className={print ? 'block font-bold' : 'block font-semibold text-red-700'}>EXPIRED when used</span>
                  : null}
              </td>
              <td className={td}>{c.dilution}</td>
              <td className={td}>{[c.qty, c.uom].filter(Boolean).join(' ')}</td>
              <td className={td}>{c.method}</td>
              <td className={td}>{c.target_pest}</td>
              <td className={td}>{c.area}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
