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
    attempts: 3, // Retry failed jobs up to 3 times
    backoff: { type: 'exponential', delay: 1000 }, // Exponential backoff
  },
});

/**
 * Adds a job to the BullMQ queue.
 * @param {string} queueName - Name of the queue (e.g., 'email-campaigns').
 * @param {object} jobData - Data for the job (e.g., campaignId, userIds, senderEmailId).
 * @param {object} options - Job options (e.g., delay, jobId).
 * @returns {Promise<object>} - Promise resolving to the added job.
 */
async function addJob(queueName, jobData, options = {}) {
  try {
    const job = await emailQueue.add(queueName, jobData, {
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

module.exports = { emailQueue, redisConnection, addJob };