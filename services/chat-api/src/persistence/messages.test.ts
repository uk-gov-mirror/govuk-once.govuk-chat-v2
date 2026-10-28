import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { send, stubDynamoDBDocumentClient } from '../test-utils/dynamodb.ts';
import type {
  lookupThread,
  getMessages,
  getMessagePage,
  sliceMessages,
  StoredMessage,
} from './messages.ts';

const NOW = new Date('2026-09-03T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

const KEY = { endUserId: 'user-1', userThreadId: 'thread-1' };
const MAPPING_KEY = { pk: 'USER#user-1', sk: 'THREAD#thread-1' };
const SYSTEM_THREAD_ID = crypto.randomUUID();

const testEnv = {} as {
  lookupThread: typeof lookupThread;
  getMessages: typeof getMessages;
  getMessagePage: typeof getMessagePage;
  sliceMessages: typeof sliceMessages;
};

beforeAll(async () => {
  stubDynamoDBDocumentClient();
  vi.stubEnv('CHAT_API_TABLE_NAME', 'test-chat-api');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);

  const messagesModule = await import('./messages.ts');
  testEnv.lookupThread = messagesModule.lookupThread;
  testEnv.getMessages = messagesModule.getMessages;
  testEnv.getMessagePage = messagesModule.getMessagePage;
  testEnv.sliceMessages = messagesModule.sliceMessages;
});

afterAll(() => {
  vi.useRealTimers();
});

function storedMapping(expiresAt = NOW_SECONDS + 1) {
  return {
    ...MAPPING_KEY,
    ...KEY,
    systemThreadId: SYSTEM_THREAD_ID,
    expiresAt,
    __edb_e__: 'threadMapping',
    __edb_v__: '1',
  };
}

function storedMessage(
  messageId: string,
  role: string,
  content: string,
  createdAt: string,
) {
  return {
    pk: `THREAD#${SYSTEM_THREAD_ID}`,
    sk: `MESSAGE#${messageId}`,
    systemThreadId: SYSTEM_THREAD_ID,
    messageId,
    role,
    content,
    runId: 'run-1',
    createdAt,
    expiresAt: NOW_SECONDS + 31_536_000,
    __edb_e__: 'message',
    __edb_v__: '1',
  };
}

// Messages in a thread, oldest first, one second apart
function threadOf(count: number) {
  return Array.from({ length: count }, (_, index) =>
    storedMessage(
      `msg-${index}`,
      index % 2 === 0 ? 'user' : 'assistant',
      `Message ${index}`,
      new Date(NOW.getTime() + index * 1000).toISOString(),
    ),
  );
}

function positionOf({
  createdAt,
  messageId,
}: {
  createdAt: string;
  messageId: string;
}) {
  return { createdAt, messageId };
}

function sentQueryInput() {
  const [call] = send.mock.calls;
  return (
    call[0] as {
      input: {
        IndexName?: string;
        KeyConditionExpression: string;
        ExpressionAttributeValues: Record<string, unknown>;
        ScanIndexForward?: boolean;
        Limit?: number;
      };
    }
  ).input;
}

function sortKeyBound(operator: '<' | '>'): unknown {
  const input = sentQueryInput();
  const [, placeholder] =
    new RegExp(String.raw` ${operator} (:\w+)`).exec(
      input.KeyConditionExpression,
    ) ?? expect.fail(`Expected a sort key condition using ${operator}`);
  return input.ExpressionAttributeValues[placeholder];
}

describe('lookupThread', () => {
  it('returns the system thread id when the mapping exists and has not expired', async () => {
    send.mockResolvedValueOnce({ Item: storedMapping() });

    const result = await testEnv.lookupThread(KEY);

    expect(result).toEqual({ systemThreadId: SYSTEM_THREAD_ID });
  });

  it('returns undefined when no mapping exists', async () => {
    send.mockResolvedValueOnce({});

    const result = await testEnv.lookupThread(KEY);

    expect(result).toBeUndefined();
  });

  it('returns undefined when the mapping has expired', async () => {
    send.mockResolvedValueOnce({ Item: storedMapping(NOW_SECONDS) });

    const result = await testEnv.lookupThread(KEY);

    expect(result).toBeUndefined();
  });
});

