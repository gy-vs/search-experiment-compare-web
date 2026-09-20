# Search Relevance Lab — A/B ranking comparison workbench

Run two ranking configurations side by side over the **same immutable corpus
snapshot** and a **fixed query set**, then compare rank movement per query as
results stream in.

## Guarantees

- **Pinned inputs.** Creating an experiment clones the current index revision
  into an immutable snapshot (`snapshotId`, `corpusRevision`). Advancing the
  live index (`POST /api/corpus/reindex`) while the experiment runs never
  changes either side's input. A revision can also be pinned explicitly.
- **Bounded concurrency.** At most N experiments (default 2) execute at once;
  extra experiments are queued FIFO. Cancellation of a queued experiment is
  immediate and hands its slot to the next waiter.
- **Streaming + resumable.** Every experiment keeps a durable, monotonic event
  log. SSE frames carry `id: <seq>`; clients resume with
  `GET /api/experiments/:id/events?after=<last confirmed seq>` (or
  `Last-Event-ID`). Replayed frames are deduplicated by seq. If the resume
  point aged out of the retention window, the server emits
  `replay_unavailable` and the client re-fetches full state.
- **Stable incremental UI.** Result rows are fixed slots keyed by the query's
  original index. Out-of-order arrivals fill slots without reordering rows, so
  an expanded row never jumps. Expanded state is keyed by query index too.
- **One terminal outcome.** Cancel-vs-completion races resolve through a single
  compare-and-set terminal transition; a client can never observe both `done`
  and `cancelled`.
- **Snapshot GC is explicit.** `POST /api/snapshots/:id/reclaim` marks every
  experiment on that snapshot **non-replayable** (a running/queued experiment
  is failed; a finished one keeps its persisted results but emits
  `snapshot_reclaimed`, and replay returns **410**).
- **Stats denominators are always shown.** Aggregates only use queries where
  **both sides returned ok**. A side returning zero results is still valid
  (counted, and separately tagged `onlySide`/`bothEmpty`); a side error
  excludes the whole query. The headline stat is `comparable/totalQueries`;
  per-doc movement fractions are over `comparedDocs` (docs present on both
  sides).

## Ranking semantics

The toy deterministic ranker scores title/body/tag token overlap with
per-config weights, rounds scores, applies **competition ranking ("1224")**
for exact score ties, and breaks remaining ties by ascending `docId`, so order
is fully deterministic. Tie groups are reported on each document.

Suffix a query with `!fail:a` or `!fail:b` to simulate that side failing.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/corpus` | Current revision + revision history |
| POST | `/api/corpus/reindex` | Publish a new index revision (optional `{doc:{...}}`) |
| GET | `/api/experiments` | List experiments + active/queued counts |
| POST | `/api/experiments` | Create (`{querySet,a,b,topK?,corpusRevision?}`); returns state |
| GET | `/api/experiments/:id` | Full state (all query slots, stats, lastSeq) |
| GET | `/api/experiments/:id/events?after=<seq>` | SSE event stream (resumable) |
| POST | `/api/experiments/:id/cancel` | Cancel (queued → terminal, running → cancelling) |
| POST | `/api/experiments/:id/replay` | Re-run on the same snapshot; **410** if reclaimed |
| GET | `/api/snapshots` | Snapshot retention status per experiment |
| POST | `/api/snapshots/:id/reclaim` | Simulate snapshot GC |

SSE events: `queued`, `running`, `query_result`, `done`, `cancelled`,
`failed`, `snapshot_reclaimed`, plus a pseudo-event `replay_unavailable`.
Comments (`: ping`) act as heartbeats and carry no id.

## Develop

```bash
npm install
npm run dev      # API on :4174, Vite UI on :4173 (proxied)
npm test         # server scenarios + client reducer tests
npm run build    # tsc --noEmit && vite build
```

## Code map

- `src/shared/types.ts` — wire protocol types
- `src/server/corpus.ts` — versioned corpus, immutable snapshots, ranker
- `src/server/compare.ts` — per-query A/B diff + stats (pure)
- `src/server/experiments.ts` — store, FIFO semaphore, runner, durable event log
- `src/server/index.ts` — HTTP + SSE routes
- `src/client/stream.ts` — pure event→view reducer (slots, dedupe, resume)
- `src/client/App.tsx` — workbench UI
