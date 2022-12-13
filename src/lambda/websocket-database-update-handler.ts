import { EventBridgeEvent } from 'aws-lambda';

const AWSXRay = require('aws-xray-sdk-core');
const AWS = AWSXRay.captureAWS(require('aws-sdk'));

const dynamoDbClient = new AWS.DynamoDB.DocumentClient({
  apiVersion: '2012-08-10',
  region: process.env.AWS_REGION,
});

interface ResponseEventDetails {
    message: string;
    senderConnectionId: string;
    whiteboardId: string;
}

// returns how many packets are currently in package packageId
async function getCurrentPacketCount(packageId: string): Promise<any> {
  const { Items: packets } = await dynamoDbClient.query({
    TableName: process.env.CONNECTION_TABLE_NAME!,
    // packetNum 0 is reserved for info about the package
    KeyConditionExpression: 'packageId = :p AND packetNum > 0',
    ExpressionAttributeValues: {
      ':p': packageId,
    },
    ProjectionExpression: 'packetNum',
  }).promise();

  return packets.length;
}

// returns how many packets should be in the package packageId
async function getTotalPacketCount(packageId: string): Promise<any> {
  const totalPacketCount = await dynamoDbClient.get({
    TableName: process.env.CANVAS_TABLE_NAME!,
    KeyConditionExpression: 'packageId = :p AND packetNum = 0',
    ExpressionAttributeValues: {
      ':p': packageId,
    },
    ProjectionExpression: 'packetCount',
  }).promise();

  if (totalPacketCount === undefined || totalPacketCount === null) {
    return undefined;
  }
  return totalPacketCount;
}

export async function handleDBUpdate(event: EventBridgeEvent<'EventResponse', ResponseEventDetails>): Promise<any> {
  console.log('Triggered by ', event);
  const packet = JSON.parse(event.detail.message);

  // check if packet is clear whiteboard event
  if (packet.contents === 'clear') {
    // get all packets
    const { packageIds, packetNums } = await dynamoDbClient.query({
      ProjectionExpression: 'packageId, packetNum',
    });

    // delete all packets
    // eslint-disable-next-line no-plusplus
    for (let i = 0; i < packageIds.length; i++) {
      dynamoDbClient.delete({
        TableName: process.env.PACKET_TABLE_NAME,
        Key: {
          packageId: packageIds[i],
          packetNum: packetNums[i],
        },
      });
    }
    return;
  }

  // put packet in the db table
  // packageId: 'whiteboardId#sender#packetId'
  const packageId = `${event.detail.whiteboardId}#${event.detail.senderConnectionId}#${packet.packetID}`;
  await dynamoDbClient.put({
    TableName: process.env.PACKET_TABLE_NAME,
    Item: {
      // shorthand for 'packageId: packageId'
      packageId,
      packetNum: packet.packetNum,
      contents: packet.contents,
    },
  });

  const totalPacketCount = await getTotalPacketCount(packageId);
  if (totalPacketCount === await getCurrentPacketCount(packageId)) {
    // package is complete
    await dynamoDbClient.update({
      TableName: process.env.PACKET_TABLE_NAME,
      Item: {
        packageId,
        packetNum: packet.packetNum,
        packetCount: packet.packetCount,
        complete: true,
      },
    });
  } else if (totalPacketCount === undefined) {
    // packetNum 0 has not been created yet (this is the first packet that reached the server)
    await dynamoDbClient.put({
      TableName: process.env.PACKET_TABLE_NAME,
      Item: {
        packageId,
        packetNum: packet.packetNum,
        packetCount: packet.packetCount,
        complete: false,
      },
    });
  }
}
