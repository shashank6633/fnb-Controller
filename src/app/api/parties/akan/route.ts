import { getDb, generateId } from '@/lib/db';

const AKAN_API_BASE = 'http://localhost:5001/api';

// Fetch confirmed parties from Akan Party Manager whose event date has passed
export async function GET() {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Try to fetch from Akan Party Manager
    let akanParties: any[] = [];
    try {
      // Fetch confirmed parties with date up to today
      const res = await fetch(
        `${AKAN_API_BASE}/parties?status=Confirmed&dateTo=${today}&limit=500`,
        {
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(5000), // 5s timeout
        }
      );

      if (res.ok) {
        const json = await res.json();
        akanParties = (json.parties || []).filter((p: any) => {
          // Only include parties whose date has passed
          if (!p.date || p.date.startsWith('TBC')) return false;
          return p.date <= today;
        });
      }
    } catch (fetchErr: any) {
      // Akan Party Manager might not be running
      return Response.json({
        error: 'Could not connect to Akan Party Manager. Make sure the backend is running on port 5001.',
        parties: [],
        connected: false,
      }, { status: 200 });
    }

    // Check which ones are already imported
    const db = getDb();
    const existingIds = new Set(
      (db.prepare('SELECT akan_unique_id FROM parties WHERE akan_unique_id != ""').all() as any[])
        .map((r: any) => r.akan_unique_id)
    );

    const partiesWithStatus = akanParties.map((p: any) => ({
      uniqueId: p.uniqueId || '',
      date: p.date || '',
      hostName: p.hostName || '',
      company: p.company || '',
      phoneNumber: p.phoneNumber || '',
      place: p.place || '',
      occasionType: p.occasionType || '',
      packageSelected: p.packageSelected || '',
      expectedPax: p.expectedPax || '',
      confirmedPax: p.confirmedPax || '',
      finalRate: p.finalRate || '',
      finalTotalAmount: p.finalTotalAmount || 0,
      partyTime: p.partyTime || '',
      status: p.status || '',
      rowIndex: p.rowIndex || 0,
      alreadyImported: existingIds.has(p.uniqueId || ''),
    }));

    return Response.json({
      parties: partiesWithStatus,
      connected: true,
      total: partiesWithStatus.length,
      imported: partiesWithStatus.filter((p: any) => p.alreadyImported).length,
      available: partiesWithStatus.filter((p: any) => !p.alreadyImported).length,
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// Import selected Akan parties into F&B Controller
export async function POST(request: Request) {
  try {
    const db = getDb();
    const body = await request.json();
    const { parties } = body;

    if (!parties || !Array.isArray(parties) || parties.length === 0) {
      return Response.json({ error: 'parties array is required' }, { status: 400 });
    }

    const results = { success: 0, skipped: 0, errors: [] as string[] };

    const importParties = db.transaction(() => {
      for (const p of parties) {
        // Skip if already imported
        if (p.uniqueId) {
          const existing = db.prepare('SELECT id FROM parties WHERE akan_unique_id = ?').get(p.uniqueId) as any;
          if (existing) {
            results.skipped++;
            continue;
          }
        }

        const id = generateId();
        const guestCount = parseInt(p.confirmedPax) || parseInt(p.expectedPax) || 0;
        const partyName = [p.hostName, p.company].filter(Boolean).join(' - ') || `Party ${p.uniqueId}`;

        db.prepare(`
          INSERT INTO parties (id, name, date, party_type, venue, floor, guest_count, status, notes,
            akan_unique_id, akan_host_name, akan_company, akan_phone, akan_occasion, akan_package, akan_final_amount, akan_row_index,
            created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          id,
          partyName,
          p.date || new Date().toISOString().split('T')[0],
          'mixed',
          p.place || '',
          '',
          guestCount,
          'completed', // Past parties come as completed
          `Imported from Akan Party Manager | ${p.occasionType || ''} | Time: ${p.partyTime || 'N/A'}`,
          p.uniqueId || '',
          p.hostName || '',
          p.company || '',
          p.phoneNumber || '',
          p.occasionType || '',
          p.packageSelected || '',
          parseFloat(p.finalTotalAmount) || 0,
          parseInt(p.rowIndex) || 0,
        );

        results.success++;
      }
    });

    importParties();

    return Response.json(results);
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
