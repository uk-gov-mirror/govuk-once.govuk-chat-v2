import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import path from 'node:path';
import { Construct } from 'constructs';
import {
  getResourceNamePrefix,
  isEphemeralEnvironment,
  repositoryRoot,
} from '../constants/environment.ts';

export interface ChatApiStackProps extends cdk.StackProps {
  serviceName: string;
  teamName: string;
  agentRuntimeArn: string;
  repositoryUrl: string;
  environment: string;
}

// A run holds its thread until it finishes, so a lambda that dies without
// releasing must not hold it longer than it could have run for.
const LAMBDA_TIMEOUT = cdk.Duration.seconds(30);

// V1's write limits (CHAT-968): 900 a minute per client, 15 a minute per
// end user.
const RATE_LIMITS = {
  stageRequestsPerSecond: 15,
  stageBurst: 30,
  endUserInvokesPerWindow: 15,
  endUserWindowSeconds: 60,
};

const TOO_MANY_REQUESTS_BODY = JSON.stringify({ error: 'Too many requests' });

interface CognitoAuth {
  authorizer: apigateway.CognitoUserPoolsAuthorizer;
  scope: string;
  userPool: cognito.UserPool;
  appClient: cognito.UserPoolClient;
  tokenEndpoint: string;
}

export class ChatApiStack extends cdk.Stack {
  public readonly gatewayUrl: string;
  public readonly tokenEndpoint: string;
  public readonly userPoolId: string;
  public readonly userPoolArn: string;
  public readonly appClientId: string;

  constructor(scope: Construct, id: string, props: ChatApiStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('ServiceName', props.serviceName);
    cdk.Tags.of(this).add('TeamName', props.teamName);
    cdk.Tags.of(this).add('RepositoryUrl', props.repositoryUrl);
    cdk.Tags.of(this).add('Environment', props.environment);

    const auth = this.cognitoAuth();
    const table = this.table();
    const apiGateway = this.apiGateway(props, auth, table);
    this.webAcl(apiGateway);

    this.gatewayUrl = apiGateway.url;
    this.tokenEndpoint = auth.tokenEndpoint;
    this.userPoolId = auth.userPool.userPoolId;
    this.userPoolArn = auth.userPool.userPoolArn;
    this.appClientId = auth.appClient.userPoolClientId;

    new cdk.CfnOutput(this, 'GatewayUrl', {
      value: apiGateway.url,
    });
  }

  cognitoAuth(): CognitoAuth {
    const userPool = new cognito.UserPool(
      this,
      `${getResourceNamePrefix()}-chat-api-user-pool`,
      {
        userPoolName: `${getResourceNamePrefix()}-chat-api-user-pool`,
        selfSignUpEnabled: false,
        removalPolicy: isEphemeralEnvironment()
          ? cdk.RemovalPolicy.DESTROY
          : cdk.RemovalPolicy.RETAIN,
      },
    );

    const invokeScope = new cognito.ResourceServerScope({
      scopeName: 'invoke',
      scopeDescription: 'Invoke the Chat API',
    });

    const resourceServer = userPool.addResourceServer(
      `${getResourceNamePrefix()}-chat-api-resource-server`,
      {
        identifier: 'chat-api',
        scopes: [invokeScope],
      },
    );

    const appClient = userPool.addClient(
      `${getResourceNamePrefix()}-chat-api-app-client`,
      {
        userPoolClientName: `${getResourceNamePrefix()}-chat-api-app-client`,
        generateSecret: true,
        oAuth: {
          flows: { clientCredentials: true },
          scopes: [
            cognito.OAuthScope.resourceServer(resourceServer, invokeScope),
          ],
        },
        // Longer-lived tokens for ephermeral environments so refreshing
        // doesn't need to happen so often
        accessTokenValidity: cdk.Duration.hours(
          isEphemeralEnvironment() ? 24 : 1,
        ),
      },
    );

    const domain = userPool.addDomain(
      `${getResourceNamePrefix()}-chat-api-domain`,
      {
        cognitoDomain: {
          domainPrefix: getResourceNamePrefix(),
        },
      },
    );

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      `${getResourceNamePrefix()}-chat-api-authorizer`,
      {
        authorizerName: `${getResourceNamePrefix()}-chat-api-authorizer`,
        cognitoUserPools: [userPool],
      },
    );

