'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '@/lib/api';
import { Utensils, Plus, Trash2, Loader2, X, Layers } from 'lucide-react';

interface TableRow {
  id: string;
  table_number: string;
  zone: string;       // = Floor (Ground Floor / First Floor / Rooftop)
  section: string;    // = free-text section code within the floor (FA / SA)
  seats: number;
  is_active: number;
  open_order_id: string | null;
  open_order_number: number | null;
}

/** Compose a section-prefixed table number: section "FA" + "1" → "FA1". A number
 *  that already carries letters (e.g. typed "FA1") is left untouched. */
function composeNumber(section: string, n: string): string {
  const s = section.trim();
  if (!s) return n;
  return /^\d+$/.test(n.trim()) ? s + n.trim() : n.trim();
}

/** Expand a bulk-entry string into individual table numbers. Accepts ranges
 *  ("1-20", "A1-A10"), comma/newline lists ("1,2,3"), and any mix
 *  ("1-10, 15, T1-T4"). Prefix must match on both ends of a range. De-duped. */
function parseTableNumbers(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (n: string) => { n = n.trim(); if (n && !seen.has(n)) { seen.add(n); out.push(n); } };
  for (const tok of input.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)) {
    const m = tok.match(/^([A-Za-z]*)\s*(\d+)\s*[-–]\s*([A-Za-z]*)\s*(\d+)$/);
    if (m && (m[3] === '' || m[1].toLowerCase() === m[3].toLowerCase())) {
      const prefix = m[1];
      let a = parseInt(m[2], 10), b = parseInt(m[4], 10);
      if (b < a) { const t = a; a = b; b = t; }
      if (b - a <= 500) { for (let i = a; i <= b; i++) add(prefix + i); continue; }
    }
    add(tok);
  }
  return out;
}

