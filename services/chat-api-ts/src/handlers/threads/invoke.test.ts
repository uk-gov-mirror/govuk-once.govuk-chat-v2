import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { logger } from '../../logging/logger.ts';
import type { ResolvedThread, ThreadKey } from '../../persistence/threads.ts';
import {
  send,
  encoder,
  invokeAgentRuntimeCommand,
  stubAwsLambdaGlobal,
  stubBedrockAgentCoreClient,
  createResponseStream,
  expectJsonHttpResponse,
  aguiEventStream,
  createFailingStream,
  type ResponseStream,
} from '../../test-utils/agent-stream.ts';

type HandlerFunction = (
  event: APIGatewayProxyEvent,
  responseStream: ResponseStream,
  context?: unknown,
) => Promise<void>;

const testEnv = {} as {
  handler: HandlerFunction;
  responseStream: ResponseStream;
};

beforeEach(() => {
  testEnv.responseStream = createResponseStream();
});

const VALID_THREAD_ID = crypto.randomUUID();
const VALID_RUN_ID = crypto.randomUUID();
const VALID_USER_ID = crypto.randomUUID();
const SYSTEM_THREAD_ID = crypto.randomUUID();
const DEFAULT_HEADERS = {
  'end-user-id': VALID_USER_ID,
  'content-type': 'application/json',
};
const AGENT_RUNTIME_ARN =
  'arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/test';
const VALID_MESSAGES = [
  { id: crypto.randomUUID(), role: 'user', content: 'Tell me about SSP' },
];

const resolveThread = vi
  .fn<(key: ThreadKey) => Promise<ResolvedThread>>()
  .mockResolvedValue({ systemThreadId: SYSTEM_THREAD_ID });

beforeAll(async () => {
  stubAwsLambdaGlobal();
  stubBedrockAgentCoreClient();
  vi.doMock('../../persistence/threads.ts', () => ({ resolveThread }));
  vi.stubEnv('AGENT_RUNTIME_ARN', AGENT_RUNTIME_ARN);

  const agentStreamModule = await import('./invoke.ts');
  testEnv.handler = agentStreamModule.handler as unknown as HandlerFunction;
});

// TODO: Use real APIGatewayProxyEvent for event parameter.
function makeEvent(
  body: unknown,
  headers: Record<string, string> = DEFAULT_HEADERS,
): APIGatewayProxyEvent {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  } as unknown as APIGatewayProxyEvent;
}

async function runAndGetErrorBody(
  body: unknown,
  headers?: Record<string, string>,
) {
  const responseStream = testEnv.responseStream;
  await testEnv.handler(makeEvent(body, headers), responseStream, {});
  return {
    responseStream,
    parsed: JSON.parse(responseStream.read()),
  };
}

function fieldErrorResponse(error: string, fields: string[]): unknown {
  return expect.objectContaining({
    error,
    details: expect.objectContaining({
      fieldErrors: expect.objectContaining(
        Object.fromEntries(fields.map((field) => [field, expect.anything()])),
      ),
    }),
  });
}

describe('configuration', () => {
  it('throws an error during module import when AGENT_RUNTIME_ARN is not configured', async () => {
    vi.resetModules();
    vi.stubEnv('AGENT_RUNTIME_ARN', undefined);

    await expect(import('./invoke.ts')).rejects.toThrow(
      'AGENT_RUNTIME_ARN is not configured',
    );
  });
});

