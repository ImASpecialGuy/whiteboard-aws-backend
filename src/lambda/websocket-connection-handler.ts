import { DocumentClient } from 'aws-sdk/clients/dynamodb';
// eslint-disable-next-line import/no-unresolved
import { APIGatewayEvent } from 'aws-lambda';

import generateLambdaProxyResponse from './utils';

const AWSXRay = require('aws-xray-sdk-core');
const AWS = AWSXRay.captureAWS(require('aws-sdk'));

const dynamoDbClient: DocumentClient = new AWS.DynamoDB.DocumentClient({
  apiVersion: '2012-08-10',
  region: process.env.AWS_REGION,
});

const gatewayClient = new AWS.ApiGatewayManagementApi({
  apiVersion: '2018-11-29',
  endpoint: process.env.API_GATEWAY_ENDPOINT,
});

export async function connectionHandler(event: APIGatewayEvent): Promise<any> {
  const { eventType, connectionId } = event.requestContext;

  if (eventType === 'CONNECT') {
    const oneHourFromNow = Math.round(Date.now() / 1000 + 3600);
    await dynamoDbClient.put({
      TableName: process.env.CONNECTION_TABLE_NAME!,
      Item: {
        connectionId,
        whiteboardId: 'DEFAULT',
        ttl: oneHourFromNow,
      },
    }).promise();

    return generateLambdaProxyResponse(200, 'Connected');
  }

  if (eventType === 'DISCONNECT') {
    await dynamoDbClient.delete({
      TableName: process.env.CONNECTION_TABLE_NAME!,
      Key: {
        connectionId,
        whiteboardId: 'DEFAULT',
      },
    }).promise();

    return generateLambdaProxyResponse(200, 'Disconnected');
  }

  return generateLambdaProxyResponse(200, 'Ok');
}
