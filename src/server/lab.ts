// Domain core for the A/B ranking-compare workbench.
//
// An experiment pins an immutable snapshot (corpus revision + query set) at
// creation time, executes both ranking configs against that snapshot, and
// streams per-query outcomes through a per-experiment event log. The log is
// the source of truth: observers (including multiple pages) attach at any
// time and resume from a sequence number. Snapshots are reclaimed after a
// TTL once the run terminates, after which the experiment can be viewed but
// not replayed.

export type Doc = {id: string; title: string; body: string};
export type RankingConfig = {id: string; name: string; titleWeight: number; bodyWeight: number};
export type Hit = {docId: string; score: number; rank: number; tied: boolean};
export type SideOutcome = {status: 'ok'; hits: Hit[]} | {status: 'error'; error: string};
export type DocDelta = {
  docId: string;
  rankA: number | null;
  rankB: number | null;
  delta: number | null; // rankA - rankB; null when the doc is missing on one side
  tiedA: boolean;
  tiedB: boolean;
};
export type QueryOutcome = {
  queryId: string;
  index: number; // position in the original query set
  query: string;
  a: SideOutcome;
  b: SideOutcome;
  deltas: DocDelta[] | null; // null unless both sides succeeded
};
export type QuerySpec = {id: string; text: string};

export type Stats = {
  totalQueries: number;
  completedQueries: number; // queries that produced an outcome at all
  comparedQueries: number; // queries valid on BOTH sides — the only ones stats use
  failedQueries: number; // queries where at least one side errored
  changedQueries: number;
  docsCompared: number;
  docsOnlyInA: number;
  docsOnlyInB: number;
  tiedDocsA: number;
  tiedDocsB: number;
  meanAbsRankDelta: number | null;
};

export type ExperimentStatus = 'running' | 'completed' | 'cancelled';
export type ExperimentEvent = {seq: number; type: string; data: unknown};

export type ExperimentView = {
  id: string;
  runId: string;
  status: ExperimentStatus;
  createdAt: string;
  configA: RankingConfig;
  configB: RankingConfig;
  snapshotRevision: number;
  replayable: boolean;
  totalQueries: number;
  stats: Stats | null;
};

export class LabError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = 'LabError';
  }
}

/** Return an error message to fail this side for this query, or null. */
export type FaultRule = (query: string, side: 'A' | 'B', config: RankingConfig) => string | null;

export type LabOptions = {
  docs: Doc[];
  queries: string[];
  configs: RankingConfig[];
  maxConcurrent?: number;
  snapshotTtlMs?: number;
  /** Per-query wait before execution (simulates backend latency; injectable for tests). */
  wait?: (queryId: string, index: number) => Promise<void>;
  fault?: FaultRule;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

type Snapshot = {revision: number; docs: Doc[]; queries: QuerySpec[]};

type Experiment = {
  id: string;
  runId: string;
  status: ExperimentStatus;
  configA: RankingConfig;
  configB: RankingConfig;
  createdAt: number;
  terminalAt: number | null;
  snapshot: Snapshot | null; // null once reclaimed
  lastSnapshotRevision: number; // kept after reclaim so the pinned revision stays visible
  lastTotalQueries: number;
  outcomes: Map<string, QueryOutcome>;
  events: ExperimentEvent[];
  stats: Stats | null;
  subscribers: Set<(event: ExperimentEvent) => void>;
  reclaimTimer: unknown;
};

class Corpus {
  private docs = new Map<string, Doc>();
  revision: number;

  constructor(docs: Doc[]) {
    for (const doc of docs) this.docs.set(doc.id, {...doc});
    this.revision = 1;
  }

  list(): Doc[] {
    return [...this.docs.values()].map(doc => ({...doc}));
  }

  upsert(doc: Doc): number {
    this.docs.set(doc.id, {...doc});
    this.revision += 1;
    return this.revision;
  }

  /** Frozen deep copy — later corpus updates cannot mutate it. */
  snapshot(): {revision: number; docs: Doc[]} {
    const docs = [...this.docs.values()].map(doc => Object.freeze({...doc}));
    return {revision: this.revision, docs: Object.freeze(docs) as unknown as Doc[]};
  }
}

function scoreDoc(doc: Doc, terms: string[], config: RankingConfig): number {
  const title = doc.title.toLowerCase();
  const body = doc.body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += config.titleWeight;
    if (body.includes(term)) score += config.bodyWeight;
  }
  return score;
}

