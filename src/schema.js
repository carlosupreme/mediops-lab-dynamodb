import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE } from './keys.js';

export const ENDPOINT = process.env.DDB_ENDPOINT ?? 'http://localhost:8000';
export const REGION = process.env.AWS_REGION ?? 'us-east-2';

/**
 * Cliente apuntado a DynamoDB Local. Las credenciales son falsas a propósito:
 * este laboratorio nunca debe tocar la cuenta real de AWS.
 */
export const raw = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: REGION,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

export const ddb = DynamoDBDocumentClient.from(raw, {
  marshallOptions: { removeUndefinedValues: true },
});

const gsi = (n) => ({
  IndexName: `GSI${n}`,
  KeySchema: [
    { AttributeName: `GSI${n}PK`, KeyType: 'HASH' },
    { AttributeName: `GSI${n}SK`, KeyType: 'RANGE' },
  ],
  Projection: { ProjectionType: 'ALL' },
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
