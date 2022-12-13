import generateLambdaProxyResponse from './utils';

const AWSXRay = require('aws-xray-sdk-core');
const AWS = AWSXRay.captureAWS(require('aws-sdk'));

const dynamoDbClient = new AWS.DynamoDB.DocumentClient({
  apiVersion: '2012-08-10',
  region: process.env.AWS_REGION,
});

const gatewayClient = new AWS.ApiGatewayManagementApi({
  apiVersion: '2018-11-29',
  endpoint: process.env.API_GATEWAY_ENDPOINT,
});

export async function handleState(event: any): Promise<any> {
  console.log('Received event ', event);

  await gatewayClient.postToConnection({
    ConnectionId: event.requestContext.connectionId,
    // ConnectionId: event.detail.senderConnectionId,
    Data: JSON.stringify({
      greetings: 'from the server!',
    }),
  });

  return generateLambdaProxyResponse(200, 'Ok');
}
