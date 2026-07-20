'use client';

import { useContext } from 'react';
import { Menu } from 'lucide-react';
import { CaptainUI } from '../CaptainShell';
import CustomerRequestsPanel from '@/components/CustomerRequestsPanel';

/**
 * Captain → Orders & Requests. The dedicated view for customer QR-menu orders
 * (approve/reject/modify) + table service requests (accept/done), scoped to
 * THIS captain's tables (+ unclaimed). Reached from the sidebar "Requests" tab;
 * the sidebar badge + toast notify the captain when new ones arrive.
 */
export default function CaptainRequestsPage() {
  const { openTables } = useContext(CaptainUI);
  return (
    <div className="pb-24 lg:pb-6">
      <div className="md:hidden flex items-center gap-2 px-4 pt-4 -mb-2">
        <button onClick={openTables} className="p-2 -ml-2 rounded-lg bg-white text-[#2D1B0E] border border-[#E8D5C4] active:scale-95" aria-label="Open tables">
          <Menu className="w-5 h-5" />
        </button>
        <span className="font-bold text-[#2D1B0E]">Orders &amp; Requests</span>
      </div>
      <CustomerRequestsPanel variant="captain" />
    </div>
  );
}
