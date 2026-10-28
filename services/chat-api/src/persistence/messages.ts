import { service } from './service.ts';
import type { ThreadKey, ResolvedThread } from './threads.ts';

export interface StoredMessage {
  messageId: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface MessagePage {
  messages: StoredMessage[];
  oldestMessageId: string | undefined;
}

export interface MessagePosition {
  createdAt: string;
  messageId: string;
}

export interface PageStart {
  direction: 'before' | 'after';
  position: MessagePosition;
}

export interface MessagePageWithPositions {
  messages: StoredMessage[];
  earlier?: MessagePosition;
  later?: MessagePosition;
}

export async function lookupThread(
  key: ThreadKey,
): Promise<ResolvedThread | undefined> {
  const nowSeconds = Math.floor(Date.now() / 1000);

  const { data: mapping } = await service.entities.threadMapping
    .get(key)
    .go({ consistent: true });

  return !mapping || mapping.expiresAt <= nowSeconds
    ? undefined
    : { systemThreadId: mapping.systemThreadId };
}

export async function getMessages(
  systemThreadId: string,
): Promise<StoredMessage[]> {
  const { data: records } = await service.entities.message.query
    .primary({ systemThreadId })
    .go();

  return records.map((record) => toStoredMessage(record));
}

function toStoredMessage(record: StoredMessage): StoredMessage {
  return {
    messageId: record.messageId,
    role: record.role,
    content: record.content,
    createdAt: record.createdAt,
  };
}

export const MESSAGE_PAGE_SIZE = 100;

function queryFrom(systemThreadId: string, from?: PageStart) {
  const query = service.entities.message.query.byCreatedAt({ systemThreadId });
  if (!from) {
    return query;
  }
  const { createdAt, messageId } = from.position;
  return from.direction === 'before'
    ? query.lt({ createdAt, messageId })
    : query.gt({ createdAt, messageId });
}

function positionOf({ createdAt, messageId }: StoredMessage): MessagePosition {
  return { createdAt, messageId };
}

export async function getMessagePage(
  systemThreadId: string,
  from?: PageStart,
): Promise<MessagePageWithPositions> {
  const isAscending = from?.direction === 'after';
  const { data: records } = await queryFrom(systemThreadId, from).go({
    order: isAscending ? 'asc' : 'desc',
    limit: MESSAGE_PAGE_SIZE + 1,
  });

  const hasMoreInPagedDirection = records.length > MESSAGE_PAGE_SIZE;
  const read = records
    .slice(0, MESSAGE_PAGE_SIZE)
    .map((record) => toStoredMessage(record));
  const messages = isAscending ? read : read.toReversed();

  const oldest = messages.at(0);
  const newest = messages.at(-1);
  if (!oldest || !newest) {
    return { messages };
  }

  // A page reached from a cursor always has the cursor's message on the
  // side it came from, so only the paged direction needs the extra read.
  const hasEarlier = isAscending || hasMoreInPagedDirection;
  const hasLater =
    from !== undefined && (!isAscending || hasMoreInPagedDirection);

  return {
    messages,
    ...(hasEarlier && { earlier: positionOf(oldest) }),
    ...(hasLater && { later: positionOf(newest) }),
  };
}

function compareMessages(a: StoredMessage, b: StoredMessage): number {
  const dateCompare = a.createdAt.localeCompare(b.createdAt);
  return dateCompare === 0
    ? a.messageId.localeCompare(b.messageId)
    : dateCompare;
}

export function sliceMessages(
  messages: StoredMessage[],
  before?: string,
): MessagePage {
  const sorted = messages.toSorted(compareMessages);

  let endIndex = sorted.length;
  if (before) {
    endIndex = sorted.findIndex((m) => m.messageId === before);
    if (endIndex === -1) {
      return { messages: [], oldestMessageId: undefined };
    }
  }

  const startIndex = Math.max(0, endIndex - MESSAGE_PAGE_SIZE);
  const page = sorted.slice(startIndex, endIndex);
  const hasEarlier = startIndex > 0;

  return {
    messages: page,
    oldestMessageId: hasEarlier ? page[0].messageId : undefined,
  };
}
