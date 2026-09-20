import type { RankConfig, RankedDoc, SideOutcome } from '../shared/types.js';

export interface CorpusDoc {
  id: string;
  title: string;
  tags: string[];
  body: string;
}

export interface CorpusRevision {
  revision: number;
  createdAt: string;
  docs: CorpusDoc[];
}

export interface CorpusSnapshot {
  id: string;
  revision: number;
  createdAt: string;
  docs: CorpusDoc[]; // frozen copy — reindexing the live corpus never mutates this
}

const seedDocs: CorpusDoc[] = [
  { id: 'd-alpha', title: 'Alpha ranking guide', tags: ['alpha', 'ranking'], body: 'alpha primary notes for the workbench' },
  { id: 'd-alpha-dup', title: 'Alpha ranking notes', tags: ['alpha'], body: 'tie checking copy' },
  { id: 'd-beta', title: 'Beta signal overview', tags: ['beta', 'signals'], body: 'beta secondary signal review' },
  { id: 'd-beta-2', title: 'Beta notes', tags: ['beta'], body: 'more beta material' },
  { id: 'd-shipping', title: 'Shipping policy', tags: ['policy'], body: 'orders and shipping handling' },
  { id: 'd-ship-faq', title: 'Shipping FAQ', tags: ['shipping', 'faq'], body: 'common shipping questions' },
  { id: 'd-empty', title: 'Unrelated', tags: ['misc'], body: 'nothing of interest here' },
];

export class CorpusStore {
  private revisions: CorpusRevision[] = [];
  private snapshots = new Map<string, CorpusSnapshot>();
  private snapshotSeq = 0;
  private current = 0;

  constructor(initialDocs: CorpusDoc[] = seedDocs) {
    this.revisions.push({ revision: 1, createdAt: new Date(0).toISOString(), docs: cloneDocs(initialDocs) });
  }

  get currentRevision(): number {
    return this.current + 1;
  }

  listRevisions(): { revision: number; createdAt: string; docCount: number }[] {
    return this.revisions.map(({ revision, createdAt, docs }) => ({ revision, createdAt, docCount: docs.length }));
  }

  getRevision(revision: number): CorpusRevision | undefined {
    return this.revisions.find((entry) => entry.revision === revision);
  }

  /** Publish a new index revision. Existing snapshots stay on the old bytes. */
  reindex(mutate: (docs: CorpusDoc[]) => CorpusDoc[]): number {
    const next = cloneDocs(mutate(this.revisions[this.current].docs));
    const revision = this.revisions.length + 1;
    this.revisions.push({ revision, createdAt: new Date().toISOString(), docs: next });
    this.current = this.revisions.length - 1;
    return revision;
  }

  snapshot(revision?: number): CorpusSnapshot {
    const target = revision ?? this.currentRevision;
    const source = this.revisions.find((entry) => entry.revision === target);
    if (!source) throw new UnknownRevisionError(target);
    this.snapshotSeq += 1;
    const id = `snap-${source.revision}-${this.snapshotSeq}`;
    const snapshot: CorpusSnapshot = {
      id,
      revision: source.revision,
      createdAt: new Date().toISOString(),
      docs: Object.freeze(cloneDocs(source.docs)) as CorpusDoc[],
    };
    this.snapshots.set(id, snapshot);
    return snapshot;
  }

  hasSnapshot(id: string): boolean {
    return this.snapshots.has(id);
  }

  getSnapshot(id: string): CorpusSnapshot | undefined {
    return this.snapshots.get(id);
  }

  /** Simulate snapshot GC: returns the ids that were still referenced. */
  reclaim(unreferencedOnly: (snapshot: CorpusSnapshot) => boolean): string[] {
    const reclaimed: string[] = [];
    for (const [id, snapshot] of this.snapshots) {
      if (unreferencedOnly(snapshot)) {
        this.snapshots.delete(id);
        reclaimed.push(id);
      }
    }
    return reclaimed;
  }
}

export class UnknownRevisionError extends Error {
  constructor(readonly revision: number) {
    super(`unknown corpus revision: ${revision}`);
  }
}

function cloneDocs(docs: CorpusDoc[]): CorpusDoc[] {
  return docs.map((doc) => ({ ...doc, tags: [...doc.tags] }));
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Deterministic toy ranker. Scores are rounded so exact ties are common;
 * competition ranking ("1224") is applied and docId ascending breaks ties,
 * so order is fully deterministic even when scores are equal.
 *
 * Queries suffixed with `!fail:<side>` (side = a|b) make that side fail,
 * which is how missing/failed outcomes are exercised.
 */
export function search(
  snapshot: CorpusSnapshot,
  rawQuery: string,
  config: RankConfig,
  side: 'a' | 'b',
  topK = 5,
): SideOutcome {
  let query = rawQuery;
  const failMatch = rawQuery.match(/\s*!fail:(a|b)\s*$/);
  if (failMatch) {
    query = rawQuery.slice(0, failMatch.index);
    if (failMatch[1] === side) return { status: 'error', error: `simulated ${side.toUpperCase()} backend failure` };
  }

  const terms = new Set(tokenize(query));
  if (terms.size === 0) return { status: 'ok', results: [] };

  const scored = snapshot.docs
    .map((doc) => {
      const titleTokens = tokenize(doc.title);
      const bodyTokens = tokenize(doc.body);
      let score = 0;
      for (const term of terms) {
        if (titleTokens.includes(term)) score += config.weights.title;
        if (bodyTokens.includes(term)) score += config.weights.body;
        if (doc.tags.includes(term)) score += config.weights.tags;
      }
      return { doc, score };
    })
    .filter((entry) => entry.score > 0)
    .map((entry) => ({
      score: entry.score,
      rounded: Math.round(entry.score * 10) / 10,
      doc: entry.doc,
    }))
    .sort((x, y) =>
      y.score - x.score !== 0
        ? y.score - x.score
        : x.doc.id < y.doc.id
          ? -1
          : x.doc.id > y.doc.id
            ? 1
            : 0,
    )
    .slice(0, topK);

  const results: RankedDoc[] = [];
  for (let i = 0; i < scored.length; i += 1) {
    const current = scored[i];
    let rank = i + 1;
    if (i > 0 && scored[i - 1].score === current.score) rank = results[i - 1].rank;
    const tiedWith = scored
      .filter((other) => other !== current && other.score === current.score)
      .map((other) => other.doc.id);
    results.push({ docId: current.doc.id, score: current.rounded, rank, tiedWith });
  }
  return { status: 'ok', results };
}
