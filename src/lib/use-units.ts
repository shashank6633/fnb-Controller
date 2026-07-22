'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/** Base measure units — the costing engine's conversions understand exactly
 *  these, so recipe-unit dropdowns must stay restricted to this set. */
export const BASE_UNIT_OPTIONS = ['kg', 'g', 'L', 'ml', 'pcs'];

/** Fallback purchase-unit list (mirrors the built-in registry) shown until
 *  /api/units loads — and kept if it fails. */
export const FALLBACK_PURCHASE_UNITS = [
  ...BASE_UNIT_OPTIONS,
  'BTL', 'CASE', 'PKT', 'TIN', 'CAN', 'JAR', 'BOX', 'BAG', 'BUNCH', 'TRAY',
];

/**
 * Purchase-unit dropdown options sourced from the Unit Registry (/units page):
 * base measure units first, then EVERY registry unit — including custom ones
 * like a new "TRAY = 30 pcs". Purchase units are bridged to recipe units via
 * the material's pack_size, so any registry label is safe to offer here.
 */
export function usePurchaseUnitOptions(): string[] {
  const [opts, setOpts] = useState<string[]>(FALLBACK_PURCHASE_UNITS);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api('/api/units');
        if (!r.ok) return;
        const j = await r.json().catch(() => ({}));
        const rows: any[] = Array.isArray(j.units) ? j.units : [];
        if (!alive || !rows.length) return;
        const seen = new Set(BASE_UNIT_OPTIONS.map(u => u.toLowerCase()));
        const extras: string[] = [];
        for (const u of rows) {
          const label = String(u.label || u.key || '').trim();
          if (!label || seen.has(label.toLowerCase())) continue;
          seen.add(label.toLowerCase());
          extras.push(label);
        }
        setOpts([...BASE_UNIT_OPTIONS, ...extras]);
      } catch {
        /* registry unavailable — keep the fallback list */
      }
    })();
    return () => { alive = false; };
  }, []);
  return opts;
}
