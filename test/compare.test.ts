import {describe, expect, it} from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {
  ExperimentLab,
  LabError,
  type ExperimentEvent,
  type Hit,
  type LabOptions,
  type QueryOutcome,
  type SideOutcome,
  type Stats,
} from '../src/server/lab';
import {createApp} from '../src/server/index';

const DOCS = [
  {id: 'd1', title: 'apple pie', body: 'sweet cinnamon dessert'},
  {id: 'd2', title: 'apple orchard', body: 'apple harvest festival'},
  {id: 'd3', title: 'banana bread', body: 'apple sauce filling'},
  {id: 'd4', title: 'kiwi salad', body: 'fresh fruit bowl'},
  {id: 'd5', title: 'fruit tart', body: 'kiwi glaze topping'},
  {id: 'd6', title: 'crisp apple', body: 'orchard notes'},
];
const QUERIES = ['apple', 'kiwi', 'flaky parser', 'zebra'];
const CONFIGS = [
  {id: 'balanced', name: 'Balanced', titleWeight: 2, bodyWeight: 1},
  {id: 'body-only', name: 'Body only', titleWeight: 0, bodyWeight: 2},
  {id: 'title-only', name: 'Title only', titleWeight: 2, bodyWeight: 0},
];
const FAULT = (query: string, side: 'A' | 'B') =>
  side === 'B' && query.includes('flaky') ? 'simulated backend error' : null;

function makeLab(overrides: Partial<LabOptions> = {}): ExperimentLab {
  return new ExperimentLab({
    docs: DOCS,
    queries: QUERIES,
    configs: CONFIGS,
    fault: FAULT,
    wait: () => Promise.resolve(),
    snapshotTtlMs: 60_000,
    ...overrides,
  });
}

/** Controllable gate: queries block until releaseAll(); afterwards waits resolve immediately. */
function gates() {
  let released = false;
  const pending: (() => void)[] = [];
  const wait = () =>
    released
      ? Promise.resolve()
      : new Promise<void>(resolve => {
          pending.push(resolve);
        });
  const releaseAll = () => {
    released = true;
    for (const resolve of pending.splice(0)) resolve();
  };
  return {wait, releaseAll};
}

async function settle(lab: ExperimentLab, id: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
    if (lab.getExperiment(id).status !== 'running') return;
  }
  throw new Error('experiment did not terminate');
}

function collect(lab: ExperimentLab, id: string, from = 0): ExperimentEvent[] {
  const events: ExperimentEvent[] = [];
  lab.subscribe(id, from, event => events.push(event));
  return events;
}

function queryOutcomes(events: ExperimentEvent[]): QueryOutcome[] {
  return events.filter(event => event.type === 'query').map(event => event.data as QueryOutcome);
}

function hits(side: SideOutcome): Hit[] {
  return side.status === 'ok' ? side.hits : [];
}

async function completedExperiment(lab: ExperimentLab) {
  const exp = lab.createExperiment('balanced', 'body-only');
  await settle(lab, exp.id);
  return {exp, events: collect(lab, exp.id), outcomes: queryOutcomes(collect(lab, exp.id))};
}

