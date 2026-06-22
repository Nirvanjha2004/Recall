import { Queue, ConnectionOptions } from 'bullmq';
import { config } from '../config';
import { SlackMessageJob } from '../types';

export const redisConnection: ConnectionOptions = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  // Fix BullMQ node connection issue
  maxRetriesPerRequest: null,
};

// Create the Queue
export const slackMessageQueue = new Queue('SlackMessageQueue', {
  connection: redisConnection
});

/**
 * Push a new Slack message job to the queue
 */
export async function queueSlackMessage(jobData: SlackMessageJob) {
  try {
    const jobName = `msg:${jobData.teamId}:${jobData.channelId}:${jobData.messageId}`;
    await slackMessageQueue.add(jobName, jobData, {
      attempts: 3, // Retry up to 3 times on failure
      backoff: {
        type: 'exponential',
        delay: 5000 // Start retrying after 5 seconds
      },
      removeOnComplete: true, // Auto clean successful jobs
      removeOnFail: false // Keep failed jobs in Redis for debugging
    });
    
    if (config.nodeEnv === 'development') {
      console.log(`Enqueued job: ${jobName}`);
    }
  } catch (error) {
    console.error('Failed to add job to BullMQ SlackMessageQueue:', error);
  }
}
