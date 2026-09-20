import { EventEmitter } from 'node:events';
import type {
  CreateExperimentBody,
  ExperimentEventData,
  ExperimentState,
  ExperimentStatus,
  QueryResultPayload,
  StoredEvent,
  StatsPayload,
} from '../shared/types.js';
import type { CorpusSnapshot, CorpusStore } from './corpus.js';
import { search } from './corpus.js';
import { compareQuery, computeStats } from './compare.js';

const DEFAULT_EVENT_LIMIT = 2000;

interface ExperimentRecord {
  id: string;
  status: ExperimentStatus;
  snapshot: CorpusSnapshot;
  querySet: string[];
  configs: { a: CreateExperimentBody['a']; b: CreateExperimentBody['b'] };
  topK: number;
  results: (QueryResultPayload | null)[];
  events: StoredEvent[];
  floorSeq: number; // events with seq <= floorSeq were trimmed
  nextSeq: number;
  eventLimit: number;
  createdAt: string;
  finishedAt: string | null;
  replayable: boolean;
  /** Set when cancel is requested so a finishing run cannot overwrite it. */
  cancelRequested: boolean;
  /** Guard against the cancel-vs-completion race (only one terminal transition wins). */
  terminal: boolean;
  queueToken: { cancelled: boolean } | null;
}

export class ExperimentNotFoundError extends Error {}
export class SnapshotReclaimedError extends Error {}
export class ReplayUnavailableError extends Error {}

export interface RunOptions {
  /** Maximum experiments executing at the same time. */
  concurrency: number;
  /** Per-query simulated latency, deterministic spread. */
  delayForIndex?: (index: number, total: number) => number;
  /** Durable per-experiment event window. Older events are trimmed. */
  eventLimit?: number;
}

/**
 * Fair FIFO semaphore with cancellable waiters. Extra experiments queue
 * instead of running; a waiter whose experiment was cancelled hands its
 * slot straight to the next experiment in line.
 */
interface Waiter {
  token: { cancelled: boolean };
  resume: () => void;
}

class Semaphore {
  private running = 0;
  private waiters: Waiter[] = [];
  constructor(private readonly limit: number) {}
  get active() {
    return this.running;
  }
  get queued() {
    return this.waiters.filter((waiter) => !waiter.token.cancelled).length;
  }
  /** Interrupt a queued waiter immediately (cancel while queued). No slot was
   *  consumed, so no other waiter is promoted — that happens on release(). */
  abandon(token: { cancelled: boolean }) {
    const index = this.waiters.findIndex((waiter) => waiter.token === token);
    if (index === -1) return;
    const [waiter] = this.waiters.splice(index, 1);
    waiter.resume();
  }
  async acquire(token: { cancelled: boolean }): Promise<() => void> {
    if (this.running >= this.limit) {
      await new Promise<void>((resume) => this.waiters.push({ token, resume }));
      if (token.cancelled) return () => {}; // ownership was already passed along
    }
    this.running += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running -= 1;
      this.pump(); // wake exactly one effective waiter per freed slot
    };
  }
  private pump() {
    const next = this.waiters.shift();
    if (!next) return;
    if (next.token.cancelled) {
      next.resume();
      this.pump(); // hand the same slot to the next live waiter
    } else {
      next.resume();
    }
  }
}

export class ExperimentStore {
  private experiments = new Map<string, ExperimentRecord>();
  private seq = 0;
  private semaphore: Semaphore;
  readonly emitter = new EventEmitter();

  constructor(
    private readonly corpus: CorpusStore,
    private readonly options: RunOptions = { concurrency: 2 },
  ) {
    this.semaphore = new Semaphore(options.concurrency);
    this.emitter.setMaxListeners(0);
  }

  get activeCount() {
    return this.semaphore.active;
  }
  get queuedCount() {
    return this.semaphore.queued;
  }

