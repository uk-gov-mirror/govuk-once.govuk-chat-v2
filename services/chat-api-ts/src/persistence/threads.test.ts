import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { send, stubDynamoDBDocumentClient } from '../test-utils/dynamodb.ts';
import type { resolveThread } from './threads.ts';

const NOW = new Date('2026-09-03T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const A_YEAR_AHEAD = NOW_SECONDS + 365 * 24 * 60 * 60;

const KEY = { endUserId: 'user-1', userThreadId: 'thread-1' };
const MAPPING_KEY = { pk: 'USER#user-1', sk: 'THREAD#thread-1' };
const STORED_SYSTEM_THREAD_ID = crypto.randomUUID();

const testEnv = {} as { resolveThread: typeof resolveThread };

beforeAll(async () => {
  stubDynamoDBDocumentClient();
  vi.stubEnv('THREADS_TABLE_NAME', 'test-threads');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);

  const threadsModule = await import('./threads.ts');
  testEnv.resolveThread = threadsModule.resolveThread;
});

afterAll(() => {
  vi.useRealTimers();
});

// ElectroDB only returns a read item whose entity identifier attributes
// match, so a stored item needs them to be found.
function storedMapping(expiresAt = NOW_SECONDS + 1) {
  return {
    ...MAPPING_KEY,
    ...KEY,
    systemThreadId: STORED_SYSTEM_THREAD_ID,
    expiresAt,
    __edb_e__: 'threadMapping',
    __edb_v__: '1',
  };
}