function executeSide(
  snapshot: Snapshot,
  query: string,
  config: RankingConfig,
  fault: FaultRule | null,
  side: 'A' | 'B',
): SideOutcome {
  const failure = fault?.(query, side, config);
  if (failure) return {status: 'error', error: failure};
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = snapshot.docs
    .map(doc => ({doc, score: scoreDoc(doc, terms, config)}))
    .filter(entry => entry.score > 0);
  // Deterministic order: score desc, then doc id asc.
  scored.sort((x, y) => y.score - x.score || (x.doc.id < y.doc.id ? -1 : 1));
  const hits: Hit[] = [];
  for (let i = 0; i < scored.length; i += 1) {
    // Competition ranking: equal scores share a rank (1, 2, 2, 4).
    const rank = i > 0 && scored[i].score === scored[i - 1].score ? hits[i - 1].rank : i + 1;
    hits.push({docId: scored[i].doc.id, score: scored[i].score, rank, tied: false});
  }
  const byScore = new Map<number, number>();
  for (const hit of hits) byScore.set(hit.score, (byScore.get(hit.score) ?? 0) + 1);
  for (const hit of hits) hit.tied = (byScore.get(hit.score) ?? 0) > 1;
  return {status: 'ok', hits};
}

function buildDeltas(a: SideOutcome, b: SideOutcome): DocDelta[] | null {
  if (a.status !== 'ok' || b.status !== 'ok') return null;
  const hitsA = new Map(a.hits.map(hit => [hit.docId, hit]));
  const hitsB = new Map(b.hits.map(hit => [hit.docId, hit]));
  const docIds = [...new Set([...hitsA.keys(), ...hitsB.keys()])].sort();
  return docIds.map(docId => {
    const hitA = hitsA.get(docId);
    const hitB = hitsB.get(docId);
    return {
      docId,
      rankA: hitA?.rank ?? null,
      rankB: hitB?.rank ?? null,
      delta: hitA && hitB ? hitA.rank - hitB.rank : null,
      tiedA: hitA?.tied ?? false,
      tiedB: hitB?.tied ?? false,
    };
  });
}

export function computeStats(queries: QuerySpec[], outcomes: Map<string, QueryOutcome>): Stats {
  let completed = 0;
  let compared = 0;
  let failed = 0;
  let changed = 0;
  let docsCompared = 0;
  let docsOnlyInA = 0;
  let docsOnlyInB = 0;
  let tiedDocsA = 0;
  let tiedDocsB = 0;
  let sumAbsDelta = 0;
  for (const query of queries) {
    const outcome = outcomes.get(query.id);
    if (!outcome) continue; // never ran (cancelled) — excluded from everything
    completed += 1;
    if (outcome.a.status !== 'ok' || outcome.b.status !== 'ok' || !outcome.deltas) {
      failed += 1;
      continue; // stats only count queries valid on both sides
    }
    compared += 1;
    let queryChanged = false;
    for (const delta of outcome.deltas) {
      if (delta.tiedA) tiedDocsA += 1;
      if (delta.tiedB) tiedDocsB += 1;
      if (delta.rankA === null) {
        docsOnlyInB += 1;
        queryChanged = true;
        continue;
      }
      if (delta.rankB === null) {
        docsOnlyInA += 1;
        queryChanged = true;
        continue;
      }
      docsCompared += 1;
      sumAbsDelta += Math.abs(delta.delta ?? 0);
      if (delta.delta !== 0) queryChanged = true;
    }
    if (queryChanged) changed += 1;
  }
  return {
    totalQueries: queries.length,
    completedQueries: completed,
    comparedQueries: compared,
    failedQueries: failed,
    changedQueries: changed,
    docsCompared,
    docsOnlyInA,
    docsOnlyInB,
    tiedDocsA,
    tiedDocsB,
    meanAbsRankDelta: docsCompared > 0 ? sumAbsDelta / docsCompared : null,
  };
}

