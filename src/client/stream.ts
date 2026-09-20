import type {
  ExperimentEventData,
  QueryResultPayload,
  StatsPayload,
} from '../shared/types';
import { computeStats } from '../server/compare';

export type Phase = 'queued' | 'running' | 'cancelling' | 'done' | 'cancelled' | 'failed';

export interface ExperimentView {
  phase: Phase;
  corpusRevision: number;
  snapshotId: string;
  totalQueries: number;
  replayable: boolean;
  /** Fixed-length slots; a slot stays null until its query result lands. */
  results: (QueryResultPayload | null)[];
  /** Highest seq already folded in — replay resumes strictly after this. */
  lastSeq: number;
  stats: StatsPayload | null;
  failure: string | null;
  snapshotReclaimed: boolean;
}

/**
 * Fold one durable event into view state. Rows are indexed by their position
 * in the original query set, so out-of-order arrival never reorders or jumps
 * already-rendered (and expanded) rows. Events are idempotent per `seq`.
 */
export function foldEvent(view: ExperimentView | null, seq: number, data: ExperimentEventData): ExperimentView {
  if (data.type === 'queued') {
    const base: ExperimentView = {
      phase: 'queued',
      corpusRevision: data.corpusRevision,
      snapshotId: data.snapshotId,
      totalQueries: data.totalQueries,
      replayable: true,
      results: Array.from({ length: data.totalQueries }, () => null),
      lastSeq: seq,
      stats: null,
      failure: null,
      snapshotReclaimed: false,
    };
    return base;
  }
  if (!view) {
    // Events arriving without a queued event (e.g. mid-run attach): keep a
    // minimal view; GET state fills totalQueries for the client before this.
    return {
      phase: 'running',
      corpusRevision: 0,
      snapshotId: '',
      totalQueries: 0,
      replayable: true,
      results: [],
      lastSeq: seq,
      stats: null,
      failure: null,
      snapshotReclaimed: false,
    };
  }
  if (seq <= view.lastSeq) return view; // duplicate / already replayed
  const next: ExperimentView = { ...view, lastSeq: seq };
  switch (data.type) {
    case 'running':
      next.phase = 'running';
      break;
    case 'query_result': {
      const results = next.results.slice();
      // Same index arriving twice (duplicate stream frame) is ignored.
      if (data.index < results.length && results[data.index] === null) {
        const { type: _omit, ...payload } = data;
        results[data.index] = payload as QueryResultPayload;
      }
      next.results = results;
      break;
    }
    case 'done':
      next.phase = 'done';
      next.stats = data.stats;
      break;
    case 'cancelled':
      next.phase = 'cancelled';
      next.stats = data.stats ?? computeStats(next.totalQueries, next.results);
      break;
    case 'failed':
      next.phase = 'failed';
      next.failure = data.error;
      break;
    case 'snapshot_reclaimed':
      // The experiment stays viewable; it simply can never be replayed.
      next.replayable = false;
      next.snapshotReclaimed = true;
      break;
  }
  return next;
}

/** Merge a full GET state into a view (used on load and after replay_unavailable). */
export function foldState(state: {
  status: Phase;
  corpusRevision: number;
  snapshotId: string;
  totalQueries: number;
  replayable: boolean;
  results: (QueryResultPayload | null)[];
  lastSeq: number;
  stats: StatsPayload | null;
}): ExperimentView {
  return {
    phase: state.status,
    corpusRevision: state.corpusRevision,
    snapshotId: state.snapshotId,
    totalQueries: state.totalQueries,
    replayable: state.replayable,
    results: state.results,
    lastSeq: state.lastSeq,
    stats: state.stats,
    failure: state.status === 'failed' ? 'experiment failed' : null,
    snapshotReclaimed: !state.replayable,
  };
}
