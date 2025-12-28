// backend/utils/queue.js
const { Queue } = require('bullmq');
const Redis = require('ioredis');

const redisConnection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // Required for BullMQ
});

const emailQueue = new Queue('email-campaigns', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
});

const welcomeQueue = new Queue('welcome-email', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
});

const purchaseQueue = new Queue('purchase-email', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
});

const queues = {
  'email-campaigns': emailQueue,
  'welcome-email': welcomeQueue,
  'purchase-email': purchaseQueue,
};

/**
 * Adds a job to the specified BullMQ queue.
 * @param {string} queueName - Name of the queue.
 * @param {object} jobData - Data for the job.
 * @param {object} options - Job options.
 * @returns {Promise<object>} - Promise resolving to the added job.
 */
async function addJob(queueName, jobData, options = {}) {
  try {
    const queue = queues[queueName];
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }
    const job = await queue.add(queueName, jobData, {
      ...options,
      jobId: options.jobId || `${queueName}-${Date.now()}-${Math.random().toString(36).substring(2)}`,
    });
    console.log(`Job ${job.id} added to queue ${queueName}`);
    return job;
  } catch (error) {
    console.error(`Error adding job to queue ${queueName}:`, error);
    throw error;
  }
}

module.exports = { emailQueue, welcomeQueue, purchaseQueue, redisConnection, addJob };