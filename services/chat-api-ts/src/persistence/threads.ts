import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity, Service } from 'electrodb';

const table = process.env.THREADS_TABLE_NAME;
if (!table) {
  throw new Error('THREADS_TABLE_NAME is not configured');
}

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ONE_YEAR_IN_SECONDS = 365 * 24 * 60 * 60;

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

const service = new Service(
  { threadMapping: ThreadMapping, thread: Thread },
  { table, client },
);

export interface ThreadKey {
  endUserId: string;
  userThreadId: string;
}

export interface ResolvedThread {
  systemThreadId: string;
}

function cancellationCodes(items: ReadonlyArray<{ code: string }>): string[] {
  return items.map((item) => item.code);
}

async function refreshExpiry(
  key: ThreadKey,
  systemThreadId: string,
  expiresAt: number,
): Promise<void> {
  const result = await service.transaction
    .write(({ threadMapping, thread }) => [
      threadMapping
        .update(key)
        .set({ expiresAt })
        .where((attribute, operation) =>
          operation.exists(attribute.systemThreadId),
        )
        .commit(),
      thread
        .update({ systemThreadId })
        .set({ expiresAt })
        .where((attribute, operation) =>
          operation.exists(attribute.systemThreadId),
        )
        .commit(),
    ])
    .go();

  if (!result.canceled) {
    return;
  }

  const codes = cancellationCodes(result.data);
  // A conflict means another message for this thread is refreshing the same
  // records to the same expiry, so this call returns as if it had.
  if (
    codes.includes('TransactionConflict') &&
    !codes.includes('ConditionalCheckFailed')
  ) {
    return;
  }
  throw new Error(`Thread expiry refresh was cancelled: ${codes.join(', ')}`);
}

// Returns undefined when another call created the thread first.
async function resolveThreadOnce(
  key: ThreadKey,
): Promise<ResolvedThread | undefined> {
  const now = new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const expiresAt = nowSeconds + ONE_YEAR_IN_SECONDS;

  const { data: mapping } = await service.entities.threadMapping
    .get(key)
    .go({ consistent: true });

  // TTL deletes expired items up to days late and one record at a time, so
  // an expired record is treated as absent here and overwritten by the create.
  if (mapping && mapping.expiresAt > nowSeconds) {
    await refreshExpiry(key, mapping.systemThreadId, expiresAt);
    return { systemThreadId: mapping.systemThreadId };
  }

  const systemThreadId = crypto.randomUUID();
  const createdAt = now.toISOString();
  const result = await service.transaction
    .write(({ threadMapping, thread }) => [
      threadMapping
        .put({ ...key, systemThreadId, createdAt, expiresAt })
        .where(
          (attribute, operation) =>
            `(${operation.notExists(attribute.systemThreadId)} OR ${operation.lte(attribute.expiresAt, nowSeconds)})`,
        )
        .commit(),
      thread
        .put({ systemThreadId, endUserId: key.endUserId, createdAt, expiresAt })
        .where(
          (attribute, operation) =>
            `(${operation.notExists(attribute.systemThreadId)} OR ${operation.lte(attribute.expiresAt, nowSeconds)})`,
        )
        .commit(),
    ])
    .go();

  if (!result.canceled) {
    return { systemThreadId };
  }

  const codes = cancellationCodes(result.data);
  const lostRace =
    codes.includes('ConditionalCheckFailed') ||
    codes.includes('TransactionConflict');
  if (lostRace) {
    return undefined;
  }
  throw new Error(`Thread creation was cancelled: ${codes.join(', ')}`);
}

export async function resolveThread(key: ThreadKey): Promise<ResolvedThread> {
  // A lost create race means the winner's mapping is now there to use, so
  // try once more. A second loss is thrown rather than retried again.
  const resolved =
    (await resolveThreadOnce(key)) ?? (await resolveThreadOnce(key));
  if (!resolved) {
    throw new Error('Thread creation lost a write race twice');
  }
  return resolved;
}
