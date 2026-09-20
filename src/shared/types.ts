// Protocol shared by server and client.

export interface RankConfig {
  name: string;
  weights: { title: number; body: number; tags: number };
}

export interface CreateExperimentBody {
  querySet: string[];
  a: RankConfig;
  b: RankConfig;
  topK?: number;
  /** Pin to a specific index revision; defaults to the newest. */
  corpusRevision?: number;
}

export interface RankedDoc {
  docId: string;
  score: number;
  /** Competition ("1224") rank, docId ascending breaks exact score ties. */
  rank: number;
  /** Other docIds sharing the same score on this side. */
  tiedWith: string[];
}

export type SideOutcome =
  | { status: 'ok'; results: RankedDoc[] }
  | { status: 'error'; error: string };

export interface DeltaEntry {
  docId: string;
  rankA: number | null;
  rankB: number | null;
  /** rankA - rankB. Positive means B ranks the doc higher. Null when absent on one side. */
  delta: number | null;
  note?: 'only_a' | 'only_b';
}

export interface QueryResultPayload {
  /** Position in the original query set — rows always render in this order. */
  index: number;
  query: string;
  durationMs: number;
  a: SideOutcome;
  b: SideOutcome;
  /** Comparable iff both sides returned ok (an empty ok side still counts). */
  comparable: boolean;
  /** Union of doc ids appearing on either side, sorted by best rank. */
  deltas: DeltaEntry[];
}

export interface StatsPayload {
  totalQueries: number;
  /** Both sides ok. This is the query-level denominator. */
  comparable: number;
  failedA: number;
  failedB: number;
  bothFailed: number;
  /** Both ok but one side returned zero hits. */
  onlySide: number;
  /** Both ok and both empty. */
  bothEmpty: number;
  /** Docs present on both sides across comparable queries. Doc-level denominator. */
  comparedDocs: number;
  improved: number;
  regressed: number;
  unchanged: number;
  avgAbsDelta: number | null;
  /** Comparable queries where at least one side has an exact score tie. */
  tieQueries: number;
}

export type ExperimentStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'done'
  | 'cancelled'
  | 'failed';

export type ExperimentEventData =
  | { type: 'queued'; experimentId: string; snapshotId: string; corpusRevision: number; totalQueries: number; configs: { a: RankConfig; b: RankConfig }; createdAt: string }
  | { type: 'running'; startedAt: string }
  | ({ type: 'query_result' } & QueryResultPayload)
  | { type: 'done'; finishedAt: string; stats: StatsPayload }
  | { type: 'cancelled'; cancelledAt: string; reason: 'user_cancelled' | 'canceled_while_queued'; stats: StatsPayload | null }
  | { type: 'failed'; finishedAt: string; error: string }
  | { type: 'snapshot_reclaimed'; at: string };

export interface StoredEvent {
  seq: number;
  data: ExperimentEventData;
}

export interface ExperimentSummary {
  id: string;
  status: ExperimentStatus;
  snapshotId: string;
  corpusRevision: number;
  replayable: boolean;
  totalQueries: number;
  completedQueries: number;
  createdAt: string;
  finishedAt: string | null;
  stats: StatsPayload | null;
}

export interface ExperimentState extends ExperimentSummary {
  querySet: string[];
  configs: { a: RankConfig; b: RankConfig };
  topK: number;
  results: (QueryResultPayload | null)[];
  lastSeq: number;
}