describe('handler', () => {
  describe('request headers', () => {
    it('returns 422 when end-user-id header is missing', async () => {
      const { responseStream } = await runAndGetErrorBody(
        { threadId: VALID_THREAD_ID, messages: VALID_MESSAGES },
        { 'content-type': 'application/json' },
      );

      expectJsonHttpResponse(
        responseStream,
        422,
        fieldErrorResponse('Agent invocation error', ['end-user-id']),
      );
      expect(resolveThread).not.toHaveBeenCalled();
    });

    it('normalises header keys before validation', async () => {
      const { responseStream } = await runAndGetErrorBody(
        { threadId: VALID_THREAD_ID, messages: VALID_MESSAGES },
        { 'End-User-Id': VALID_USER_ID, 'content-type': 'application/json' },
      );

      expectJsonHttpResponse(
        responseStream,
        422,
        fieldErrorResponse('Agent invocation error', ['runId']),
      );
    });
  });

  describe('request body parsing', () => {
    it('returns a 422 for a malformed JSON body', async () => {
      const logWarn = vi.spyOn(logger, 'warn');
      const logError = vi.spyOn(logger, 'error');
      const responseStream = testEnv.responseStream;
      const event = {
        body: '{not valid json',
        headers: DEFAULT_HEADERS,
      } as unknown as APIGatewayProxyEvent;

      await testEnv.handler(event, responseStream, {});

      expectJsonHttpResponse(responseStream, 422, {
        error: 'Invalid or malformed JSON was provided',
      });
      expect(logWarn).toHaveBeenCalledWith(
        'Request rejected before reaching the handler',
        { error: expect.any(Error), statusCode: 422 },
      );
      expect(logError).not.toHaveBeenCalled();
    });

    it('returns 415 when Content-Type is missing or not JSON', async () => {
      const responseStream = testEnv.responseStream;

      await testEnv.handler(
        makeEvent(
          { threadId: VALID_THREAD_ID, messages: VALID_MESSAGES },
          { 'end-user-id': VALID_USER_ID },
        ),
        responseStream,
        {},
      );

      expectJsonHttpResponse(responseStream, 415, {
        error: 'Unsupported Media Type',
      });
    });
  });

  describe('request body validation', () => {
    it('returns 422 with validation details when schema validation occurs', async () => {
      const { responseStream } = await runAndGetErrorBody({
        threadId: 'not-a-uuid',
      });

      expectJsonHttpResponse(
        responseStream,
        422,
        fieldErrorResponse('Agent invocation error', ['threadId', 'messages']),
      );
    });

    it('returns 422 with validation details when schema validation occurs for nested fields', async () => {
      const { responseStream } = await runAndGetErrorBody({
        threadId: VALID_THREAD_ID,
        messages: [{ id: 'msg-1', role: 'user', content: '' }],
      });

      expectJsonHttpResponse(
        responseStream,
        422,
        fieldErrorResponse('Agent invocation error', ['messages']),
      );
    });
  });

  describe('successful invocation', () => {
    it('invokes the agent runtime with the full payload and streams AG-UI events back', async () => {
      const responseStream = testEnv.responseStream;

      const events: BaseEvent[] = [
        {
          type: EventType.RUN_STARTED,
          threadId: SYSTEM_THREAD_ID,
          runId: VALID_RUN_ID,
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: 'msg-1',
          role: 'assistant',
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: 'msg-1',
          delta: 'Statutory Sick Pay ',
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: 'msg-1',
          delta: 'is a weekly payment.',
        },
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: 'msg-1',
        },
        {
          type: EventType.RUN_FINISHED,
          threadId: SYSTEM_THREAD_ID,
          runId: VALID_RUN_ID,
        },
      ];
      send.mockResolvedValueOnce({ response: aguiEventStream(events) });

      const requestBody = {
        threadId: VALID_THREAD_ID,
        runId: VALID_RUN_ID,
        state: {},
        forwardedProps: {},
        tools: [],
        context: [],
        messages: VALID_MESSAGES,
      };

      await testEnv.handler(makeEvent(requestBody), responseStream, {});

      expect(responseStream.read()).toBe(
        events.map((event) => encoder.encode(event)).join(''),
      );
      expect(resolveThread).toHaveBeenCalledWith({
        endUserId: VALID_USER_ID,
        userThreadId: VALID_THREAD_ID,
      });
      expect(invokeAgentRuntimeCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          agentRuntimeArn: AGENT_RUNTIME_ARN,
          runtimeSessionId: SYSTEM_THREAD_ID,
          payload: JSON.stringify({
            threadId: SYSTEM_THREAD_ID,
            runId: VALID_RUN_ID,
            state: {},
            messages: VALID_MESSAGES,
            tools: [],
            context: [],
            forwardedProps: {
              endUserId: VALID_USER_ID,
            },
          }),
        }),
      );
    });
  });

  describe('thread store failures', () => {
    it('returns a 500 JSON error without invoking the runtime when the thread cannot be resolved', async () => {
      const logError = vi.spyOn(logger, 'error');
      const responseStream = testEnv.responseStream;
      const storeError = new Error('Error from thread store');
      resolveThread.mockRejectedValueOnce(storeError);

      await testEnv.handler(
        makeEvent({
          threadId: VALID_THREAD_ID,
          runId: VALID_RUN_ID,
          messages: VALID_MESSAGES,
        }),
        responseStream,
        {},
      );

      expectJsonHttpResponse(responseStream, 500, {
        error: 'Agent invocation error',
      });
      expect(logError).toHaveBeenCalledWith('Thread resolution failed', {
        error: storeError,
        userThreadId: VALID_THREAD_ID,
        runId: VALID_RUN_ID,
      });
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('agent runtime failures', () => {
    describe('pre-stream failures', () => {
      it('returns a 500 JSON error when runtime client invocation fails before opening stream', async () => {
        const logError = vi.spyOn(logger, 'error');
        const responseStream = testEnv.responseStream;
        const runtimeError = new Error('Error from agent runtime');
        send.mockRejectedValueOnce(runtimeError);

        await testEnv.handler(
          makeEvent({
            threadId: VALID_THREAD_ID,
            runId: VALID_RUN_ID,
            messages: VALID_MESSAGES,
          }),
          responseStream,
          {},
        );

        expectJsonHttpResponse(responseStream, 500, {
          error: 'Agent invocation error',
        });
        expect(logError).toHaveBeenCalledWith(
          'Agent runtime invocation failed',
          {
            error: runtimeError,
            threadId: SYSTEM_THREAD_ID,
            userThreadId: VALID_THREAD_ID,
            runId: VALID_RUN_ID,
          },
        );
      });

      it('returns a 500 JSON error when no response body is returned from agent runtime', async () => {
        const logError = vi.spyOn(logger, 'error');
        const responseStream = testEnv.responseStream;
        send.mockResolvedValueOnce({ response: undefined });

        await testEnv.handler(
          makeEvent({
            threadId: VALID_THREAD_ID,
            runId: VALID_RUN_ID,
            messages: VALID_MESSAGES,
          }),
          responseStream,
          {},
        );

        expectJsonHttpResponse(responseStream, 500, {
          error: 'Agent invocation error',
        });
        expect(logError).toHaveBeenCalledWith(
          'Agent runtime returned no response body',
          {
            threadId: SYSTEM_THREAD_ID,
            userThreadId: VALID_THREAD_ID,
            runId: VALID_RUN_ID,
          },
        );
      });
    });

    describe('mid-stream failures', () => {
      it('emits synthetic RUN_STARTED carrying the system thread id followed by RUN_ERROR when response stream fails before RUN_STARTED chunk', async () => {
        const responseStream = testEnv.responseStream;

        send.mockResolvedValueOnce({ response: createFailingStream() });

        await testEnv.handler(
          makeEvent({
            threadId: VALID_THREAD_ID,
            runId: VALID_RUN_ID,
            messages: VALID_MESSAGES,
          }),
          responseStream,
          {},
        );

        const relayed = responseStream.read();
        expect(relayed).toContain(EventType.RUN_STARTED);
        expect(relayed).toContain(SYSTEM_THREAD_ID);
        expect(relayed).toContain(EventType.RUN_ERROR);
      });
    });
  });
});