describe('getMessages', () => {
  it('returns messages mapped to the StoredMessage shape', async () => {
    send.mockResolvedValueOnce({
      Items: [
        storedMessage('msg-1', 'user', 'Hello', '2026-09-03T12:00:00.000Z'),
        storedMessage(
          'msg-2',
          'assistant',
          'Hi there',
          '2026-09-03T12:00:01.000Z',
        ),
      ],
    });

    const result = await testEnv.getMessages(SYSTEM_THREAD_ID);

    expect(result).toEqual([
      {
        messageId: 'msg-1',
        role: 'user',
        content: 'Hello',
        createdAt: '2026-09-03T12:00:00.000Z',
      },
      {
        messageId: 'msg-2',
        role: 'assistant',
        content: 'Hi there',
        createdAt: '2026-09-03T12:00:01.000Z',
      },
    ]);
  });

  it('returns an empty array when no messages exist', async () => {
    send.mockResolvedValueOnce({ Items: [] });

    const result = await testEnv.getMessages(SYSTEM_THREAD_ID);

    expect(result).toEqual([]);
  });
});

describe('getMessagePage', () => {
  describe('without a start', () => {
    it('queries the index for the newest messages, descending, reading one more than a page', async () => {
      send.mockResolvedValueOnce({ Items: [] });

      await testEnv.getMessagePage(SYSTEM_THREAD_ID);

      expect(sentQueryInput()).toMatchObject({
        IndexName: 'gsi1',
        ScanIndexForward: false,
        Limit: 101,
      });
    });

    it('returns the messages oldest first, with no positions, when fewer than 101 come back', async () => {
      const thread = threadOf(3);
      send.mockResolvedValueOnce({ Items: thread.toReversed() });

      const result = await testEnv.getMessagePage(SYSTEM_THREAD_ID);

      expect(result).toEqual({
        messages: thread.map((m) => ({
          messageId: m.messageId,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        })),
      });
    });

    it('drops the oldest read and returns an earlier position, but no later one, when 101 come back', async () => {
      const thread = threadOf(101);
      send.mockResolvedValueOnce({ Items: thread.toReversed() });

      const result = await testEnv.getMessagePage(SYSTEM_THREAD_ID);

      expect(result.messages.map((m) => m.messageId)).toEqual(
        thread.slice(1).map((m) => m.messageId),
      );
      expect(result.earlier).toEqual(positionOf(thread[1]));
      expect(result.later).toBeUndefined();
    });
  });

  describe('with a before start', () => {
    const start = {
      direction: 'before' as const,
      position: positionOf(threadOf(102)[101]),
    };

    it('queries the index below the start, descending, reading one more than a page', async () => {
      send.mockResolvedValueOnce({ Items: [] });

      await testEnv.getMessagePage(SYSTEM_THREAD_ID, start);

      expect(sentQueryInput()).toMatchObject({
        IndexName: 'gsi1',
        ScanIndexForward: false,
        Limit: 101,
      });
      expect(sortKeyBound('<')).toContain(start.position.messageId);
    });

    it('returns the messages oldest first, with only a later position, when fewer than 101 come back', async () => {
      const thread = threadOf(3);
      send.mockResolvedValueOnce({ Items: thread.toReversed() });

      const result = await testEnv.getMessagePage(SYSTEM_THREAD_ID, start);

      expect(result.messages.map((m) => m.messageId)).toEqual(
        thread.map((m) => m.messageId),
      );
      expect(result.earlier).toBeUndefined();
      expect(result.later).toEqual(positionOf(thread[2]));
    });

    it('drops the oldest read and returns both positions when 101 come back', async () => {
      const thread = threadOf(101);
      send.mockResolvedValueOnce({ Items: thread.toReversed() });

      const result = await testEnv.getMessagePage(SYSTEM_THREAD_ID, start);

      expect(result.messages.map((m) => m.messageId)).toEqual(
        thread.slice(1).map((m) => m.messageId),
      );
      expect(result.earlier).toEqual(positionOf(thread[1]));
      expect(result.later).toEqual(positionOf(thread[100]));
    });
  });

  describe('with an after start', () => {
    const start = {
      direction: 'after' as const,
      position: positionOf(threadOf(1)[0]),
    };

    it('queries the index above the start, ascending, reading one more than a page', async () => {
      send.mockResolvedValueOnce({ Items: [] });

      await testEnv.getMessagePage(SYSTEM_THREAD_ID, start);

      expect(sentQueryInput()).toMatchObject({
        IndexName: 'gsi1',
        ScanIndexForward: true,
        Limit: 101,
      });
      expect(sortKeyBound('>')).toContain(start.position.messageId);
    });

    it('returns the messages as read, with only an earlier position, when fewer than 101 come back', async () => {
      const thread = threadOf(4).slice(1);
      send.mockResolvedValueOnce({ Items: thread });

      const result = await testEnv.getMessagePage(SYSTEM_THREAD_ID, start);

      expect(result.messages.map((m) => m.messageId)).toEqual(
        thread.map((m) => m.messageId),
      );
      expect(result.earlier).toEqual(positionOf(thread[0]));
      expect(result.later).toBeUndefined();
    });

    it('drops the newest read and returns both positions when 101 come back', async () => {
      const thread = threadOf(102).slice(1);
      send.mockResolvedValueOnce({ Items: thread });

      const result = await testEnv.getMessagePage(SYSTEM_THREAD_ID, start);

      expect(result.messages.map((m) => m.messageId)).toEqual(
        thread.slice(0, 100).map((m) => m.messageId),
      );
      expect(result.earlier).toEqual(positionOf(thread[0]));
      expect(result.later).toEqual(positionOf(thread[99]));
    });
  });

  it.each(['before', 'after'] as const)(
    'returns no positions for an empty page with a %s start',
    async (direction) => {
      send.mockResolvedValueOnce({ Items: [] });

      const result = await testEnv.getMessagePage(SYSTEM_THREAD_ID, {
        direction,
        position: positionOf(threadOf(1)[0]),
      });

      expect(result).toEqual({ messages: [] });
    },
  );
});

