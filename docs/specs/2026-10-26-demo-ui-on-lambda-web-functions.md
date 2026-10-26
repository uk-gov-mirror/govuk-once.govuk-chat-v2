# Run demo-ui on Lambda web functions

**Date:** 2026-10-26

**Status:** accepted

## Problem

`services/demo-ui` is a Next.js app that runs on ECS Express Mode
(`ecs.CfnExpressGatewayService`) in a per-stack VPC. Setting up ECS is a heavy
task and slow to deploy: the stack carries a VPC, a Docker image build and an
ECS service that exist only to host one small app. We want something simpler.

AWS has recently released [Lambda web functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html):
a Lambda function type that runs an ordinary Node.js HTTP server behind a
managed HTTPS endpoint, scales to zero and serves many concurrent requests per
execution environment. It looks like the best fit for us:

- ECS is a heavy set-up and, while serverless, isn't the same abstraction as
  Lambda.
- The Lambda Web Adapter is also too heavy. Web functions are a lighter
  abstraction.
- Amplify Hosting previously wasn't up to date for our Next.js version, and
  needs a different deploy model from the rest of our app.

We want to know whether demo-ui can move to web functions, and what changes if
it does. The repo favours AWS serverless (see AGENTS.md).

This spec is also a compatibility review of the ECS configuration, so the
differences are agreed before any code is written.

## Goals

- demo-ui is served from a Lambda web function instead of ECS Express.
- Sign-in with Cognito, the SSE chat stream and the machine-to-machine call to
  the Chat API behave as they do today.
- The ECS service, its Docker image and the per-stack VPC are removed from the
  CDK app.

## Non-goals

- Changing what demo-ui does or its UI.
- A custom domain or WAF. Neither exists today.
- Moving to the platform shared VPC (tracked separately; see the comment in
  `demo-ui-stack.ts`).
