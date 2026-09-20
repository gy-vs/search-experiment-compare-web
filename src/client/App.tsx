import {useCallback, useEffect, useRef, useState} from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  FlaskConical,
  Loader2,
  Play,
  RotateCcw,
  XCircle,
} from 'lucide-react';

type RankingConfig = {id: string; name: string; titleWeight: number; bodyWeight: number};
type Hit = {docId: string; score: number; rank: number; tied: boolean};
type SideOutcome = {status: 'ok'; hits: Hit[]} | {status: 'error'; error: string};
type DocDelta = {
  docId: string;
  rankA: number | null;
  rankB: number | null;
  delta: number | null;
  tiedA: boolean;
  tiedB: boolean;
};
type QueryOutcome = {queryId: string; index: number; query: string; a: SideOutcome; b: SideOutcome; deltas: DocDelta[] | null};
type QuerySpec = {id: string; text: string};
type Stats = {
  totalQueries: number;
  completedQueries: number;
  comparedQueries: number;
  failedQueries: number;
  changedQueries: number;
  docsCompared: number;
  docsOnlyInA: number;
  docsOnlyInB: number;
  tiedDocsA: number;
  tiedDocsB: number;
  meanAbsRankDelta: number | null;
};
type ExperimentView = {
  id: string;
  runId: string;
  status: 'running' | 'completed' | 'cancelled';
  createdAt: string;
  configA: RankingConfig;
  configB: RankingConfig;
  snapshotRevision: number;
  replayable: boolean;
  totalQueries: number;
  stats: Stats | null;
};
type MetaEvent = {
  runId: string;
  experimentId: string;
  snapshotRevision: number;
  queries: QuerySpec[];
  configA: RankingConfig;
  configB: RankingConfig;
  createdAt: string;
};
type CorpusState = {revision: number; docs: {id: string; title: string; body: string}[]};

const STATUS_LABEL: Record<string, string> = {running: 'Running', completed: 'Completed', cancelled: 'Cancelled'};

