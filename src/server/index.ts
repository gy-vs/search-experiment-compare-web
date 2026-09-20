import express from 'express';
import {fileURLToPath} from 'node:url';
import {ExperimentLab, LabError} from './lab';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary query judgments',revision:3,content:'query judgments: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary query judgments',revision:5,content:'query judgments: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

// Seed data for the compare workbench. Crafted so the default pair
// (balanced vs body-only) exercises ties, one-sided hits, a failing query
// and an empty-but-valid query.
function defaultLab(): ExperimentLab {
  return new ExperimentLab({
    docs: [
      {id: 'd1', title: 'apple pie', body: 'sweet cinnamon dessert'},
      {id: 'd2', title: 'apple orchard', body: 'apple harvest festival'},
      {id: 'd3', title: 'banana bread', body: 'apple sauce filling'},
      {id: 'd4', title: 'kiwi salad', body: 'fresh fruit bowl'},
      {id: 'd5', title: 'fruit tart', body: 'kiwi glaze topping'},
      {id: 'd6', title: 'crisp apple', body: 'orchard notes'},
    ],
    queries: ['apple', 'kiwi', 'flaky parser', 'zebra'],
    configs: [
      {id: 'balanced', name: 'Balanced (title 2 / body 1)', titleWeight: 2, bodyWeight: 1},
      {id: 'title-heavy', name: 'Title heavy (title 5 / body 1)', titleWeight: 5, bodyWeight: 1},
      {id: 'title-only', name: 'Title only (title 2 / body 0)', titleWeight: 2, bodyWeight: 0},
      {id: 'body-only', name: 'Body only (title 0 / body 2)', titleWeight: 0, bodyWeight: 2},
    ],
    // Simulated backend bug: queries mentioning "flaky" fail on side B.
    fault: (query, side) => (side === 'B' && query.includes('flaky') ? 'simulated backend error' : null),
  });
}

function labErrorStatus(code: string): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'unknown_config':
      return 400;
    case 'concurrency_limit':
      return 429;
    case 'snapshot_reclaimed':
      return 410;
    case 'running':
      return 409;
    default:
      return 500;
  }
}

export function createApp(lab: ExperimentLab = defaultLab()){
  const app=express();
  app.use(express.json({limit:'1mb'}));

  // --- legacy judgment-record endpoints (unchanged) ---
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"search-relevance",count:rows.length}));
  app.get('/api/experiments',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/experiments/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/experiments/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/experiments/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  // --- A/B ranking-compare workbench ---
  app.get('/api/compare/configs', (_req, res) => res.json(lab.listConfigs()));
  app.get('/api/compare/corpus', (_req, res) => res.json({revision: lab.corpusRevision(), docs: lab.listDocs()}));
  app.post('/api/compare/corpus/documents', (req, res) => {
    const {id, title, body} = req.body ?? {};
    if (typeof id !== 'string' || !id || typeof title !== 'string' || typeof body !== 'string') {
      return res.status(400).json({error: 'invalid_doc', message: 'expected {id, title, body} strings'});
    }
    const revision = lab.upsertDoc({id, title, body});
    res.json({id, revision});
  });

  app.get('/api/compare/experiments', (_req, res) => res.json(lab.listExperiments()));
  app.post('/api/compare/experiments', (req, res) => {
    const view = lab.createExperiment(String(req.body?.configA ?? ''), String(req.body?.configB ?? ''));
    res.status(201).json(view);
  });
  app.get('/api/compare/experiments/:id', (req, res) => res.json(lab.getExperiment(req.params.id)));
  app.post('/api/compare/experiments/:id/cancel', (req, res) => {
    const result = lab.cancel(req.params.id);
    if (!result.ok) return res.status(409).json({error: 'not_running', status: result.status});
    res.json(result);
  });
  app.post('/api/compare/experiments/:id/rerun', (req, res) => res.json(lab.rerun(req.params.id)));

  // Server-sent events: full replay from `Last-Event-ID` (or ?from=), then live.
  app.get('/api/compare/experiments/:id/stream', (req, res) => {
    lab.getExperiment(req.params.id); // 404 before committing to SSE
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    const lastEventId = req.header('last-event-id');
    const from = Number(lastEventId ?? req.query.from ?? 0) || 0;
    const unsubscribe = lab.subscribe(req.params.id, from, event => {
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof LabError) {
      return res.status(labErrorStatus(err.code)).json({error: err.code, message: err.message, detail: err.detail ?? null});
    }
    console.error(err);
    res.status(500).json({error: 'internal'});
  });
  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