- Multi-Region endpoints.
- Adopting web functions for any other service.
- Writing our own L2 construct for web functions (see
  [Alternatives considered](#alternatives-considered)).

## Findings

### Availability and CDK support

The details below come from the AWS documentation and GitHub, and were checked
on 2026-10-26. Items marked **unverified** need confirming before
implementation.

- The CloudFormation resources are `AWS::Lambda::WebFunction`,
  `AWS::Lambda::WebFunctionRevision`, `AWS::Lambda::WebFunctionEndpoint` and
  (for VPC egress) `AWS::Lambda::NetworkConnector`.
- The L1 classes `CfnWebFunction`, `CfnWebFunctionRevision` and
  `CfnWebFunctionEndpoint` are in **stable `aws-cdk-lib` from 2.273.0**. We are
  on 2.272.0, which doesn't have them, so the dependency needs a minor bump. No
  alpha package is needed: `@aws-cdk/aws-lambda-web-function-alpha` does not
  exist on npm.
- There is **no L2**. [aws-cdk#39210](https://github.com/aws/aws-cdk/pull/39210)
  proposes one but is unmerged, so we use L1 constructs for now.
- Whether the feature is available in `eu-west-1`, our default region, is
  **unverified**.

### Compatibility of the current ECS configuration

| Current (ECS Express)                                       | On web functions                                                                                                                                                                                                                                                            | Impact       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Docker image (`DockerImageAsset`, `Dockerfile`)             | Zip from S3 only, Node.js 24 runtime only, 512 MB unzipped. Container images are not documented (**unverified**).                                                                                                                                                           | Breaking     |
| `CMD node server.js`, `PORT=3000`                           | Lambda sets `AWS_LAMBDA_HTTP_ENDPOINT` (`host:port`) and loads `index.js` from the zip root (or `AWS_LAMBDA_NODEJS_ENTRYPOINT`). The server must be listening within 10 s. Next.js standalone reads `PORT` and `HOSTNAME`, so a small entry shim must map one to the other. | Change       |
| `healthCheckPath: /api/health`                              | No health check. Lambda only checks that the port is listening. A revision is `Active` even if the app is broken.                                                                                                                                                           | Incompatible |
| 0.5 vCPU / 1 GB, min = max = 1 task                         | Fixed 2 vCPU / 2 GB per environment, scales from zero, no minimum. `MaxEnvironments` caps scaling. Default V8 heap is 1 GB.                                                                                                                                                 | Change       |
| ALB with AWS-managed `*.ecs.<region>.on.aws` endpoint + TLS | Public `*.lambda-web.<region>.on.aws` endpoint. No custom domain or WAF on the endpoint itself. CloudFront is the intended front door.                                                                                                                                      | Change       |
| ALB sets `Host` and `X-Forwarded-Proto`                     | CloudFront must **not** forward `Host` (the origin returns 404). The app sees the Lambda domain as `Host`.                                                                                                                                                                  | **Breaking** |
| Secrets injected by ECS (`SESSION_SECRET`)                  | Revision environment variables only. A CloudFormation dynamic reference would resolve the secret into the template and the Lambda console.                                                                                                                                  | Change       |
| Task role / execution role                                  | Single `ExecutionRoleArn` on the revision. Trust principal **unverified**.                                                                                                                                                                                                  | Change       |
| Public subnets, no NAT, per-stack VPC                       | Outbound is public IPv4 by default. demo-ui only calls Cognito and API Gateway, both public, so the VPC and `NetworkConnector` are not needed.                                                                                                                              | Simplifies   |
| Long-lived ALB connections for SSE                          | HTTP/1.1 response streaming works with no configuration. 900 s maximum request duration. No WebSockets (demo-ui doesn't use them). CloudFront's origin response timeout applies in front (**unverified** for this origin type).                                             | Check        |
| One long-lived process                                      | Environments appear and disappear. `SIGTERM` gives 1 s. Module-level caches (Cognito OIDC discovery, M2M token) are per environment.                                                                                                                                        | Change       |
| CloudWatch logs to `/ecs/express/<prefix>-demo-ui`          | `TelemetryConfig.LoggingConfig` on the revision. Log group naming **unverified**.                                                                                                                                                                                           | Change       |
| Rolling deployment managed by ECS                           | Immutable revisions. The endpoint routes by `RevisionWeights` (up to two revisions).                                                                                                                                                                                        | Change       |

### Cognito

Cognito is the part of the design with the most moving pieces.

- **Redirect URI.** `appOrigin()` in `src/auth/urls.ts` builds the origin from
  the `Host` header and `X-Forwarded-Proto`, relying on the ALB passing `Host`
  through. With CloudFront in front of a web function, `Host` is the Lambda
  domain, so the OAuth `redirect_uri`, the callback's origin check and the
  post-sign-in redirect would all point at the wrong host and Cognito would
  reject the request. The app needs another source for its public origin
  (R5).
- **Callback URLs.** The sign-in client's callback and logout URLs are
  `https://<public host>/…`. Today they come from the ECS endpoint via an
  `AwsCustomResource` calling `updateUserPoolClient`, which exists to break the
  dependency cycle between the endpoint and the client ID. The same cycle exists
  here (function environment → client ID → callback URL → CloudFront domain →
  function), so the custom resource stays, pointing at the CloudFront domain.
- **Client secret and M2M token.** `DescribeUserPoolClient` is called at runtime
  to read the client secret, then the client-credentials token is cached for the
  life of the process. On Lambda that cache is per execution environment, so
  scale-out and cold starts cause more token requests. That is acceptable for a
  demo app, but worth knowing. The IAM permission moves to the execution role.
- **Sessions.** The session and sign-in-flow state live in iron-session
  encrypted cookies, so nothing depends on a particular instance or sticky
  sessions. `SESSION_SECRET` is unchanged, but delivering it differs (R6).
- **Local development.** `http://localhost:3000` is still registered as a
  callback in ephemeral environments only.

## Requirements

1. **R1:** `aws-cdk-lib` is upgraded to a version that includes
   `CfnWebFunction`, `CfnWebFunctionRevision` and `CfnWebFunctionEndpoint`
   (2.273.0 or later). `aws-cdk` (the CLI) stays compatible. No alpha package
   is added.
2. **R2:** `DemoUiStack` deploys demo-ui as a Lambda web function on the
   `nodejs24.x` runtime from a zip of the Next.js standalone build. The Docker
   image asset, the ECS Express service, its roles and the per-stack VPC are
   removed.
3. **R3:** Requests reach the web function only through CloudFront. The
   endpoint uses `IamAuth`, and CloudFront signs requests with an origin access
   control. A direct, unsigned request to the endpoint is rejected.
4. **R4:** The SSE response from `POST /api/chat` streams to the browser
   through CloudFront and is not buffered.
5. **R5:** The app derives its public origin from something other than the
   `Host` header, so the redirect URI, the callback origin check and the
   post-sign-in redirect all use the CloudFront domain.
6. **R6:** `SESSION_SECRET` is not stored in plain text in the CloudFormation
   template or the revision's environment variables.
7. **R7:** The sign-in client's callback and logout URLs are set from the
   CloudFront domain, and `http://localhost:3000` is still registered only in
   ephemeral environments.
8. **R8:** The execution role grants only `cognito-idp:DescribeUserPoolClient`
   on the user pool, read access to the session secret, and log delivery.
9. **R9:** Replacing a revision does not fail the deployment while the
   endpoint still routes to the old one.
10. **R10:** The stack outputs the public CloudFront URL and the sign-in client
    ID, as it does today.
11. **R11:** A deployment is followed by an automated check that `/api/health`
    responds through CloudFront, because Lambda gives no health signal.
12. **R12:** The package's README, scripts and CI workflow describe the new
    build and deployment. Docker-only files and the commented-out Docker CI
    job are removed.

## Design

### Packaging

`next build` already produces `.next/standalone`. Because of
`outputFileTracingRoot`, the standalone server sits at
`services/demo-ui/server.js` inside that output. The zip contains the
standalone output, `.next/static` and a root `index.js` shim that:

1. sets `HOSTNAME` and `PORT` from `AWS_LAMBDA_HTTP_ENDPOINT`,
2. loads `SESSION_SECRET` (see below), then
3. requires the standalone `server.js`.

The shim is the only new application code. The build stays "no emitted
JavaScript committed" as AGENTS.md requires: `next build` output is produced at
deploy time and not committed, in line with the existing allowance for bundling
at deploy time.

The revision takes its code from S3 (`BuildConfig.CodeConfig.S3Object`), so the
zip is uploaded as an `aws-s3-assets` `Asset`. The pnpm workspace layout, and
whether the build runs inside CDK or as a step before `cdk deploy`, are open
questions.

### Resources (all L1)

- `CfnWebFunction`, with `CfnWebFunctionRevision` (runtime `nodejs24.x`,
  execution role, environment variables, a per-request timeout long enough for
  chat streaming, logging config) and `CfnWebFunctionEndpoint`
  (`HomeRegion`, `IamAuth`, a `MaxEnvironments` cap and a `RateLimit` to bound
  cost and abuse).
- A CloudFront distribution with a `lambda` origin access control, the
  endpoint's domain as the origin, `AllViewerExceptHostHeader`, caching
  disabled for everything except `/_next/static/*`, and the
  `lambda:InvokeWebFunctionEndpoint` resource policy for
  `cloudfront.amazonaws.com`, scoped to the distribution ARN. There is no L2
  `WebFunctionEndpointOrigin` yet
  ([aws-cdk#39434](https://github.com/aws/aws-cdk/issues/39434)), so the origin
  is wired by hand.
- The revision's `DeletionPolicy` and `UpdateReplacePolicy` are `Retain`,
  because replacing a revision an endpoint still routes to otherwise fails
  with a 409 (reported in aws-cdk#39234, not AWS documentation).
- The existing `AwsCustomResource` for the sign-in client stays, pointing at the
  CloudFront domain.

### Public origin (R5)

Two ways to give the app its origin:

1. A `PUBLIC_ORIGIN` environment variable set from the CloudFront domain. This
   is simple, but puts the distribution into the function's environment, which
   creates a cycle: distribution → function → distribution. The existing
   custom-resource approach would have to be extended to the function.
2. A CloudFront Function that copies the viewer `Host` into an
   `X-Forwarded-Host` header, which `appOrigin()` then reads. There is no
   cycle, and local development and `next dev` keep working through the
   `Host` fallback.

Option 2 is preferred, pending the open question on trusting that header.

### Secret (R6)

The shim fetches `SESSION_SECRET` from Secrets Manager before loading the
server and sets `process.env.SESSION_SECRET`. That has to fit inside the 10 s
startup window, and adds an `@aws-sdk/client-secrets-manager` dependency.

### Security

- Auth: `IamAuth` with an OAC means the Lambda endpoint can't be reached
  directly. `ApplicationManaged` would bypass CloudFront, so it isn't used.
- The execution role is least-privilege (R8).
- Lambda strips an AWS-signature `Authorization` header and passes through
  application ones, so the app's bearer-token calls are unaffected. The
  CloudFront → Lambda hop only affects inbound requests.
- Requests share a Node process, so the app mustn't keep per-request global
  state. Today's code only caches OIDC discovery and the M2M token, both
  shared by design.
- Accessibility and privacy are unchanged: no UI or data changes.

## Alternatives considered

- **Stay on ECS Express.** Works today and has a health check, a Docker
  workflow and no L1 pitfalls. Rejected for this spec because setting up ECS
  is heavy and slow, and we want something simpler. It remains the fallback if a blocking
  incompatibility turns up (see Open questions).
- **Lambda with the Lambda Web Adapter** (as used by the removed
  `chat-api-fastapi` service). Rejected as too heavy: it adds an adapter layer
  on top of the event-function model, which web functions remove.
- **Wait for the L2 construct** (aws-cdk#39210). Avoids hand-writing L1
  plumbing, but there is no merge date and the work is otherwise unblocked.
- **Amplify Hosting.** Rejected: it previously wasn't up to date for our
  Next.js version (not re-checked for this spec), and it needs a different
  deploy model from the rest of our app.
- **A CloudFront + S3 static export.** Demo-ui needs server routes (auth, SSE
  proxy), so a static export doesn't work.

## Implementation plan

1. Bump `aws-cdk-lib` to 2.273.0 or later and regenerate `pnpm-lock.yaml`;
   confirm `cdk` checks pass (R1).
2. Add the entry shim in `services/demo-ui` (port mapping, secret loading),
   with unit tests, and change `appOrigin()` to prefer `X-Forwarded-Host` (R5,
   R6).
3. Add a build step that produces the deployable zip from the standalone
   output (R2).
4. Replace the ECS Express service, roles, Docker asset and VPC in
   `DemoUiStack` with the web function, endpoint, CloudFront distribution and
   OAC, and update the sign-in client's callback wiring and outputs; update
   `demo-ui-stack.test.ts` (R2, R3, R7, R8, R9, R10).
5. Add the post-deploy `/api/health` check to the deploy script (R11).
6. Remove the Dockerfile, `.dockerignore` entries and the commented-out Docker
   CI job; update the README and CI path filters (R12).

### Testing

- **Unit (vitest, CDK):** assert presence of the web function, revision with
  `Retain` policies, endpoint with `IamAuth`, CloudFront distribution with the
  OAC, the invoke permission, the execution role's policy, the callback URLs
  (localhost only when ephemeral) and the outputs. Assert the ECS service and
  VPC are gone (R2, R3, R7, R8, R9, R10).
- **Unit (app):** `appOrigin()` with and without `X-Forwarded-Host`; the shim
  maps `AWS_LAMBDA_HTTP_ENDPOINT` to `HOSTNAME`/`PORT` and fails clearly if the
  secret can't be loaded (R5, R6).
- **Manual, against real AWS** (tagged separately, per AGENTS.md): sign in end
  to end, send a chat message that streams for longer than CloudFront's default
  origin timeout, hit the Lambda endpoint directly and confirm it is rejected,
  and cold-start after idle (R3, R4, R5, R11).

### Rollout

The stack name is unchanged, so a deploy replaces the ECS resources in place.
The public URL changes, from `*.ecs.<region>.on.aws` to a CloudFront domain, so
the Cognito callback URLs change in the same deployment and any bookmarked or
shared URLs stop working. The old `/ecs/express/<prefix>-demo-ui` log group is
retained in stag/prod, as in the
[rename spec](./2026-10-20-rename-chat-ui-to-demo-ui.md), and developers can
delete it. Superseded retained revisions accumulate; they are tiny but need an
occasional cleanup.

## Risks

- **L1 only, new service.** Documentation and behaviour may still shift. We
  pin `aws-cdk-lib` and expect a follow-up to adopt the L2 when it ships.
- **CloudFront origin timeout** could cut off long chat streams (R4). Mitigate
  by testing early; the quota can be raised.
- **No health signal** means a broken revision looks healthy. Mitigate with
  R11.
- **Bootstrap S3 permissions.** The CDK bootstrap template may not let the
  Lambda service read the assets bucket (reported in aws-cdk#39234,
  **unverified** for our account). If so, we need a dedicated versioned
  bucket.
- **Cost is not established.** AWS bills memory for an environment's whole
  lifetime including idle time. Cost isn't the motivation for this work, but no
  comparison with the current task has been done.
- **Fixed 2 GB / 2 vCPU** is more than today's task; fine for cost at this
  scale, but not tunable.

## Open questions

1. Is the feature available in `eu-west-1`? If not, is it acceptable to host
   in another region, or do we wait? (Verify against the AWS docs and a test
   deploy.)
2. Does this change warrant an ADR? Moving hosting from ECS to Lambda web
   functions is an architectural decision, but it is the team's call, so none
   has been drafted.
3. Is it acceptable for `appOrigin()` to trust `X-Forwarded-Host`? It is safe
   only because the endpoint is reachable solely through CloudFront (R3), and
   a CloudFront Function would overwrite any client-supplied value.
4. Can the revision's code come from the CDK bootstrap bucket, or do we need
   our own versioned bucket?
5. Where does `next build` run: inside CDK (bundling) or as a script before
   `cdk deploy`, given the pnpm workspace layout?
6. What is the execution role's trust principal, and how is the log group
   named and retained for a web function's `LoggingConfig`?
7. Is a CloudFront origin timeout above the 30 s default needed for realistic
   chat responses, and does a web function origin accept it?
8. What is the endpoint's auto-deployment behaviour versus `RevisionWeights`;
   do we want canary weighting for a demo app, or always the latest revision?
9. Is the setup really simpler once the added moving parts (CloudFront,
   shim, L1 plumbing) are counted, compared with staying on ECS Express?
