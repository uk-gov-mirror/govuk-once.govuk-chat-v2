import middy from '@middy/core';
import httpHeaderNormalizer from '@middy/http-header-normalizer';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import type { APIGatewayProxyResult } from 'aws-lambda';
import {
  ClientInputHeadersSchema,
  ThreadMessagesPathParametersSchema,
  ThreadMessagesQuerySchema,
  type ClientInputHeaders,
  type ThreadMessagesPathParameters,
  type ThreadMessagesQuery,
} from '../../schemas/client-input.ts';
import {
  zodHeadersValidator,
  zodPathParametersValidator,
  zodQueryValidator,
  type ValidatedHeadersEvent,
  type ValidatedPathParametersEvent,
  type ValidatedQueryEvent,
} from '../../http/zod-validator.ts';
import {
  buildJsonErrorResponse,
  jsonHttpErrorHandler,
  type JsonErrorResponse,
} from '../../http/errors.ts';
import { logger } from '../../logging/logger.ts';
import {
  lookupThread,
  getMessagePage,
  type PageStart,
} from '../../persistence/messages.ts';
import { encodeCursor } from '../../schemas/cursor.ts';

type ListMessagesEvent = ValidatedHeadersEvent<ClientInputHeaders> &
  ValidatedPathParametersEvent<ThreadMessagesPathParameters> &
  ValidatedQueryEvent<ThreadMessagesQuery>;

function messagesPageUrl(threadId: string, start: PageStart): string {
  return `/v1/threads/${threadId}/messages?cursor=${encodeCursor(start)}`;
}

async function listMessages(
  event: ListMessagesEvent,
): Promise<APIGatewayProxyResult | JsonErrorResponse> {
  const endUserId = event.headers['end-user-id'];
  const { threadId } = event.pathParameters;
  const { cursor } = event.queryStringParameters;

  let thread;
  try {
    thread = await lookupThread({ endUserId, userThreadId: threadId });
  } catch (error) {
    logger.error('Thread lookup failed', {
      error,
      userThreadId: threadId,
    });
    return buildJsonErrorResponse(500, { error: 'Messages retrieval error' });
  }

  if (!thread) {
    return buildJsonErrorResponse(404, { error: 'Thread not found' });
  }

  let page;
  try {
    page = await getMessagePage(thread.systemThreadId, cursor);
  } catch (error) {
    logger.error('Message retrieval failed', {
      error,
      userThreadId: threadId,
    });
    return buildJsonErrorResponse(500, { error: 'Messages retrieval error' });
  }

  const earlierMessagesUrl = page.earlier
    ? messagesPageUrl(threadId, { direction: 'before', position: page.earlier })
    : undefined;
  const laterMessagesUrl = page.later
    ? messagesPageUrl(threadId, { direction: 'after', position: page.later })
    : undefined;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: page.messages.map((message) => ({
        id: message.messageId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      })),
      earlierMessagesUrl,
      laterMessagesUrl,
    }),
  };
}

export const handler = middy()
  .use(injectLambdaContext(logger, { resetKeys: true }))
  .use(httpHeaderNormalizer())
  .use(
    zodHeadersValidator(ClientInputHeadersSchema, 'Messages retrieval error'),
  )
  .use(
    zodPathParametersValidator(
      ThreadMessagesPathParametersSchema,
      'Messages retrieval error',
    ),
  )
  .use(zodQueryValidator(ThreadMessagesQuerySchema, 'Messages retrieval error'))
  .use(jsonHttpErrorHandler())
  .handler(listMessages);
