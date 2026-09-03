import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import path from 'node:path';
import { Construct } from 'constructs';
import {
  getResourceNamePrefix,
  isEphemeralEnvironment,
  repoRoot,
} from '../constants/environment.ts';

export interface ChatApiTsStackProps extends cdk.StackProps {
  serviceName: string;
  teamName: string;
  agentRuntimeArn: string;
  repositoryUrl: string;
  environment: string;
}

interface CognitoAuth {
  authorizer: apigateway.CognitoUserPoolsAuthorizer;
  scope: string;
}

export class ChatApiTsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ChatApiTsStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('ServiceName', props.serviceName);
    cdk.Tags.of(this).add('TeamName', props.teamName);
    cdk.Tags.of(this).add('RepositoryUrl', props.repositoryUrl);
    cdk.Tags.of(this).add('Environment', props.environment);

    const auth = this.cognitoAuth();
    const threadTable = this.threadTable();
    const apiGateway = this.apiGateway(props, auth, threadTable);

    new cdk.CfnOutput(this, 'GatewayUrl', {
      value: apiGateway.url,
    });
  }

  cognitoAuth(): CognitoAuth {
    const userPool = new cognito.UserPool(
      this,
      `${getResourceNamePrefix()}-chat-api-ts-user-pool`,
      {
        userPoolName: `${getResourceNamePrefix()}-chat-api-ts-user-pool`,
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
      `${getResourceNamePrefix()}-chat-api-ts-resource-server`,
      {
        identifier: 'chat-api',
        scopes: [invokeScope],
      },
    );

    const appClient = userPool.addClient(
      `${getResourceNamePrefix()}-chat-api-ts-app-client`,
      {
        userPoolClientName: `${getResourceNamePrefix()}-chat-api-ts-app-client`,
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
      `${getResourceNamePrefix()}-chat-api-ts-domain`,
      {
        cognitoDomain: {
          domainPrefix: getResourceNamePrefix(),
        },
      },
    );

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      `${getResourceNamePrefix()}-chat-api-ts-authorizer`,
      {
        authorizerName: `${getResourceNamePrefix()}-chat-api-ts-authorizer`,
        cognitoUserPools: [userPool],
      },
    );

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
    });

    new cdk.CfnOutput(this, 'AppClientId', {
      value: appClient.userPoolClientId,
    });

    new cdk.CfnOutput(this, 'TokenEndpoint', {
      value: `https://${domain.domainName}.auth.${this.region}.amazoncognito.com/oauth2/token`,
    });

    return {
      authorizer,
      scope: `chat-api/${invokeScope.scopeName}`,
    };
  }

  threadTable(): dynamodb.Table {
    const tableName = `${getResourceNamePrefix()}-chat-api-ts-threads`;

    return new dynamodb.Table(this, tableName, {
      tableName,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: isEphemeralEnvironment()
        ? cdk.RemovalPolicy.DESTROY
        : cdk.RemovalPolicy.RETAIN,
    });
  }

  apiGateway(
    props: ChatApiTsStackProps,
    auth: CognitoAuth,
    threadTable: dynamodb.Table,
  ): apigateway.RestApi {
    const api = new apigateway.RestApi(
      this,
      `${getResourceNamePrefix()}-chat-api-ts-gateway`,
      {
        restApiName: `${getResourceNamePrefix()}-chat-api-ts-gateway`,
        deployOptions: {
          stageName: props.environment,
        },
        defaultMethodOptions: {
          authorizationType: apigateway.AuthorizationType.COGNITO,
          authorizer: auth.authorizer,
          authorizationScopes: [auth.scope],
        },
      },
    );

    const agentStreamFunction = this.lambdaHandler('threads/invoke.ts', {
      AGENT_RUNTIME_ARN: props.agentRuntimeArn,
      THREADS_TABLE_NAME: threadTable.tableName,
    });

    threadTable.grantReadWriteData(agentStreamFunction);

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

    const v1 = api.root.addResource('v1');

    // POST /v1/threads/invoke
    const agentStream = v1.addResource('threads').addResource('invoke');
    agentStream.addMethod('POST', agentStreamLambda);

    return api;
  }

  lambdaHandler(
    handlerPath: string,
    environment?: { [key: string]: string },
  ): NodejsFunction {
    const nameSuffix = handlerPath.replaceAll(/[^a-zA-Z0-9-]/g, '-');
    const functionName = `${getResourceNamePrefix()}-chat-api-ts-${nameSuffix}`;

    return new NodejsFunction(this, functionName, {
      functionName: functionName,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      environment: {
        POWERTOOLS_SERVICE_NAME: 'chat-api-ts',
        ...environment,
      },
      entry: path.resolve(
        repoRoot(),
        `services/chat-api-ts/src/handlers/${handlerPath}`,
      ),
      handler: 'handler',
    });
  }
}
