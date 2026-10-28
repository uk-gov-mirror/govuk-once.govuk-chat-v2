import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity, Service, type WhereAttributeSymbol } from 'electrodb';

const table = process.env.CHAT_API_TABLE_NAME;
if (!table) {
  throw new Error('CHAT_API_TABLE_NAME is not configured');
}

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// One year in seconds.
export const RETENTION_PERIOD_IN_SECONDS = 31_536_000;

const ThreadMapping = new Entity({
  model: { service: 'chat-api', entity: 'threadMapping', version: '1' },
  attributes: {
    endUserId: { type: 'string', required: true },
    userThreadId: { type: 'string', required: true },
    systemThreadId: { type: 'string', required: true, readOnly: true },
    createdAt: { type: 'string', required: true, readOnly: true },
    expiresAt: { type: 'number', required: true },
  },
  indexes: {
    primary: {
      pk: {
        field: 'pk',
        composite: ['endUserId'],
        template: 'USER#${endUserId}',
        casing: 'none',
      },
      sk: {
        field: 'sk',
        composite: ['userThreadId'],
        template: 'THREAD#${userThreadId}',
        casing: 'none',
      },
    },
  },
});

const Thread = new Entity({
  model: { service: 'chat-api', entity: 'thread', version: '1' },
  attributes: {
    systemThreadId: { type: 'string', required: true },
    endUserId: { type: 'string', required: true, readOnly: true },
    createdAt: { type: 'string', required: true, readOnly: true },
    expiresAt: { type: 'number', required: true },
  },
  indexes: {
    primary: {
      pk: {
        field: 'pk',
        composite: ['systemThreadId'],
        template: 'THREAD#${systemThreadId}',
        casing: 'none',
      },
      sk: { field: 'sk', composite: [], template: 'THREAD', casing: 'none' },
    },
  },
});

const RunLock = new Entity({
  model: { service: 'chat-api', entity: 'runLock', version: '1' },
  attributes: {
    systemThreadId: { type: 'string', required: true },
    runId: { type: 'string', required: true },
    expiresAt: { type: 'number', required: true },
  },
  indexes: {
    primary: {
      pk: {
        field: 'pk',
        composite: ['systemThreadId'],
        template: 'THREAD#${systemThreadId}',
        casing: 'none',
      },
      sk: { field: 'sk', composite: [], template: 'LOCK', casing: 'none' },
    },
  },
});

const Run = new Entity({
  model: { service: 'chat-api', entity: 'run', version: '1' },
  attributes: {
    systemThreadId: { type: 'string', required: true },
    runId: { type: 'string', required: true },
    createdAt: { type: 'string', required: true, readOnly: true },
    expiresAt: { type: 'number', required: true },
  },
  indexes: {
    primary: {
      pk: {
        field: 'pk',
        composite: ['systemThreadId'],
        template: 'THREAD#${systemThreadId}',
        casing: 'none',
      },
      sk: {
        field: 'sk',
        composite: ['runId'],
        template: 'RUN#${runId}',
        casing: 'none',
      },
    },
  },
});

const Message = new Entity({
  model: { service: 'chat-api', entity: 'message', version: '1' },
  attributes: {
    systemThreadId: { type: 'string', required: true },
    messageId: { type: 'string', required: true },
    role: { type: 'string', required: true },
    content: { type: 'string', required: true },
    runId: { type: 'string', required: true },
    createdAt: { type: 'string', required: true, readOnly: true },
    expiresAt: { type: 'number', required: true },
  },
  indexes: {
    primary: {
      pk: {
        field: 'pk',
        composite: ['systemThreadId'],
        template: 'THREAD#${systemThreadId}',
        casing: 'none',
      },
      sk: {
        field: 'sk',
        composite: ['messageId'],
        template: 'MESSAGE#${messageId}',
        casing: 'none',
      },
    },
    byCreatedAt: {
      index: 'gsi1',
      pk: { field: 'gsi1pk', composite: ['systemThreadId'] },
      sk: { field: 'gsi1sk', composite: ['createdAt', 'messageId'] },
    },
  },
});

export const service = new Service(
  {
    threadMapping: ThreadMapping,
    thread: Thread,
    runLock: RunLock,
    run: Run,
    message: Message,
  },
  { table, client },
);

interface ExpiringRecord {
  systemThreadId: WhereAttributeSymbol<string>;
  expiresAt: WhereAttributeSymbol<number>;
}

interface ExpiryOperations {
  notExists: (attribute: WhereAttributeSymbol<string>) => string;
  lte: (attribute: WhereAttributeSymbol<number>, value: number) => string;
}

export function absentOrExpired(nowSeconds: number) {
  return (attribute: ExpiringRecord, operation: ExpiryOperations): string =>
    `(${operation.notExists(attribute.systemThreadId)} OR ${operation.lte(attribute.expiresAt, nowSeconds)})`;
}

export function cancellationCodes(
  items: ReadonlyArray<{ code: string }>,
): string[] {
  return items.map((item) => item.code);
}