  create(body: CreateExperimentBody): ExperimentRecord {
    const queries = (body.querySet ?? []).map((q) => String(q)).filter((q) => q.trim().length > 0);
    if (queries.length === 0) throw new Error('querySet must contain at least one query');
    if (!body.a || !body.b) throw new Error('both configs a and b are required');
    const topK = clampTopK(body.topK);

    const snapshot = this.corpus.snapshot(body.corpusRevision); // immutable; revision pin
    this.seq += 1;
    const id = `exp-${this.seq}`;
    const now = new Date().toISOString();
    const record: ExperimentRecord = {
      id,
      status: 'queued',
      snapshot,
      querySet: queries,
      configs: { a: body.a, b: body.b },
      topK,
      results: queries.map(() => null),
      events: [],
      floorSeq: 0,
      nextSeq: 1,
      eventLimit: this.options.eventLimit ?? DEFAULT_EVENT_LIMIT,
      createdAt: now,
      finishedAt: null,
      replayable: true,
      cancelRequested: false,
      terminal: false,
      queueToken: null,
    };
    this.experiments.set(id, record);
    this.append(record, {
      type: 'queued',
      experimentId: id,
      snapshotId: snapshot.id,
      corpusRevision: snapshot.revision,
      totalQueries: queries.length,
      configs: record.configs,
      createdAt: now,
    });
    void this.run(record);
    return record;
  }

  get(id: string): ExperimentRecord | undefined {
    return this.experiments.get(id);
  }

  require(id: string): ExperimentRecord {
    const record = this.experiments.get(id);
    if (!record) throw new ExperimentNotFoundError(id);
    return record;
  }

  list(): ExperimentRecord[] {
    return [...this.experiments.values()];
  }

  /**
   * Cancel a run. A queued experiment is terminal immediately; a running one
   * enters `cancelling` and the runner posts the terminal `cancelled` event,
   * so cancel and natural completion can never both be observed.
   */
  cancel(id: string): ExperimentRecord {
    const record = this.require(id);
    if (record.terminal) return record; // idempotent
    record.cancelRequested = true;
    if (record.status === 'queued') {
      if (record.queueToken) this.semaphore.abandon(record.queueToken);
      this.toTerminal(record, 'cancelled');
      record.finishedAt = new Date().toISOString();
      this.append(record, {
        type: 'cancelled',
        cancelledAt: record.finishedAt,
        reason: 'canceled_while_queued',
        stats: null,
      });
    } else if (record.status === 'running') {
      record.status = 'cancelling';
    }
    return record;
  }

  /**
   * Snapshot GC hook. Finished experiments become non-replayable; anything
   * still queued/running is failed outright because its pinned input is gone.
   */
  markSnapshotReclaimed(snapshotId: string): ExperimentRecord[] {
    const affected: ExperimentRecord[] = [];
    for (const record of this.experiments.values()) {
      if (record.snapshot.id !== snapshotId) continue;
      record.replayable = false;
      if (!record.terminal) {
        record.cancelRequested = true;
        if (record.status === 'queued' && record.queueToken) {
          this.semaphore.abandon(record.queueToken);
        }
        this.toTerminal(record, 'failed');
        record.finishedAt = new Date().toISOString();
        this.append(record, {
          type: 'failed',
          finishedAt: record.finishedAt,
          error: 'snapshot_reclaimed',
        });
      } else {
        this.append(record, { type: 'snapshot_reclaimed', at: new Date().toISOString() });
      }
      affected.push(record);
    }
    return affected;
  }

  /** Re-run an experiment against the same pinned snapshot bytes. */
  replay(id: string): ExperimentRecord {
    const original = this.require(id);
    if (!original.replayable || !this.corpus.hasSnapshot(original.snapshot.id)) {
      throw new SnapshotReclaimedError(`snapshot ${original.snapshot.id} was reclaimed`);
    }
    return this.create({
      querySet: original.querySet,
      a: original.configs.a,
      b: original.configs.b,
      topK: original.topK,
      corpusRevision: original.snapshot.revision,
    });
  }

  eventsAfter(record: ExperimentRecord, afterSeq: number): { events: StoredEvent[]; trimmed: boolean } {
    if (afterSeq < record.floorSeq) return { events: [], trimmed: true };
    return { events: record.events.filter((event) => event.seq > afterSeq), trimmed: false };
  }

  stateOf(record: ExperimentRecord): ExperimentState {
    return {
      id: record.id,
      status: record.status,
      snapshotId: record.snapshot.id,
      corpusRevision: record.snapshot.revision,
      replayable: record.replayable,
      totalQueries: record.querySet.length,
      completedQueries: record.results.filter(Boolean).length,
      createdAt: record.createdAt,
      finishedAt: record.finishedAt,
      stats: terminalStats(record),
      querySet: record.querySet,
      configs: record.configs,
      topK: record.topK,
      results: record.results,
      lastSeq: record.nextSeq - 1,
    };
  }

  summaryOf(record: ExperimentRecord): ExperimentState {
    return this.stateOf(record);
  }

