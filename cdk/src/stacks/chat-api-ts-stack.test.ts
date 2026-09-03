import * as cdk from 'aws-cdk-lib';
import baseContext from '../../cdk.json' with { type: 'json' };
import { Tags, Template, Match } from 'aws-cdk-lib/assertions';
import { vi, describe, it, afterEach } from 'vitest';
import { ChatApiTsStack } from './chat-api-ts-stack.ts';

const context = {
  ...baseContext,
  // prevent stacks from being bundled
  'aws:cdk:bundling-stacks': [],
};

describe('ChatApiTsStack', () => {
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
    const stack = new ChatApiTsStack(app, 'TestStack', baseProps);
    return Template.fromStack(stack);
  }

  function stackTags() {
    const app = new cdk.App({ context });
    const stack = new ChatApiTsStack(app, 'TestStack', baseProps);
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
    it('creates the agent-stream lambda with its AGENT_RUNTIME_ARN and table name configured', () => {
      const template = stackTemplate();

      const [tableId] = Object.keys(
        template.findResources('AWS::DynamoDB::Table'),
      );

      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: Match.stringLikeRegexp('chat-api-ts-threads-invoke-ts'),
        Environment: {
          Variables: Match.objectLike({
            AGENT_RUNTIME_ARN: baseProps.agentRuntimeArn,
            POWERTOOLS_SERVICE_NAME: 'chat-api-ts',
            THREADS_TABLE_NAME: { Ref: tableId },
          }),
        },
      });
    });

    it('grants the agent-stream lambda access to the thread table', () => {
      const template = stackTemplate();

      const [tableId] = Object.keys(
        template.findResources('AWS::DynamoDB::Table'),
      );
      const functions = template.findResources('AWS::Lambda::Function', {
        Properties: {
          FunctionName: Match.stringLikeRegexp('chat-api-ts-threads-invoke-ts'),
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

  describe('DynamoDB thread table', () => {
    it('creates the table with the keys and TTL attribute the repository expects', () => {
      const template = stackTemplate();

      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: Match.stringLikeRegexp('chat-api-ts-threads'),
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
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

    it('requires Cognito auth on POST requests', () => {
      const template = stackTemplate();

      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'POST',
        AuthorizationType: 'COGNITO_USER_POOLS',
        AuthorizationScopes: ['chat-api/invoke'],
      });
    });

    it('outputs the gateway URL', () => {
      const template = stackTemplate();

      template.hasOutput('GatewayUrl', {});
    });
  });

  describe('Cognito', () => {
    it('creates a User Pool', () => {
      const template = stackTemplate();

      template.hasResourceProperties('AWS::Cognito::UserPool', {
        UserPoolName: Match.stringLikeRegexp('chat-api-ts-user-pool'),
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
