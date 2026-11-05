# Run demo-ui on Lambda web functions

**Date:** 2026-10-26

**Status:** accepted

## Problem

`services/demo-ui` is a small Next.js app that runs on ECS Express Mode. To
host it, the stack carries a VPC, a Docker image build and an ECS service, which
is heavy and slow to deploy for one app.

AWS has released [Lambda web functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html):
a Lambda that runs an ordinary Node.js HTTP server behind a managed HTTPS
endpoint and scales to zero. It is lighter than ECS, and lighter than the
Lambda Web Adapter, which adds a layer that web functions remove. Amplify
Hosting needs a different deploy model from the rest of our app.

## Goals

- demo-ui runs on a Lambda web function, reachable over HTTPS, with sign-in
  through Cognito working as it does today.
- The ECS service, Docker image and VPC are removed from the CDK app.

## Non-goals

- Changing what demo-ui does, or reproducing ECS-specific set-up (health
  checks, container settings, rolling deploys) on Lambda.
- A custom domain, WAF or CloudFront. None exist today.
- Writing our own L2 construct for web functions.

## Requirements

1. **R1:** `aws-cdk-lib` is upgraded to a version that includes the web
   function L1 constructs (2.273.0 or later; we are on 2.272.0).
2. **R2:** `DemoUiStack` serves demo-ui from a `nodejs24.x` web function built
   from the Next.js standalone output. The ECS service, Docker image asset and
   VPC are removed.
3. **R3:** A user can sign in with Cognito and reach the app. The sign-in
   client's callback and logout URLs are set from the web function's endpoint
   URL, with `http://localhost:3000` registered only in ephemeral environments.
4. **R4:** The chat response streams to the browser.
5. **R5:** The stack outputs the app URL and the sign-in client ID, as it does
   today.
6. **R6:** The README, scripts and CI workflow describe the new build and
   deploy. Docker-only files are removed.

## Design

### What changes

| Today (ECS Express)       | With a web function                                        |
| ------------------------- | ---------------------------------------------------------- |
| Docker image              | Zip of the Next.js standalone build, uploaded to S3        |
| ECS service behind an ALB | `CfnWebFunction` + revision + endpoint (L1)                |
| Per-stack VPC             | None; outbound calls to Cognito and API Gateway are public |
| ECS task role             | Revision execution role                                    |

There is no L2 construct yet ([aws-cdk#39210](https://github.com/aws/aws-cdk/pull/39210)),
so the stack uses the L1 classes `CfnWebFunction`, `CfnWebFunctionRevision` and
`CfnWebFunctionEndpoint`.

### Packaging

`next build` already produces `.next/standalone`. The zip holds that output,
`.next/static` and a small `index.js` at the root that points Next's `HOSTNAME`
and `PORT` at the address Lambda provides (`AWS_LAMBDA_HTTP_ENDPOINT`) and then
starts the standalone server. Nothing built is committed.

### Cognito

The endpoint is a public HTTPS URL and Cognito is what protects the app, as
with the ECS endpoint today. The endpoint therefore uses no AWS-level auth
(`ApplicationManaged`), and the `Host` header reaches the app unchanged, so
`appOrigin()` and the OAuth redirect logic need no change.

The sign-in client's callback URLs need the endpoint's URL, and the function
needs the client ID, which is a circular dependency. The stack already solves
this with an `AwsCustomResource` that calls `updateUserPoolClient` after the
endpoint exists; it stays, pointing at the new endpoint URL.

Session state lives in encrypted cookies, so it doesn't depend on which Lambda
environment serves a request.

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

1. Bump `aws-cdk-lib` (R1).
2. Add the `index.js` entry shim in `services/demo-ui`, with a unit test (R2).
3. Add a script that builds the zip from the standalone output (R2, R6).
4. Replace the ECS service, Docker asset and VPC in `DemoUiStack` with the web
   function, revision and endpoint; point the sign-in client callbacks and
   outputs at the endpoint; update `demo-ui-stack.test.ts` (R2, R3, R5).
5. Remove the Dockerfile and Docker CI job; update the README and CI (R6).

### Testing

- CDK unit tests assert the web function, revision and endpoint exist, the
  callback URLs include localhost only when ephemeral, the outputs exist, and
  the ECS service is gone.
- Manual check against real AWS: sign in, send a chat message and watch it
  stream, and open the app after it has been idle (R3, R4).

### Rollout

The public URL changes (from `*.ecs.<region>.on.aws` to the web function's
domain), and the Cognito callback URLs change in the same deployment. Existing
bookmarks stop working.

## Risks

- **New, L1-only service.** Behaviour and documentation may still shift.
- **No health check.** Lambda only confirms the server is listening, so a broken
  build can look healthy; the manual check covers this for a demo app.
- **Streaming limits.** Web functions allow responses up to 15 minutes, which
  is more than chat needs, but streaming is untested with our app (R4).

## Open questions

1. Is web functions available in `eu-west-1`?
2. Can the revision's code come from the CDK bootstrap bucket? A reported
   permissions problem ([aws-cdk#39234](https://github.com/aws/aws-cdk/issues/39234))
   may mean we need our own bucket.
3. How should `SESSION_SECRET` reach the function? Revision environment
   variables are plain text; the secret is better fetched at start-up.
4. Where does `next build` run: inside CDK, or as a script before `cdk deploy`?
5. Does this warrant an ADR? That is the team's call.