function transactionCancelled(codes: string[]): Error {
  return Object.assign(new Error('Transaction cancelled'), {
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

interface WriteItem {
  Key?: Record<string, string>;
  Item?: Record<string, unknown>;
  ConditionExpression: string;
  ExpressionAttributeValues: Record<string, unknown>;
}

interface SentInput {
  Key?: Record<string, string>;
  TransactItems?: Array<{ Put?: WriteItem; Update?: WriteItem }>;
}

function sentInputs(): SentInput[] {
  return send.mock.calls.map((call) => (call[0] as { input: SentInput }).input);
}

function writes(input: SentInput, kind: 'Put' | 'Update'): WriteItem[] {
  const items = input.TransactItems ?? expect.fail('Expected a transaction');
  return items.map(
    (item) => item[kind] ?? expect.fail(`Expected a ${kind} transact item`),
  );
}

describe('configuration', () => {
  it('throws an error during module import when THREADS_TABLE_NAME is not configured', async () => {
    vi.resetModules();
    vi.stubEnv('THREADS_TABLE_NAME', undefined);

    await expect(import('./threads.ts')).rejects.toThrow(
      'THREADS_TABLE_NAME is not configured',
    );
  });
});

describe('resolveThread', () => {
  describe('when the mapping exists and has not expired', () => {
    it('returns the stored system id and refreshes the expiry on both records', async () => {
      send
        .mockResolvedValueOnce({ Item: storedMapping() })
        .mockResolvedValueOnce({});

      const result = await testEnv.resolveThread(KEY);

      expect(result).toEqual({ systemThreadId: STORED_SYSTEM_THREAD_ID });
      const [read, write] = sentInputs();
      expect(read.Key).toEqual(MAPPING_KEY);
      const [mappingUpdate, threadUpdate] = writes(write, 'Update');
      expect(mappingUpdate.Key).toEqual(MAPPING_KEY);
      expect(threadUpdate.Key).toEqual({
        pk: `THREAD#${STORED_SYSTEM_THREAD_ID}`,
        sk: 'THREAD',
      });
      for (const update of [mappingUpdate, threadUpdate]) {
        expect(update.ConditionExpression).toMatch(/attribute_exists/);
        expect(Object.values(update.ExpressionAttributeValues)).toContain(
          A_YEAR_AHEAD,
        );
      }
    });

    it('returns the stored system id when the refresh conflicts with a concurrent transaction', async () => {
      send
        .mockResolvedValueOnce({ Item: storedMapping() })
        .mockRejectedValueOnce(
          transactionCancelled(['TransactionConflict', 'None']),
        );

      await expect(testEnv.resolveThread(KEY)).resolves.toEqual({
        systemThreadId: STORED_SYSTEM_THREAD_ID,
      });
    });

    it.each([
      [
        'a record is missing',
        ['TransactionConflict', 'ConditionalCheckFailed'],
      ],
      ['the cancellation is not a conflict', ['ThrottlingError', 'None']],
    ])(
      'throws when the refresh transaction is cancelled because %s',
      async (_description, codes) => {
        send
          .mockResolvedValueOnce({ Item: storedMapping() })
          .mockRejectedValueOnce(transactionCancelled(codes));

        await expect(testEnv.resolveThread(KEY)).rejects.toThrow(
          /refresh was cancelled/,
        );
      },
    );
  });

  describe('when the mapping does not exist', () => {
    it('creates both records in one conditional transaction with a new system id', async () => {
      send.mockResolvedValueOnce({}).mockResolvedValueOnce({});

      const { systemThreadId } = await testEnv.resolveThread(KEY);

      const [, write] = sentInputs();
      const [mappingPut, threadPut] = writes(write, 'Put');
      expect(mappingPut.Item).toMatchObject({
        ...MAPPING_KEY,
        systemThreadId,
        expiresAt: A_YEAR_AHEAD,
      });
      expect(threadPut.Item).toMatchObject({
        pk: `THREAD#${systemThreadId}`,
        sk: 'THREAD',
        endUserId: KEY.endUserId,
        expiresAt: A_YEAR_AHEAD,
      });
      for (const put of [mappingPut, threadPut]) {
        expect(put.ConditionExpression).toMatch(
          /attribute_not_exists\(.+\) OR .+ <= /,
        );
        expect(Object.values(put.ExpressionAttributeValues)).toContain(
          NOW_SECONDS,
        );
      }
    });

    it('treats an expired mapping as absent and creates a new thread', async () => {
      send
        .mockResolvedValueOnce({ Item: storedMapping(NOW_SECONDS) })
        .mockResolvedValueOnce({});

      const { systemThreadId } = await testEnv.resolveThread(KEY);

      expect(systemThreadId).not.toBe(STORED_SYSTEM_THREAD_ID);
      const [, write] = sentInputs();
      expect(write.TransactItems?.[0].Put).toBeDefined();
    });

    it.each([
      [
        'ConditionalCheckFailed on the mapping',
        ['ConditionalCheckFailed', 'None'],
      ],
      ['TransactionConflict', ['None', 'TransactionConflict']],
    ])(
      'adopts the winning id after losing the create race with %s',
      async (_description, codes) => {
        send
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(transactionCancelled(codes))
          .mockResolvedValueOnce({ Item: storedMapping() })
          .mockResolvedValueOnce({});

        const result = await testEnv.resolveThread(KEY);

        expect(result).toEqual({ systemThreadId: STORED_SYSTEM_THREAD_ID });
        const inputs = sentInputs();
        expect(inputs).toHaveLength(4);
        expect(inputs[3].TransactItems?.[0].Update).toBeDefined();
      },
    );

    it('throws rather than retrying again when the second create is also cancelled', async () => {
      send
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(
          transactionCancelled(['ConditionalCheckFailed', 'None']),
        )
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(
          transactionCancelled(['ConditionalCheckFailed', 'None']),
        );

      await expect(testEnv.resolveThread(KEY)).rejects.toThrow(/twice/);
      expect(send).toHaveBeenCalledTimes(4);
    });

    it('throws without retrying when the cancellation is not a lost race', async () => {
      send
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(
          transactionCancelled(['ThrottlingError', 'None']),
        );

      await expect(testEnv.resolveThread(KEY)).rejects.toThrow(
        /creation was cancelled/,
      );
      expect(send).toHaveBeenCalledTimes(2);
    });
  });
});
