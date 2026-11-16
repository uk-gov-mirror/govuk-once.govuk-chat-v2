# Run demo-ui on Lambda web functions

**Date:** 2026-10-26

**Status:** accepted

## Problem

`services/demo-ui` is a small Next.js app that runs on ECS Express Mode. To
host it, the stack carries a VPC, a Docker image build and an ECS service, which
is heavy and slow to deploy for one app.

AWS has released [Lambda web functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html):
a Lambda that runs an ordinary Node.js HTTP server behind a managed HTTPS
endpoint and scales to zero.

## Goals

- demo-ui runs on a Lambda web function, reachable over HTTPS, with sign-in
  through Cognito working as it does today.
- The ECS service, Docker image and VPC are removed from the CDK app.

## Non-goals

- Changing what demo-ui does, or reproducing ECS-specific set-up (health
  checks, container settings, rolling deploys) on Lambda.
- A custom domain, WAF or CloudFront. None exist today.

## Requirements

1. **R1:** `aws-cdk-lib` is upgraded to a version that includes the
   `WebFunction` L2 construct (2.276.0 or later; we are on 2.274.0).
2. **R2:** `DemoUiStack` serves demo-ui from a `nodejs24.x` web function built
   from the Next.js standalone output.
3. **R3:** A user can sign in with Cognito and reach the app.
4. **R4:** The chat response streams to the browser.
5. **R5:** The stack outputs the app URL and the sign-in client ID, as it does
   today.
6. **R6:** The README, scripts and CI workflow describe the new build and
   deploy. The Dockerfile, the root `.dockerignore` and the `/api/health`
   route, which exists only for the ECS health check, are removed.

## Design

### Web function

`DemoUiStack` hosts the app on a `lambda.WebFunction`
([aws-cdk#39210](https://github.com/aws/aws-cdk/pull/39210)) alongside the
existing Cognito resources. Its outbound calls to Cognito and API Gateway are
public, so it needs no VPC.

Two of the construct's defaults don't suit us and are set explicitly:

- **Timeout** defaults to 30 seconds. It is set high enough for a streamed
  chat response (R4); web functions allow up to 15 minutes.
- **Log group** defaults to one retained on stack deletion. The stack passes
  its own, destroyed in ephemeral environments, so they tear down cleanly.

### Packaging

`next build` already produces `.next/standalone`. The package directory holds
that output, `.next/static` and a small `index.js` at the root that points
Next's `HOSTNAME` and `PORT` at the address Lambda provides
(`AWS_LAMBDA_HTTP_ENDPOINT`) and then starts the standalone server. Nothing
built is committed. The directory is passed as
`WebFunctionCode.fromAssetToManagedBucket()`.

### Cognito

The endpoint is a public HTTPS URL and Cognito is what protects the app, as
with the ECS endpoint today. The endpoint therefore uses no AWS-level auth
(`ApplicationManaged`), and the `Host` header reaches the app unchanged, so
`appOrigin()` and the OAuth redirect logic need no change.

The sign-in client's callback URLs need the endpoint's URL, and the function
needs the client ID, which is a circular dependency. The stack already solves
this with an `AwsCustomResource` that calls `updateUserPoolClient` after the
endpoint exists; it stays, pointing at the new endpoint URL.

### Behaviour

- **When** a user signs in through Cognito, **then** they are returned to
  the web function's endpoint and reach the app (R3).
- **When** the stack deploys to an ephemeral environment, **then** the
  sign-in client's callback and logout URLs include `http://localhost:3000`
  as well as the endpoint (R3).
- **When** it deploys to `stag` or `prod`, **then** they include only the
  endpoint (R3).
- **When** consecutive requests are served by different Lambda environments,
  **then** the session holds, because it lives in encrypted cookies.
- **When** a user sends a chat message, **then** the response streams to the
  browser (R4).
- **When** the app is opened after it has been idle, **then** it loads.
- **When** a build that fails to start is deployed, **then** the deploy
  succeeds and requests fail, as creating a revision doesn't check that the
  code starts.

## Alternatives considered

- **Stay on ECS Express.** Works today, but is the heavy set-up we want to
  leave. It remains the fallback if a blocker turns up.
- **Lambda Web Adapter.** More moving parts than web functions.
- **Put CloudFront in front** (IAM-signed origin, `Host` rewriting). Adds a
  distribution, an origin access control and a way to restore the public origin
  for Cognito, for no benefit while we have no custom domain or WAF. Revisit
  if we need either.
- **Amplify Hosting.** Different deploy model from the rest of our app.

## Implementation plan

One pull request. Each step names how it is checked.

1. Bump `aws-cdk-lib` (R1). Checked by the CDK dev checks passing.
2. Add the `index.js` entry shim in `services/demo-ui` (R2). Checked by a
   unit test.
3. Add a script that builds the zip from the standalone output (R2, R6).
4. Replace the ECS service, Docker asset and VPC in `DemoUiStack` with a
   `WebFunction`; point the sign-in client callbacks and outputs at the
   endpoint (R2, R3, R5). Checked by `demo-ui-stack.test.ts` asserting the
   web function and its endpoint exist, the callback URLs include localhost
   only when ephemeral, and the outputs exist.
5. Remove the Dockerfile, `.dockerignore`, `/api/health` route and Docker CI
   job; update the README and CI (R6). Checked manually against real AWS by
   running through the [behaviour](#behaviour) scenarios: sign in, send a chat
   message and watch it stream, and open the app after it has been idle.

### Rollout

The public URL changes (from `*.ecs.<region>.on.aws` to the web function's
domain), and the Cognito callback URLs change in the same deployment. Existing
bookmarks stop working.

## Risks

- **New service and construct.** Behaviour and documentation may still shift,
  and the L2 construct is only weeks old.
- **No health check.** A broken build deploys successfully and only fails
  once requests arrive. The manual check covers this for a demo app.
- **Streaming is untested** with our app on web functions (R4).

## Open questions

1. Is web functions available in `eu-west-1`?
2. Are our accounts bootstrapped with a customer managed KMS key? If so,
   `fromAssetToManagedBucket()` can't copy the staged asset, and we'd upload
   the zip to a bucket ourselves and use `WebFunctionCode.fromBucket()`.
3. How should `SESSION_SECRET` reach the function? Revision environment
   variables are plain text; the secret is better fetched at start-up.
4. Where does `next build` run: inside CDK, or as a script before `cdk deploy`?
5. Does this warrant an ADR? That is the team's call.
