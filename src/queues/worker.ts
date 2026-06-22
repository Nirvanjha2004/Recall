import { Worker, Job } from 'bullmq';
import { redisConnection } from './decisionQueue';
import { SlackMessageJob, Decision } from '../types';
import { getThreadHistory, getUserInfo, getChannelName, getMessageLink } from '../services/slack';
import { classifyAndExtractDecision } from '../services/groq';
import { db } from '../db';

let worker: Worker | null = null;

export function startWorker() {
  if (worker) {
    console.log('Worker is already running.');
    return worker;
  }

  console.log('Initializing BullMQ SlackMessageQueue Worker...');

  worker = new Worker<SlackMessageJob>(
    'SlackMessageQueue',
    async (job: Job<SlackMessageJob>) => {
      const { 
        teamId, 
        channelId, 
        channelName: initialChannelName, 
        messageId, 
        threadTs, 
        userId, 
        userName: initialUserName, 
        text, 
        messageDate 
      } = job.data;

      console.log(`Processing job ${job.id} for team ${teamId}, channel ${channelId}, message ${messageId}`);

      try {
        // 1. Gather thread history if this message is inside a thread
        let threadHistory: string[] = [];
        if (threadTs) {
          threadHistory = await getThreadHistory(teamId, channelId, threadTs, messageId);
        }

        // 2. Query Groq LLM to classify and extract structure
        const extraction = await classifyAndExtractDecision(text, userId, threadHistory);

        if (!extraction.isDecision || !extraction.decisionText || !extraction.category) {
          console.log(`Job ${job.id}: Message did not contain a decision/commitment.`);
          return { isDecision: false };
        }

        console.log(`Job ${job.id}: Captured a ${extraction.category}! Decision: "${extraction.decisionText}"`);

        // 3. Resolve metadata (Owner name, Channel name, Link)
        const ownerId = extraction.ownerId || userId;
        const ownerInfo = await getUserInfo(teamId, ownerId);
        const channelName = initialChannelName || (await getChannelName(teamId, channelId));
        const slackLink = await getMessageLink(teamId, channelId, messageId);

        // 4. Save into Database
        const decisionRecord: Decision = {
          workspace_id: teamId,
          channel_id: channelId,
          channel_name: channelName,
          message_id: messageId,
          thread_ts: threadTs,
          user_id: ownerId,
          user_name: ownerInfo.realName,
          category: extraction.category,
          decision_text: extraction.decisionText,
          rationale: extraction.rationale,
          slack_link: slackLink,
          message_date: new Date(messageDate),
        };

        await db.query(
          `INSERT INTO decisions (
            workspace_id, channel_id, channel_name, message_id, thread_ts,
            user_id, user_name, category, decision_text, rationale, slack_link, message_date
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (message_id) 
          DO UPDATE SET
            category = EXCLUDED.category,
            decision_text = EXCLUDED.decision_text,
            rationale = EXCLUDED.rationale,
            user_id = EXCLUDED.user_id,
            user_name = EXCLUDED.user_name,
            slack_link = EXCLUDED.slack_link`,
          [
            decisionRecord.workspace_id,
            decisionRecord.channel_id,
            decisionRecord.channel_name,
            decisionRecord.message_id,
            decisionRecord.thread_ts,
            decisionRecord.user_id,
            decisionRecord.user_name,
            decisionRecord.category,
            decisionRecord.decision_text,
            decisionRecord.rationale,
            decisionRecord.slack_link,
            decisionRecord.message_date
          ]
        );

        console.log(`Job ${job.id}: Decision successfully saved in database.`);
        return { isDecision: true, id: messageId };
      } catch (error) {
        console.error(`Error processing job ${job.id}:`, error);
        throw error; // Re-throw so BullMQ triggers retry logic
      }
    },
    {
      connection: redisConnection,
      concurrency: 2 // Number of parallel jobs per worker process
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`Worker job ${job?.id} failed with error:`, err);
  });

  worker.on('error', (err) => {
    console.error('Worker connection or core error:', err);
  });

  console.log('✓ BullMQ SlackMessageQueue Worker initialized and listening for jobs.');

  return worker;
}

export async function stopWorker() {
  if (worker) {
    await worker.close();
    worker = null;
    console.log('BullMQ Worker stopped.');
  }
}
