import {
  CfnOutput, Duration, RemovalPolicy, Stack, StackProps,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { WebSocketLambdaIntegration } from '@aws-cdk/aws-apigatewayv2-integrations-alpha';
import * as apigwv2 from '@aws-cdk/aws-apigatewayv2-alpha';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import { Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import {
  Effect, PolicyStatement, Role, ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { EventBus, LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import path = require('path');
import { Route } from 'aws-cdk-lib/aws-appmesh';
import { CfnRoute, CfnRouteResponse } from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketRoute, WebSocketRouteIntegration } from '@aws-cdk/aws-apigatewayv2-alpha';

export interface SimpleLambdaProps {
  memorySize?: number;
  reservedConcurrentExecutions?: number;
  runtime?: Runtime;
  name: string;
  description: string;
  entryFilename: string;
  handler?: string;
  timeout?: Duration;
  envVariables?: any;
}

export class SimpleLambda extends Construct {
  public fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: SimpleLambdaProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, id, {
      entry: `../src/lambda/${props.entryFilename}`,
      handler: props.handler ?? 'handler',
      runtime: props.runtime ?? Runtime.NODEJS_14_X,
      timeout: props.timeout ?? Duration.seconds(5),
      memorySize: props.memorySize ?? 1024,
      tracing: Tracing.ACTIVE,
      functionName: props.name,
      description: props.description,
      depsLockFilePath: path.join(__dirname, '..', '..', 'src', 'package-lock.json'),
      environment: props.envVariables ?? {},
    });
  }
}

interface WebSocketStackProps extends StackProps {
  regionCodesToReplicate: string[]
}

export class WebsocketsBlogStack extends Stack {
  constructor(scope: Construct, id: string, props: WebSocketStackProps) {
    super(scope, id, props);

    // table for storing update packets
    // packets stored until the full package is complete
    // on complete package, delete table entries and update canvas
    const packetTable = new Table(this, 'Packets', {
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      tableName: 'Packets',
      // packageId consists of: whiteboardId#sender#packetId
      // this ensures every packageId is unique
      partitionKey: {
        name: 'packageId',
        type: AttributeType.STRING,
      },
      // to represent the 1 to many relationship between the package and its packets
      // a sort key is used where every packet is identified by its packetNum
      sortKey: {
        name: 'packetNum',
        type: AttributeType.NUMBER,
      },
    });

    // table for storing canvas states
    // retrieved when a new user joins
    // updated when an update package is completed
    // currently only using 1 whiteboard, so use 'DEFAULT' as only partition key
    const canvasTable = new Table(this, 'Canvases', {
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      tableName: 'Canvases',
      // identify canvas by whiteboardId alone, as there is 1 canvas per whiteboard session
      partitionKey: {
        name: 'whiteboardId',
        type: AttributeType.STRING,
      },
    });

    // table for storing web socket connections
    // currently only using 1 whiteboard, so use 'DEFAULT' as only partition key
    const connectionTable = new Table(this, 'WebsocketConnections', {
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      tableName: 'WebsocketConnections',
      partitionKey: {
        name: 'whiteboardId',
        type: AttributeType.STRING,
      },
      sortKey: {
        name: 'connectionId',
        type: AttributeType.STRING,
      },
    });
    // dedicated event bus
    const eventBus = new events.EventBus(this, 'EventBus', {
      eventBusName: 'WhiteboardEventBus',
    });

    // (Dis-)connect handler
    const connectionLambda = new SimpleLambda(this, 'ConnectionHandlerLambda', {
      entryFilename: 'websocket-connection-handler.ts',
      handler: 'connectionHandler',
      name: 'ConnectionHandler',
      description: 'Handles the onConnect & onDisconnect events emitted by the WebSocket API Gateway',
      envVariables: {
        CONNECTION_TABLE_NAME: connectionTable.tableName,
      },
    });
    connectionTable.grantFullAccess(connectionLambda.fn);
    canvasTable.grantReadData(connectionLambda.fn);

    // receive/store packets and update canvas when packages are complete
    const dbUpdateLambda = new SimpleLambda(this, 'DbUpdateHandlerLambda', {
      entryFilename: 'websocket-database-update-handler.ts',
      handler: 'handleDBUpdate',
      name: 'DbUpdateHandler',
      description: 'Collects packets and updates database on receiving full update package',
      envVariables: {
        CANVAS_TABLE_NAME: canvasTable.tableName,
        PACKET_TABLE_NAME: packetTable.tableName,
      },
    });
    canvasTable.grantFullAccess(dbUpdateLambda.fn);
    packetTable.grantFullAccess(dbUpdateLambda.fn);

    // Main (default route) handler
    const requestHandlerLambda = new SimpleLambda(this, 'RequestHandlerLambda', {
      entryFilename: 'websocket-request-handler.ts',
      handler: 'handleMessage',
      name: 'RequestHandler',
      description: 'Handles requests sent via websocket and stores (connectionId, whiteboardId) tuple in DynamoDB. Sends WhiteboardMessageReceived events to EventBridge.',
      envVariables: {
        BUS_NAME: eventBus.eventBusName,
      },
    });

    eventBus.grantPutEventsTo(requestHandlerLambda.fn);

    const webSocketApi = new apigwv2.WebSocketApi(this, 'WebsocketApi', {
      apiName: 'WebSocketApi',
      description: 'A regional Websocket API for the multi-region whiteboard application.',
      connectRouteOptions: {
        integration: new WebSocketLambdaIntegration('connectionIntegration', connectionLambda.fn),
      },
      disconnectRouteOptions: {
        integration: new WebSocketLambdaIntegration('disconnectIntegration', connectionLambda.fn),
      },
      defaultRouteOptions: {
        integration: new WebSocketLambdaIntegration('defaultIntegration', requestHandlerLambda.fn),
      },
    });

    const websocketStage = new apigwv2.WebSocketStage(this, 'WebsocketStage', {
      webSocketApi,
      stageName: 'whiteboard',
      autoDeploy: true,
    });

    const stateHandler = new SimpleLambda(this, 'CanvasHandlerLambda', {
      entryFilename: 'websocket-state-handler.ts',
      handler: 'handleState',
      name: 'StateHandler',
      description: 'Sends all packages of the canvas state',
      envVariables: {
        PACKET_TABLE_NAME: packetTable.tableName,
        API_GATEWAY_ENDPOINT: websocketStage.callbackUrl,
      },
    });

    webSocketApi.addRoute('getState', {
      integration: new WebSocketLambdaIntegration('GetStateIntegration', stateHandler.fn),
    });

    const processLambda = new SimpleLambda(this, 'ProcessEventLambda', {
      entryFilename: 'websocket-response-handler.ts',
      handler: 'handler',
      name: 'ProcessEvent',
      description: 'Gets invoked when a new "WhiteboardMessageReceived" event is published to EventBridge. The function determines the connectionIds and pushes the message to the clients',
      envVariables: {
        CONNECTION_TABLE_NAME: connectionTable.tableName,
        API_GATEWAY_ENDPOINT: websocketStage.callbackUrl,
      },
    });

    // Create policy to allow Lambda function to use @connections API of API Gateway
    const allowConnectionManagementOnApiGatewayPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      resources: [
        `arn:aws:execute-api:${this.region}:${this.account}:${webSocketApi.apiId}/${websocketStage.stageName}/*`,
      ],
      actions: ['execute-api:ManageConnections'],
    });

    // Attach custom policy to Lambda function
    processLambda.fn.addToRolePolicy(allowConnectionManagementOnApiGatewayPolicy);
    stateHandler.fn.addToRolePolicy(allowConnectionManagementOnApiGatewayPolicy);

    // An explicit, but empty IAM role is required.
    // Otherwise, the CDK will overwrite permissions for implicit roles for each region.
    // This leads to only the last written IAM policy being set and thus restricting the rule to a single region.
    const crossRegionEventRole = new Role(this, 'CrossRegionRole', {
      inlinePolicies: {},
      assumedBy: new ServicePrincipal('events.amazonaws.com'),
    });

    // Generate list of Event buses in other regions
    const crossRegionalEventbusTargets = props.regionCodesToReplicate
      .map((regionCode) => new EventBus(events.EventBus.fromEventBusArn(
        this,
        `WebsocketBlogBus-${regionCode}`,
        `arn:aws:events:${regionCode}:${this.account}:event-bus/${eventBus.eventBusName}`,
      ), {
        role: crossRegionEventRole,
      }));

    new events.Rule(this, 'ProcessRequest', {
      eventBus,
      enabled: true,
      ruleName: 'ProcessWhiteboardMessage',
      description: 'Invokes a Lambda function for each whiteboard update to push the event via websocket and replicates the event to event buses in other regions.',
      eventPattern: {
        detailType: ['WhiteboardMessageReceived'],
        source: ['WhiteboardApplication'],
      },
      targets: [
        new LambdaFunction(processLambda.fn),
        new LambdaFunction(dbUpdateLambda.fn),
        ...crossRegionalEventbusTargets,
      ],
    });

    eventBus.grantPutEventsTo(processLambda.fn);
    connectionTable.grantReadData(processLambda.fn);

    new CfnOutput(this, 'bucketName', {
      value: websocketStage.url,
      description: 'WebSocket API URL',
      exportName: `websocketAPIUrl-${this.region}`,
    });
  }
}
