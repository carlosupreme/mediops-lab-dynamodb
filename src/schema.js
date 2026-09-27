import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE, TTL_ATTR } from './keys.js';

export const ENDPOINT = process.env.DDB_ENDPOINT ?? 'http://localhost:8000';
export const REGION = process.env.AWS_REGION ?? 'us-east-1';

/**
 * Cliente apuntado a DynamoDB Local. Las credenciales son falsas a propósito:
 * este laboratorio nunca debe tocar la cuenta real de AWS.
 */
export const raw = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: REGION,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  // DynamoDB Local es SQLite en un contenedor: con decenas de miles de
  // escrituras se atasca y agota el timeout por defecto del SDK (3 s). Subirlo
  // es una concesión al laboratorio, no al modelo — contra DynamoDB real estos
  // valores sobran. Sin esto, sembrar la escala media falla a media siembra.
  requestHandler: { requestTimeout: 60_000, connectionTimeout: 10_000 },
  maxAttempts: 5,
});

export const ddb = DynamoDBDocumentClient.from(raw, {
  marshallOptions: { removeUndefinedValues: true },
});

/**
 * Proyecciones tal como las declara la sección 2.1 de `Patrones de acceso.md`.
 *
 * No son `ALL` a propósito. Con `ALL` cualquier consulta a un índice parece
 * gratis y el laboratorio dejaría de ver el coste que sí existe en producción:
 * un índice ancho se paga en almacenamiento y en WCU de cada escritura, y un
 * índice estrecho obliga a un segundo salto a la tabla. Modelarlas de verdad es
 * lo que hace que AP-32 y AP-105 revelen su segunda petición.
 */
export const PROYECCIONES = {
  1: { ProjectionType: 'KEYS_ONLY' },
  2: {
    ProjectionType: 'INCLUDE',
    NonKeyAttributes: [
      'tipo', 'estado', 'organizationId', 'patientId', 'doctorUserId', 'appointmentId',
      'noteId', 'prescriptionId', 'inicioISO', 'duracionMin', 'modalidad', 'titulo',
      'fecha', 'hora', 'canal', 'importe', 'moneda',
    ],
  },
  3: {
    ProjectionType: 'INCLUDE',
    NonKeyAttributes: [
      'tipo', 'estado', 'organizationId', 'patientId', 'doctorUserId', 'appointmentId',
      'tsISO', 'provider', 'motivo', 'canal', 'userId',
    ],
  },
  // ALL y no INCLUDE: GSI4 lo comparten miembros, invitaciones, tutores, citas,
  // recetas y auditoría, y su INCLUDE pasaba de 26 atributos. DynamoDB admite 20 por
  // índice; DynamoDB Local no aplica el límite, así que el laboratorio no lo veía.
  4: { ProjectionType: 'ALL' },
};

const gsi = (n) => ({
  IndexName: `GSI${n}`,
  KeySchema: [
    { AttributeName: `GSI${n}PK`, KeyType: 'HASH' },
    { AttributeName: `GSI${n}SK`, KeyType: 'RANGE' },
  ],
  Projection: PROYECCIONES[n],
});

export const TABLE_DEF = {
  TableName: TABLE,
  BillingMode: 'PAY_PER_REQUEST',
  KeySchema: [
    { AttributeName: 'PK', KeyType: 'HASH' },
    { AttributeName: 'SK', KeyType: 'RANGE' },
  ],
  AttributeDefinitions: [
    { AttributeName: 'PK', AttributeType: 'S' },
    { AttributeName: 'SK', AttributeType: 'S' },
    ...[1, 2, 3, 4].flatMap((n) => [
      { AttributeName: `GSI${n}PK`, AttributeType: 'S' },
      { AttributeName: `GSI${n}SK`, AttributeType: 'S' },
    ]),
  ],
  GlobalSecondaryIndexes: [gsi(1), gsi(2), gsi(3), gsi(4)],
  /**
   * El nombre sale de TTL_ATTR, no de un literal. La tabla desplegada declaraba
   * `expiraTTL` mientras el código escribía `expiraEn`: nada expiraba y no había
   * ningún error que lo delatara. Quien defina la tabla en CloudFormation debe
   * leer esta misma constante.
   */
  TimeToLiveSpecification: { AttributeName: TTL_ATTR, Enabled: true },
  StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
};

export async function tableExists() {
  try {
    await raw.send(new DescribeTableCommand({ TableName: TABLE }));
    return true;
  } catch (e) {
    if (e.name === 'ResourceNotFoundException') return false;
    throw e;
  }
}

export async function recreateTable() {
  if (await tableExists()) {
    await raw.send(new DeleteTableCommand({ TableName: TABLE }));
  }
  await raw.send(new CreateTableCommand(TABLE_DEF));
}