export default function App() {
  const [configs, setConfigs] = useState<RankingConfig[]>([]);
  const [experiments, setExperiments] = useState<ExperimentView[]>([]);
  const [corpus, setCorpus] = useState<CorpusState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [configA, setConfigA] = useState('balanced');
  const [configB, setConfigB] = useState('body-only');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [exps, corp] = await Promise.all([
      fetch('/api/compare/experiments').then(r => r.json()),
      fetch('/api/compare/corpus').then(r => r.json()),
    ]);
    setExperiments(exps);
    setCorpus(corp);
  }, []);

  useEffect(() => {
    fetch('/api/compare/configs').then(r => r.json()).then(setConfigs);
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function createExperiment() {
    setError(null);
    const response = await fetch('/api/compare/experiments', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({configA, configB}),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.message ?? body.error ?? 'failed to create experiment');
      return;
    }
    setSelected(body.id);
    refresh();
  }

  async function simulateIndexUpdate() {
    // Mutates a doc and bumps the corpus revision; pinned snapshots are unaffected.
    await fetch('/api/compare/corpus/documents', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({id: 'd6', title: 'crisp apple', body: `orchard notes apple update ${Date.now()}`}),
    });
    refresh();
  }

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>Search Relevance Lab</strong>
        <small>A/B ranking compare</small>
        <span className="spacer" />
        <span className="corpus-indicator" title="Current index revision">
          <Database size={14} /> index r{corpus?.revision ?? '…'}
        </span>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>New experiment</h2>
          <label className="field">
            Side A
            <select value={configA} onChange={event => setConfigA(event.target.value)}>
              {configs.map(config => (
                <option key={config.id} value={config.id}>{config.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Side B
            <select value={configB} onChange={event => setConfigB(event.target.value)}>
              {configs.map(config => (
                <option key={config.id} value={config.id}>{config.name}</option>
              ))}
            </select>
          </label>
          <button className="primary block" onClick={createExperiment}>
            <Play size={15} /> Run comparison
          </button>
          {error && <p className="error">{error}</p>}
          <h2>Experiments</h2>
          <div className="list">
            {experiments.length === 0 && <p className="muted">No experiments yet.</p>}
            {[...experiments].reverse().map(exp => (
              <button
                key={exp.id}
                className={exp.id === selected ? 'active' : ''}
                onClick={() => setSelected(exp.id)}
              >
                {exp.id} · {exp.configA.id} vs {exp.configB.id}
                <br />
                <small>
                  {STATUS_LABEL[exp.status]} · snapshot r{exp.snapshotRevision}
                  {exp.replayable ? '' : ' · not replayable'}
                </small>
              </button>
            ))}
          </div>
          <h2>Corpus</h2>
          <p className="muted">{corpus ? `${corpus.docs.length} docs · revision r${corpus.revision}` : '…'}</p>
          <button className="block" onClick={simulateIndexUpdate}>
            Simulate index update
          </button>
        </aside>
        <section className="pane grow">
          {selected ? (
            <ExperimentView key={selected} experimentId={selected} corpusRevision={corpus?.revision ?? null} onChanged={refresh} />
          ) : (
            <p className="muted">Select or create an experiment.</p>
          )}
        </section>
      </section>
    </main>
  );
}

function ExperimentView({
  experimentId,
  corpusRevision,
  onChanged,
}: {
  experimentId: string;
  corpusRevision: number | null;
  onChanged: () => void;
}) {
  const [meta, setMeta] = useState<MetaEvent | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, QueryOutcome>>({});
  const [status, setStatus] = useState<'running' | 'completed' | 'cancelled'>('running');
  const [stats, setStats] = useState<Stats | null>(null);
  const [replayable, setReplayable] = useState(true);
  const [conn, setConn] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    // EventSource automatically resends Last-Event-ID on reconnect; the server
    // replays only events after it, so a dropped connection resumes from the
    // last confirmed event without duplicates.
    const source = new EventSource(`/api/compare/experiments/${experimentId}/stream`);
    source.onopen = () => setConn('live');
    source.onerror = () => setConn('reconnecting');
    source.addEventListener('meta', event => {
      const next: MetaEvent = JSON.parse((event as MessageEvent).data);
      // A new runId means the experiment was rerun: reset per-run state.
      // The same meta replayed after a reconnect is ignored.
      if (runIdRef.current !== next.runId) {
        runIdRef.current = next.runId;
        setMeta(next);
        setOutcomes({});
        setStats(null);
        setStatus('running');
        setReplayable(true);
      }
    });
    source.addEventListener('query', event => {
      const outcome: QueryOutcome = JSON.parse((event as MessageEvent).data);
      setOutcomes(prev => ({...prev, [outcome.queryId]: outcome}));
    });
    source.addEventListener('done', event => {
      const data = JSON.parse((event as MessageEvent).data) as {stats: Stats};
      setStats(data.stats);
      setStatus('completed');
    });
    source.addEventListener('cancelled', () => setStatus('cancelled'));
    source.addEventListener('snapshot-reclaimed', () => setReplayable(false));
    return () => source.close();
  }, [experimentId]);

  async function cancel() {
    const response = await fetch(`/api/compare/experiments/${experimentId}/cancel`, {method: 'POST'});
    // 409 means the run finished first — the stream delivers the terminal event.
    if (response.status !== 409) onChanged();
  }

  async function rerun() {
    const response = await fetch(`/api/compare/experiments/${experimentId}/rerun`, {method: 'POST'});
    if (response.status === 410) setReplayable(false);
    onChanged();
  }

  function toggle(queryId: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(queryId)) next.delete(queryId);
      else next.add(queryId);
      return next;
    });
  }

  const queries = meta?.queries ?? [];
  const outcomeList = Object.values(outcomes);
  const liveCompared = outcomeList.filter(o => o.a.status === 'ok' && o.b.status === 'ok').length;
  const liveFailed = outcomeList.filter(o => o.a.status !== 'ok' || o.b.status !== 'ok').length;
  const indexMoved = meta !== null && corpusRevision !== null && corpusRevision > meta.snapshotRevision;

  return (
    <div>
      <div className="toolbar">
        <strong>{experimentId}</strong>
        <span className={`pill status-${status}`}>{STATUS_LABEL[status]}</span>
        <span className={`pill conn-${conn}`}>{conn === 'live' ? 'live' : conn === 'connecting' ? 'connecting…' : 'reconnecting…'}</span>
        {!replayable && (
          <span className="pill danger" title="The pinned snapshot was reclaimed">
            snapshot reclaimed — cannot replay
          </span>
        )}
        <span className="spacer" />
        {status === 'running' && (
          <button onClick={cancel}>
            <XCircle size={15} /> Cancel
          </button>
        )}
        {status !== 'running' && replayable && (
          <button onClick={rerun}>
            <RotateCcw size={15} /> Re-run
          </button>
        )}
      </div>
      {meta && (
        <p className="muted revision-line">
          {meta.configA.id} vs {meta.configB.id} · pinned snapshot r{meta.snapshotRevision}
          {corpusRevision !== null && ` · index now r${corpusRevision}`}
          {indexMoved && (
            <span className="pill warn">
              <AlertTriangle size={12} /> index updated since snapshot — this run used r{meta.snapshotRevision}
            </span>
          )}
        </p>
      )}
      <div className="stats-bar">
        {stats ? (
          <>
            <span>
              Stats count <strong>{stats.comparedQueries} of {stats.totalQueries}</strong> queries (both sides valid)
            </span>
            <span>{stats.failedQueries} failed / excluded</span>
            <span>{stats.changedQueries} queries with rank changes</span>
            <span>mean |Δrank| {stats.meanAbsRankDelta === null ? '—' : stats.meanAbsRankDelta.toFixed(2)}</span>
            <span>
              ties {stats.tiedDocsA}/{stats.tiedDocsB} · only A {stats.docsOnlyInA} · only B {stats.docsOnlyInB}
            </span>
          </>
        ) : (
          <span>
            <Loader2 size={13} className="spin" /> received {outcomeList.length}/{queries.length} ·{' '}
            {liveCompared} counted so far (both sides valid) · {liveFailed} failed / excluded
          </span>
        )}
      </div>
      <div className="query-list">
        {queries.map((query, index) => (
          <QueryRow
            key={query.id}
            index={index}
            text={query.text}
            outcome={outcomes[query.id] ?? null}
            expanded={expanded.has(query.id)}
            onToggle={() => toggle(query.id)}
            meta={meta}
          />
        ))}
      </div>
    </div>
  );
}