function defaultWait(queryId: string): Promise<void> {
  // Deterministic per-query latency so queries complete out of order, like a
  // real fan-out — the UI must not rely on arrival order.
  let hash = 0;
  for (const char of queryId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const ms = 10 + (hash % 60);
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class ExperimentLab {
  private corpus: Corpus;
  private queries: QuerySpec[];
  private configs = new Map<string, RankingConfig>();
  private experiments = new Map<string, Experiment>();
  private experimentSeq = 0;
  private runSeq = 0;
  private maxConcurrent: number;
  private snapshotTtlMs: number;
  private waitFn: (queryId: string, index: number) => Promise<void>;
  private fault: FaultRule | null;
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (handle: unknown) => void;

  constructor(options: LabOptions) {
    this.corpus = new Corpus(options.docs);
    this.queries = options.queries.map((text, index) => ({id: `q${index + 1}`, text}));
    for (const config of options.configs) this.configs.set(config.id, config);
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.snapshotTtlMs = options.snapshotTtlMs ?? 5 * 60_000;
    this.waitFn = options.wait ?? defaultWait;
    this.fault = options.fault ?? null;
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        (timer as unknown as {unref?: () => void}).unref?.();
        return timer;
      });
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  }

  listConfigs(): RankingConfig[] {
    return [...this.configs.values()].map(config => ({...config}));
  }

  corpusRevision(): number {
    return this.corpus.revision;
  }

  listDocs(): Doc[] {
    return this.corpus.list();
  }

  /** Simulates an index update: bumps the corpus revision. Running experiments are unaffected. */
  upsertDoc(doc: Doc): number {
    return this.corpus.upsert(doc);
  }

  listExperiments(): ExperimentView[] {
    return [...this.experiments.values()].map(exp => {
      this.maybeReclaim(exp);
      return this.view(exp);
    });
  }

  getExperiment(id: string): ExperimentView {
    const exp = this.require(id);
    this.maybeReclaim(exp);
    return this.view(exp);
  }

  createExperiment(configAId: string, configBId: string): ExperimentView {
    const configA = this.configs.get(configAId);
    const configB = this.configs.get(configBId);
    if (!configA || !configB) {
      throw new LabError('unknown_config', `unknown ranking config: ${configAId} / ${configBId}`);
    }
    if (this.runningCount() >= this.maxConcurrent) {
      throw new LabError('concurrency_limit', `at most ${this.maxConcurrent} concurrent experiment runs`, {
        limit: this.maxConcurrent,
      });
    }
    const snapshot = this.takeSnapshot();
    const exp: Experiment = {
      id: `exp-${++this.experimentSeq}`,
      runId: '',
      status: 'running',
      configA,
      configB,
      createdAt: this.now(),
      terminalAt: null,
      snapshot,
      lastSnapshotRevision: snapshot.revision,
      lastTotalQueries: snapshot.queries.length,
      outcomes: new Map(),
      events: [],
      stats: null,
      subscribers: new Set(),
      reclaimTimer: null,
    };
    this.experiments.set(exp.id, exp);
    this.startRun(exp);
    return this.view(exp);
  }

  /** Re-execute against the SAME pinned snapshot. Impossible once it is reclaimed. */
  rerun(id: string): ExperimentView {
    const exp = this.require(id);
    this.maybeReclaim(exp);
    if (exp.status === 'running') throw new LabError('running', 'experiment is already running');
    if (!exp.snapshot) {
      throw new LabError('snapshot_reclaimed', 'snapshot was reclaimed; experiment cannot be replayed', {
        replayable: false,
      });
    }
    if (this.runningCount() >= this.maxConcurrent) {
      throw new LabError('concurrency_limit', `at most ${this.maxConcurrent} concurrent experiment runs`, {
        limit: this.maxConcurrent,
      });
    }
    this.startRun(exp);
    return this.view(exp);
  }

  /**
   * Cancel a running experiment. Loses the race against completion: if the run
   * already terminated, returns ok:false with the terminal status. Exactly one
   * terminal event (done or cancelled) is ever emitted.
   */
  cancel(id: string): {ok: boolean; status: ExperimentStatus} {
    const exp = this.require(id);
    if (exp.status !== 'running') return {ok: false, status: exp.status};
    exp.status = 'cancelled';
    exp.terminalAt = this.now();
    this.emit(exp, 'cancelled', {completedQueries: exp.outcomes.size, totalQueries: exp.lastTotalQueries});
    this.scheduleReclaim(exp);
    return {ok: true, status: 'cancelled'};
  }

  /**
   * Replay every event with seq > fromSeq, then deliver live events.
   * Any number of observers may subscribe (e.g. two pages on one experiment).
   */
  subscribe(id: string, fromSeq: number, cb: (event: ExperimentEvent) => void): () => void {
    const exp = this.require(id);
    this.maybeReclaim(exp);
    for (const event of exp.events) {
      if (event.seq > fromSeq) cb(event);
    }
    exp.subscribers.add(cb);
    return () => {
      exp.subscribers.delete(cb);
    };
  }

  private takeSnapshot(): Snapshot {
    const corpusSnapshot = this.corpus.snapshot();
    return {
      revision: corpusSnapshot.revision,
      docs: corpusSnapshot.docs,
      queries: this.queries.map(query => ({...query})),
    };
  }

  private startRun(exp: Experiment): void {
    if (exp.reclaimTimer !== null) {
      this.clearTimer(exp.reclaimTimer);
      exp.reclaimTimer = null;
    }
    exp.runId = `run-${++this.runSeq}`;
    exp.status = 'running';
    exp.terminalAt = null;
    exp.events = [];
    exp.outcomes = new Map();
    exp.stats = null;
    const snapshot = exp.snapshot!;
    const runId = exp.runId;
    this.emit(exp, 'meta', {
      runId,
      experimentId: exp.id,
      snapshotRevision: snapshot.revision,
      queries: snapshot.queries,
      configA: exp.configA,
      configB: exp.configB,
      createdAt: new Date(exp.createdAt).toISOString(),
    });
    // Queries fan out concurrently; completion order is not query order.
    Promise.all(snapshot.queries.map((query, index) => this.runQuery(exp, runId, snapshot, query, index)))
      .then(() => this.finish(exp, runId))
      .catch(() => this.finish(exp, runId));
  }

  private async runQuery(
    exp: Experiment,
    runId: string,
    snapshot: Snapshot,
    query: QuerySpec,
    index: number,
  ): Promise<void> {
    try {
      await this.waitFn(query.id, index);
    } catch {
      // A faulty delay hook must not kill the run.
    }
    // Stale run (rerun happened) or cancelled while waiting: drop silently.
    if (exp.runId !== runId || exp.status !== 'running') return;
    const a = executeSide(snapshot, query.text, exp.configA, this.fault, 'A');
    const b = executeSide(snapshot, query.text, exp.configB, this.fault, 'B');
    const outcome: QueryOutcome = {
      queryId: query.id,
      index,
      query: query.text,
      a,
      b,
      deltas: buildDeltas(a, b),
    };
    exp.outcomes.set(query.id, outcome);
    this.emit(exp, 'query', outcome);
  }

  private finish(exp: Experiment, runId: string): void {
    // Lost the race against cancel (or superseded by a rerun): no terminal event.
    if (exp.runId !== runId || exp.status !== 'running') return;
    exp.status = 'completed';
    exp.terminalAt = this.now();
    exp.stats = computeStats(exp.snapshot!.queries, exp.outcomes);
    this.emit(exp, 'done', {stats: exp.stats});
    this.scheduleReclaim(exp);
  }

  private scheduleReclaim(exp: Experiment): void {
    if (!Number.isFinite(this.snapshotTtlMs)) return;
    exp.reclaimTimer = this.setTimer(() => this.reclaim(exp), this.snapshotTtlMs);
  }

  private reclaim(exp: Experiment): void {
    exp.reclaimTimer = null;
    if (!exp.snapshot || exp.status === 'running') return;
    exp.snapshot = null; // the event log stays: viewable, but not replayable
    this.emit(exp, 'snapshot-reclaimed', {experimentId: exp.id, replayable: false});
  }

  private maybeReclaim(exp: Experiment): void {
    if (
      exp.snapshot &&
      exp.status !== 'running' &&
      exp.terminalAt !== null &&
      this.now() - exp.terminalAt >= this.snapshotTtlMs
    ) {
      this.reclaim(exp);
    }
  }

  private emit(exp: Experiment, type: string, data: unknown): void {
    const event: ExperimentEvent = {seq: exp.events.length + 1, type, data};
    exp.events.push(event);
    for (const cb of [...exp.subscribers]) cb(event);
  }

  private runningCount(): number {
    let count = 0;
    for (const exp of this.experiments.values()) if (exp.status === 'running') count += 1;
    return count;
  }

  private require(id: string): Experiment {
    const exp = this.experiments.get(id);
    if (!exp) throw new LabError('not_found', `no experiment ${id}`);
    return exp;
  }

  private view(exp: Experiment): ExperimentView {
    return {
      id: exp.id,
      runId: exp.runId,
      status: exp.status,
      createdAt: new Date(exp.createdAt).toISOString(),
      configA: {...exp.configA},
      configB: {...exp.configB},
      snapshotRevision: exp.snapshot ? exp.snapshot.revision : exp.lastSnapshotRevision,
      replayable: exp.snapshot !== null,
      totalQueries: exp.snapshot ? exp.snapshot.queries.length : exp.lastTotalQueries,
      stats: exp.stats ? {...exp.stats} : null,
    };
  }
}
