'use client';

/**
 * /requisitions/print?ids=<id>
 *
 * The Print button in the Requisitions detail panel (owner ruling #126: "Also a
 * Print button on Requisitions", so the staff who raised a request, HODs and
 * managers can print without the Store desk). Under /requisitions so it opens
 * for exactly the people who can open that page; the figures come from the
 * same visibility-filtered read. The slip is the Store desk's — one layout.
 */

import { use } from 'react';
import RequisitionPrintSheet from '../../store-requisitions/print/RequisitionPrintSheet';

export default function RequisitionPrintPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = use(searchParams);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || '';
  return <RequisitionPrintSheet ids={one(sp.ids).split(',')} />;
}
