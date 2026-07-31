/**
 * Ejecuta patrones y los evalúa contra reglas de "buen single-table design".
 * El veredicto no mira la latencia local (no es representativa): mira la forma
 * del acceso — nº de peticiones, sobre-lectura, tamaño de la colección, paginación.
 */
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './schema.js';
import { TABLE } from './keys.js';
import { Ctx, resumen, percentil, itemBytes } from './metrics.js';
import { PATTERNS, byId } from './patterns.js';

const REGLAS = [
  {
    id: 'scan',
    nivel: 'grave',
    test: (s) => s.esScan,
    msg: () => 'Usa Scan: el coste crece con el tamaño de la tabla, no con el del resultado.',
  },
  {
    id: 'sobrelectura',
    nivel: 'grave',
    test: (s) => s.examinados > 0 && s.items / s.examinados < 0.5 && s.examinados > 10,
    msg: (s) =>
      `Sobre-lectura: examina ${s.examinados} items para devolver ${s.items} (${Math.round((s.items / s.examinados) * 100)}%). Se paga por lo examinado.`,
  },
  {
    id: 'filtro',
    nivel: 'aviso',
    test: (s) => s.usaFiltro,
    msg: () => 'Usa FilterExpression: filtra después de leer. Si es un acceso frecuente, llévalo a la clave.',
  },
  {
    id: 'paginacion',
    nivel: 'grave',
    test: (s) => s.truncado,
    msg: () => 'La respuesta se truncó en 1 MB: este acceso necesita paginación explícita.',
  },
  {
    id: 'fanout',
    nivel: 'aviso',
    test: (s, p) => s.peticiones > 3 && !p.fanout,
    msg: (s) => `${s.peticiones} peticiones para un solo patrón (fan-out no declarado).`,
  },
  {
    id: 'fanout-critico',
    nivel: 'grave',
    test: (s, p) => s.peticiones > 1 && ['Muy alta'].includes(p.prioridad),
    msg: (s) =>
      `Patrón de prioridad muy alta resuelto en ${s.peticiones} peticiones: debería ser 1.`,
  },
  {
    id: 'coleccion-grande',
    nivel: 'aviso',
    test: (s) => s.items > 300 && !s.limitado,
    msg: (s) => `Devuelve ${s.items} items sin Limit: colección grande y sin cota superior.`,
  },
  {
    id: 'sin-datos',
    nivel: 'aviso',
    test: (s, p) => s.items === 0 && !p.escritura,
    msg: () => 'No devolvió items: revisa que la clave del patrón exista en el dataset.',
  },
];

export async function runPattern(id, fixtures, { repeticiones = 5 } = {}) {
  const p = byId[id];
  if (!p) throw new Error(`Patrón desconocido: ${id}`);

  const razonSkip = p.skip?.(fixtures);
  if (razonSkip) {
    return { id, nombre: p.nombre, grupo: p.grupo, prioridad: p.prioridad, omitido: razonSkip };
  }

  const latencias = [];
  let ultimo = null;
  let error = null;

  for (let i = 0; i < repeticiones; i++) {
    const c = new Ctx(fixtures);
    try {
      await p.run(c);
    } catch (e) {
      error = `${e.name}: ${e.message}`;
      ultimo = c;
      break;
    }
    latencias.push(resumen(c.requests).ms);
    ultimo = c;
  }

  const s = ultimo ? resumen(ultimo.requests) : null;
  const hallazgos = error
    ? [{ id: 'error', nivel: 'grave', msg: `La operación falló: ${error}` }]
    : REGLAS.filter((r) => r.test(s, p)).map((r) => ({ id: r.id, nivel: r.nivel, msg: r.msg(s, p) }));

  return {
    id,
    nombre: p.nombre,
    grupo: p.grupo,
    prioridad: p.prioridad,
    op: p.op,
    indice: p.indice,
    clave: p.clave,
    hu: p.hu ?? [],
    escritura: Boolean(p.escritura),
    error,
    resumen: s,
    latencia: {
      p50: percentil(latencias, 50),
      p95: percentil(latencias, 95),
      min: latencias.length ? Math.min(...latencias) : 0,
      max: latencias.length ? Math.max(...latencias) : 0,
      corridas: latencias.length,
    },
    peticiones: ultimo?.requests ?? [],
    notas: ultimo?.notas ?? [],
    muestra: (ultimo?.items ?? []).slice(0, 3),
    veredicto: hallazgos.some((h) => h.nivel === 'grave')
      ? 'grave'
      : hallazgos.length
        ? 'aviso'
        : 'ok',
    hallazgos,
  };
}

