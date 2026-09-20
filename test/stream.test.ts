import { describe, expect, it } from 'vitest';
import { foldEvent, foldState } from '../src/client/stream';
import { computeStats } from '../src/server/compare';
import type { ExperimentEventData, QueryResultPayload } from '../src/shared/types';

function queued(seq: number, total: number): { seq: number; data: ExperimentEventData } {
  return {
    seq,
    data: {
      type: 'queued',
      experimentId: 'exp-x',
      snapshotId: 'snap-1-1',
      corpusRevision: 1,
      totalQueries: total,
      configs: {
        a: { name: 'A', weights: { title: 1, body: 1, tags: 1 } },
        b: { name: 'B', weights: { title: 1, body: 1, tags: 1 } },
      },
      createdAt: new Date(0).toISOString(),
    },
  };
}

function queryEvent(seq: number, index: number, query: string, result: Partial<QueryResultPayload>) {
  return {
    seq,
    data: {
      type: 'query_result' as const,
      index,
      query,
      durationMs: 5,
      a: { status: 'ok' as const, results: [] },
      b: { status: 'ok' as const, results: [] },
      comparable: true,
      deltas: [],
      ...result,
    },
  };
}

describe('foldEvent', () => {
  it('keeps a fixed slot order regardless of frame arrival order', () => {
    let view = foldEvent(null, 1, queued(1, 3).data);
    const e3 = queryEvent(2, 2, 'q3', {});
    const e1 = queryEvent(3, 0, 'q1', {});
    const e2 = queryEvent(4, 1, 'q2', {});
    view = foldEvent(view, e3.seq, e3.data);
    view = foldEvent(view, e1.seq, e1.data);
    view = foldEvent(view, e2.seq, e2.data);
    expect(view.results.map((result) => result?.query)).toEqual(['q1', 'q2', 'q3']);
    expect(view.lastSeq).toBe(4);
  });

  it('ignores frames with seq <= lastSeq (resume dedupe)', () => {
    let view = foldEvent(null, 1, queued(1, 2).data);
    const e1 = queryEvent(2, 0, 'q1', {});
    view = foldEvent(view, e1.seq, e1.data);
    const replayed = foldEvent(view, e1.seq, { ...e1.data, query: 'OVERWRITE' });
    expect(replayed).toBe(view);
    expect(replayed.results[0]?.query).toBe('q1');
  });

  it('does not overwrite a filled slot on duplicate index delivery', () => {
    let view = foldEvent(null, 1, queued(1, 2).data);
    view = foldEvent(view, 2, queryEvent(2, 0, 'q1', {}).data);
    const again = queryEvent(5, 0, 'q1-again', {});
    view = foldEvent(view, again.seq, again.data);
    expect(view.results[0]?.query).toBe('q1');
  });

  it('marks excluded (failed-side) queries but keeps them visible in their slot', () => {
    let view = foldEvent(null, 1, queued(1, 2).data);
    const failed = queryEvent(2, 1, 'q2', {
      a: { status: 'error', error: 'boom' },
      b: { status: 'ok', results: [] },
      comparable: false,
    });
    view = foldEvent(view, failed.seq, failed.data);
    expect(view.results[1]?.comparable).toBe(false);
    expect(view.results[0]).toBeNull();
  });

  it('terminal done carries stats and phase; snapshot_reclaimed flips replayability without hiding rows', () => {
    let view = foldEvent(null, 1, queued(1, 1).data);
    view = foldEvent(view, 2, queryEvent(2, 0, 'q1', {}).data);
    view = foldEvent(view, 3, {
      type: 'done',
      finishedAt: new Date(1).toISOString(),
      stats: computeStats(1, [view.results[0]]),
    });
    expect(view.phase).toBe('done');
    expect(view.stats?.comparable).toBe(1);

    const reclaimed = foldEvent(view, 4, { type: 'snapshot_reclaimed', at: new Date(2).toISOString() });
    expect(reclaimed.phase).toBe('done'); // still viewable
    expect(reclaimed.replayable).toBe(false);
    expect(reclaimed.snapshotReclaimed).toBe(true);
    expect(reclaimed.results[0]?.query).toBe('q1');
  });

  it('cancelled event with null stats still advances the phase', () => {
    let view = foldEvent(null, 1, queued(1, 1).data);
    view = foldEvent(view, 2, { type: 'running', startedAt: new Date(0).toISOString() });
    view = foldEvent(view, 3, {
      type: 'cancelled',
      cancelledAt: new Date(1).toISOString(),
      reason: 'user_cancelled',
      stats: null,
    });
    expect(view.phase).toBe('cancelled');
    // no stats were attached — UI shows the live paired-count instead of inventing ones
    expect(view.stats?.comparable ?? 0).toBe(0);
  });

  it('foldState rebuilds from a GET for full re-buffer after replay_unavailable', () => {
    const result = queryEvent(9, 0, 'q1', {}).data as QueryResultPayload;
    const view = foldState({
      status: 'done',
      corpusRevision: 3,
      snapshotId: 'snap-3-2',
      totalQueries: 1,
      replayable: false,
      results: [result],
      lastSeq: 10,
      stats: computeStats(1, [result]),
    });
    expect(view.lastSeq).toBe(10);
    expect(view.snapshotReclaimed).toBe(true);
    expect(view.results[0]?.query).toBe('q1');
  });
});

describe('computeStats denominators', () => {
  it('counts a both-sides-failed query once in failedA/failedB/bothFailed and excludes it', () => {
    const result = queryEvent(1, 0, 'q', {
      a: { status: 'error', error: 'x' },
      b: { status: 'error', error: 'y' },
      comparable: false,
    }).data as QueryResultPayload;
    const stats = computeStats(1, [result]);
    expect(stats.comparable).toBe(0);
    expect(stats.failedA).toBe(1);
    expect(stats.failedB).toBe(1);
    expect(stats.bothFailed).toBe(1);
    expect(stats.comparedDocs).toBe(0);
  });
});
