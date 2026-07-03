'use client';

import CustomerRequestsPanel from '@/components/CustomerRequestsPanel';

// Full-page board of incoming QR-menu orders + table service requests.
// The same panel is embedded at the top of the Captain page (variant="embed").
export default function RequestsBoardPage() {
  return <CustomerRequestsPanel variant="page" />;
}
