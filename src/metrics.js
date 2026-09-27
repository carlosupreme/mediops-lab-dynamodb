/**
 * Medición de una operación contra DynamoDB.
 *
 * IMPORTANTE sobre la latencia: DynamoDB Local corre sobre SQLite en tu máquina;
 * sus milisegundos NO predicen los de DynamoDB real. Sirven sólo para comparar
 * patrones entre sí (¿AP-10 es 50× más caro que AP-16?), no como SLA.
 *
 * Las señales que sí trasladan al servicio real son estructurales:
 *   · nº de peticiones (fan-out)
 *   · items devueltos vs items examinados (sobre-lectura por FilterExpression)
 *   · bytes leídos → RCU estimadas
 *   · si toca 1 partición o N
 */
import {
  QueryCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './schema.js';

const CMD = {
  Query: QueryCommand,
  GetItem: GetCommand,
  PutItem: PutCommand,
  UpdateItem: UpdateCommand,
  DeleteItem: DeleteCommand,
  TransactWriteItems: TransactWriteCommand,
  BatchGetItem: BatchGetCommand,
};

const WRITE_OPS = new Set(['PutItem', 'UpdateItem', 'DeleteItem', 'TransactWriteItems']);

export const itemBytes = (item) => (item ? Buffer.byteLength(JSON.stringify(item)) : 0);

/** RCU estimadas: 4 KB por unidad; lectura eventualmente consistente = mitad. */
export const estRCU = (bytes, consistent = false) =>
  +((Math.ceil(bytes / 4096) || 0) * (consistent ? 1 : 0.5)).toFixed(2);

/** WCU estimadas: 1 KB por unidad, redondeo hacia arriba por item. */
export const estWCU = (bytes) => Math.max(1, Math.ceil(bytes / 1024));

/**
 * Contexto de ejecución de un patrón. `measure` registra la operación en las
 * métricas; `silent` ejecuta preparativos que no deben contaminar la medición.
 */
export class Ctx {
  constructor(fixtures) {
    this.f = fixtures;
    this.requests = [];
    this.items = [];
    this.notas = [];
  }

  async silent(op, params) {
    return ddb.send(new CMD[op](params));
  }

  async measure(op, params, { index = 'Tabla', label = null, collect = true } = {}) {
    const t0 = performance.now();
    const res = await ddb.send(
      new CMD[op]({ ...params, ReturnConsumedCapacity: 'INDEXES' }),
    );
    const ms = performance.now() - t0;

    const returned = res.Items ?? (res.Item ? [res.Item] : []);
    const bytes = returned.reduce((a, i) => a + itemBytes(i), 0);
    const write = WRITE_OPS.has(op);
    const writeBytes = write ? this.#writeBytes(op, params) : 0;

    const rec = {
      op,
      index,
      label,
      ms: +ms.toFixed(2),
      count: res.Count ?? returned.length,
      scanned: res.ScannedCount ?? returned.length,
      bytes: write ? writeBytes : bytes,
      unidades: write ? estWCU(writeBytes) : estRCU(bytes, params.ConsistentRead === true),
      tipoUnidad: write ? 'WCU' : 'RCU',
      // ConsumedCapacity real reportado por el motor (DynamoDB Local lo aproxima)
      capacidadMotor: res.ConsumedCapacity
        ? Array.isArray(res.ConsumedCapacity)
          ? res.ConsumedCapacity.reduce((a, c) => a + (c.CapacityUnits ?? 0), 0)
          : (res.ConsumedCapacity.CapacityUnits ?? 0)
        : null,
      // Se guardan para que las reglas puedan inspeccionar la FORMA del acceso,
      // no sólo su coste: si la clave lleva el tenant, si la escritura condicional
      // deja al ítem recuperable. Es lo que faltaba para detectar una fuga entre
      // organizaciones o una condición que cierra la puerta para siempre.
      pkConsultada: params.ExpressionAttributeValues?.[':pk'] ?? null,
      condicion: params.ConditionExpression ?? null,
      usaFiltro: Boolean(params.FilterExpression),
      esScan: op === 'Scan',
      // Un `Limit` explícito también deja LastEvaluatedKey: eso es paginación
      // intencional, no la pared de 1 MB. Sólo lo segundo es un problema.
      truncado: Boolean(res.LastEvaluatedKey) && !params.Limit,
      limitado: Boolean(params.Limit),
      transactItems: op === 'TransactWriteItems' ? params.TransactItems.length : null,
    };
    this.requests.push(rec);
    if (collect) this.items.push(...returned.slice(0, 5));
    return res;
  }

  #writeBytes(op, params) {
    if (op === 'PutItem') return itemBytes(params.Item);
    if (op === 'TransactWriteItems')
      return params.TransactItems.reduce(
        (a, t) => a + itemBytes(t.Put?.Item ?? t.Update?.Key ?? t.Delete?.Key ?? {}),
        0,
      );
    return itemBytes(params.Key ?? {});
  }

  nota(txt) {
    this.notas.push(txt);
  }
}

/** Agrega las peticiones de una corrida a un resumen por patrón. */
export function resumen(requests) {
  const s = {
    peticiones: requests.length,
    items: requests.reduce((a, r) => a + r.count, 0),
    examinados: requests.reduce((a, r) => a + r.scanned, 0),
    bytes: requests.reduce((a, r) => a + r.bytes, 0),
    unidades: +requests.reduce((a, r) => a + r.unidades, 0).toFixed(2),
    tipoUnidad: requests.some((r) => r.tipoUnidad === 'WCU') ? 'WCU' : 'RCU',
    ms: +requests.reduce((a, r) => a + r.ms, 0).toFixed(2),
    usaFiltro: requests.some((r) => r.usaFiltro),
    esScan: requests.some((r) => r.esScan),
    truncado: requests.some((r) => r.truncado),
    limitado: requests.some((r) => r.limitado),
    indices: [...new Set(requests.map((r) => r.index))],
  };
  s.eficiencia = s.examinados > 0 ? +(s.items / s.examinados).toFixed(3) : 1;
  s.pks = requests.map((r) => r.pkConsultada).filter(Boolean);
  s.condiciones = requests.map((r) => r.condicion).filter(Boolean);
  return s;
}

export const percentil = (arr, p) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return +a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))].toFixed(2);
};
