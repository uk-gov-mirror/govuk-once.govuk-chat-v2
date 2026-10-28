import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from 'aws-lambda';
import { logger } from '../../logging/logger.ts';
import type { ResolvedThread, ThreadKey } from '../../persistence/threads.ts';
import type {
  StoredMessage,
  MessagePage,
  PageStart,
} from '../../persistence/messages.ts';
import { encodeCursor } from '../../schemas/cursor.ts';
import { apiGatewayProxyEventFixture } from '../../test-utils/api-gateway.ts';

/* eslint-disable unicorn/no-null -- API Gateway types body as string | null */

type StandardHandler = (
  event: APIGatewayProxyEvent,
  context: Context,
) => Promise<APIGatewayProxyResult>;

const testEnv = {} as { handler: StandardHandler };

const VALID_THREAD_ID = crypto.randomUUID();
const VALID_USER_ID = crypto.randomUUID();
const SYSTEM_THREAD_ID = crypto.randomUUID();
const END_USER_ID_HEADER = { 'end-user-id': VALID_USER_ID };

const lookupThread = vi
  .fn<(key: ThreadKey) => Promise<ResolvedThread | undefined>>()
  .mockResolvedValue({ systemThreadId: SYSTEM_THREAD_ID });
const getMessagePage = vi
  .fn<(systemThreadId: string, from?: PageStart) => Promise<MessagePage>>()
  .mockResolvedValue({ messages: [] });

beforeAll(async () => {
  vi.doMock('../../persistence/messages.ts', () => ({
    lookupThread,
    getMessagePage,
  }));
  vi.stubEnv('CHAT_API_TABLE_NAME', 'test-chat-api');

  const messagesModule = await import('./messages.ts');
  testEnv.handler = messagesModule.handler as unknown as StandardHandler;
});

beforeEach(() => {
  lookupThread.mockResolvedValue({ systemThreadId: SYSTEM_THREAD_ID });
  getMessagePage.mockResolvedValue({ messages: [] });
});

function validEvent(
  queryOverrides?: Record<string, string>,
): APIGatewayProxyEvent {
  return apiGatewayProxyEventFixture(null, END_USER_ID_HEADER, {
    pathParameters: { threadId: VALID_THREAD_ID },
    queryStringParameters: queryOverrides,
    httpMethod: 'GET',
  });
}

async function runHandler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  return testEnv.handler(event, {} as Context);
}

function parsedBody(response: APIGatewayProxyResult): unknown {
  return JSON.parse(response.body);
}

describe('request headers', () => {
  it('returns 422 when end-user-id header is missing', async () => {
    const event = apiGatewayProxyEventFixture(
      null,
      {},
      {
        pathParameters: { threadId: VALID_THREAD_ID },
        httpMethod: 'GET',
      },
    );

    const response = await runHandler(event);

    expect(response.statusCode).toBe(422);
    expect(parsedBody(response)).toMatchObject({
      error: 'Messages retrieval error',
      details: expect.objectContaining({
        fieldErrors: expect.objectContaining({
          'end-user-id': expect.anything(),
        }),
      }),
    });
    expect(lookupThread).not.toHaveBeenCalled();
  });
});

describe('path parameter validation', () => {
  it('returns 422 when threadId is not a UUID', async () => {
    const event = apiGatewayProxyEventFixture(null, END_USER_ID_HEADER, {
      pathParameters: { threadId: 'not-a-uuid' },
      httpMethod: 'GET',
    });

    const response = await runHandler(event);

    expect(response.statusCode).toBe(422);
    expect(parsedBody(response)).toMatchObject({
      error: 'Messages retrieval error',
      details: expect.objectContaining({
        fieldErrors: expect.objectContaining({
          threadId: expect.anything(),
        }),
      }),
    });
    expect(lookupThread).not.toHaveBeenCalled();
  });
});

describe('query parameter validation', () => {
  it('returns 422 when the cursor is malformed', async () => {
    const event = validEvent({ cursor: 'not-a-cursor' });

    const response = await runHandler(event);

    expect(response.statusCode).toBe(422);
    expect(parsedBody(response)).toMatchObject({
      error: 'Messages retrieval error',
      details: expect.objectContaining({
        fieldErrors: expect.objectContaining({
          cursor: expect.anything(),
        }),
      }),
    });
    expect(getMessagePage).not.toHaveBeenCalled();
  });
});

