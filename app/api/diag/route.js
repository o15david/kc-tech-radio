import { NextResponse, after } from 'next/server';
import { getNewsPool, kickBodyEnrichment, getEnrichDiag } from '../../../lib/ingest';

// TEMPORARY diagnostic (Nov 20, 2026): why does the article-body
// pass never publish stats in production while working locally?
// ?kick=1 starts a pass on this instance under after(); polling
// the plain route reports the pass lifecycle counters and the
// enrich stats as this instance sees them. Delete once understood.
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const url = new URL(request.url);
  const pool = await getNewsPool();
  if (url.searchParams.get('kick')) {
    const pass = kickBodyEnrichment(pool.items);
    let afterError = null;
    try {
      after(() => pass);
    } catch (err) {
      afterError = String(err);
    }
    return NextResponse.json({
      kicked: true,
      afterError,
      diag: getEnrichDiag(),
      enrich: pool.enrich || null,
    });
  }
  return NextResponse.json({ diag: getEnrichDiag(), enrich: pool.enrich || null });
}
