import type { Server } from 'node:http';
import express, { type Response } from 'express';
import { fileURLToPath } from 'node:url';
import type { StoredEvent } from '../shared/types.js';
import { CorpusStore, UnknownRevisionError } from './corpus.js';
import {
  ExperimentNotFoundError,
  ExperimentStore,
  SnapshotReclaimedError,
} from './experiments.js';

export interface AppOptions {
  concurrency?: number;
  eventLimit?: number;
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  const corpus = new CorpusStore();
  const experiments = new ExperimentStore(corpus, {
    concurrency: options.concurrency ?? 2,
    eventLimit: options.eventLimit,
  });

  app.use(express.json({ limit: '1mb' }));

  // ---- Corpus / index -----------------------------------------------------

  app.get('/api/corpus', (_req, res) => {
    res.json({
      currentRevision: corpus.currentRevision,
      revisions: corpus.listRevisions(),
    });
  });

  // Simulate the live index advancing mid-experiment. Snapshots are untouched.
  app.post('/api/corpus/reindex', (req, res) => {
    const addDoc = req.body?.doc ?? null;
    const revision = corpus.reindex((docs) => {
      if (addDoc && typeof addDoc.id === 'string') {
        return [...docs.filter((doc) => doc.id !== addDoc.id), normalizeDoc(addDoc, revisionTag(docs.length))];
      }
      // default mutation: bump a field so ordering can shift on the new revision
      const next = docs.map((doc, i) =>
        i === 0 ? { ...doc, body: `${doc.body} reindexed` } : doc,
      );
      return next;
    });
    res.status(201).json({ revision });
  });

  // ---- Experiments --------------------------------------------------------

  app.get('/api/experiments', (_req, res) => {
    res.json({
      active: experiments.activeCount,
      queued: experiments.queuedCount,
      experiments: experiments.list().map((record) => experiments.summaryOf(record)),
    });
  });

  app.post('/api/experiments', (req, res) => {
    try {
      const record = experiments.create(req.body ?? {});
      res.status(201).json(experiments.stateOf(record));
    } catch (error) {
      if (error instanceof UnknownRevisionError) {
        res.status(400).json({ error: 'unknown_revision', revision: error.revision });
      } else {
        res.status(400).json({ error: error instanceof Error ? error.message : 'invalid_request' });
      }
    }
  });

  app.get('/api/experiments/:id', (req, res) => {
    try {
      res.json(experiments.stateOf(experiments.require(req.params.id)));
    } catch (error) {
      if (error instanceof ExperimentNotFoundError) res.status(404).json({ error: 'not_found' });
      else throw error;
    }
  });

  app.post('/api/experiments/:id/cancel', (req, res) => {
    try {
      const record = experiments.cancel(req.params.id);
      res.json(experiments.stateOf(record));
    } catch (error) {
      if (error instanceof ExperimentNotFoundError) res.status(404).json({ error: 'not_found' });
      else throw error;
    }
  });

  app.post('/api/experiments/:id/replay', (req, res) => {
    try {
      const record = experiments.replay(req.params.id);
      res.status(201).json(experiments.stateOf(record));
    } catch (error) {
      if (error instanceof ExperimentNotFoundError) res.status(404).json({ error: 'not_found' });
      else if (error instanceof SnapshotReclaimedError) {
        res.status(410).json({ error: 'snapshot_reclaimed', replayable: false });
      } else throw error;
    }
  });

  // SSE: replay durable events after the client's cursor, then stream live ones.
  app.get('/api/experiments/:id/events', (req, res) => {
    let record;
    try {
      record = experiments.require(req.params.id);
    } catch (error) {
      if (error instanceof ExperimentNotFoundError) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      throw error;
    }

    const afterRaw =
      typeof req.query.after === 'string'
        ? req.query.after
        : req.header('last-event-id') ?? '0';
    const after = Number.parseInt(afterRaw, 10);
    const cursor = Number.isFinite(after) ? after : 0;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');

    const replay = experiments.eventsAfter(record, cursor);
    if (replay.trimmed) {
      // The confirmation point aged out; client must re-fetch full state.
      res.write(`event: replay_unavailable\ndata: ${JSON.stringify({ from: cursor })}\n\n`);
    } else {
      for (const event of replay.events) writeSse(res, event);
    }

    const onEvent = (event: StoredEvent) => {
      if (event.seq <= cursor) return; // dedupe against the resumed position
      writeSse(res, event);
      if (event.data.type === 'done' || event.data.type === 'cancelled' || event.data.type === 'failed') {
        // Give the frame time to flush, then close; EventSource does not retry a clean end.
        setTimeout(() => res.end(), 150);
      }
    };
    experiments.emitter.on(`exp:${record.id}`, onEvent);

    // Heartbeat keeps proxies from cutting an idle stream; it has no id so
    // the client's resume cursor never moves.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    heartbeat.unref?.();

    req.on('close', () => {
      clearInterval(heartbeat);
      experiments.emitter.off(`exp:${record.id}`, onEvent);
      res.end();
    });
  });

  // ---- Snapshot administration (simulates storage GC) ---------------------

  app.get('/api/snapshots', (_req, res) => {
    res.json({
      snapshots: experiments
        .list()
        .map((record) => ({
          snapshotId: record.snapshot.id,
          corpusRevision: record.snapshot.revision,
          experimentId: record.id,
          experimentStatus: record.status,
          retained: corpus.hasSnapshot(record.snapshot.id),
        })),
    });
  });

  app.post('/api/snapshots/:id/reclaim', (req, res) => {
    const target = experiments.list().find((record) => record.snapshot.id === req.params.id);
    if (!target || !corpus.hasSnapshot(target.snapshot.id)) {
      res.status(404).json({ error: 'snapshot_not_found' });
      return;
    }
    const reclaimed = corpus.reclaim((snapshot) => snapshot.id === req.params.id);
    const affected = experiments.markSnapshotReclaimed(req.params.id);
    res.json({
      reclaimed,
      experiments: affected.map((record) => experiments.summaryOf(record)),
      // Finished experiments keep their persisted results, but cannot replay.
      note: 'experiments on this snapshot are now non-replayable',
    });
  });

  return app;
}

function writeSse(res: Response, event: StoredEvent): void {
  res.write(`id: ${event.seq}\nevent: ${event.data.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

function revisionTag(index: number): string[] {
  return [`rev-${index}`];
}

function normalizeDoc(doc: { id?: unknown; title?: unknown; tags?: unknown; body?: unknown }, tags: string[]) {
  return {
    id: String(doc.id ?? `doc-${Date.now()}`),
    title: String(doc.title ?? doc.id ?? 'Untitled'),
    tags: Array.isArray(doc.tags) ? doc.tags.map(String) : tags,
    body: String(doc.body ?? ''),
  };
}

export function startServer(port = 4174): Server {
  const server = createApp().listen(port, '127.0.0.1', () => {
    console.log(`server http://127.0.0.1:${port}`);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer();
}
