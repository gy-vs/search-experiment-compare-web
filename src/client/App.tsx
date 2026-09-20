import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  FlaskConical,
  Minus,
  Pause,
  Play,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type {
  ExperimentState,
  QueryResultPayload,
  RankedDoc,
  RankConfig,
} from '../shared/types';
import { foldEvent, foldState, type ExperimentView } from './stream';

interface CorpusInfo {
  currentRevision: number;
}
interface ListResponse {
  active: number;
  queued: number;
  experiments: ExperimentState[];
}

const DEFAULT_A: RankConfig = { name: 'Baseline', weights: { title: 3, body: 1, tags: 2 } };
const DEFAULT_B: RankConfig = { name: 'Candidate', weights: { title: 1, body: 2, tags: 4 } };

export default function App() {
  const [corpus, setCorpus] = useState<CorpusInfo | null>(null);
  const [list, setList] = useState<ListResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<ExperimentView | null>(null);

  const [queryText, setQueryText] = useState(
    'alpha\nbeta\nshipping\nnonexistent topic\nalpha !fail:b',
  );
  const [a, setA] = useState<RankConfig>(DEFAULT_A);
  const [b, setB] = useState<RankConfig>(DEFAULT_B);
  const [createError, setCreateError] = useState<string | null>(null);

  // Expansion state is keyed by query INDEX, never by arrival order, so rows
  // filling in late cannot move another row's expand/collapse state.
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    refreshCorpus();
    refreshList();
  }, []);

  const refreshList = useCallback(async () => {
    const response = await fetch('/api/experiments');
    const value = (await response.json()) as ListResponse;
    setList(value);
    setSelected((current) => current ?? value.experiments[0]?.id ?? null);
  }, []);

  const refreshCorpus = useCallback(async () => {
    const response = await fetch('/api/corpus');
    setCorpus((await response.json()) as CorpusInfo);
  }, []);

  // Poll only while experiments are non-terminal — keeps two open pages in
  // sync for the experiment list; rows themselves stream over SSE.
  useEffect(() => {
    const anyActive = list?.experiments.some(
      (exp) => exp.status === 'queued' || exp.status === 'running' || exp.status === 'cancelling',
    );
    if (!anyActive) return;
    const timer = setInterval(refreshList, 700);
    return () => clearInterval(timer);
  }, [list, refreshList]);

  const reindex = useCallback(async () => {
    await fetch('/api/corpus/reindex', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await refreshCorpus();
    await refreshList();
  }, [refreshCorpus, refreshList]);

  const createExperiment = useCallback(async () => {
    const querySet = queryText.split('\n').map((q) => q.trim()).filter(Boolean);
    setCreateError(null);
    const response = await fetch('/api/experiments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ querySet, a, b, topK: 5 }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      setCreateError(error.error ?? 'failed to create experiment');
      return;
    }
    const state = (await response.json()) as ExperimentState;
    await refreshList();
    setSelected(state.id);
  }, [queryText, a, b, refreshList]);

  const selectExperiment = useCallback(
    async (id: string) => {
      setSelected(id);
      setExpanded(new Set());
    },
    [],
  );

  const cancel = useCallback(async () => {
    if (!selected) return;
    await fetch(`/api/experiments/${selected}/cancel`, { method: 'POST' });
  }, [selected]);

  const replay = useCallback(async () => {
    if (!selected) return;
    const response = await fetch(`/api/experiments/${selected}/replay`, { method: 'POST' });
    if (response.status === 410) return; // banner already marks it non-replayable
    if (response.ok) {
      const state = (await response.json()) as ExperimentState;
      await refreshList();
      setSelected(state.id);
      setExpanded(new Set());
    }
  }, [selected, refreshList]);

  const reclaimSnapshot = useCallback(async () => {
    if (!view) return;
    await fetch(`/api/snapshots/${view.snapshotId}/reclaim`, { method: 'POST' });
    await refreshList();
  }, [view, refreshList]);

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Search Relevance Lab</strong>
        <small>A/B ranking comparison on immutable snapshots</small>
        <span className="revision">
          index revision <b>{corpus?.currentRevision ?? '…'}</b>
        </span>
        <button className="ghost" onClick={reindex}>
          <RefreshCw size={13} /> advance index
        </button>
      </header>

      <section className="workspace">
        <aside className="pane sidebar">
          <h2>Experiments</h2>
          <p className="muted">
            {list ? `${list.active} running · ${list.queued} queued (limit 2)` : 'loading…'}
          </p>
          <div className="list">
            {list?.experiments.map((exp) => (
              <button
                key={exp.id}
                className={exp.id === selected ? 'active' : ''}
                onClick={() => selectExperiment(exp.id)}
              >
                <span className="exp-id">{exp.id}</span>
                <StatusBadge status={exp.status} />
                <small>
                  rev {exp.corpusRevision} · {exp.completedQueries}/{exp.totalQueries}
                  {!exp.replayable && <em className="noreplay"> · snapshot reclaimed</em>}
                </small>
              </button>
            ))}
          </div>

          <h2 className="mt">New experiment</h2>
          <textarea
            aria-label="Queries, one per line"
            value={queryText}
            onChange={(event) => setQueryText(event.target.value)}
          />
          <ConfigEditor label="A" config={a} onChange={setA} />
          <ConfigEditor label="B" config={b} onChange={setB} />
          <button className="primary wide" onClick={createExperiment}>
            <Play size={14} /> run both sides
          </button>
          {createError && <p className="error">{createError}</p>}
          <p className="hint">
            Hint: suffix a query with <code>!fail:a</code> or <code>!fail:b</code> to simulate a
            side failure.
          </p>
        </aside>

        <section className="pane results">
          {selected ? (
            <ExperimentPanel
              key={selected}
              id={selected}
              view={view}
              setView={setView}
              expanded={expanded}
              toggle={(index) =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(index)) next.delete(index);
                  else next.add(index);
                  return next;
                })
              }
              onCancel={cancel}
              onReplay={replay}
              onReclaim={reclaimSnapshot}
              onSettled={refreshList}
            />
          ) : (
            <p className="muted">Create an experiment to begin.</p>
          )}
        </section>
      </section>
    </main>
  );
}

