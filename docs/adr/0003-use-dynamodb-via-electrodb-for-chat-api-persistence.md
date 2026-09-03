# 3. Use DynamoDB via ElectroDB for Chat API persistence

**Date:** 2026-09-02

## Context

The TypeScript Chat API has no persistent storage. The first thing it needs
to store is which end user owns each thread (CHAT-934). That needs two
records written together in one transaction, each with a condition, and an
expiry on each record. Message history, run ids and thread management are
planned next. Several developers will be writing data-access code in
parallel on whatever we choose now.

The Python API's PynamoDB code was a learning exercise and is being removed,
so it is not a precedent.

We compared the plain AWS SDK v3 document client with ElectroDB,
DynamoDB-Toolbox v2, Dynamoose and OneTable.

## Decision

We will use DynamoDB, accessed through ElectroDB.

Data access will live in repository modules, one per kind of record, that
expose operations named for what they do, such as resolving a thread.
Callers never see key formats, DynamoDB expressions or ElectroDB types.

Each service gets one table, with string keys `pk` and `sk` whose values
ElectroDB builds from each record's attributes. All of a service's record
types are defined in one ElectroDB Service and share that table.

## Status

**proposed**

## Consequences

- From Lambda, DynamoDB needs no VPC, no connection pool and has no idle
  cost, and transactions and TTL are built in. Other stores were not
  evaluated. The story assumed DynamoDB and nothing in what we store calls
  for a relational database.
- ElectroDB's Service and collections model fits the planned work: several
  record types in one table, and a single query that returns a thread with
  its messages, grouped by type and typed. Key formats, DynamoDB expressions
  and result types are defined once, in the schema, rather than written by
  hand in every repository.
- ElectroDB is one person's project. Version 3 has had five years of
  releases, and if it stopped being maintained only the repository modules
  would need changing, but we are knowingly accepting a single-maintainer
  risk.
- ElectroDB's LICENSE file says MIT and its package.json says ISC. Both are
  permissive; we will raise the mismatch upstream.
- The plain SDK was not chosen. For this story alone it is the smaller
  change, and what it sends to DynamoDB can be checked directly in unit
  tests, but it leaves every repository writing keys and expressions by
  hand. With the planned growth that could mean inconsistent code across
  repositories and a move to a library later anyway.
- DynamoDB-Toolbox v2 was the runner-up: MIT and two regular maintainers,
  but rewritten in March 2025 and so less used. If ElectroDB stops being
  maintained, it is the first alternative to evaluate.
- Dynamoose does not expose DynamoDB's cancellation reasons, which we need
  to tell a lost write race from a real failure. OneTable has had no
  release since February 2025.
