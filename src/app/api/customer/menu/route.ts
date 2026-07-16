import { getDb } from '@/lib/db';
import { resolveTableByToken, buildCustomerMenu, getCustomerMenuDesign, otpAppliesToTable } from '@/lib/customer';
import { otpChannelReady } from '@/lib/customer-otp';

/**
 * GET /api/customer/menu?t=<qr_token>
 *
 * PUBLIC (no staff session) — the customer scans the table's QR standee, which
 * opens /menu?t=<token>. This returns everything the design app needs to boot:
 * the resolved table, brand name, and the full menu in the design's shape.
 *
 * Scoped entirely by the table's qr_token; an unknown/inactive token → 404.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get('t') || url.searchParams.get('table') || '';
    const table = resolveTableByToken(token);
    if (!table) {
      return Response.json({ ok: false, error: 'This QR code is not linked to a table. Please ask our staff.' }, { status: 404 });
    }

    const db = getDb();
    const brandRow = db.prepare("SELECT value FROM settings WHERE key = 'business_name'").get() as any;
    const brand = { name: (brandRow?.value || 'Akan').toString() };

    // How the customer menu presents categories + which ordering workflow runs —
    // set on Settings → Customer Menu Page Design. otpReady tells the client
    // whether the WhatsApp OTP step can actually run (provider + template set);
    // when false the guest-details page still captures name+mobile but skips
    // the code screen (orders fall back to captain approval server-side).
    // otpApplies = is THIS table inside the admin's OTP scope (mirrors the
    // orders route's enforcement so the client shows the right variant:
    // mandatory gate vs skippable ask). The raw scope lists stay server-side.
    const fullDesign = getCustomerMenuDesign();
    const { otpScope: _scope, ...designPublic } = fullDesign;
    const design = {
      ...designPublic,
      otpReady: otpChannelReady(),
      otpApplies: otpAppliesToTable(fullDesign, { id: table.id, zone: table.zone, section: table.section }),
    };

    const menu = buildCustomerMenu(table.outlet_id);

    return Response.json({
      ok: true,
      table: { id: table.id, number: table.table_number, zone: table.zone, seats: table.seats },
      brand,
      design,
      menu,
    }, {
      // Menu can be cached briefly at the edge/browser; it changes rarely.
      headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' },
    });
  } catch (e: any) {
    console.error('[/api/customer/menu GET]', e);
    return Response.json({ ok: false, error: 'Could not load the menu.' }, { status: 500 });
  }
}
