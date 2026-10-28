import { z } from 'zod';
import type { PageStart } from '../persistence/messages.ts';

const INVALID_CURSOR_MESSAGE = 'cursor must be a valid cursor';

const CursorPayloadSchema = z.strictObject({
  direction: z.enum(['before', 'after']),
  createdAt: z.iso.datetime(),
  messageId: z.uuid(),
});

type CursorPayload = z.infer<typeof CursorPayloadSchema>;

export function encodeCursor({ direction, position }: PageStart): string {
  const payload: CursorPayload = {
    direction,
    createdAt: position.createdAt,
    messageId: position.messageId,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const CursorSchema = z
  .base64url({ message: INVALID_CURSOR_MESSAGE })
  .transform((token, context): PageStart => {
    const json = Buffer.from(token, 'base64url').toString('utf8');
    const result = CursorPayloadSchema.safeParse(parseJson(json));
    if (!result.success) {
      context.addIssue({ code: 'custom', message: INVALID_CURSOR_MESSAGE });
      return z.NEVER;
    }
    const { direction, createdAt, messageId } = result.data;
    return { direction, position: { createdAt, messageId } };
  });