describe('thread not found', () => {
  it('returns 404 when the thread does not exist', async () => {
    lookupThread.mockResolvedValueOnce(undefined);

    const response = await runHandler(validEvent());

    expect(response.statusCode).toBe(404);
    expect(parsedBody(response)).toEqual({ error: 'Thread not found' });
  });
});

describe('thread lookup failure', () => {
  it('returns 500 when the thread lookup throws', async () => {
    const logError = vi.spyOn(logger, 'error');
    const storeError = new Error('DynamoDB error');
    lookupThread.mockRejectedValueOnce(storeError);

    const response = await runHandler(validEvent());

    expect(response.statusCode).toBe(500);
    expect(parsedBody(response)).toEqual({
      error: 'Messages retrieval error',
    });
    expect(logError).toHaveBeenCalledWith('Thread lookup failed', {
      error: storeError,
      userThreadId: VALID_THREAD_ID,
    });
  });
});

describe('message retrieval failure', () => {
  it('returns 500 when getMessagePage throws', async () => {
    const logError = vi.spyOn(logger, 'error');
    const storeError = new Error('DynamoDB error');
    getMessagePage.mockRejectedValueOnce(storeError);

    const response = await runHandler(validEvent());

    expect(response.statusCode).toBe(500);
    expect(parsedBody(response)).toEqual({
      error: 'Messages retrieval error',
    });
    expect(logError).toHaveBeenCalledWith('Message retrieval failed', {
      error: storeError,
      userThreadId: VALID_THREAD_ID,
    });
  });
});

describe('successful retrieval', () => {
  it('returns messages with the correct response shape', async () => {
    const storedMessages: StoredMessage[] = [
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
    ];
    getMessagePage.mockResolvedValueOnce({ messages: storedMessages });

    const response = await runHandler(validEvent());

    expect(response.statusCode).toBe(200);
    expect(parsedBody(response)).toEqual({
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          content: 'Hello',
          createdAt: '2026-09-03T12:00:00.000Z',
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Hi there',
          createdAt: '2026-09-03T12:00:01.000Z',
        },
      ],
    });
  });

  it('resolves the thread using the end-user-id header and path threadId', async () => {
    await runHandler(validEvent());

    expect(lookupThread).toHaveBeenCalledWith({
      endUserId: VALID_USER_ID,
      userThreadId: VALID_THREAD_ID,
    });
  });

  it('reads the page starting from the decoded cursor', async () => {
    const start: PageStart = {
      direction: 'before',
      position: {
        createdAt: '2026-09-03T12:00:00.000Z',
        messageId: crypto.randomUUID(),
      },
    };

    await runHandler(validEvent({ cursor: encodeCursor(start) }));

    expect(getMessagePage).toHaveBeenCalledWith(SYSTEM_THREAD_ID, start);
  });

  it('omits the earlier and later URLs when the page has no positions', async () => {
    const response = await runHandler(validEvent());

    expect(response.statusCode).toBe(200);
    expect(parsedBody(response)).toEqual({
      messages: [],
    });
  });

  it('builds only earlierMessagesUrl, from the earlier position, when the page has only that', async () => {
    const earlier = {
      createdAt: '2026-09-03T12:00:00.000Z',
      messageId: crypto.randomUUID(),
    };
    getMessagePage.mockResolvedValueOnce({ messages: [], earlier });

    const response = await runHandler(validEvent());

    const cursor = encodeCursor({ direction: 'before', position: earlier });
    expect(parsedBody(response)).toEqual({
      messages: [],
      earlierMessagesUrl: `/v1/threads/${VALID_THREAD_ID}/messages?cursor=${cursor}`,
    });
  });

  it('builds only laterMessagesUrl, from the later position, when the page has only that', async () => {
    const later = {
      createdAt: '2026-09-03T12:00:01.000Z',
      messageId: crypto.randomUUID(),
    };
    getMessagePage.mockResolvedValueOnce({ messages: [], later });

    const response = await runHandler(validEvent());

    const cursor = encodeCursor({ direction: 'after', position: later });
    expect(parsedBody(response)).toEqual({
      messages: [],
      laterMessagesUrl: `/v1/threads/${VALID_THREAD_ID}/messages?cursor=${cursor}`,
    });
  });
});