function ConfigEditor({
  label,
  config,
  onChange,
}: {
  label: string;
  config: RankConfig;
  onChange: (config: RankConfig) => void;
}) {
  return (
    <div className="config">
      <div className="config-head">
        <span className={`side side-${label.toLowerCase()}`}>{label}</span>
        <input
          aria-label={`${label} name`}
          value={config.name}
          onChange={(event) => onChange({ ...config, name: event.target.value })}
        />
      </div>
      <div className="weights">
        {(['title', 'body', 'tags'] as const).map((field) => (
          <label key={field}>
            {field}
            <input
              type="number"
              value={config.weights[field]}
              onChange={(event) =>
                onChange({ ...config, weights: { ...config.weights, [field]: Number(event.target.value) } })
              }
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

function ExperimentPanel({
  id,
  view,
  setView,
  expanded,
  toggle,
  onCancel,
  onReplay,
  onReclaim,
  onSettled,
}: {
  id: string;
  view: ExperimentView | null;
  setView: React.Dispatch<React.SetStateAction<ExperimentView | null>>;
  expanded: Set<number>;
  toggle: (index: number) => void;
  onCancel: () => void;
  onReplay: () => void;
  onReclaim: () => void;
  onSettled: () => void;
}) {
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting' | 'closed'>(
    'connecting',
  );
  const [replayGap, setReplayGap] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const cursorRef = useRef(0);
  const settledRef = useRef(false);

  // Hydrate full state once (covers attaching to an already-finished run, and
  // gives us the result-slot length before any query_result frames).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/experiments/${id}`)
      .then((response) => response.json())
      .then((state: ExperimentState) => {
        if (cancelled) return;
        cursorRef.current = state.lastSeq;
        setView(foldState(state));
      });
    return () => {
      cancelled = true;
    };
  }, [id, setView]);

  useEffect(() => {
    let source: EventSource | null = null;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let terminal = false; // once the run ends, network close is expected, not a drop

    const connect = () => {
      // Resume from the last confirmed event seq.
      source = new EventSource(`/api/experiments/${id}/events?after=${cursorRef.current}`);
      source.onopen = () => {
        if (!disposed) setConnection('live');
      };

      const eventTypes = [
        'queued',
        'running',
        'query_result',
        'done',
        'cancelled',
        'failed',
        'snapshot_reclaimed',
      ] as const;
      for (const type of eventTypes) {
        source.addEventListener(type, (event) => {
          const raw = event as MessageEvent<string>;
          if (type === 'done' || type === 'cancelled' || type === 'failed') {
            terminal = true;
            setConnection('closed');
            source?.close();
            if (!settledRef.current) {
              settledRef.current = true;
              onSettled();
            }
          }
          const seq = Number(raw.lastEventId);
          const data = JSON.parse(raw.data) as Parameters<typeof foldEvent>[2];
          cursorRef.current = seq;
          setView((current) => foldEvent(current, seq, data));
        });
      }

      // Gap in the durable window: re-fetch authoritative state, then keep streaming.
      source.addEventListener('replay_unavailable', () => {
        setReplayGap(true);
        fetch(`/api/experiments/${id}`)
          .then((response) => response.json())
          .then((state: ExperimentState) => {
            if (disposed) return;
            cursorRef.current = state.lastSeq;
            setView(foldState(state));
            setReplayGap(false);
          });
      });

      source.onerror = () => {
        if (disposed || terminal) return; // clean end after a terminal frame
        source?.close();
        setConnection('reconnecting');
        retry = setTimeout(connect, 600); // EventSource itself also retries; we own the cursor
      };
    };

    connect();
    return () => {
      disposed = true;
      terminal = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (view?.snapshotReclaimed) setNotice('Snapshot was reclaimed — this experiment can no longer be replayed.');
  }, [view?.snapshotReclaimed]);

  if (!view) return <p className="muted">Loading experiment…</p>;

  const completed = view.results.filter(Boolean).length;
  const live = view.phase === 'running' || view.phase === 'queued' || view.phase === 'cancelling';

  return (
    <>
      <div className="exp-header">
        <div>
          <h2>{id}</h2>
          <small>
            snapshot <code>{view.snapshotId}</code> · pinned to corpus revision{' '}
            <b>{view.corpusRevision}</b>
          </small>
        </div>
        <div className="actions">
          <StatusBadge status={view.phase} />
          <span className={`conn conn-${connection}`}>
            {replayGap ? 're-buffering…' : connection}
          </span>
          {(view.phase === 'running' || view.phase === 'queued') && (
            <button onClick={onCancel}>
              <Pause size={13} /> cancel
            </button>
          )}
          {!live && (
            <button disabled={!view.replayable} title={view.replayable ? 'Re-run on same snapshot' : 'Snapshot reclaimed'} onClick={onReplay}>
              <RefreshCw size={13} /> replay
            </button>
          )}
          {!live && view.replayable && (
            <button className="danger-ghost" onClick={onReclaim}>
              <Trash2 size={13} /> reclaim snapshot
            </button>
          )}
        </div>
      </div>

      {notice && <div className="banner warn">{notice}</div>}
      {!view.replayable && !notice && (
        <div className="banner warn">Snapshot reclaimed: results stay viewable, replay is unavailable.</div>
      )}
      {view.phase === 'cancelled' && <div className="banner muted-banner">Experiment cancelled — stats cover completed pairs only.</div>}
      {view.phase === 'failed' && <div className="banner error">Experiment failed: {view.failure}</div>}

      <ProgressBar completed={completed} total={view.totalQueries} />

      <StatsBar view={view} />

      <div className="rows">
        {view.results.map((result, index) => (
          <QueryRow key={index} index={index} result={result} open={expanded.has(index)} onToggle={() => toggle(index)} />
        ))}
      </div>
    </>
  );
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  return (
    <div className="progress">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${total === 0 ? 0 : (completed / total) * 100}%` }} />
      </div>
      <small>
        {completed}/{total} queries completed
      </small>
    </div>
  );
}

function StatsBar({ view }: { view: ExperimentView }) {
  const stats = view.stats;
  const live = view.phase === 'running' || view.phase === 'queued' || view.phase === 'cancelling';
  const completed = view.results.filter(Boolean).length;
  const comparable = view.results.filter((result) => result?.comparable).length;

  // Live aggregate uses the same rule as the terminal stats: both sides ok.
  const liveDenominator = comparable;
  const pairedDocs = useMemo(
    () =>
      view.results.reduce(
        (sum, result) => sum + (result ? result.deltas.filter((delta) => delta.delta !== null).length : 0),
        0,
      ),
    [view.results],
  );

  if (live) {
    return (
      <div className="stats">
        <Stat label="comparable queries" value={`${liveDenominator}/${completed} finished`} sub="both sides ok" />
        <Stat label="paired docs so far" value={String(pairedDocs)} sub="present on both sides" />
        <Stat label="excluded from stats" value={`${completed - liveDenominator}`} sub="a side failed" />
      </div>
    );
  }
  if (!stats) return null;
  return (
    <div className="stats">
      <Stat
        label="denominator: queries"
        value={`${stats.comparable}/${stats.totalQueries}`}
        sub={`only both-sides-valid queries count; ${stats.totalQueries - stats.comparable} excluded`}
        emphasis
      />
      <Stat label="denominator: docs" value={String(stats.comparedDocs)} sub="docs present on both sides" />
      <Stat
        label="B improves"
        value={`${stats.improved}/${stats.comparedDocs}`}
        sub="rank delta > 0"
        icon={<ArrowUp size={14} className="up" />}
      />
      <Stat
        label="B regresses"
        value={`${stats.regressed}/${stats.comparedDocs}`}
        sub="rank delta < 0"
        icon={<ArrowDown size={14} className="down" />}
      />
      <Stat
        label="unchanged"
        value={`${stats.unchanged}/${stats.comparedDocs}`}
        icon={<Minus size={14} />}
      />
      <Stat
        label="avg |Δrank|"
        value={stats.avgAbsDelta === null ? '—' : String(stats.avgAbsDelta)}
        sub={`over ${stats.comparedDocs} docs`}
      />
      <Stat label="tie queries" value={`${stats.tieQueries}/${stats.comparable}`} sub="exact score tie on a side" />
      <Stat label="only one side hits" value={String(stats.onlySide)} sub="both ok, one empty" />
      <Stat label="both empty" value={String(stats.bothEmpty)} />
      <Stat label="A failed" value={String(stats.failedA)} />
      <Stat label="B failed" value={String(stats.failedB)} />
      <Stat label="both failed" value={String(stats.bothFailed)} />
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  icon,
  emphasis,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div className={`stat ${emphasis ? 'stat-emphasis' : ''}`}>
      <div className="stat-value">
        {icon}
        {value}
      </div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function QueryRow({
  index,
  result,
  open,
  onToggle,
}: {
  index: number;
  result: QueryResultPayload | null;
  open: boolean;
  onToggle: () => void;
}) {
  if (!result) {
    return (
      <div className="row row-pending">
        <span className="row-index">#{index + 1}</span>
        <span className="muted">waiting…</span>
      </div>
    );
  }
  const aFail = result.a.status === 'error';
  const bFail = result.b.status === 'error';
  const hasTie =
    (result.a.status === 'ok' && result.a.results.some((doc) => doc.tiedWith.length > 0)) ||
    (result.b.status === 'ok' && result.b.results.some((doc) => doc.tiedWith.length > 0));
  return (
    <div className={`row ${open ? 'open' : ''} ${!result.comparable ? 'incomparable' : ''}`}>
      <button className="row-head" onClick={onToggle}>
        <span className="row-index">#{index + 1}</span>
        <span className="row-query">{result.query.replace(/\s*!fail:[ab]\s*$/, '')}</span>
        {!result.comparable && <span className="tag tag-error">excluded from stats</span>}
        {result.comparable && result.deltas.some((delta) => delta.note) && (
          <span className="tag tag-warn">missing on a side</span>
        )}
        {result.comparable && hasTie && <span className="tag tag-tie">tie</span>}
        <span className="row-deltas">
          {result.comparable
            ? summarize(result)
            : `${aFail ? 'A error' : ''}${aFail && bFail ? ' · ' : ''}${bFail ? 'B error' : ''}`}
        </span>
      </button>
      {open && <QueryDetail result={result} />}
    </div>
  );
}

function summarize(result: QueryResultPayload): string {
  const paired = result.deltas.filter((delta) => delta.delta !== null);
  const moves = paired.filter((delta) => delta.delta !== 0).length;
  const onlyA = result.deltas.filter((delta) => delta.note === 'only_a').length;
  const onlyB = result.deltas.filter((delta) => delta.note === 'only_b').length;
  return `${paired.length} paired · ${moves} moved${onlyA || onlyB ? ` · A-only ${onlyA} / B-only ${onlyB}` : ''}`;
}

function QueryDetail({ result }: { result: QueryResultPayload }) {
  return (
    <div className="detail">
      <SideColumn title="A" outcome={result.a} />
      <div className="diff-column">
        <h4>rank Δ (A→B)</h4>
        {result.deltas.length === 0 && <p className="muted">no hits on either side</p>}
        {result.deltas.map((delta) => (
          <div key={delta.docId} className="diff-row">
            <code>{delta.docId}</code>
            <span className="ranks">
              {delta.rankA === null ? <em>missing</em> : delta.rankA}
              <span className="arrow">→</span>
              {delta.rankB === null ? <em>missing</em> : delta.rankB}
            </span>
            <DeltaPill delta={delta.delta} note={delta.note} />
          </div>
        ))}
      </div>
      <SideColumn title="B" outcome={result.b} />
    </div>
  );
}

function SideColumn({ title, outcome }: { title: string; outcome: QueryResultPayload['a'] }) {
  return (
    <div className="side-column">
      <h4 className={`side side-${title.toLowerCase()}`}>{title} results</h4>
      {outcome.status === 'error' ? (
        <div className="side-error">query failed: {outcome.error}</div>
      ) : outcome.results.length === 0 ? (
        <p className="muted">no results</p>
      ) : (
        <ol className="doc-list">
          {outcome.results.map((doc: RankedDoc) => (
            <li key={doc.docId}>
              <span className="doc-rank">{doc.rank}</span>
              <code>{doc.docId}</code>
              <span className="doc-score">{doc.score}</span>
              {doc.tiedWith.length > 0 && (
                <span className="tag tag-tie">tied: {doc.tiedWith.join(', ')}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function DeltaPill({ delta, note }: { delta: number | null; note?: 'only_a' | 'only_b' }) {
  if (delta === null) {
    return <span className="pill pill-missing">{note === 'only_a' ? 'only A' : 'only B'}</span>;
  }
  if (delta === 0) return <span className="pill pill-zero">=</span>;
  return (
    <span className={delta > 0 ? 'pill pill-up' : 'pill pill-down'}>
      {delta > 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
      {Math.abs(delta)}
    </span>
  );
}
