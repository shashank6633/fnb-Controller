/**
 * Web NFC helpers for STAFF screens (docs/valet/DESIGN.md §6b).
 *
 * Web NFC exists only in Chrome on Android, over HTTPS. Everything here is
 * capability-detected: where it is missing the callers hide their NFC buttons
 * and the QR / typed alternatives remain. A guest's or staff member's ordinary
 * NFC TAP never comes through here — the phone opens the URL by itself.
 * Not yet exercised on a physical device (see docs/valet/HARDWARE.md).
 */
import { useSyncExternalStore } from 'react';

interface NdefRecord { recordType: string; data?: DataView; encoding?: string }
interface NdefReadingEvent extends Event { serialNumber: string; message: { records: NdefRecord[] } }
interface NdefReader {
  scan(opts?: { signal?: AbortSignal }): Promise<void>;
  write(msg: { records: { recordType: 'url'; data: string }[] }, opts?: { overwrite?: boolean; signal?: AbortSignal }): Promise<void>;
  onreading: ((e: NdefReadingEvent) => void) | null;
  onreadingerror: ((e: Event) => void) | null;
}
type NdefCtor = new () => NdefReader;

function ctor(): NdefCtor | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { NDEFReader?: NdefCtor }).NDEFReader ?? null;
}

/** True only where the browser can read/write NFC from a web page. */
export const webNfcSupported = (): boolean => ctor() !== null && window.isSecureContext;

// Browser-only facts that never change while the page is open, read without a
// hydration mismatch: the server render sees the fallback, the browser the truth.
const never = () => () => {};
export const useWebNfc = (): boolean => useSyncExternalStore(never, webNfcSupported, () => false);
export const useOrigin = (): string => useSyncExternalStore(never, () => window.location.origin, () => '');

/** The key-tag reference inside a sticker URL (…/valet/attendant?nfc=<ref>), or ''. */
export function refFromUrl(url: string): string {
  try { return new URL(url).searchParams.get('nfc') || ''; } catch { return ''; }
}

/** Wait for ONE sticker and return its first URL record + chip serial. */
export async function readOnce(timeoutMs = 30_000): Promise<{ url: string; serial: string }> {
  const C = ctor();
  if (!C) throw new Error('This phone\'s browser cannot read NFC. Use the camera scan or type the tag number.');
  const reader = new C();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await new Promise((resolve, reject) => {
      reader.onreading = (e) => {
        const rec = e.message.records.find(r => r.recordType === 'url' || r.recordType === 'absolute-url');
        const url = rec?.data ? new TextDecoder(rec.encoding || 'utf-8').decode(rec.data) : '';
        if (!url) { reject(new Error('That NFC tag has no valet link on it.')); return; }
        resolve({ url, serial: e.serialNumber || '' });
      };
      reader.onreadingerror = () => reject(new Error('Could not read that tag — hold it still against the back of the phone.'));
      ac.signal.addEventListener('abort', () => reject(new Error('No tag was tapped. Try again.')));
      reader.scan({ signal: ac.signal }).catch(reject);
    });
  } finally { clearTimeout(timer); ac.abort(); }
}

/** Write one URL record to the next sticker held to the phone. */
export async function writeUrl(url: string, timeoutMs = 30_000): Promise<void> {
  const C = ctor();
  if (!C) throw new Error('This browser cannot write NFC. Use an NFC app (e.g. NXP TagWriter) with the link instead.');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try { await new C().write({ records: [{ recordType: 'url', data: url }] }, { overwrite: true, signal: ac.signal }); }
  finally { clearTimeout(timer); }
}