describe('sliceMessages', () => {
  const messages: StoredMessage[] = [
    {
      messageId: 'c',
      role: 'user',
      content: 'Third',
      createdAt: '2026-09-03T12:00:02.000Z',
    },
    {
      messageId: 'a',
      role: 'user',
      content: 'First',
      createdAt: '2026-09-03T12:00:00.000Z',
    },
    {
      messageId: 'b',
      role: 'assistant',
      content: 'Second',
      createdAt: '2026-09-03T12:00:01.000Z',
    },
  ];

  it('returns all messages sorted by createdAt ascending when within the page size', () => {
    const result = testEnv.sliceMessages(messages);

    expect(result.messages.map((m) => m.messageId)).toEqual(['a', 'b', 'c']);
    expect(result.oldestMessageId).toBeUndefined();
  });

  it('returns messages before the given message id', () => {
    const result = testEnv.sliceMessages(messages, 'c');

    expect(result.messages.map((m) => m.messageId)).toEqual(['a', 'b']);
    expect(result.oldestMessageId).toBeUndefined();
  });

  it('returns empty messages when before references an unknown id', () => {
    const result = testEnv.sliceMessages(messages, 'unknown');

    expect(result.messages).toEqual([]);
    expect(result.oldestMessageId).toBeUndefined();
  });

  it('returns empty messages when before references the earliest message', () => {
    const result = testEnv.sliceMessages(messages, 'a');

    expect(result.messages).toEqual([]);
    expect(result.oldestMessageId).toBeUndefined();
  });

  it('handles an empty messages array', () => {
    const result = testEnv.sliceMessages([]);

    expect(result.messages).toEqual([]);
    expect(result.oldestMessageId).toBeUndefined();
  });
});
