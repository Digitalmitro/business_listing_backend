const { S3Client } = require('@aws-sdk/client-s3');
const { SESClient } = require('@aws-sdk/client-ses');
const dotenv = require('dotenv');

dotenv.config();

const awsConfig = {
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
};

const s3 = new S3Client(awsConfig);
const ses = new SESClient(awsConfig);

module.exports = { s3, ses };
