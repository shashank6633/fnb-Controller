'use client';

/**
 * Audit log viewer — admin-only.
 * Every high-value action (PO approve/reject, requisition acknowledge,
 * admin reset) writes an immutable audit_events row. This page lets you
 * filter by event type, entity, actor, or date.
 */

import { useEffect, useMemo, useState } from 'react';
import { History, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { fmtIST } from '@/lib/format-date';

interface Evt {
  id: string; event_type: string; entity_type: string; entity_id: string;
  actor_email: string; outlet_id?: string;
  before_json?: string | null; after_json?: string | null;
  note?: string; created_at: string;
}
interface Resp {
  total: number; returned: number;
  filters: { event_types: string[]; entity_types: string[]; actors: string[] };
  events: Evt[];
}

const EVENT_TONE: Record<string, string> = {
  'po.approve':            'bg-emerald-100 text-emerald-700',
  'po.reject':             'bg-red-100 text-red-700',
  'po.edit':               'bg-amber-100 text-amber-800',
  'requisition.acknowledge': 'bg-blue-100 text-blue-700',
  'admin.reset':           'bg-red-100 text-red-800',
};

const today = () => new Date().toISOString().slice(0, 10);
const minusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

export default function AuditPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [eventType, setEventType] = useState('');
  const [entityType, setEntityType] = useState('');
  const [actor, setActor] = useState('');
  const [from, setFrom] = useState(minusDays(30));
  const [to, setTo] = useState(today());
  const [expanded, setExpanded] = useState<string | null>(null);

  const reload = () => {
    setLoading(true); setError('');
    const qs = new URLSearchParams();
    if (eventType) qs.set('event_type', eventType);
    if (entityType) qs.set('entity_type', entityType);
    if (actor) qs.set('actor', actor);
    if (from) qs.set('from', from);
    if (to)   qs.set('to', to);
    qs.set('limit', '500');
    fetch(`/api/audit?${qs}`)
      .then(async r => r.ok ? r.json() : Promise.reject(await r.text()))
      .then(setData)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(reload, [eventType, entityType, actor, from, to]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <History className="text-[#af4408]" size={24} />
        <div>
          <h1 className="text-xl font-semibold text-[#2D1B0E]">Audit Log</h1>
          <p className="text-xs text-[#8B7355]">
            Append-only record of every high-value action (PO approval, resets, acknowledgments).
            {data && <> · <strong className="text-[#2D1B0E]">{data.total.toLocaleString('en-IN')}</strong> total events captured.</>}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white border border-[#E8D5C4] rounded-xl p-4 flex flex-wrap items-end gap-3">
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          Event type
          <select value={eventType} onChange={e => setEventType(e.target.value)}
                  className="px-2 py-1.5 border border-[#D4B896] rounded text-sm min-w-[160px]">
            <option value="">All</option>
            {data?.filters.event_types.map(t => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          Entity type
          <select value={entityType} onChange={e => setEntityType(e.target.value)}
                  className="px-2 py-1.5 border border-[#D4B896] rounded text-sm min-w-[140px]">
            <option value="">All</option>
            {data?.filters.entity_types.map(t => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          Actor
          <select value={actor} onChange={e => setActor(e.target.value)}
                  className="px-2 py-1.5 border border-[#D4B896] rounded text-sm min-w-[180px]">
            <option value="">Anyone</option>
            {data?.filters.actors.map(a => <option key={a}>{a}</option>)}
          </select>
        </label>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          From <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="px-2 py-1.5 border border-[#D4B896] rounded text-sm" />
        </label>
        <label className="text-xs text-[#6B5744] flex flex-col gap-1">
          To <input type="date" value={to} onChange={e => setTo(e.target.value)} className="px-2 py-1.5 border border-[#D4B896] rounded text-sm" />
        </label>
        <div className="ml-auto text-xs text-[#6B5744]">
          {loading ? <Loader2 className="animate-spin" size={14} /> : data ? `${data.returned} event(s)` : ''}
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm">{error}</div>}

      <div className="bg-white border border-[#E8D5C4] rounded-xl overflow-hidden">
        {!data || data.events.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#8B7355]">
            {loading ? 'Loading…' : 'No events match these filters.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[900px]">
            <thead className="bg-[#FFF1E3] text-[#6B5744]">
              <tr>
                <th className="text-left py-2 px-3 font-medium w-32">When</th>
                <th className="text-left py-2 px-3 font-medium">Event</th>
                <th className="text-left py-2 px-3 font-medium">Entity</th>
                <th className="text-left py-2 px-3 font-medium">Actor</th>
                <th className="text-left py-2 px-3 font-medium">Note</th>
                <th className="w-6"></th>
              </tr>
            </thead>
            <tbody>
              {data.events.map(e => {
                const open = expanded === e.id;
                const hasDetail = !!(e.before_json || e.after_json);
                return (
                  <>
                    <tr key={e.id} className="border-t border-[#E8D5C4]/50 hover:bg-[#FFF8F0]/50 align-top cursor-pointer"
                        onClick={() => hasDetail && setExpanded(open ? null : e.id)}>
                      <td className="py-1.5 px-3 font-mono text-[#6B5744] whitespace-nowrap">{fmtIST(e.created_at)}</td>
                      <td className="py-1.5 px-3">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${EVENT_TONE[e.event_type] || 'bg-[#FFF1E3] text-[#6B5744]'}`}>
                          {e.event_type}
                        </span>
                      </td>
                      <td className="py-1.5 px-3">
                        <div className="text-[#2D1B0E]">{e.entity_type}</div>
                        <div className="text-[10px] font-mono text-[#8B7355] truncate max-w-[180px]">{e.entity_id}</div>
                      </td>
                      <td className="py-1.5 px-3 text-[#6B5744]">{e.actor_email || '—'}</td>
                      <td className="py-1.5 px-3 text-[#6B5744] max-w-[280px] truncate">{e.note || '—'}</td>
                      <td className="py-1.5 px-2 text-[#8B7355]">
                        {hasDetail && (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
                      </td>
                    </tr>
                    {open && hasDetail && (
                      <tr className="bg-[#FFF8F0]"><td colSpan={6} className="px-4 py-2">
                        <div className="grid grid-cols-2 gap-3 text-[10px]">
                          {e.before_json && (
                            <div>
                              <div className="font-semibold text-red-700 mb-1">BEFORE</div>
                              <pre className="bg-white border border-red-200 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(JSON.parse(e.before_json), null, 2)}</pre>
                            </div>
                          )}
                          {e.after_json && (
                            <div>
                              <div className="font-semibold text-emerald-700 mb-1">AFTER</div>
                              <pre className="bg-white border border-emerald-200 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(JSON.parse(e.after_json), null, 2)}</pre>
                            </div>
                          )}
                        </div>
                      </td></tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
