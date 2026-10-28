import { describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';
import {
  MessageSchema,
  RunAgentInputSchema,
  ClientInputHeadersSchema,
  ThreadMessagesPathParametersSchema,
  ThreadMessagesQuerySchema,
} from './client-input.ts';
import { encodeCursor } from './cursor.ts';

const VALID_THREAD_ID = crypto.randomUUID();
const VALID_RUN_ID = crypto.randomUUID();

const VALID_MESSAGE = {
  id: crypto.randomUUID(),
  role: 'user',
  content: 'Tell me about SSP',
};

function expectInputSuccess(schema: ZodType, input: unknown): void {
  const result = schema.safeParse(input);
  expect(result.success).toBe(true);
}

function expectInputFailure(
  schema: ZodType,
  input: unknown,
  fieldErrors: Record<string, unknown>,
): void {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  const error = z.flattenError(result.error!);
  expect(error.fieldErrors).toEqual(fieldErrors);
}

describe('ClientInputHeadersSchema', () => {
  it('accepts valid headers containing end-user-id', () => {
    expectInputSuccess(ClientInputHeadersSchema, {
      'end-user-id': crypto.randomUUID(),
    });
  });

  it('rejects missing end-user-id header', () => {
    expectInputFailure(
      ClientInputHeadersSchema,
      {},
      {
        'end-user-id': ['end-user-id must be a valid UUID'],
      },
    );
  });
});

describe('MessageSchema', () => {
  it('accepts a valid message', () => {
    expectInputSuccess(MessageSchema, VALID_MESSAGE);
  });

  it('accepts each allowed role', () => {
    for (const role of ['user', 'assistant', 'system', 'tool']) {
      expectInputSuccess(MessageSchema, { ...VALID_MESSAGE, role });
    }
  });

  it('rejects a role outside the allowed set', () => {
    const result = MessageSchema.safeParse({
      ...VALID_MESSAGE,
      role: 'developer',
    });
    const error = z.flattenError(result.error!);

    expect(result.success).toBe(false);
    expect(error.fieldErrors).toMatchObject({ role: [/Invalid option/] });
  });

  it('rejects an empty id', () => {
    const { id: _id, ...withoutId } = VALID_MESSAGE;
    expectInputFailure(MessageSchema, withoutId, {
      id: ['id must be a valid UUID'],
    });
  });

  it('rejects empty content', () => {
    expectInputFailure(
      MessageSchema,
      { ...VALID_MESSAGE, content: '' },
      {
        content: ['content must not be empty'],
      },
    );
  });

  it('rejects a message missing content entirely', () => {
    const { content: _content, ...withoutContent } = VALID_MESSAGE;
    expectInputFailure(MessageSchema, withoutContent, {
      content: ['Invalid input: expected string, received undefined'],
    });
  });
});

describe('RunAgentInputSchema', () => {
  const validInput = {
    threadId: VALID_THREAD_ID,
    runId: VALID_RUN_ID,
    messages: [VALID_MESSAGE],
  };

  it('accepts a minimal valid input', () => {
    expectInputSuccess(RunAgentInputSchema, validInput);
  });

  it('accepts a full valid input with all optional fields present but empty', () => {
    expectInputSuccess(RunAgentInputSchema, {
      ...validInput,
      state: {},
      forwardedProps: {},
      tools: [],
      context: [],
    });
  });

  describe('threadId', () => {
    it('rejects a missing threadId', () => {
      const { threadId: _threadId, ...withoutThreadId } = validInput;
      expectInputFailure(RunAgentInputSchema, withoutThreadId, {
        threadId: ['threadId must be a valid UUID'],
      });
    });

    it('rejects a threadId that is not a UUID', () => {
      expectInputFailure(
        RunAgentInputSchema,
        { ...validInput, threadId: 'not-a-uuid' },
        { threadId: ['threadId must be a valid UUID'] },
      );
    });
  });

  describe('runId', () => {
    it('rejects a missing runId', () => {
      const { runId: _runId, ...withoutRunId } = validInput;
      expectInputFailure(RunAgentInputSchema, withoutRunId, {
        runId: ['runId must be a valid UUID'],
      });
    });

    it('rejects a runId that is not a UUID', () => {
      expectInputFailure(
        RunAgentInputSchema,
        { ...validInput, runId: 'not-a-uuid' },
        { runId: ['runId must be a valid UUID'] },
      );
    });
  });

  describe('parentRunId', () => {
    it('rejects any value, including a valid UUID', () => {
      expectInputFailure(
        RunAgentInputSchema,
        { ...validInput, parentRunId: VALID_RUN_ID },
        { parentRunId: ['Invalid input: expected never, received string'] },
      );
    });
  });

  describe('state', () => {
    it('accepts an empty object', () => {
      expectInputSuccess(RunAgentInputSchema, { ...validInput, state: {} });
    });

    it('rejects a non-empty object', () => {
      expectInputFailure(
        RunAgentInputSchema,
        { ...validInput, state: { invalidKey: 'value' } },
        { state: ['Unrecognized key: "invalidKey"'] },
      );
    });
  });

  describe('forwardedProps', () => {
    it('accepts an empty object', () => {
      expectInputSuccess(RunAgentInputSchema, {
        ...validInput,
        forwardedProps: {},
      });
    });

    it('rejects a non-empty object', () => {
      expectInputFailure(
        RunAgentInputSchema,
        { ...validInput, forwardedProps: { foo: 'bar' } },
        { forwardedProps: ['Unrecognized key: "foo"'] },
      );
    });
  });

  describe('tools', () => {
    it('accepts an empty array', () => {
      expectInputSuccess(RunAgentInputSchema, { ...validInput, tools: [] });
    });

    it('rejects a non-empty array', () => {
      expectInputFailure(
        RunAgentInputSchema,
        { ...validInput, tools: [{ name: 'search' }] },
        { tools: ['Too big: expected array to have <=0 items'] },
      );
    });
  });

  describe('context', () => {
    it('accepts an empty array', () => {
      expectInputSuccess(RunAgentInputSchema, { ...validInput, context: [] });
    });

    it('rejects a non-empty array', () => {
      expectInputFailure(
        RunAgentInputSchema,
        {
          ...validInput,
          context: [{ description: 'context', value: 'toggle' }],
        },
        { context: ['Too big: expected array to have <=0 items'] },
      );
    });
  });

  describe('messages', () => {
    it('rejects a missing messages field', () => {
      const { messages: _messages, ...withoutMessages } = validInput;
      expectInputFailure(RunAgentInputSchema, withoutMessages, {
        messages: ['Invalid input: expected array, received undefined'],
      });
    });

    it('rejects an empty messages array', () => {
      expectInputFailure(
        RunAgentInputSchema,
        { ...validInput, messages: [] },
        {
          messages: [
            'messages must contain at least one message',
            'the last message must be a user message',
          ],
        },
      );
    });

    it('rejects messages when the last one is not from the user', () => {
      expectInputFailure(
        RunAgentInputSchema,
        {
          ...validInput,
          messages: [
            { id: crypto.randomUUID(), role: 'assistant', content: 'hi' },
          ],
        },
        { messages: ['the last message must be a user message'] },
      );
    });

    it('rejects a message with empty content', () => {
      expectInputFailure(
        RunAgentInputSchema,
        {
          ...validInput,
          messages: [{ id: crypto.randomUUID(), role: 'user', content: '' }],
        },
        { messages: ['content must not be empty'] },
      );
    });
  });
});

describe('ThreadMessagesPathParametersSchema', () => {
  it('accepts a valid UUID threadId', () => {
    expectInputSuccess(ThreadMessagesPathParametersSchema, {
      threadId: crypto.randomUUID(),
    });
  });

  it('rejects a missing threadId', () => {
    expectInputFailure(
      ThreadMessagesPathParametersSchema,
      {},
      {
        threadId: ['threadId must be a valid UUID'],
      },
    );
  });

  it('rejects a threadId that is not a UUID', () => {
    expectInputFailure(
      ThreadMessagesPathParametersSchema,
      { threadId: 'not-a-uuid' },
      { threadId: ['threadId must be a valid UUID'] },
    );
  });
});

describe('ThreadMessagesQuerySchema', () => {
  it('accepts an empty object', () => {
    const result = ThreadMessagesQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data).toEqual({});
  });

  it('decodes an optional cursor into a page start', () => {
    const start = {
      direction: 'before',
      position: {
        createdAt: new Date().toISOString(),
        messageId: crypto.randomUUID(),
      },
    } as const;
    const result = ThreadMessagesQuerySchema.safeParse({
      cursor: encodeCursor(start),
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ cursor: start });
  });
});
