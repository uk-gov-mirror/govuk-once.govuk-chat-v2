# Run demo-ui on Lambda web functions

**Date:** 2026-10-26

**Status:** accepted

**2-minute read. You're asked to decide 2 things.** The
[build sheet](#build-sheet) is for whoever implements it; you don't need it
to review.

## Briefing

### Problem

`services/demo-ui` is a small Next.js app on ECS Express Mode. Hosting it
needs a VPC, a Docker image build and an ECS service, which is heavy and slow
to deploy for one app.
[Lambda web functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html)
run an ordinary Node.js HTTP server behind a managed HTTPS endpoint and scale
to zero, so we'll host demo-ui on one instead.

### Before and after

- **Today:** an ECS Express service runs a Docker image in a VPC, health-
  checked on `/api/health`, at a URL on `*.ecs.<region>.on.aws`.
- **After:** a Lambda web function runs a zip of the Next.js build, with no
  VPC or health check, at a URL on the web function's domain.

### What you'll experience

You deploy demo-ui and open the URL from the stack output, as now. It's a new
URL, so old bookmarks stop working. You sign in through Cognito as you do
today, and chat replies stream to the browser. If nobody has used it for a
while, it still loads. If you deploy a build that can't start, the deploy
still succeeds and you find out when you open the app.

### Decide

#### 1. Should the endpoint be public, with Cognito as its only protection?

**Recommended: yes.** That's how the ECS endpoint works today. The `Host`
header reaches the app unchanged, so the OAuth redirect logic doesn't change.

- **Alternative:** CloudFront in front, with an IAM-signed origin. It adds a
  distribution, an origin access control, `Host` rewriting and a way to keep
  Cognito's redirects working, for no benefit while we have no custom domain
  or WAF. We'd revisit it if we need either.

#### 2. How should `SESSION_SECRET` reach the function?

**Recommended: fetch it from Secrets Manager at start-up.** ECS injects it
into the container today, and web functions have no equivalent, so the app
needs code to fetch it.

- **Alternative:** an environment variable. Simpler, but revision environment
  variables are plain text.

### Know

- **Web functions over the alternatives:** ECS Express is the set-up we're
  leaving but stays the fallback, Lambda Web Adapter has more moving parts,
  and Amplify Hosting has a different deploy model from the rest of our app.
- **No health check:** a broken build deploys and only fails on requests,
  which the manual check covers for a demo app.
- **No VPC:** calls to Cognito and API Gateway are public.
- **Docker goes:** the Dockerfile, root `.dockerignore`, Docker CI job and
  `/api/health` are removed.
- **Two construct defaults are overridden:** a 30-second timeout, too short
  for a streamed reply, and a log group retained on stack deletion, which
  would stop ephemeral environments tearing down cleanly.

### Precedent

The existing custom resource sets the sign-in client's callback URLs
(localhost only in ephemeral environments), the stack outputs stay the same,
and sessions stay in encrypted cookies.

### Risks

- **The service and its CDK construct are new**, the construct only weeks
  old, so behaviour may still shift.
- **Streaming is untested** with our app on web functions.

### Open questions

- Is web functions available in `eu-west-1`?
- Are our accounts bootstrapped with a customer managed KMS key? If so, CDK
  can't stage the code for us, and we'd upload it ourselves.
- Where does `next build` run: inside CDK, or as a script beforehand?
- Does this warrant an ADR? That's the team's call.

## Build sheet

### Files

```
.dockerignore                         # remove
.github/workflows/demo-ui-ci.yaml     # remove Docker job and .dockerignore paths
cdk/package.json                      # aws-cdk-lib >= 2.276.0
cdk/src/stacks/demo-ui-stack.ts       # WebFunction replaces VPC, Docker asset, ECS service
cdk/src/stacks/demo-ui-stack.test.ts
services/demo-ui/
  Dockerfile                          # remove
  README.md
  index.js                            # add: HOSTNAME, PORT from AWS_LAMBDA_HTTP_ENDPOINT; start standalone server
  scripts/                            # add: build zip of .next/standalone, .next/static, index.js
  src/app/api/health/                 # remove
```

### `WebFunction`

- `runtime`: `WebFunctionRuntime.NODEJS_24_X`
- `code`: `WebFunctionCode.fromAssetToManagedBucket(<package dir>)`
- `defaultEndpointAuth`: `WebFunctionAuthType.APPLICATION_MANAGED`
- `timeout`: enough for a streamed reply; default 30s, maximum 900s
- `logGroup`: the stack's own; `DESTROY` when ephemeral, `RETAIN` otherwise
- `environment`: `ENVIRONMENT`, `CHAT_API_URL`, `COGNITO_TOKEN_ENDPOINT`,
  `COGNITO_USER_POOL_ID`, `COGNITO_APP_CLIENT_ID`,
  `COGNITO_SIGN_IN_CLIENT_ID`; `SESSION_SECRET` per decision 2
- Role: `cognito-idp:DescribeUserPoolClient` on the user pool

### Stack wiring

- `SignInClientSettings` origins: `https://<endpoint.domainName>`, plus
  `http://localhost:3000` when ephemeral
- Outputs: `EndpointUrl` from `endpoint.domainName`; `SignInClientId`
  unchanged

### Edge cases

- If the app fails to start, the deploy still succeeds.
- If the bootstrap bucket uses a customer managed KMS key, staging fails with
  `AccessDenied` on `CopyObject`; use `fromBucket()`.
- If the `WebFunction` construct id changes, the endpoint gets a new URL.

### Checks

- CDK tests: web function and endpoint exist; localhost callbacks only when
  ephemeral; both outputs exist.
- Unit test for the entry shim.
- Manual, against real AWS: sign in, stream a reply, open after idle.
- Set **implemented** in the implementation pull request.
