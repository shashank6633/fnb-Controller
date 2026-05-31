/**
 * POST /api/party-requisitions/parse-fp
 *
 * Accepts a multipart upload of an AKAN Function Prospectus PDF (`file`
 * field), runs it through the FP parser, and pre-computes a material
 * requisition via the estimator. Returns the structured parse + the
 * resolved materials so the UI can pre-fill a Party Requisition form.
 *
 * Auth: any signed-in user.
 */

import { parseAkanFP } from '@/lib/fp-parser';
import { estimateMaterialsForFP, type MaterialEstimate } from '@/lib/fp-estimator';
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const RAW_TEXT_CAP = 5000;

export async function POST(req: Request) {
  try {
    // ── 1. Auth ──
    const user = await getCurrentUser();
    if (!user) {
      return Response.json({ error: 'Sign in required' }, { status: 401 });
    }

    // ── 2. Read file ──
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return Response.json({ error: 'Expected multipart/form-data' }, { status: 400 });
    }

    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return Response.json({ error: 'Missing "file" field' }, { status: 400 });
    }

    const blob = file as File;
    if (blob.size === 0) {
      return Response.json({ error: 'Uploaded file is empty' }, { status: 400 });
    }

    const arrayBuf = await blob.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    // ── 3. Parse ──
    let parsed;
    try {
      parsed = await parseAkanFP(buffer);
    } catch (e: any) {
      return Response.json(
        { error: `Failed to parse PDF: ${e?.message || String(e)}` },
        { status: 400 },
      );
    }

    const warnings: string[] = [];
    if (!parsed.event_date) warnings.push('Could not extract event date');
    if (!parsed.guest_count) warnings.push('Could not extract guest count');
    if (parsed.menu.veg_starters.length + parsed.menu.nonveg_starters.length +
        parsed.menu.veg_mains.length + parsed.menu.nonveg_mains.length === 0) {
      warnings.push('No menu items extracted — PDF format may have changed');
    }

    // ── 4. Estimate materials ──
    let materials: MaterialEstimate[] = [];
    try {
      materials = await estimateMaterialsForFP(getDb(), parsed);
    } catch (e: any) {
      warnings.push(`Estimator failed: ${e?.message || String(e)}`);
      materials = [];
    }

    // ── 5. Trim raw_text in response ──
    const responseParsed = {
      ...parsed,
      raw_text: parsed.raw_text.length > RAW_TEXT_CAP
        ? parsed.raw_text.slice(0, RAW_TEXT_CAP) + '\n…[truncated]'
        : parsed.raw_text,
    };

    return Response.json({
      parsed: responseParsed,
      materials,
      warnings,
    });
  } catch (error: any) {
    return Response.json(
      { error: error?.message || 'Unknown error parsing FP' },
      { status: 500 },
    );
  }
}
