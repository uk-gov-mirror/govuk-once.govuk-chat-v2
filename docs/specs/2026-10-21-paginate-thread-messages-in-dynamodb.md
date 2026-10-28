# Paginate thread messages in DynamoDB

**Date:** 2026-10-21

**Status:** implemented

## Problem

`GET /v1/threads/{threadId}/messages` in `services/chat-api` returns a
thread's messages 50 at a time, but it gets each page by reading every message
in the thread from DynamoDB (`getMessages`), sorting them in memory and
slicing out the page (`sliceMessages`). The work and read cost of every request
grow with the length of the thread, not with the size of the page.

DynamoDB can't return the page directly today. Messages are stored with the
sort key `MESSAGE#${messageId}`, and message ids are client-supplied UUIDs (the
assistant's message reuses the run id). Key order is random, not chronological,
so no key condition or `Limit` selects the most recent page of messages.

Reading the whole thread also has a latent bug. ElectroDB's `pages` query option
defaults to 1, so `getMessages` gets only the first page of DynamoDB results,
which is at most 1 MB. Because key order is random, a thread larger than that
would silently lose an arbitrary set of messages from its history, not just the
oldest ones.

The endpoint's pagination is mostly a port of the conversation questions API in
GOV.UK Chat v1 ([alphagov/govuk-chat](https://github.com/alphagov/govuk-chat)).
That API runs on PostgreSQL, where it can let the database order and limit by
`created_at`. The port kept v1's contract but not its query, because the v2
table has no time-ordered key to query on.

We want to replace the approach now, before more code builds on reading whole
threads. The clients that will depend on this API are a mobile app and a more
feature-rich web UI. `services/chat-ui` is a rough demo. None of them pages
through messages yet, so this is the time to settle the contract.

## Goals

- Each request for a page of messages reads only that page from DynamoDB,
  however long the thread is.
- Clients can page back through a thread's full history by following
  `earlierMessagesUrl`, as v1's API allows with `earlier_questions_url`.
- Clients can page forwards again from any earlier page by following
  `laterMessagesUrl`, as v1's API allows with `later_questions_url`.
- A page holds up to 100 messages, the same amount of conversation as a v1
  page of 50 questions, each with its answer.
- The cursor contract is settled before clients start to depend on it.

## Non-goals

- Making the page size client-configurable.
- Changing any client. No client pages through messages yet.
- Migrating existing message data. Data in the current tables can be discarded.
- Strongly consistent message reads. Messages are read with eventual
  consistency today, and the index proposed here can't offer anything else.
- Changing how expired-but-not-yet-deleted records are treated.
- Changing how runs and messages are written, beyond indexing messages by
  creation time.

## Requirements

1. **R1:** Getting a page of a thread's messages makes one DynamoDB query for
   messages, after the existing thread lookup, reading at most 101 message
   records (one page, plus one to detect more messages in the direction being
   paged), whatever the thread's length.
2. **R2:** Without a cursor, the response contains the thread's 100 most recent
   messages, ordered oldest first by `createdAt`, then by message id.
3. **R3:** Following a response's `earlierMessagesUrl` returns up to 100
   messages that come immediately before the oldest message in that response,
   in the same order as R2.
4. **R4:** `earlierMessagesUrl` is present only when older messages exist
   than the first one in the response. It is a relative URL that clients follow
   as given, without building it themselves.
5. **R5:** A cursor value with the wrong format is rejected with `422` and the
   endpoint's existing validation error body.
6. **R6:** A cursor holds only a message's position, using values the client
   has already been sent, not internal ids such as the system thread id or
   table key formats. It can only select messages from the thread resolved for
   the caller.
7. **R7:** The response body keeps its current fields, in camelCase to match
   the rest of the response and AG-UI: `earlier_messages_url` becomes
   `earlierMessagesUrl`. The only addition is `laterMessagesUrl` (R9).
8. **R8:** Following a response's `laterMessagesUrl` returns up to 100 messages
   that come immediately after the newest message in that response, in the
   same order as R2. These are the next messages in the thread, not its most
   recent page. That was a bug in v1's forward paging.
9. **R9:** `laterMessagesUrl` is present only when newer messages exist than
   the last one in the response, so it is never on the first page. Like
   `earlierMessagesUrl`, clients follow it as given.

## Design

### Index messages by creation time

Add a global secondary index (GSI) to the `chat-api` table, keyed on two new
string attributes, `gsi1pk` and `gsi1sk`. The `Message` entity in
`src/persistence/service.ts` gains a second ElectroDB index on them, with no
key templates, so ElectroDB builds both keys:

- pk: composed of `systemThreadId`, e.g. `$chat-api#systemthreadid_<id>`
- sk: composed of `createdAt` then `messageId`, e.g.
  `$message_1#createdat_<createdAt>#messageid_<messageId>`

This gives DynamoDB what PostgreSQL gives v1: messages in `created_at` order
within a thread. `createdAt` comes from `Date.prototype.toISOString()`, which
has a fixed width, so the sort order of the strings is chronological.
ElectroDB lowercases keys by default, but it lowercases the values it queries
with in the same way, so the order holds. The message id breaks ties in the
same way as `compareMessages` does today. Because both are in one string,
"before this message" is a single `<` condition on the sort key.

The index has its own partition key field rather than reusing `pk`, because
ElectroDB requires indexes that share a key field to use the same template.
Reusing `pk` would tie the GSI to the primary index's
`THREAD#${systemThreadId}` template. The cost is one extra attribute per
message. The existing entities keep their templates; changing those is
separate work.

Only message records have `gsi1pk` and `gsi1sk`, so the index holds no other
records. ElectroDB adds a filter expression on entity identity to queries, and
DynamoDB applies it after `Limit`. In this index the filter never removes an
item, so a `Limit` of 101 returns up to 101 messages.

The primary index is unchanged. `beginRun` keeps checking for a duplicate
message by `(systemThreadId, messageId)` in its transaction, and a message
can still be fetched by id.

#### Consistency

GSI reads are always eventually consistent. DynamoDB copies writes to a GSI
asynchronously, usually within a fraction of a second. If a client reloads the
history immediately after a run finishes, the page could miss that run's
messages until the next load. Reads of messages are already eventually
consistent today, because `getMessages` doesn't ask for strongly consistent
reads.

That gap only matters for a client that sends a message and then reads the
history back to show it. The current GOV.UK mobile apps don't: they show the
user's question from memory as soon as it is sent, show the answer from the
response, and load history only when the chat screen opens. In v2 the
assistant's reply arrives on the stream, so a client has even less reason to
read straight back.

### Read one page

`getMessages` and `sliceMessages` are replaced by one repository operation in
`src/persistence/messages.ts`, for example
`getMessagePage(systemThreadId, from?: PageStart) => Promise<MessagePage>`.
`PageStart` is a direction (`before` or `after`) and a `MessagePosition`, which
is `{ createdAt, messageId }`.

1. Query the new index for the thread. Without a start, or with `before`, query
   in descending order. With `after`, query in ascending order. A start
   restricts the query to sort keys below (`before`) or above (`after`) the
   one built from its position. Ask for 101 items with ElectroDB's
   `limit` option, which sets DynamoDB's `Limit`. With the default of one page,
   that means one request reading at most 101 items (R1). Don't use `count`: it
   sets no `Limit` and keeps requesting pages until it has enough items, so a
   single request can read up to 1 MB.
2. If 101 come back, there are more messages in the direction being paged: drop
   the last one read. Put the rest oldest first, reversing them after a
   descending query (R2, R3, R8).
3. Return the messages with up to two positions: the oldest message on the page
   when earlier messages exist (R4), and the newest message when later ones
   exist (R9).

The 101st item tells us whether there are more messages in the direction being
paged. Nothing extra needs reading for the other direction, because a page
reached with a start always has at least one message on the side it came
from: the message the cursor points at. So a page fetched with `before` has
later messages, and a page fetched with `after` has earlier ones. An empty
page has no message to point a link at, so it has neither link. A page
without a start is the most recent, so it has no later messages.

v1 runs a separate `exists?` query for each direction to decide whether there
are earlier or later questions. Here the page query and the cursor already
answer both.

`MessagePage` replaces `oldestMessageId` with those positions. Callers see a
position made of record attributes, not keys or ElectroDB types, as
[ADR 0003](../adr/0003-use-dynamodb-via-electrodb-for-chat-api-persistence.md)
requires. The partition always comes from the thread lookup for the caller's
`end-user-id` and `threadId`, never from the cursor (R6).

### Cursor

`earlierMessagesUrl` and `laterMessagesUrl` both carry `?cursor=<token>`.
The token holds a direction, plus the `createdAt` and `messageId` of the
oldest message on the page (for `before`) or the newest (for `after`). It is
JSON, base64url-encoded so that it is safe in a query string. Clients treat it
as opaque: they follow the URLs as given (R4) and aren't told the format.
Encoding and decoding live in one module in `src/schemas/`, so the format is
defined once.

The handler decodes the token straight into a `PageStart`, so a page after the
first needs no lookup before the query (R1). `ThreadMessagesQuerySchema`
replaces `before` with `cursor`, and checks that the token decodes to a valid
direction, an ISO 8601 timestamp and a UUID (R5). One token carries one
direction, so a request can't ask for both.

The token holds only values the client has already been sent in the response
body (R6). It is deliberately not ElectroDB's built-in `cursor`, which encodes
DynamoDB's `LastEvaluatedKey`. That key contains `pk`, which is
`THREAD#<systemThreadId>`. The system thread id isn't secret, but it is
internal, and keeping it and our key formats out of the public API leaves us
free to change them. The built-in cursor would also point at the 101st item
read, not the edge of the page.

The token doesn't need signing. The partition always comes from the caller's
thread lookup, so a tampered or foreign token can only move the starting point
within the caller's own thread. A well-formed token whose values don't match a
message isn't an error: the endpoint returns `200` with whatever is before or
after that point in the thread, possibly no messages. Detecting it would need
a lookup of the message on every page, as in option A under
[Alternatives considered](#alternatives-considered).

v1's objection to timestamps in cursors doesn't apply here. Clients never build
or format the token, and it carries the exact stored `createdAt` with the
message id as a tie-breaker, so no records are skipped.

An opaque token is the usual pattern for cursor-paginated APIs, for example
Google's `page_token`, GraphQL Relay's `endCursor` and AWS's `NextToken`. It
also suits R4: if clients never build the cursor, a format they can read buys
them nothing.

The trade-offs:

- It replaces `before`, which breaks the v1-style contract, but no client
  depends on it yet.
- Clients can only page from a cursor the server gave them, not from a message
  id they hold.
- The token is base64, not encrypted. Anyone can decode it, so it must only
  ever hold values the client is allowed to see (R6). That also makes it easy
  to inspect when debugging.

### Paging forwards

v1 also pages forwards, with an `after` parameter and `later_questions_url`.
[PR #380](https://github.com/alphagov/govuk-chat/pull/380) fixed a bug where
following `later_questions_url` returned the most recent page rather than the
next one. It added an end-to-end test for paging back and forth, while noting
that it's "pretty unlikely that anyone will ever paginate back and forth
through a conversation's questions".

Neither of the current GOV.UK mobile apps uses v1's paging in either direction.
Both load only the most recent 50 answered questions from
`GET /conversation/{id}`. Neither calls `/conversation/{id}/questions`, the
endpoint that takes `before` and `after`, or reads `earlier_questions_url` or
`later_questions_url`.

This spec includes paging forwards (R8, R9) for future clients. It adds
little to the work: an ascending query on the same index, a second position in
`MessagePage`, and a direction in the cursor. It needs no extra reads (see
[Read one page](#read-one-page)).

### Infrastructure

`cdk/src/stacks/chat-api-stack.ts` adds the GSI to the existing table, with
`gsi1pk` as its partition key, `gsi1sk` as its sort key, and
`ProjectionType.ALL` so a page needs no extra reads. A GSI can be added to a
table in place, so the table isn't replaced or renamed.

## Alternatives considered

- **Keep `before=<messageId>`, following v1 (option A).** v1's `before` and
  `after` take a question's UUID, and the server looks up that question's
  `created_at`. The v1 commit that added them
  ([3e896eb0](https://github.com/alphagov/govuk-chat/commit/3e896eb0)) rejected
  timestamp parameters, because clients would have had to agree on precision
  and format. It keeps the current contract, lets a client page from any
  message it holds, and the lookup can return `404` for a cursor whose message
  isn't in the thread. But every page after the first costs a lookup before
  the query, and clients can depend on the cursor being a message id. An
  opaque cursor avoids the lookup, and a cursor with wrong values only ever
  returns the caller's own messages, so a `404` isn't worth it.
- **Use `before`/`after=<messageId>:<createdAt>` (option C).** This is
  readable, needs no lookup, and takes the direction from the parameter name.
  But clients can see the format and might start building or parsing cursors,
  so changing it later would be a breaking change, as with option A. It can't
  detect a cursor with wrong values either. It has the weaknesses of both
  other options, and the opaque token is easy enough to decode when debugging.

- **Add a local secondary index (LSI) instead.** An LSI can serve strongly
  consistent reads, which would close the gap described under
  [Consistency](#consistency). But it can only be created with its table, so
  adding one would mean replacing the table under a new name. In `stag` and
  `prod`, someone would then have to delete the retained old table by hand. It
  would also cap each thread's records at 10 GB. The current clients don't read
  back what they have just written, so strongly consistent reads aren't worth
  that.
- **Key the GSI on the existing attributes.** DynamoDB GSIs can have
  multi-attribute keys, and ElectroDB supports them with `type: "composite"`.
  A GSI on `systemThreadId`, then `createdAt` and `messageId`, would need no
  new attribute and would index existing messages. But a range condition can
  only apply to the last attribute in a condition. With ElectroDB 3.9.3,
  `.lt({ createdAt, messageId })` becomes
  `createdAt = :createdAt AND messageId < :messageId`, not "before this
  message". Paging correctly would take two queries, or skipping messages with
  the same timestamp in code. Existing data can be discarded, so a single
  string sort key is simpler.
- **Use ElectroDB's built-in cursor.** This needs the least code, but it puts
  the system thread id and key formats in the public API, and points at the
  wrong item. See [Cursor](#cursor).
- **Change the message sort key to `MESSAGE#${createdAt}#${messageId}`.** This
  needs no index. But `beginRun` checks for duplicate messages by id before the
  user message's `createdAt` is set, and a retried request would get a
  different timestamp and so a different key. Keeping that check would need an
  extra marker record per message.
- **Use time-ordered message ids (e.g. UUIDv7) and keep the sort key.** Clients
  supply message ids, and the agent run protocol doesn't require them to be
  time-ordered, so the API can't rely on them.

## Implementation plan

1. Add the GSI to the `chat-api` table in CDK, with a stack test asserting the
   index exists (R1).
2. Add the creation-time index to the `Message` entity in
   `services/chat-api/src/persistence/service.ts`, so that every message
   written gets `gsi1pk` and `gsi1sk` (R1).
3. Add `getMessagePage` to `src/persistence/messages.ts`, with
   `MESSAGE_PAGE_SIZE` raised to 100, and tests (R1–R4, R6, R8, R9).
4. Add the cursor module in `src/schemas/` and replace `before` with `cursor`
   in `ThreadMessagesQuerySchema`, with tests (R5, R6).
5. Switch the handler in `src/handlers/threads/messages.ts` to the new
   operations, build both URLs under their camelCase names, remove
   `getMessages` and `sliceMessages`, and replace their tests (R3, R4, R7, R8,
   R9). Rename the field in the `services/demo-ui` route test fixture too.

Steps 1–5 land in one pull request, as the code in step 3 queries an index
that step 1 creates.

### Testing

- `services/chat-api/src/persistence/messages.test.ts`, using the existing
  stubbed document client: drop the `getMessages` and `sliceMessages` tests and
  cover `getMessagePage`'s logic paths:
  - Without a start, and with a `before` start, the query uses the index, runs
    in descending order and sends a `Limit` of 101 (R1). Results come back
    reversed into ascending order (R2, R3).
  - With an `after` start, the query runs in ascending order with the same
    `Limit`, and results aren't reversed (R1, R8).
  - Exactly 101 results: the last one read is dropped, and a position is
    returned for that direction. Fewer than 101: no position for that direction
    (R4, R9).
  - A non-empty page with a `before` start always returns a later position, a
    non-empty page with an `after` start always returns an earlier one, an
    empty page returns neither, and a page without a start never returns a
    later one (R4, R9).
- Cursor module: a token round-trips to the same direction and position, the
  schema rejects input that isn't base64url JSON or lacks a valid direction,
  timestamp and UUID (R5), and the token holds only those three values (R6).
- `services/chat-api/src/handlers/threads/messages.test.ts`: change the
  mocks to the new repository operations. Keep the existing handler paths, and
  cover turning a cursor into a page start and building `earlierMessagesUrl`
  and `laterMessagesUrl` from the returned positions (R3, R4, R7, R8, R9).
  Cover a malformed cursor returning `422` (R5).
- `cdk/src/stacks/chat-api-stack.test.ts`: assert the table has the GSI with
  `hasResourceProperties`.
- Run `scripts/dev-checks.sh` in `services/chat-api` and `cdk`.
- Manual check in a dev environment: deploy, build a thread with more than 100
  messages (more than 50 runs). Page back through it with
  `earlierMessagesUrl` until it is absent, then forwards with
  `laterMessagesUrl` until that is absent. Check that each page follows on
  from the last. v1 automates this flow in an end-to-end test (PR #380). v2
  has no equivalent yet, so it stays manual.

### Rollout

Adding the GSI updates the table in place. The Lambda functions reference the
table, so CloudFormation finishes creating the index before it updates them.
Messages written before the deploy have no GSI keys, so they aren't in the
index and won't be returned. Existing data can be discarded, so they are not
backfilled.

Replacing `before` with `cursor` breaks any client that sends `before`, and
renaming `earlier_messages_url` breaks any client that reads it. No client
pages through messages yet, so nothing needs to change first.

## Risks

- **A client reads straight back after a run.** A future client that reloads
  history the moment a run finishes could briefly miss that run's messages
  (see [Consistency](#consistency)). If that becomes a need, the fix is an
  index that supports strongly consistent reads, which would mean an LSI and
  replacing the table.
- **Another entity uses the `gsi1pk`/`gsi1sk` fields.** The index relies on
  only messages having them. If another entity's index used the same fields,
  its records would enter the index. ElectroDB's entity filter would keep them
  out of results, but pages could come back short.
- **The read stops being bounded.** If someone later adds a filter that removes
  items from the index, or swaps `limit` for `count`, pages would come back
  short or read more than 101 items. The persistence tests assert the `Limit`
  that is sent.
- **Something sensitive gets into the cursor.** The token is only encoded, so
  anything added to it later is readable by clients. The cursor tests assert
  what it holds (R6).
- **A page splits an exchange.** v1 pages by question, so a question and its
  answer are always on the same page. v2 pages by message. A run usually writes
  a user and an assistant message, so 100 messages is 50 exchanges, but a run
  with no assistant content writes only the user message. After one of those, a
  page can start or end between a question and its answer. Clients see the
  rest of the exchange on the next page.
- **Clocks decide the order.** The order depends on `createdAt` timestamps from
  Lambda clocks, as it does today. This change doesn't make that any worse.
