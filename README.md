# Search Relevance Lab

Local workbench for query judgments and A/B ranking-config comparison.

Run `npm install`, then `npm run dev` (API on :4174, UI on :4173). `npm test` runs the suite.

## A/B compare workbench

An **experiment** runs two ranking configs (side A / side B) over the same query set and
streams per-query rank deltas.

- **Immutable snapshot**: creating an experiment pins the corpus revision *and* the query
  set (`snapshotRevision` in the `meta` event). Index updates during a run bump the live
  corpus revision but never leak into a running experiment; re-run replays against the
  pinned snapshot, not the live index.
- **Concurrency limit**: at most 2 concurrent runs; extra creates get `429 concurrency_limit`.
- **Streaming**: `GET /api/compare/experiments/:id/stream` (SSE) emits `meta`, one `query`
  event per completed query (completion order ≠ query order; each carries its original
  `index`), then exactly one terminal event (`done` with stats, or `cancelled`). Observers
  resume with `Last-Event-ID` (or `?from=<seq>`); any number of pages can watch the same run.
- **Snapshot reclamation**: snapshots are reclaimed 5 min after the run terminates. The
  experiment stays viewable (event log is kept) but is marked `replayable: false` and
  re-run returns `410 snapshot_reclaimed`.
- **Stats denominator**: aggregates (`done.stats`) count only queries that completed with
  **both** sides valid — `comparedQueries of totalQueries`, with `failedQueries` excluded.

### API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/compare/configs` | ranking-config presets |
| GET/POST | `/api/compare/corpus` · `/api/compare/corpus/documents` | inspect / simulate index update (bumps revision) |
| GET/POST | `/api/compare/experiments` | list / create+run (201, 400, 429) |
| GET | `/api/compare/experiments/:id` | view incl. `replayable`, `stats` |
| POST | `/api/compare/experiments/:id/cancel` | 200, or 409 `not_running` if the run finished first |
| POST | `/api/compare/experiments/:id/rerun` | replays pinned snapshot; 409 while running, 410 once reclaimed |
| GET | `/api/compare/experiments/:id/stream` | SSE; resumes from `Last-Event-ID` |

### Demo data

Queries: `apple`, `kiwi`, `flaky parser`, `zebra`. With the default pair
(balanced vs body-only): `apple` exercises score ties and docs missing on one side,
`flaky parser` fails side B (simulated backend error), `zebra` matches nothing but is
still valid and counted in the stats denominator.