export async function runAll(fixtures, { repeticiones = 3, onProgress = () => {} } = {}) {
  const out = [];
  for (const p of PATTERNS) {
    onProgress(p.id);
    out.push(await runPattern(p.id, fixtures, { repeticiones }));
  }
  return out;
}

/**
 * Prueba de carga simple: N ejecuciones del patrón con concurrencia C.
 * Sirve para comparar patrones bajo presión, no para estimar capacidad real.
 */
export async function loadTest(id, fixtures, { total = 200, concurrencia = 20 } = {}) {
  const p = byId[id];
  if (!p) throw new Error(`Patrón desconocido: ${id}`);
  const lat = [];
  let fallos = 0;
  let next = 0;
  const t0 = performance.now();
  const worker = async () => {
    while (next < total) {
      next++;
      const c = new Ctx(fixtures);
      try {
        await p.run(c);
        lat.push(resumen(c.requests).ms);
      } catch {
        fallos++;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrencia }, worker));
  const segundos = (performance.now() - t0) / 1000;
  return {
    id,
    nombre: p.nombre,
    total,
    concurrencia,
    fallos,
    segundos: +segundos.toFixed(2),
    opsPorSegundo: +(total / segundos).toFixed(1),
    p50: percentil(lat, 50),
    p95: percentil(lat, 95),
    p99: percentil(lat, 99),
  };
}

/**
 * Radiografía del dataset: recorre la tabla y mide cómo quedaron repartidos los
 * items entre particiones. Es el diagnóstico que delata particiones calientes y
 * colecciones sin cota — lo que ningún patrón individual muestra.
 */
export async function analizarParticiones({ topN = 12 } = {}) {
  const porPK = new Map();
  const porTipo = new Map();
  const porGSI = { GSI1: new Map(), GSI2: new Map(), GSI3: new Map(), GSI4: new Map() };
  let total = 0;
  let bytes = 0;
  let key;

  do {
    const r = await ddb.send(
      new ScanCommand({ TableName: TABLE, ExclusiveStartKey: key, Limit: 2000 }),
    );
    for (const it of r.Items ?? []) {
      const b = itemBytes(it);
      total++;
      bytes += b;
      const pk = porPK.get(it.PK) ?? { items: 0, bytes: 0 };
      pk.items++;
      pk.bytes += b;
      porPK.set(it.PK, pk);
      const t = porTipo.get(it.tipo ?? '—') ?? { items: 0, bytes: 0 };
      t.items++;
      t.bytes += b;
      porTipo.set(it.tipo ?? '—', t);
      for (const g of ['GSI1', 'GSI2', 'GSI3', 'GSI4']) {
        const v = it[`${g}PK`];
        if (!v) continue;
        const e = porGSI[g].get(v) ?? { items: 0, bytes: 0 };
        e.items++;
        e.bytes += b;
        porGSI[g].set(v, e);
      }
    }
    key = r.LastEvaluatedKey;
  } while (key);

  const top = (m) =>
    [...m.entries()]
      .sort((a, b) => b[1].items - a[1].items)
      .slice(0, topN)
      .map(([clave, v]) => ({ clave, ...v, kb: +(v.bytes / 1024).toFixed(1) }));

  const prefijo = (k) => k.split('#')[0];
  const porPrefijo = new Map();
  for (const [k, v] of porPK) {
    const e = porPrefijo.get(prefijo(k)) ?? { particiones: 0, items: 0, bytes: 0, max: 0 };
    e.particiones++;
    e.items += v.items;
    e.bytes += v.bytes;
    e.max = Math.max(e.max, v.items);
    porPrefijo.set(prefijo(k), e);
  }

  return {
    total,
    bytes,
    mb: +(bytes / 1048576).toFixed(2),
    particiones: porPK.size,
    itemsPorParticion: +(total / porPK.size).toFixed(2),
    topParticiones: top(porPK),
    topPorIndice: Object.fromEntries(
      Object.entries(porGSI).map(([g, m]) => [
        g,
        { particiones: m.size, items: [...m.values()].reduce((a, v) => a + v.items, 0), top: top(m) },
      ]),
    ),
    porTipo: [...porTipo.entries()]
      .sort((a, b) => b[1].items - a[1].items)
      .map(([tipo, v]) => ({ tipo, ...v, kb: +(v.bytes / 1024).toFixed(1) })),
    porPrefijo: [...porPrefijo.entries()]
      .sort((a, b) => b[1].items - a[1].items)
      .map(([prefijo, v]) => ({ prefijo, ...v, mediaItems: +(v.items / v.particiones).toFixed(1) })),
  };
}