    const tokenEndpoint = `https://${domain.domainName}.auth.${this.region}.amazoncognito.com/oauth2/token`;

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
    });

    new cdk.CfnOutput(this, 'AppClientId', {
      value: appClient.userPoolClientId,
    });

    new cdk.CfnOutput(this, 'TokenEndpoint', {
      value: tokenEndpoint,
    });

    return {
      authorizer,
      scope: `chat-api/${invokeScope.scopeName}`,
      userPool,
      appClient,
      tokenEndpoint,
    };
  }

  table(): dynamodb.Table {
    const tableName = `${getResourceNamePrefix()}-chat-api`;

    const table = new dynamodb.Table(this, tableName, {
      tableName,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: isEphemeralEnvironment()
        ? cdk.RemovalPolicy.DESTROY
        : cdk.RemovalPolicy.RETAIN,
    });

    table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    return table;
  }

  apiGateway(
    props: ChatApiStackProps,
    auth: CognitoAuth,
    table: dynamodb.Table,
  ): apigateway.RestApi {
    const api = new apigateway.RestApi(
      this,
      `${getResourceNamePrefix()}-chat-api-gateway`,
      {
        restApiName: `${getResourceNamePrefix()}-chat-api-gateway`,
        deployOptions: {
          stageName: props.environment,
          throttlingRateLimit: RATE_LIMITS.stageRequestsPerSecond,
          throttlingBurstLimit: RATE_LIMITS.stageBurst,
        },
        defaultMethodOptions: {
          authorizationType: apigateway.AuthorizationType.COGNITO,
          authorizer: auth.authorizer,
          authorizationScopes: [auth.scope],
        },
      },
    );

    // API Gateway's default 429 body is { "message": ... }
    api.addGatewayResponse('throttled', {
      type: apigateway.ResponseType.THROTTLED,
      templates: { 'application/json': TOO_MANY_REQUESTS_BODY },
    });

    const agentStreamFunction = this.lambdaHandler('threads/invoke.ts', {
      AGENT_RUNTIME_ARN: props.agentRuntimeArn,
      CHAT_API_TABLE_NAME: table.tableName,
      RUN_LOCK_LEASE_SECONDS: LAMBDA_TIMEOUT.toSeconds().toString(),
    });

    table.grantReadWriteData(agentStreamFunction);

    agentStreamFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [
          // AgentCore requires both the base runtime ARN and a wildcard for sub-paths
          // (e.g. /runtime-endpoint/DEFAULT).
          props.agentRuntimeArn,
          `${props.agentRuntimeArn}/*`,
        ],
      }),
    );

    const agentStreamLambda = new apigateway.LambdaIntegration(
      agentStreamFunction,
      {
        responseTransferMode: apigateway.ResponseTransferMode.STREAM,
      },
    );

    const messagesFunction = this.lambdaHandler('threads/messages.ts', {
      CHAT_API_TABLE_NAME: table.tableName,
    });

    table.grantReadData(messagesFunction);

    const messagesLambda = new apigateway.LambdaIntegration(messagesFunction);

    const v1 = api.root.addResource('v1');
    const threads = v1.addResource('threads');

    // POST /v1/threads/invoke
    const invoke = threads.addResource('invoke');
    invoke.addMethod('POST', agentStreamLambda);

    // GET /v1/threads/{threadId}/messages
    const threadById = threads.addResource('{threadId}');
    const messages = threadById.addResource('messages');
    messages.addMethod('GET', messagesLambda);

    return api;
  }

  webAcl(api: apigateway.RestApi): wafv2.CfnWebACL {
    const name = `${getResourceNamePrefix()}-chat-api-web-acl`;
    const tooManyRequestsBodyKey = 'too-many-requests';

    const endUserInvokeLimit: wafv2.CfnWebACL.RuleProperty = {
      name: 'end-user-invoke-limit',
      priority: 0,
      statement: {
        rateBasedStatement: {
          aggregateKeyType: 'CUSTOM_KEYS',
          customKeys: [
            {
              // Count requests separately for each end-user based on the 'end-user-id' header
              // WAF requires a text transformation even if no transformation is needed
              header: {
                name: 'end-user-id',
                textTransformations: [{ priority: 0, type: 'NONE' }],
              },
            },
          ],
          limit: RATE_LIMITS.endUserInvokesPerWindow,
          evaluationWindowSec: RATE_LIMITS.endUserWindowSeconds,
          scopeDownStatement: {
            andStatement: {
              statements: [
                {
                  byteMatchStatement: {
                    fieldToMatch: { method: {} },
                    positionalConstraint: 'EXACTLY',
                    searchString: 'POST',
                    textTransformations: [{ priority: 0, type: 'NONE' }],
                  },
                },
                {
                  // The stage name prefixes the path as WAF sees it
                  byteMatchStatement: {
                    fieldToMatch: { uriPath: {} },
                    positionalConstraint: 'ENDS_WITH',
                    searchString: '/v1/threads/invoke',
                    textTransformations: [{ priority: 0, type: 'NONE' }],
                  },
                },
              ],
            },
          },
        },
      },
      action: {
        block: {
          customResponse: {
            responseCode: 429,
            customResponseBodyKey: tooManyRequestsBodyKey,
          },
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: `${name}-end-user-invoke-limit`,
      },
    };

    const webAcl = new wafv2.CfnWebACL(this, name, {
      name,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      customResponseBodies: {
        [tooManyRequestsBodyKey]: {
          contentType: 'APPLICATION_JSON',
          content: TOO_MANY_REQUESTS_BODY,
        },
      },
      rules: [endUserInvokeLimit],
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: name,
      },
    });

    new wafv2.CfnWebACLAssociation(this, `${name}-association`, {
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });

    return webAcl;
  }

  lambdaHandler(
    handlerPath: string,
    environment?: { [key: string]: string },
  ): NodejsFunction {
    const nameSuffix = handlerPath.replaceAll(/[^a-zA-Z0-9-]/g, '-');
    const functionName = `${getResourceNamePrefix()}-chat-api-${nameSuffix}`;

    return new NodejsFunction(this, functionName, {
      functionName: functionName,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: LAMBDA_TIMEOUT,
      environment: {
        POWERTOOLS_SERVICE_NAME: 'chat-api',
        ...environment,
      },
      entry: path.resolve(
        repositoryRoot(),
        `services/chat-api/src/handlers/${handlerPath}`,
      ),
      handler: 'handler',
    });
  }
}
