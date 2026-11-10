'use client';

/**
 * /store-requisitions/print?ids=<id>,<id>…&ctx=<tab · department>
 *
 * The Store desk's print (owner ruling #126): a card's Print sends one id,
 * "Print all" sends every requisition on the tab in view, in the desk's order.
 * Under /store-requisitions so it opens for exactly the people who can open the
 * desk (canAccessPage prefix rule). The slip itself is RequisitionPrintSheet.
 */

import { use } from 'react';
import RequisitionPrintSheet from './RequisitionPrintSheet';

export default function StoreRequisitionPrintPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = use(searchParams);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || '';
  return <RequisitionPrintSheet ids={one(sp.ids).split(',')} context={one(sp.ctx)} />;
}