  private append(record: ExperimentRecord, data: ExperimentEventData): StoredEvent {
    const event: StoredEvent = { seq: record.nextSeq, data };
    record.nextSeq += 1;
    record.events.push(event);
    if (record.events.length > record.eventLimit) {
      const drop = record.events.length - record.eventLimit;
      record.events.splice(0, drop);
      record.floorSeq = record.events.length > 0 ? record.events[0].seq - 1 : record.nextSeq - 1;
    }
    this.emitter.emit(`exp:${record.id}`, event);
    return event;
  }

  private toTerminal(record: ExperimentRecord, status: ExperimentStatus): boolean {
    if (record.terminal) return false; // first terminal transition wins
    record.terminal = true;
    record.status = status;
    return true;
  }

  private async run(record: ExperimentRecord) {
    const token = {
      get cancelled() {
        return record.cancelRequested;
      },
    };
    record.queueToken = token;
    const release = await this.semaphore.acquire(token);
    record.queueToken = null;
    try {
      if (record.cancelRequested || record.terminal) return; // cancel won the queue race
      if (!this.corpus.hasSnapshot(record.snapshot.id)) {
        record.finishedAt = new Date().toISOString();
        if (this.toTerminal(record, 'failed')) {
          this.append(record, { type: 'failed', finishedAt: record.finishedAt, error: 'snapshot_reclaimed' });
        }
        return;
      }

      record.status = 'running';
      this.append(record, { type: 'running', startedAt: new Date().toISOString() });

      // All queries are issued concurrently with independent, deterministic
      // latencies, so results arrive out of order; the client places each
      // result by its original `index`, never by arrival order. The sync
      // sections after each await are atomic on the event loop.
      await Promise.all(
        record.querySet.map(async (_, index) => {
          const result = await this.evaluate(record, index);
          if (record.cancelRequested || record.terminal) return;
          record.results[index] = result;
          this.append(record, { type: 'query_result', ...result });
        }),
      );

      if (record.cancelRequested) {
        record.finishedAt = new Date().toISOString();
        if (this.toTerminal(record, 'cancelled')) {
          this.append(record, {
            type: 'cancelled',
            cancelledAt: record.finishedAt,
            reason: 'user_cancelled',
            stats: computeStats(record.querySet.length, record.results),
          });
        }
        return;
      }

      record.finishedAt = new Date().toISOString();
      if (this.toTerminal(record, 'done')) {
        this.append(record, {
          type: 'done',
          finishedAt: record.finishedAt,
          stats: computeStats(record.querySet.length, record.results),
        });
      }
    } catch (error) {
      record.finishedAt = new Date().toISOString();
      if (this.toTerminal(record, 'failed')) {
        this.append(record, {
          type: 'failed',
          finishedAt: record.finishedAt,
          error: error instanceof Error ? error.message : 'unknown_error',
        });
      }
    } finally {
      release();
    }
  }

  private async evaluate(record: ExperimentRecord, index: number): Promise<QueryResultPayload> {
    const query = record.querySet[index];
    const started = Date.now();
    const delay = this.options.delayForIndex
      ? this.options.delayForIndex(index, record.querySet.length)
      : defaultDelay(index, record.querySet.length);
    const [a, b] = await Promise.all([
      runSide(delay, () => search(record.snapshot, query, record.configs.a, 'a', record.topK)),
      runSide(delay, () => search(record.snapshot, query, record.configs.b, 'b', record.topK)),
    ]);
    return compareQuery(index, query, Date.now() - started, a, b);
  }
}

function terminalStats(record: ExperimentRecord): StatsPayload | null {
  if (record.status === 'done') return computeStats(record.querySet.length, record.results);
  if (record.status === 'cancelled') {
    const cancelled = record.events.find((event) => event.data.type === 'cancelled');
    return cancelled && cancelled.data.type === 'cancelled' ? cancelled.data.stats : null;
  }
  return null;
}

function defaultDelay(index: number, total: number): number {
  // Deterministic pseudo-scatter (permutation of 10..10+6*(n-1)); middle
  // indices tend to finish before early ones, so arrival order != query order.
  const permuted = (index * 7 + (total % 5) * 3) % total;
  return 10 + permuted * 6;
}

function runSide(delay: number, fn: () => ReturnType<typeof search>): Promise<ReturnType<typeof search>> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(fn()), delay);
  });
}

function clampTopK(topK: number | undefined): number {
  if (topK === undefined || !Number.isFinite(topK)) return 5;
  return Math.max(1, Math.min(20, Math.floor(topK)));
}