describe('ranking semantics', () => {
  it('assigns shared competition ranks and tie flags for equal scores', async () => {
    const lab = makeLab();
    const {outcomes} = await completedExperiment(lab);
    const apple = outcomes.find(o => o.query === 'apple')!;
    const aHits = hits(apple.a);
    // balanced: d1 and d6 both score 2 → shared rank 2, next rank skips to 4
    expect(aHits.find(h => h.docId === 'd1')).toMatchObject({rank: 2, tied: true});
    expect(aHits.find(h => h.docId === 'd6')).toMatchObject({rank: 2, tied: true});
    expect(aHits.find(h => h.docId === 'd3')).toMatchObject({rank: 4, tied: false});
    // body-only: d2 and d3 tie at rank 1
    const bHits = hits(apple.b);
    expect(bHits.find(h => h.docId === 'd2')).toMatchObject({rank: 1, tied: true});
    expect(bHits.find(h => h.docId === 'd3')).toMatchObject({rank: 1, tied: true});
    // deltas carry the tie flags for the UI
    const d1 = apple.deltas!.find(d => d.docId === 'd1')!;
    expect(d1.tiedA).toBe(true);
    expect(d1.tiedB).toBe(false);
  });

  it('marks docs missing on one side with null rank and null delta', async () => {
    const lab = makeLab();
    const {outcomes} = await completedExperiment(lab);
    const apple = outcomes.find(o => o.query === 'apple')!;
    // d1 matches only titles → absent from body-only side B
    const d1 = apple.deltas!.find(d => d.docId === 'd1')!;
    expect(d1.rankA).toBe(2);
    expect(d1.rankB).toBeNull();
    expect(d1.delta).toBeNull();
    // d3 is present on both sides with a real delta (rank 4 vs rank 1)
    const d3 = apple.deltas!.find(d => d.docId === 'd3')!;
    expect(d3).toMatchObject({rankA: 4, rankB: 1, delta: 3});
    // no doc is unique to side B in this fixture
    expect(apple.deltas!.every(d => d.rankA !== null)).toBe(true);
  });

  it('reports a failing side as an error outcome with no deltas', async () => {
    const lab = makeLab();
    const {outcomes} = await completedExperiment(lab);
    const flaky = outcomes.find(o => o.query === 'flaky parser')!;
    expect(flaky.a.status).toBe('ok');
    expect(flaky.b).toEqual({status: 'error', error: 'simulated backend error'});
    expect(flaky.deltas).toBeNull();
  });

  it('treats a query with zero hits on both sides as valid and comparable', async () => {
    const lab = makeLab();
    const {outcomes} = await completedExperiment(lab);
    const zebra = outcomes.find(o => o.query === 'zebra')!;
    expect(zebra.a).toEqual({status: 'ok', hits: []});
    expect(zebra.b).toEqual({status: 'ok', hits: []});
    expect(zebra.deltas).toEqual([]);
  });

  it('emits query events in completion order, each carrying its original index', async () => {
    // q1 is artificially slow → events arrive out of query order.
    const lab = makeLab({wait: queryId => new Promise(resolve => setTimeout(resolve, queryId === 'q1' ? 30 : 0))});
    const exp = lab.createExperiment('balanced', 'body-only');
    const events = collect(lab, exp.id);
    await settle(lab, exp.id);
    const arrivals = queryOutcomes(events);
    expect(arrivals).toHaveLength(4);
    expect(arrivals[arrivals.length - 1].queryId).toBe('q1');
    expect(arrivals.map(o => o.index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});

describe('stats denominator', () => {
  it('counts only completed queries valid on both sides', async () => {
    const lab = makeLab();
    const {exp} = await completedExperiment(lab);
    const stats = lab.getExperiment(exp.id).stats!;
    expect(stats.totalQueries).toBe(4);
    expect(stats.completedQueries).toBe(4);
    expect(stats.comparedQueries).toBe(3); // apple, kiwi, zebra — flaky parser excluded
    expect(stats.failedQueries).toBe(1);
    expect(stats.changedQueries).toBe(2);
    expect(stats.docsCompared).toBe(3);
    expect(stats.docsOnlyInA).toBe(3);
    expect(stats.docsOnlyInB).toBe(0);
    expect(stats.tiedDocsA).toBe(2);
    expect(stats.tiedDocsB).toBe(2);
    expect(stats.meanAbsRankDelta).toBeCloseTo(4 / 3);
  });

  it('emits the stats with the done event', async () => {
    const lab = makeLab();
    const {events} = await completedExperiment(lab);
    const done = events.find(e => e.type === 'done')!;
    expect((done.data as {stats: Stats}).stats.comparedQueries).toBe(3);
  });
});

describe('cancel vs completion', () => {
  it('cancel during a run wins: cancelled event, no done, pending queries dropped', async () => {
    const g = gates();
    const lab = makeLab({wait: g.wait});
    const exp = lab.createExperiment('balanced', 'body-only');
    const events = collect(lab, exp.id);
    const result = lab.cancel(exp.id);
    expect(result).toEqual({ok: true, status: 'cancelled'});
    g.releaseAll();
    await settle(lab, exp.id);
    expect(lab.getExperiment(exp.id).status).toBe('cancelled');
    expect(events.map(e => e.type)).toEqual(['meta', 'cancelled']);
  });

  it('cancel in the same tick as completion still wins (synchronous transition)', async () => {
    const lab = makeLab(); // wait resolves immediately, continuations are microtasks
    const exp = lab.createExperiment('balanced', 'body-only');
    const result = lab.cancel(exp.id);
    expect(result).toEqual({ok: true, status: 'cancelled'});
    await settle(lab, exp.id);
    const events = collect(lab, exp.id);
    expect(events.map(e => e.type)).toEqual(['meta', 'cancelled']);
  });

  it('cancel after completion loses the race: ok:false, exactly one terminal event', async () => {
    const lab = makeLab();
    const exp = lab.createExperiment('balanced', 'body-only');
    await settle(lab, exp.id);
    expect(lab.cancel(exp.id)).toEqual({ok: false, status: 'completed'});
    const terminal = collect(lab, exp.id).filter(e => e.type === 'done' || e.type === 'cancelled');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].type).toBe('done');
  });

  it('a second cancel is rejected', async () => {
    const g = gates();
    const lab = makeLab({wait: g.wait});
    const exp = lab.createExperiment('balanced', 'body-only');
    expect(lab.cancel(exp.id).ok).toBe(true);
    expect(lab.cancel(exp.id)).toEqual({ok: false, status: 'cancelled'});
    g.releaseAll();
  });
});

describe('snapshot isolation', () => {
  it('pins the corpus revision: index updates mid-run do not leak into the run', async () => {
    const g = gates();
    const lab = makeLab({wait: g.wait});
    const exp = lab.createExperiment('balanced', 'body-only');
    expect(lab.corpusRevision()).toBe(1);
    lab.upsertDoc({id: 'd7', title: 'apple apple', body: 'apple apple'});
    expect(lab.corpusRevision()).toBe(2);
    g.releaseAll();
    await settle(lab, exp.id);
    const events = collect(lab, exp.id);
    expect((events[0].data as {snapshotRevision: number}).snapshotRevision).toBe(1);
    const apple = queryOutcomes(events).find(o => o.query === 'apple')!;
    expect(hits(apple.a).map(h => h.docId)).not.toContain('d7');
    expect(hits(apple.b).map(h => h.docId)).not.toContain('d7');
    // a NEW experiment snapshots the updated corpus
    const next = lab.createExperiment('balanced', 'body-only');
    await settle(lab, next.id);
    const appleNext = queryOutcomes(collect(lab, next.id)).find(o => o.query === 'apple')!;
    expect(hits(appleNext.a).map(h => h.docId)).toContain('d7');
  });

  it('rerun replays against the pinned snapshot, not the live index', async () => {
    const lab = makeLab();
    const exp = lab.createExperiment('balanced', 'body-only');
    await settle(lab, exp.id);
    lab.upsertDoc({id: 'd7', title: 'apple apple', body: 'apple apple'});
    const rerun = lab.rerun(exp.id);
    expect(rerun.status).toBe('running');
    expect(rerun.runId).not.toBe(exp.runId);
    expect(rerun.snapshotRevision).toBe(1);
    await settle(lab, exp.id);
    const events = collect(lab, exp.id);
    expect(events[0]).toMatchObject({seq: 1, type: 'meta'}); // log reset for the new run
    expect((events[0].data as {snapshotRevision: number}).snapshotRevision).toBe(1);
    const apple = queryOutcomes(events).find(o => o.query === 'apple')!;
    expect(hits(apple.a).map(h => h.docId)).not.toContain('d7');
    expect(events[events.length - 1].type).toBe('done');
  });

  it('rejects rerun while running', async () => {
    const g = gates();
    const lab = makeLab({wait: g.wait});
    const exp = lab.createExperiment('balanced', 'body-only');
    expect(() => lab.rerun(exp.id)).toThrowError(/already running/);
    g.releaseAll();
    await settle(lab, exp.id);
  });
});

describe('snapshot reclamation', () => {
  it('reclaims the snapshot after the TTL: marked not replayable, rerun throws, log still readable', async () => {
    const lab = makeLab({snapshotTtlMs: 30});
    const exp = lab.createExperiment('balanced', 'body-only');
    await settle(lab, exp.id);
    expect(lab.getExperiment(exp.id).replayable).toBe(true);
    const events = collect(lab, exp.id); // live subscriber observes the reclaim
    await new Promise(resolve => setTimeout(resolve, 80));
    const view = lab.getExperiment(exp.id);
    expect(view.replayable).toBe(false);
    expect(view.snapshotRevision).toBe(1); // pinned revision stays visible
    expect(events.some(e => e.type === 'snapshot-reclaimed')).toBe(true);
    let error: unknown;
    try {
      lab.rerun(exp.id);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(LabError);
    expect((error as LabError).code).toBe('snapshot_reclaimed');
    // the event log survives: the experiment is viewable but not replayable
    const replay = collect(lab, exp.id);
    expect(replay.some(e => e.type === 'done')).toBe(true);
  });
});

describe('concurrency limit', () => {
  it('rejects runs beyond the limit and accepts them again after termination', async () => {
    const g = gates();
    const lab = makeLab({wait: g.wait, maxConcurrent: 2});
    const first = lab.createExperiment('balanced', 'body-only');
    lab.createExperiment('balanced', 'title-only');
    let error: unknown;
    try {
      lab.createExperiment('balanced', 'title-only');
    } catch (err) {
      error = err;
    }
    expect((error as LabError).code).toBe('concurrency_limit');
    g.releaseAll();
    await settle(lab, first.id);
    const third = lab.createExperiment('balanced', 'title-only');
    await settle(lab, third.id);
    expect(lab.getExperiment(third.id).status).toBe('completed');
  });
});

describe('observers and resume', () => {
  it('delivers identical events to two subscribers; a late subscriber replays the full log', async () => {
    const g = gates();
    const lab = makeLab({wait: g.wait});
    const exp = lab.createExperiment('balanced', 'body-only');
    const a: ExperimentEvent[] = [];
    const b: ExperimentEvent[] = [];
    lab.subscribe(exp.id, 0, event => a.push(event));
    lab.subscribe(exp.id, 0, event => b.push(event));
    g.releaseAll();
    await settle(lab, exp.id);
    expect(a.map(e => `${e.seq}:${e.type}`)).toEqual(b.map(e => `${e.seq}:${e.type}`));
    expect(a[a.length - 1].type).toBe('done');
    const late = collect(lab, exp.id);
    expect(late.map(e => e.seq)).toEqual(a.map(e => e.seq));
  });

  it('resumes from a sequence number without duplicates', async () => {
    const lab = makeLab();
    const {exp, events: all} = await completedExperiment(lab);
    const from = all[2].seq;
    const resumed = collect(lab, exp.id, from);
    expect(resumed.map(e => e.seq)).toEqual(all.filter(e => e.seq > from).map(e => e.seq));
    expect(resumed[0].seq).toBe(from + 1);
  });
});

type SseEvent = {id: string; event: string; data: string};

function readSse(port: number, path: string, headers: Record<string, string> = {}): Promise<SseEvent[]> {
  return new Promise((resolve, reject) => {
    const events: SseEvent[] = [];
    const req = http.get({host: '127.0.0.1', port, path, headers}, res => {
      let buffer = '';
      res.on('data', chunk => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed: Partial<SseEvent> = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) parsed.id = line.slice(4);
            else if (line.startsWith('event: ')) parsed.event = line.slice(7);
            else if (line.startsWith('data: ')) parsed.data = line.slice(6);
          }
          if (parsed.event) {
            events.push(parsed as SseEvent);
            if (parsed.event === 'done' || parsed.event === 'cancelled') {
              req.destroy();
              resolve(events);
              return;
            }
          }
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', err => (events.length > 0 ? resolve(events) : reject(err)));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(events);
    });
  });
}

describe('http api', () => {
  it('creates an experiment pinned to the current corpus revision', async () => {
    const app = createApp(makeLab());
    const res = await request(app).post('/api/compare/experiments').send({configA: 'balanced', configB: 'body-only'}).expect(201);
    expect(res.body).toMatchObject({status: 'running', snapshotRevision: 1, replayable: true, totalQueries: 4});
  });

  it('rejects unknown configs with 400 and overflow runs with 429', async () => {
    const g = gates();
    const lab = makeLab({wait: g.wait, maxConcurrent: 1});
    const app = createApp(lab);
    await request(app).post('/api/compare/experiments').send({configA: 'nope', configB: 'body-only'}).expect(400);
    await request(app).post('/api/compare/experiments').send({configA: 'balanced', configB: 'body-only'}).expect(201);
    const res = await request(app).post('/api/compare/experiments').send({configA: 'balanced', configB: 'title-only'}).expect(429);
    expect(res.body.error).toBe('concurrency_limit');
    g.releaseAll();
  });

  it('returns 409 when cancel loses the race against completion', async () => {
    const lab = makeLab();
    const app = createApp(lab);
    const created = await request(app).post('/api/compare/experiments').send({configA: 'balanced', configB: 'body-only'}).expect(201);
    await settle(lab, created.body.id);
    const res = await request(app).post(`/api/compare/experiments/${created.body.id}/cancel`).expect(409);
    expect(res.body).toMatchObject({error: 'not_running', status: 'completed'});
  });

  it('returns 410 on rerun once the snapshot is reclaimed', async () => {
    const lab = makeLab({snapshotTtlMs: 30});
    const app = createApp(lab);
    const created = await request(app).post('/api/compare/experiments').send({configA: 'balanced', configB: 'body-only'}).expect(201);
    await settle(lab, created.body.id);
    await new Promise(resolve => setTimeout(resolve, 80));
    const res = await request(app).post(`/api/compare/experiments/${created.body.id}/rerun`).expect(410);
    expect(res.body.error).toBe('snapshot_reclaimed');
    const view = await request(app).get(`/api/compare/experiments/${created.body.id}`).expect(200);
    expect(view.body.replayable).toBe(false);
  });

  it('404s the stream for unknown experiments', async () => {
    const app = createApp(makeLab());
    await request(app).get('/api/compare/experiments/nope/stream').expect(404);
  });

  it('streams the event log and resumes from Last-Event-ID', async () => {
    const lab = makeLab();
    const app = createApp(lab);
    const server = app.listen(0);
    const {port} = server.address() as AddressInfo;
    try {
      const exp = lab.createExperiment('balanced', 'body-only');
      await settle(lab, exp.id);
      const full = await readSse(port, `/api/compare/experiments/${exp.id}/stream`);
      expect(full[0]).toMatchObject({id: '1', event: 'meta'});
      expect(full[full.length - 1].event).toBe('done');
      const resumed = await readSse(port, `/api/compare/experiments/${exp.id}/stream`, {'last-event-id': '2'});
      expect(resumed.map(e => e.id)).toEqual(full.slice(2).map(e => e.id));
      expect(resumed[0].id).toBe('3');
      const viaParam = await readSse(port, `/api/compare/experiments/${exp.id}/stream?from=2`);
      expect(viaParam.map(e => e.id)).toEqual(resumed.map(e => e.id));
    } finally {
      server.close();
    }
  });

  it('serves two concurrent SSE observers the identical stream', async () => {
    const g = gates();
    const lab = makeLab({wait: g.wait});
    const app = createApp(lab);
    const server = app.listen(0);
    const {port} = server.address() as AddressInfo;
    try {
      const exp = lab.createExperiment('balanced', 'body-only');
      const first = readSse(port, `/api/compare/experiments/${exp.id}/stream`);
      const second = readSse(port, `/api/compare/experiments/${exp.id}/stream`);
      g.releaseAll();
      const [a, b] = await Promise.all([first, second]);
      expect(a.map(e => `${e.id}:${e.event}`)).toEqual(b.map(e => `${e.id}:${e.event}`));
      expect(a[a.length - 1].event).toBe('done');
    } finally {
      server.close();
    }
  });
});
