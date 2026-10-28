import { NextRequest, type NextResponse } from 'next/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadInput } from '../../../../chat-api/client.ts';
import { endUserIdFor } from '../../../../chat-api/end-user-id.ts';

const THREAD_ID = crypto.randomUUID();
const USER_SUB = crypto.randomUUID();
const MESSAGES = [
  {
    id: crypto.randomUUID(),
    role: 'user',
    content: 'Tell me about SSP',
    createdAt: '2026-09-30T12:00:00.000Z',
  },
];

const readSession = vi.fn<() => Promise<{ sub: string } | undefined>>();
const listThreadMessages = vi.fn<(input: ThreadInput) => Promise<Response>>();

const testEnv = {} as {
  GET: (request: NextRequest) => Promise<NextResponse>;
};

beforeAll(async () => {
  vi.doMock('../../../../auth/session.ts', () => ({ readSession }));
  vi.doMock('../../../../chat-api/client.ts', () => ({ listThreadMessages }));
  const routeModule = await import('./route.ts');
  testEnv.GET = routeModule.GET;
});

beforeEach(() => {
  readSession.mockResolvedValue({ sub: USER_SUB });
});

function messagesRequest(cookie = `thread_id=${THREAD_ID}`): NextRequest {
  return new NextRequest('http://localhost/api/chat/messages', {
    headers: { cookie },
  });
}

describe('GET', () => {
  it('returns the messages using the signed-in user sub and renews the thread cookie', async () => {
    listThreadMessages.mockResolvedValueOnce(
      Response.json({
        messages: MESSAGES,
        earlierMessagesUrl: `/v1/threads/${THREAD_ID}/messages?cursor=x`,
      }),
    );
    const request = messagesRequest();

    const response = await testEnv.GET(request);

    expect(listThreadMessages).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      endUserId: endUserIdFor(USER_SUB),
      signal: request.signal,
    });
    expect(await response.json()).toEqual({ messages: MESSAGES });
    expect(response.cookies.get('thread_id')?.value).toBe(THREAD_ID);
  });

  it('returns no messages when there is no thread cookie', async () => {
    const response = await testEnv.GET(messagesRequest(''));

    expect(await response.json()).toEqual({ messages: [] });
    expect(listThreadMessages).not.toHaveBeenCalled();
  });

  it('returns 401 when the session is invalid', async () => {
    readSession.mockResolvedValue(undefined);

    const response = await testEnv.GET(messagesRequest());

    expect(response.status).toBe(401);
    expect(listThreadMessages).not.toHaveBeenCalled();
  });

  it('returns no messages when the API does not find the thread', async () => {
    listThreadMessages.mockResolvedValueOnce(
      Response.json({ error: 'Thread not found' }, { status: 404 }),
    );

    const response = await testEnv.GET(messagesRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messages: [] });
  });

  it('returns the API status with a generic error when the API fails', async () => {
    listThreadMessages.mockResolvedValueOnce(
      Response.json({ error: 'Messages retrieval error' }, { status: 500 }),
    );

    const response = await testEnv.GET(messagesRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Chat API request failed' });
  });
});
