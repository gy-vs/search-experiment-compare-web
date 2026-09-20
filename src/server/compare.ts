import type {
  DeltaEntry,
  QueryResultPayload,
  RankedDoc,
  SideOutcome,
  StatsPayload,
} from '../shared/types.js';

export function compareQuery(
  index: number,
  query: string,
  durationMs: number,
  a: SideOutcome,
  b: SideOutcome,
): QueryResultPayload {
  const comparable = a.status === 'ok' && b.status === 'ok';
  const deltas: DeltaEntry[] = [];
  if (comparable) {
    const rankOf = (results: RankedDoc[]) => {
      const map = new Map<string, number>();
      for (const doc of results) map.set(doc.docId, doc.rank);
      return map;
    };
    const rankA = rankOf(a.results);
    const rankB = rankOf(b.results);
    const union = new Set<string>([...rankA.keys(), ...rankB.keys()]);
    const bestRank = (docId: string) =>
      Math.min(rankA.get(docId) ?? Number.POSITIVE_INFINITY, rankB.get(docId) ?? Number.POSITIVE_INFINITY);
    for (const docId of [...union].sort((x, y) => bestRank(x) - bestRank(y) || (x < y ? -1 : 1))) {
      const ra = rankA.get(docId) ?? null;
      const rb = rankB.get(docId) ?? null;
      deltas.push({
        docId,
        rankA: ra,
        rankB: rb,
        delta: ra !== null && rb !== null ? ra - rb : null,
        note: ra === null ? 'only_b' : rb === null ? 'only_a' : undefined,
      });
    }
  }
  return { index, query, durationMs, a, b, comparable, deltas };
}

export function hasTie(side: SideOutcome): boolean {
  return side.status === 'ok' && side.results.some((doc) => doc.tiedWith.length > 0);
}

/** Denominators are carried explicitly so the UI can always show what a fraction is over. */
export function computeStats(totalQueries: number, results: (QueryResultPayload | null)[]): StatsPayload {
  let comparable = 0;
  let failedA = 0;
  let failedB = 0;
  let bothFailed = 0;
  let onlySide = 0;
  let bothEmpty = 0;
  let comparedDocs = 0;
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;
  let tieQueries = 0;
  let absDeltaSum = 0;

  for (const result of results) {
    if (!result) continue;
    const aFail = result.a.status === 'error';
    const bFail = result.b.status === 'error';
    if (aFail) failedA += 1;
    if (bFail) failedB += 1;
    if (aFail && bFail) bothFailed += 1;
    if (!result.comparable) continue; // stats only use completed, both-valid queries

    comparable += 1;
    const aOk = result.a.status === 'ok' ? result.a.results : [];
    const bOk = result.b.status === 'ok' ? result.b.results : [];
    const aEmpty = aOk.length === 0;
    const bEmpty = bOk.length === 0;
    if (aEmpty && bEmpty) bothEmpty += 1;
    else if (aEmpty || bEmpty) onlySide += 1;
    if (hasTie(result.a) || hasTie(result.b)) tieQueries += 1;

    for (const delta of result.deltas) {
      if (delta.delta === null) continue; // missing on one side is not a paired doc
      comparedDocs += 1;
      absDeltaSum += Math.abs(delta.delta);
      if (delta.delta > 0) improved += 1; // B places it higher
      else if (delta.delta < 0) regressed += 1;
      else unchanged += 1;
    }
  }

  return {
    totalQueries,
    comparable,
    failedA,
    failedB,
    bothFailed,
    onlySide,
    bothEmpty,
    comparedDocs,
    improved,
    regressed,
    unchanged,
    avgAbsDelta: comparedDocs > 0 ? Math.round((absDeltaSum / comparedDocs) * 100) / 100 : null,
    tieQueries,
  };
}
