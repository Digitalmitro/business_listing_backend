// backend/utils/queue.js
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const logger = require('./logger');

const redisConnection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // Required for BullMQ
});

redisConnection.on('connect', () => {
  logger.info('redis.connected', 'Redis connection established');
});
redisConnection.on('error', (error) => {
  logger.error('redis.connection_error', 'Redis connection emitted an error', { error });
});
redisConnection.on('ready', () => {
  logger.info('redis.ready', 'Redis is ready to accept commands');
});
redisConnection.on('reconnecting', (delayMs) => {
  logger.warn('redis.reconnecting', 'Redis is reconnecting', { delayMs });
});
redisConnection.on('end', () => {
  logger.warn('redis.disconnected', 'Redis connection closed');
});

const defaultAttempts = parseInt(process.env.QUEUE_DEFAULT_ATTEMPTS, 10) || 3;
const defaultDelay = parseInt(process.env.QUEUE_DEFAULT_DELAY, 10) || 1000;

const emailQueue = new Queue('email-campaigns', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: defaultAttempts,
    backoff: { type: 'exponential', delay: defaultDelay },
  },
});

const welcomeQueue = new Queue('welcome-email', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: defaultAttempts,
    backoff: { type: 'exponential', delay: defaultDelay },
  },
});

const purchaseQueue = new Queue('purchase-email', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: defaultAttempts,
    backoff: { type: 'exponential', delay: defaultDelay },
  },
});

const claimQueue = new Queue('claim-email', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: defaultAttempts,
    backoff: { type: 'exponential', delay: defaultDelay },
  },
});

const kycQueue = new Queue('kyc-email', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: defaultAttempts,
    backoff: { type: 'exponential', delay: defaultDelay },
  },
});

const geocodingQueue = new Queue('geocoding-batch', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: parseInt(process.env.GEOCODING_ATTEMPTS, 10) || 5,
    backoff: { type: 'exponential', delay: parseInt(process.env.GEOCODING_DELAY, 10) || 2000 },
  },
});

const enquiryQueue = new Queue('enquiry-email', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: defaultAttempts,
    backoff: { type: 'exponential', delay: defaultDelay },
  },
});

const bookingQueue = new Queue('booking-email', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: defaultAttempts,
    backoff: { type: 'exponential', delay: defaultDelay },
  },
});

const leadFollowUpQueue = new Queue('lead-follow-up', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: defaultAttempts,
    backoff: { type: 'exponential', delay: defaultDelay },
  },
});

const scheduledSocialPostQueue = new Queue('scheduled-social-post', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: defaultAttempts,
    backoff: { type: 'exponential', delay: defaultDelay },
  },
});

const queues = {
  'email-campaigns': emailQueue,
  'welcome-email': welcomeQueue,
  'purchase-email': purchaseQueue,
  'claim-email': claimQueue,
  'kyc-email': kycQueue,
  'geocoding-batch': geocodingQueue,
  'enquiry-email': enquiryQueue,
  'booking-email': bookingQueue,
  'lead-follow-up': leadFollowUpQueue,
  'scheduled-social-post': scheduledSocialPostQueue,
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
      removeOnComplete: { count: 100 }, // Keep last 100 for debugging
      removeOnFail: { count: 500 },     // Keep last 500 fails
    });
    logger.info('queue.job_added', 'Job added to BullMQ queue', {
      queue: queueName,
      jobId: job.id,
    });
    return job;
  } catch (error) {
    logger.error('queue.add_failed', 'Failed to add job to BullMQ queue', {
      queue: queueName,
      error,
    });
    throw error;
  }
}

async function closeQueueConnections() {
  logger.info('queue.shutdown_started', 'Closing BullMQ queues and Redis connection');
  const results = await Promise.allSettled(Object.values(queues).map((queue) => queue.close()));
  const failures = results.filter((result) => result.status === 'rejected');

  if (redisConnection.status !== 'end') await redisConnection.quit();

  if (failures.length) {
    logger.error('queue.shutdown_partial', 'Some BullMQ queues did not close cleanly', {
      failureCount: failures.length,
      errors: failures.map((failure) => failure.reason),
    });
  } else {
    logger.info('queue.shutdown_complete', 'BullMQ queues and Redis connection closed');
  }
}

module.exports = {
  emailQueue,
  welcomeQueue,
  purchaseQueue,
  claimQueue,
  kycQueue,
  geocodingQueue,
  enquiryQueue,
  bookingQueue,
  leadFollowUpQueue,
  scheduledSocialPostQueue,
  redisConnection,
  addJob,
  closeQueueConnections,
};
