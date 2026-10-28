import * as cdk from 'aws-cdk-lib';
import baseContext from '../../cdk.json' with { type: 'json' };
import { Tags, Template, Match } from 'aws-cdk-lib/assertions';
import { vi, describe, it, afterEach } from 'vitest';
import { ChatApiStack } from './chat-api-stack.ts';

const context = {
  ...baseContext,
  // prevent stacks from being bundled
  'aws:cdk:bundling-stacks': [],
};

describe('ChatApiStack', () => {
  const baseProps = {
    serviceName: 'chat-api',
    teamName: 'chat',
    repositoryUrl: 'https://example.com/repo',
    environment: 'testing',
    agentRuntimeArn:
      'arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/test',
  };

  function stackTemplate() {
    const app = new cdk.App({ context });
    const stack = new ChatApiStack(app, 'TestStack', baseProps);
    return Template.fromStack(stack);
  }

  function stackTags() {
    const app = new cdk.App({ context });
    const stack = new ChatApiStack(app, 'TestStack', baseProps);
    return Tags.fromStack(stack);
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('Stack tags', () => {
    it('sets common tags', () => {
      stackTags().hasValues({
        ServiceName: baseProps.serviceName,
        TeamName: baseProps.teamName,
        RepositoryUrl: baseProps.repositoryUrl,
        Environment: baseProps.environment,
      });
    });
  });

  describe('API lambda functions', () => {
    it('creates the agent-stream lambda with its environment and a lock lease matching its timeout', () => {
      const template = stackTemplate();

      const [tableId] = Object.keys(
        template.findResources('AWS::DynamoDB::Table'),
      );

      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: Match.stringLikeRegexp('chat-api-threads-invoke-ts'),
        Timeout: 30,
        Environment: {
          Variables: Match.objectLike({
            AGENT_RUNTIME_ARN: baseProps.agentRuntimeArn,
            POWERTOOLS_SERVICE_NAME: 'chat-api',
            CHAT_API_TABLE_NAME: { Ref: tableId },
            RUN_LOCK_LEASE_SECONDS: '30',
          }),
        },
      });
    });

    it('creates the messages lambda', () => {
      const template = stackTemplate();

      const [tableId] = Object.keys(
        template.findResources('AWS::DynamoDB::Table'),
      );

      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: Match.stringLikeRegexp('chat-api-threads-messages-ts'),
        Environment: {
          Variables: Match.objectLike({
            POWERTOOLS_SERVICE_NAME: 'chat-api',
            CHAT_API_TABLE_NAME: { Ref: tableId },
          }),
        },
      });
    });

    it('grants the messages lambda read-only access to the table', () => {
      const template = stackTemplate();

      const [tableId] = Object.keys(
        template.findResources('AWS::DynamoDB::Table'),
      );
      const functions = template.findResources('AWS::Lambda::Function', {
        Properties: {
          FunctionName: Match.stringLikeRegexp('chat-api-threads-messages-ts'),
        },
      });
      const roleId =
        Object.values(functions)[0].Properties.Role['Fn::GetAtt'][0];

      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['dynamodb:Query']),
              Effect: 'Allow',
              Resource: Match.arrayWith([{ 'Fn::GetAtt': [tableId, 'Arn'] }]),
            }),
          ]),
        },
        Roles: Match.arrayWith([Match.objectLike({ Ref: roleId })]),
      });
    });

    it('grants the agent-stream lambda access to the table', () => {
      const template = stackTemplate();

      const [tableId] = Object.keys(
        template.findResources('AWS::DynamoDB::Table'),
      );
      const functions = template.findResources('AWS::Lambda::Function', {
        Properties: {
          FunctionName: Match.stringLikeRegexp('chat-api-threads-invoke-ts'),
        },
      });
      const roleId =
        Object.values(functions)[0].Properties.Role['Fn::GetAtt'][0];

      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Resource: Match.arrayWith([{ 'Fn::GetAtt': [tableId, 'Arn'] }]),
            }),
          ]),
        },
        Roles: Match.arrayWith([Match.objectLike({ Ref: roleId })]),
      });
    });
  });

  describe('DynamoDB table', () => {
    it('creates the table with the keys, index and TTL attribute the repository expects', () => {
      const template = stackTemplate();

      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: Match.stringLikeRegexp('chat-api'),
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        GlobalSecondaryIndexes: [
          Match.objectLike({
            IndexName: 'gsi1',
            KeySchema: [
              { AttributeName: 'gsi1pk', KeyType: 'HASH' },
              { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          }),
        ],
      });
    });

    it('retains the table for non-ephemeral environments', () => {
      vi.stubEnv('ENVIRONMENT', 'prod');

      const productionTemplate = stackTemplate();

      productionTemplate.hasResource('AWS::DynamoDB::Table', {
        DeletionPolicy: 'Retain',
      });

      vi.unstubAllEnvs();
      const template = stackTemplate();

      template.hasResource('AWS::DynamoDB::Table', {
        DeletionPolicy: 'Delete',
      });
    });
  });

  describe('API Gateway', () => {
    it('creates a REST API', () => {
      const template = stackTemplate();

      template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    });

    it('exposes a /v1/threads/invoke resource path', () => {
      const template = stackTemplate();

      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: 'v1',
      });
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: 'threads',
      });
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: 'invoke',
      });
    });

    it('exposes a /v1/threads/{threadId}/messages resource path', () => {
      const template = stackTemplate();

      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: '{threadId}',
      });
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: 'messages',
      });
    });

    it('requires Cognito auth on POST requests', () => {
      const template = stackTemplate();

      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'POST',
        AuthorizationType: 'COGNITO_USER_POOLS',
        AuthorizationScopes: ['chat-api/invoke'],
      });
    });

    it('requires Cognito auth on GET requests', () => {
      const template = stackTemplate();

      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'GET',
        AuthorizationType: 'COGNITO_USER_POOLS',
        AuthorizationScopes: ['chat-api/invoke'],
      });
    });

    it('outputs the gateway URL', () => {
      const template = stackTemplate();

      template.hasOutput('GatewayUrl', {});
    });

    it('throttles the stage and answers with the API error body', () => {
      const template = stackTemplate();

      template.hasResourceProperties('AWS::ApiGateway::Stage', {
        MethodSettings: Match.arrayWith([
          Match.objectLike({
            HttpMethod: '*',
            ResourcePath: '/*',
            ThrottlingRateLimit: Match.anyValue(),
            ThrottlingBurstLimit: Match.anyValue(),
          }),
        ]),
      });
      template.hasResourceProperties('AWS::ApiGateway::GatewayResponse', {
        ResponseType: 'THROTTLED',
        ResponseTemplates: {
          'application/json': Match.stringLikeRegexp('"error"'),
        },
      });
    });
  });

  describe('WAF', () => {
    it('rate limits each end user on POST invoke requests with a 429', () => {
      const template = stackTemplate();

      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: [
          Match.objectLike({
            Statement: {
              RateBasedStatement: Match.objectLike({
                CustomKeys: [
                  { Header: Match.objectLike({ Name: 'end-user-id' }) },
                ],
                ScopeDownStatement: {
                  AndStatement: {
                    Statements: [
                      Match.objectLike({
                        ByteMatchStatement: Match.objectLike({
                          SearchString: 'POST',
                        }),
                      }),
                      Match.objectLike({
                        ByteMatchStatement: Match.objectLike({
                          SearchString: '/v1/threads/invoke',
                        }),
                      }),
                    ],
                  },
                },
              }),
            },
            Action: {
              Block: {
                CustomResponse: Match.objectLike({ ResponseCode: 429 }),
              },
            },
          }),
        ],
      });
    });

    it('associates the web ACL with the API stage', () => {
      const template = stackTemplate();

      const [stageId] = Object.keys(
        template.findResources('AWS::ApiGateway::Stage'),
      );

      template.hasResourceProperties('AWS::WAFv2::WebACLAssociation', {
        ResourceArn: Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([Match.objectLike({ Ref: stageId })]),
          ]),
        }),
      });
    });
  });

  describe('Cognito', () => {
    it('creates a User Pool', () => {
      const template = stackTemplate();

      template.hasResourceProperties('AWS::Cognito::UserPool', {
        UserPoolName: Match.stringLikeRegexp('chat-api-user-pool'),
      });
    });

    it('creates a Resource Server with an invoke scope', () => {
      const template = stackTemplate();

      template.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', {
        Identifier: 'chat-api',
        Scopes: Match.arrayWith([Match.objectLike({ ScopeName: 'invoke' })]),
      });
    });

    it('creates an App Client with client credentials flow', () => {
      const template = stackTemplate();

      template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        AllowedOAuthFlows: ['client_credentials'],
        GenerateSecret: true,
      });
    });

    it('outputs the User Pool ID and App Client ID', () => {
      const template = stackTemplate();

      template.hasOutput('UserPoolId', {});
      template.hasOutput('AppClientId', {});
      template.hasOutput('TokenEndpoint', {});
    });
  });
});
