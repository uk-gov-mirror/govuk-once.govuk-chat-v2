#!/usr/bin/env bash
set -e

# Fetches a JWT from a Cognito token endpoint using the client credentials
# flow, then curls the given URL with the token as a Bearer header.
# The client secret is fetched from Cognito automatically.
#
# Usage:
# $ APP_CLIENT_ID=xxx USER_POOL_ID=yyy TOKEN_ENDPOINT=zzz ./api-curl.sh https://12345.execute-api.eu-west-1.amazonaws.com
# $ APP_CLIENT_ID=xxx USER_POOL_ID=yyy TOKEN_ENDPOINT=zzz ./api-curl.sh -X POST -d '{"message":"hi"}' https://12345.execute-api.eu-west-1.amazonaws.com

if [ -z "$APP_CLIENT_ID" ] || [ -z "$USER_POOL_ID" ] || [ -z "$TOKEN_ENDPOINT" ]; then
  echo "Required env vars: APP_CLIENT_ID, USER_POOL_ID, TOKEN_ENDPOINT" >&2
  exit 1
fi

echo "1"
APP_CLIENT_SECRET=$(aws cognito-idp describe-user-pool-client \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$APP_CLIENT_ID" \
  --query "UserPoolClient.ClientSecret" \
  --output text)

if [ -z "$APP_CLIENT_SECRET" ] || [ "$APP_CLIENT_SECRET" = "None" ]; then
  echo "Failed to fetch client secret for APP_CLIENT_ID=$APP_CLIENT_ID" >&2
  exit 1
fi
echo "2"

TOKEN=$(curl --silent --fail \
  --request POST "$TOKEN_ENDPOINT" \
  --header "Content-Type: application/x-www-form-urlencoded" \
  --user "${APP_CLIENT_ID}:${APP_CLIENT_SECRET}" \
  --data "grant_type=client_credentials&scope=chat-api/invoke" \
  | jq -r '.access_token')

echo "3"
if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "Failed to fetch access token from $TOKEN_ENDPOINT" >&2
  exit 1
fi

curl --header "Authorization: Bearer ${TOKEN}" "$@"
