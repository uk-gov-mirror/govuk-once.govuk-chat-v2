# Chat API TypeScript

TypeScript Lambda serverless HTTP API. Exploring whether this is a better API
option than Python Lambda Web Adapter

## Usage

To deploy:

```
./scripts/cdk-deploy.sh
```

To invoke:

```
GATEWAY_URL=$(scripts/fetch-cdk-output.sh ChatApiTsStack GatewayUrl)
export TOKEN_ENDPOINT=$(scripts/fetch-cdk-output.sh ChatApiTsStack TokenEndpoint)
export USER_POOL_ID=$(scripts/fetch-cdk-output.sh ChatApiTsStack UserPoolId)
export APP_CLIENT_ID=$(scripts/fetch-cdk-output.sh ChatApiTsStack AppClientId)

./scripts/api-curl.sh -X POST "${GATEWAY_URL%/}/v1/threads/invoke" \
  -H "Content-Type: application/json" \
  -H "end-user-id: $(uuidgen)" \
  -d '{
    "threadId": "'"$(uuidgen)"'",
    "runId": "'"$(uuidgen)"'",
    "messages": [
      { "id": "'"$(uuidgen)"'", "role": "user", "content": "Tell me about Statutory Sick Pay" }
    ]
  }'
```

## Threads

A thread belongs to the end user in the `end-user-id` header. It is
identified by that header and the client's `threadId` together, so two end
users sending the same `threadId` get separate threads. The API generates
its own id for each thread and uses it as the agent runtime session. Run
events such as `RUN_STARTED` carry that id, not the client's. Threads expire
a year after their last message.
