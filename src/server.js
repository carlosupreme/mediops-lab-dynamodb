import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ENDPOINT, REGION, tableExists } from './schema.js';
import { seed, SCALES } from './seed.js';
import { PATTERNS, GRUPOS } from './patterns.js';
import { runPattern, runAll, loadTest, analizarParticiones } from './runner.js';

const app = express();
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

const FIXTURES = fileURLToPath(new URL('../.lab/fixtures.json', import.meta.url));
const leerFixtures = () =>
  existsSync(FIXTURES) ? JSON.parse(readFileSync(FIXTURES, 'utf8')) : null;

const sse = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  return (evento, data) => res.write(`event: ${evento}\ndata: ${JSON.stringify(data)}\n\n`);
};

app.get('/api/estado', async (_req, res) => {
  res.json({
    endpoint: ENDPOINT,
    region: REGION,
    tabla: await tableExists(),
    fixtures: leerFixtures(),
    escalas: SCALES,
    patrones: PATTERNS.length,
  });
});

app.get('/api/patrones', (_req, res) => {
  res.json({
    grupos: GRUPOS,
    patrones: PATTERNS.map(({ run, skip, ...p }) => p),
  });
});

app.get('/api/seed', async (req, res) => {
  const send = sse(res);
  try {
    const f = await seed({
      scale: req.query.scale ?? 'medium',
      onProgress: (m) => send('progreso', { mensaje: m }),
    });
    send('listo', f);
  } catch (e) {
    send('error', { mensaje: `${e.name}: ${e.message}` });
  }
  res.end();
});

app.get('/api/run-all', async (req, res) => {
  const f = leerFixtures();
  const send = sse(res);
  if (!f) {
    send('error', { mensaje: 'No hay dataset. Genera los datos mock primero.' });
    return res.end();
  }
  const rep = Number(req.query.rep ?? 3);
  try {
    for (const p of PATTERNS) {
      send('inicio', { id: p.id });
      send('resultado', await runPattern(p.id, f, { repeticiones: rep }));
    }
    send('fin', { total: PATTERNS.length });
  } catch (e) {
    send('error', { mensaje: `${e.name}: ${e.message}` });
  }
  res.end();
});

app.post('/api/run/:id', async (req, res) => {
  const f = leerFixtures();
  if (!f) return res.status(409).json({ error: 'No hay dataset. Genera los datos mock primero.' });
  try {
    res.json(await runPattern(req.params.id, f, { repeticiones: Number(req.body?.rep ?? 5) }));
  } catch (e) {
    res.status(400).json({ error: `${e.name}: ${e.message}` });
  }
});

app.post('/api/carga/:id', async (req, res) => {
  const f = leerFixtures();
  if (!f) return res.status(409).json({ error: 'No hay dataset. Genera los datos mock primero.' });
  try {
    res.json(
      await loadTest(req.params.id, f, {
        total: Number(req.body?.total ?? 200),
        concurrencia: Number(req.body?.concurrencia ?? 20),
      }),
    );
  } catch (e) {
    res.status(400).json({ error: `${e.name}: ${e.message}` });
  }
});

app.get('/api/particiones', async (_req, res) => {
  try {
    res.json(await analizarParticiones());
  } catch (e) {
    res.status(500).json({ error: `${e.name}: ${e.message}` });
  }
});

const PORT = process.env.PORT ?? 4000;
app.listen(PORT, () => {
  console.log(`\n  MediOps · laboratorio de modelado DynamoDB`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  DynamoDB Local: ${ENDPOINT} (${REGION})\n`);
});