function QueryRow({
  index,
  text,
  outcome,
  expanded,
  onToggle,
  meta,
}: {
  index: number;
  text: string;
  outcome: QueryOutcome | null;
  expanded: boolean;
  onToggle: () => void;
  meta: MetaEvent | null;
}) {
  const failed = outcome !== null && (outcome.a.status !== 'ok' || outcome.b.status !== 'ok');
  const deltas = outcome?.deltas ?? null;
  const changed = deltas ? deltas.filter(d => d.delta === null || d.delta !== 0).length : 0;
  const onlyA = deltas ? deltas.filter(d => d.rankB === null).length : 0;
  const onlyB = deltas ? deltas.filter(d => d.rankA === null).length : 0;
  const ties = deltas ? deltas.filter(d => d.tiedA || d.tiedB).length : 0;

  return (
    <div className="query-row">
      <button className="head" onClick={onToggle} aria-expanded={expanded}>
        {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <span className="qindex">#{index + 1}</span>
        <span className="qtext">{text}</span>
        {!outcome && (
          <span className="chip muted-chip">
            <Loader2 size={12} className="spin" /> waiting
          </span>
        )}
        {outcome && failed && (
          <span className="chip danger-chip">
            <AlertTriangle size={12} /> failed — excluded from stats
          </span>
        )}
        {outcome && !failed && deltas && (
          <>
            <span className="chip">{deltas.length} docs</span>
            {changed > 0 && <span className="chip changed-chip">{changed} changed</span>}
            {onlyA > 0 && <span className="chip">only A: {onlyA}</span>}
            {onlyB > 0 && <span className="chip">only B: {onlyB}</span>}
            {ties > 0 && <span className="chip">ties: {ties}</span>}
            {changed === 0 && (
              <span className="chip ok-chip">
                <CheckCircle2 size={12} /> identical ranks
              </span>
            )}
          </>
        )}
      </button>
      {expanded && outcome && (
        <div className="body">
          {failed ? (
            <div className="side-errors">
              <SideStatus label={meta?.configA.id ?? 'A'} side={outcome.a} />
              <SideStatus label={meta?.configB.id ?? 'B'} side={outcome.b} />
            </div>
          ) : (
            <DeltaTable outcome={outcome} meta={meta} />
          )}
        </div>
      )}
    </div>
  );
}

function SideStatus({label, side}: {label: string; side: SideOutcome}) {
  if (side.status === 'ok') {
    return (
      <span className="chip ok-chip">
        <CheckCircle2 size={12} /> {label}: ok ({side.hits.length} hits)
      </span>
    );
  }
  return (
    <span className="chip danger-chip">
      <AlertTriangle size={12} /> {label}: {side.error}
    </span>
  );
}

function DeltaTable({outcome, meta}: {outcome: QueryOutcome; meta: MetaEvent | null}) {
  const hitsA = new Map(outcome.a.status === 'ok' ? outcome.a.hits.map(h => [h.docId, h]) : []);
  const hitsB = new Map(outcome.b.status === 'ok' ? outcome.b.hits.map(h => [h.docId, h]) : []);
  return (
    <table className="deltas">
      <thead>
        <tr>
          <th>doc</th>
          <th>{meta?.configA.id ?? 'A'} rank (score)</th>
          <th>{meta?.configB.id ?? 'B'} rank (score)</th>
          <th>Δ rank</th>
        </tr>
      </thead>
      <tbody>
        {(outcome.deltas ?? []).map(delta => (
          <tr key={delta.docId}>
            <td className="mono">{delta.docId}</td>
            <td>
              {delta.rankA === null ? (
                <span className="pill missing">missing</span>
              ) : (
                <>
                  #{delta.rankA} <span className="muted">({hitsA.get(delta.docId)?.score})</span>
                  {delta.tiedA && <span className="pill tie">tie</span>}
                </>
              )}
            </td>
            <td>
              {delta.rankB === null ? (
                <span className="pill missing">missing</span>
              ) : (
                <>
                  #{delta.rankB} <span className="muted">({hitsB.get(delta.docId)?.score})</span>
                  {delta.tiedB && <span className="pill tie">tie</span>}
                </>
              )}
            </td>
            <td>
              {delta.delta === null ? (
                <span className="pill missing">{delta.rankA === null ? 'only in B' : 'only in A'}</span>
              ) : delta.delta === 0 ? (
                <span className="muted">=</span>
              ) : delta.delta < 0 ? (
                <span className="delta-up">▲ {Math.abs(delta.delta)} in B</span>
              ) : (
                <span className="delta-down">▼ {delta.delta} in B</span>
              )}
            </td>
          </tr>
        ))}
        {(outcome.deltas ?? []).length === 0 && (
          <tr>
            <td colSpan={4} className="muted">
              no hits on either side — valid, counted in stats
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