export default function TablesPage() {
  const [tables, setTables] = useState<TableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ table_number: '', zone: '', section: '', seats: 2 });
  const [edit, setEdit] = useState<TableRow | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulk, setBulk] = useState({ text: '', zone: '', section: '', seats: 2 });
  const bulkNumbers = useMemo(() => parseTableNumbers(bulk.text), [bulk.text]);
  // Preview the composed labels (FA1, FA2…) exactly as they'll be created —
  // de-duped AFTER composition so the count matches what the API actually makes
  // (e.g. section FA + "1-3, FA2" → FA1, FA2, FA3, not a phantom 4th).
  const bulkComposed = useMemo(() => [...new Set(bulkNumbers.map(n => composeNumber(bulk.section, n)))], [bulkNumbers, bulk.section]);

  // Group tables Floor → Section → tables, and flag any section that lands on
  // more than one floor (likely a typo the owner asked us to surface). Floor and
  // section are free text, so the maps use null-prototype objects — a table named
  // "__proto__"/"constructor" is then ordinary data, never a crash or a poison.
  const { grouped, floorNames, crossFloorSections } = useMemo(() => {
    const byFloor: Record<string, Record<string, TableRow[]>> = Object.create(null);
    const sectionFloors: Record<string, Set<string>> = Object.create(null);
    for (const t of tables) {
      const floor = t.zone || '';
      const sec = t.section || '';
      (byFloor[floor] ??= Object.create(null));
      (byFloor[floor][sec] ??= []).push(t);
      if (sec) (sectionFloors[sec] ??= new Set()).add(floor);
    }
    const crossFloorSections = Object.entries(sectionFloors)
      .filter(([, floors]) => floors.size > 1)
      .map(([sec, floors]) => ({ section: sec, floors: [...floors].map(f => f || '(no floor)') }));
    return { grouped: byFloor, floorNames: Object.keys(byFloor).sort(), crossFloorSections };
  }, [tables]);

  const load = useCallback(async () => {
    try {
      const r = await api('/api/dine-in/tables');
      const j = await r.json();
      setTables(j.items || []);
    } catch (_) {} finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function addTable() {
    if (!form.table_number.trim()) return;
    setSaving(true);
    try {
      // Single add: compose too, so typing Section "FA" + number "1" → "FA1".
      const body = { ...form, table_number: composeNumber(form.section, form.table_number) };
      const r = await api('/api/dine-in/tables', { method: 'POST', body });
      const j = await r.json();
      if (j.error) alert(j.error);
      else { setForm({ table_number: '', zone: form.zone, section: form.section, seats: form.seats }); await load(); }
    } finally { setSaving(false); }
  }

  async function createBulk() {
    if (!bulkNumbers.length) return;
    setSaving(true);
    try {
      const r = await api('/api/dine-in/tables', { method: 'POST', body: { table_numbers: bulkComposed, zone: bulk.zone, section: bulk.section, seats: bulk.seats } });
      const j = await r.json();
      if (j.error) { alert(j.error); return; }
      const msg = `Created ${j.created} table${j.created === 1 ? '' : 's'}.` +
        (j.skipped ? ` Skipped ${j.skipped} that already exist${j.skipped === 1 ? 's' : ''}${j.skippedNumbers?.length ? `: ${j.skippedNumbers.slice(0, 12).join(', ')}${j.skippedNumbers.length > 12 ? '…' : ''}` : ''}.` : '');
      setBulkOpen(false); setBulk({ text: '', zone: '', section: '', seats: 2 });
      await load();
      alert(msg);
    } finally { setSaving(false); }
  }

  async function saveEdit() {
    if (!edit) return;
    setSaving(true);
    try {
      const r = await api('/api/dine-in/tables', { method: 'PUT', body: edit });
      const j = await r.json();
      if (j.error) alert(j.error);
      else { setEdit(null); await load(); }
    } finally { setSaving(false); }
  }

  async function remove(t: TableRow) {
    if (!confirm(`Deactivate table ${t.table_number}?`)) return;
    const r = await api(`/api/dine-in/tables?id=${t.id}`, { method: 'DELETE' });
    const j = await r.json();
    if (j.error) alert(j.error); else load();
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-[#af4408]/10 rounded-lg"><Utensils className="w-6 h-6 text-[#af4408]" /></div>
        <div>
          <h1 className="text-2xl font-bold text-[#af4408]">Tables</h1>
          <p className="text-sm text-[#8B7355]">Set up your floors, sections and tables — e.g. section <b>FA</b> on the Ground Floor holds <b>FA1, FA2…</b></p>
        </div>
      </div>

      <div className="card mb-6 p-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-[#8B7355] mb-1">Floor</label>
          <input value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })}
            placeholder="Ground Floor / Rooftop" className="w-40 bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-[#8B7355] mb-1">Section</label>
          <input value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })}
            placeholder="FA / SA" className="w-24 bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-[#8B7355] mb-1">Table number</label>
          <input value={form.table_number} onChange={(e) => setForm({ ...form, table_number: e.target.value })}
            placeholder={form.section ? `${form.section.trim()}1 or 1` : 'e.g. 12'} className="w-28 bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-[#8B7355] mb-1">Seats</label>
          <input type="number" min={1} value={form.seats} onChange={(e) => setForm({ ...form, seats: Number(e.target.value) })}
            className="w-20 bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
        </div>
        <button onClick={addTable} disabled={saving || !form.table_number.trim()}
          className="flex items-center gap-2 bg-[#af4408] hover:bg-[#8a3506] disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Add table
        </button>
        <button onClick={() => { setBulk({ text: '', zone: form.zone, section: form.section, seats: form.seats }); setBulkOpen(true); }}
          className="flex items-center gap-2 border border-[#D4B896] text-[#af4408] hover:bg-[#FFF1E3] px-4 py-2 rounded-lg text-sm font-medium">
          <Layers size={16} /> Bulk add section
        </button>
      </div>

      {crossFloorSections.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 px-4 py-3 text-sm">
          <b>Check floor assignment:</b> {crossFloorSections.map(c => `section "${c.section}" is on ${c.floors.join(' & ')}`).join('; ')}. A section usually belongs to one floor — edit the odd tables if this isn&apos;t intended.
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-[#8B7355]">Loading…</div>
      ) : tables.length === 0 ? (
        <div className="card text-center py-12 text-[#8B7355]">No tables yet — add your first above.</div>
      ) : (
        <div className="space-y-6">
          {floorNames.map((floor) => {
            const sections = Object.keys(grouped[floor]).sort();
            const floorCount = sections.reduce((s, sec) => s + grouped[floor][sec].length, 0);
            return (
              <div key={`f:${floor}`} className="card p-4">
                <div className="flex items-baseline gap-2 mb-3 pb-2 border-b border-[#E8D5C4]">
                  <h2 className="text-lg font-bold text-[#2D1B0E]">{floor || 'No floor'}</h2>
                  <span className="text-xs text-[#8B7355]">{floorCount} table{floorCount === 1 ? '' : 's'} · {sections.filter(Boolean).length || 0} section{sections.filter(Boolean).length === 1 ? '' : 's'}</span>
                </div>
                <div className="space-y-4">
                  {sections.map((sec) => (
                    <div key={`s:${sec}`}>
                      <div className="text-xs font-semibold uppercase tracking-wide text-[#af4408] mb-2">
                        {sec ? `Section ${sec}` : 'No section'} <span className="text-[#8B7355] font-normal">· {grouped[floor][sec].length}</span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {grouped[floor][sec].map((t) => (
                          <div key={t.id} className="border border-[#E8D5C4] rounded-lg p-3 flex items-center justify-between bg-[#FFFBF3]">
                            <div>
                              <p className="font-bold text-[#2D1B0E]">{t.table_number}</p>
                              <p className="text-xs text-[#8B7355]">{t.seats} seats
                                {t.open_order_id && <span className="ml-1 text-amber-700">· occupied (#{t.open_order_number})</span>}</p>
                            </div>
                            <div className="flex gap-2">
                              <button onClick={() => setEdit(t)} className="text-xs text-[#af4408] hover:underline">Edit</button>
                              <button onClick={() => remove(t)} className="text-red-500 hover:text-red-700"><Trash2 size={16} /></button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {bulkOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => !saving && setBulkOpen(false)}>
          <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-semibold text-[#2D1B0E] flex items-center gap-2"><Layers size={18} className="text-[#af4408]" /> Bulk add a section</h2>
              <button onClick={() => setBulkOpen(false)}><X size={18} className="text-[#8B7355]" /></button>
            </div>
            <p className="text-xs text-[#8B7355] mb-3">Pick a Floor + Section, then enter the numbers as a range <code className="bg-[#FFF1E3] px-1 rounded">1-10</code> or list <code className="bg-[#FFF1E3] px-1 rounded">1, 2, 5</code>. With a Section, they become <code className="bg-[#FFF1E3] px-1 rounded">FA1, FA2…</code> Existing tables are skipped.</p>
            <div className="flex gap-3 mb-3">
              <div className="flex-1">
                <label className="block text-xs text-[#8B7355] mb-1">Floor (all)</label>
                <input value={bulk.zone} onChange={(e) => setBulk({ ...bulk, zone: e.target.value })}
                  placeholder="Ground Floor" className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
              </div>
              <div className="w-28">
                <label className="block text-xs text-[#8B7355] mb-1">Section (all)</label>
                <input value={bulk.section} onChange={(e) => setBulk({ ...bulk, section: e.target.value })}
                  placeholder="FA" className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
            <label className="block text-xs text-[#8B7355] mb-1">Numbers</label>
            <textarea value={bulk.text} onChange={(e) => setBulk({ ...bulk, text: e.target.value })} rows={2} autoFocus
              placeholder="e.g. 1-10"
              className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm font-mono" />
            <div className="flex gap-3 mt-3">
              <div className="w-24">
                <label className="block text-xs text-[#8B7355] mb-1">Seats (all)</label>
                <input type="number" min={1} value={bulk.seats} onChange={(e) => setBulk({ ...bulk, seats: Number(e.target.value) })}
                  className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="mt-3 text-xs text-[#8B7355] bg-[#FBF4DF] border border-[#E8D5C4] rounded-lg px-3 py-2 min-h-[38px]">
              {bulkComposed.length === 0 ? 'Nothing to add yet.' : (
                <><b className="text-[#2D1B0E]">{bulkComposed.length} table{bulkComposed.length === 1 ? '' : 's'}</b>{bulk.zone ? ` on ${bulk.zone}` : ''}: {bulkComposed.slice(0, 24).join(', ')}{bulkComposed.length > 24 ? ` … +${bulkComposed.length - 24} more` : ''}</>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setBulkOpen(false)} className="px-4 py-2 text-sm text-[#8B7355]">Cancel</button>
              <button onClick={createBulk} disabled={saving || !bulkComposed.length}
                className="flex items-center gap-2 bg-[#af4408] hover:bg-[#8a3506] text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Create {bulkComposed.length || ''} table{bulkComposed.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      )}

      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setEdit(null)}>
          <div className="bg-white border border-[#E8D5C4] rounded-xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-[#2D1B0E]">Edit table</h2>
              <button onClick={() => setEdit(null)}><X size={18} className="text-[#8B7355]" /></button>
            </div>
            <div className="space-y-3">
              <div><label className="block text-xs text-[#8B7355] mb-1">Table number</label>
                <input value={edit.table_number} onChange={(e) => setEdit({ ...edit, table_number: e.target.value })}
                  className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" /></div>
              <div className="flex gap-3">
                <div className="flex-1"><label className="block text-xs text-[#8B7355] mb-1">Floor</label>
                  <input value={edit.zone} onChange={(e) => setEdit({ ...edit, zone: e.target.value })}
                    placeholder="Ground Floor" className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" /></div>
                <div className="w-24"><label className="block text-xs text-[#8B7355] mb-1">Section</label>
                  <input value={edit.section || ''} onChange={(e) => setEdit({ ...edit, section: e.target.value })}
                    placeholder="FA" className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" /></div>
              </div>
              <div><label className="block text-xs text-[#8B7355] mb-1">Seats</label>
                <input type="number" min={1} value={edit.seats} onChange={(e) => setEdit({ ...edit, seats: Number(e.target.value) })}
                  className="w-full bg-[#FFF1E3] border border-[#D4B896] rounded-lg px-3 py-2 text-sm" /></div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setEdit(null)} className="px-4 py-2 text-sm text-[#8B7355]">Cancel</button>
              <button onClick={saveEdit} disabled={saving}
                className="bg-[#af4408] hover:bg-[#8a3506] text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
