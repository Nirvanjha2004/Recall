import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { config } from '../config';
import { queueSlackMessage } from '../queues/decisionQueue';
import { db } from '../db';
import { getUserInfo, getChannelName, exchangeOAuthCode } from '../services/slack';
import { synthesizeSearchResponse } from '../services/groq';
import { SlackMessageJob, Decision } from '../types';

export const slackRouter = Router();

// Middleware to capture raw body for signature verification
export const rawBodySaver = (req: any, res: Response, buf: Buffer, encoding: string) => {
  if (buf && buf.length) {
    req.rawBody = buf.toString((encoding || 'utf8') as BufferEncoding);
  }
};

/**
 * Middleware: Verify Slack Signing Signature
 */
export function verifySlackSignature(req: any, res: Response, next: NextFunction) {
  const signingSecret = config.slack.signingSecret;
  
  if (!signingSecret) {
    if (config.nodeEnv === 'development') {
      console.warn('Slack verification skipped: SLACK_SIGNING_SECRET is missing.');
      return next();
    }
    return res.status(500).send('Slack Signing Secret is not configured.');
  }

  const signature = req.headers['x-slack-signature'] as string;
  const timestamp = req.headers['x-slack-request-timestamp'] as string;

  if (!signature || !timestamp) {
    return res.status(401).send('Missing Slack verification headers.');
  }

  // Prevent replay attacks (check if timestamp is within 5 minutes)
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - (60 * 5);
  if (parseInt(timestamp, 10) < fiveMinutesAgo) {
    return res.status(401).send('Replay attack suspected.');
  }

  const baseString = `v0:${timestamp}:${req.rawBody || ''}`;
  const hmac = crypto.createHmac('sha256', signingSecret);
  const computedSignature = `v0=${hmac.update(baseString).digest('hex')}`;

  try {
    if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computedSignature))) {
      return next();
    }
  } catch (err) {
    // Length mismatch or empty values
  }

  return res.status(401).send('Invalid signature.');
}

/**
 * Route: Slack OAuth Installation Link
 */
slackRouter.get('/oauth/install', (req: Request, res: Response) => {
  if (!config.slack.clientId) {
    return res.status(500).send('Slack Client ID is not configured.');
  }

  const scopes = [
    'channels:history',
    'groups:history',
    'chat:write',
    'commands',
    'users:read',
    'channels:read',
    'groups:read'
  ].join(',');

  const slackAuthUrl = `https://slack.com/oauth/v2/authorize?client_id=${config.slack.clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(config.slack.redirectUri)}`;
  
  res.redirect(slackAuthUrl);
});

/**
 * Route: Slack OAuth Callback handler
 */
slackRouter.get('/oauth/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) {
    return res.status(400).send('Missing authorization code.');
  }

  try {
    const workspace = await exchangeOAuthCode(code);
    res.redirect(`/?installed=true&team=${encodeURIComponent(workspace.team_name)}`);
  } catch (error: any) {
    console.error('Slack OAuth Callback Error:', error);
    res.redirect(`/?installed=false&error=${encodeURIComponent(error.message || 'Unknown error')}`);
  }
});

/**
 * Route: Slack Events Webhook handler
 */
slackRouter.post('/events', verifySlackSignature, async (req: Request, res: Response) => {
  const { type, challenge, event } = req.body;

  // 1. URL Verification handshake
  if (type === 'url_verification') {
    return res.json({ challenge });
  }

  // Acknowledge event immediately to prevent Slack timeout retries
  res.status(200).send({ ok: true });

  // 2. Handle actual events
  if (type === 'event_callback' && event) {
    const { type: eventType, text, user, ts, channel, thread_ts, subtype, bot_id } = event;

    // We only care about user messages in channels (skip bot posts, deleted messages, joins, etc.)
    if (eventType === 'message' && text && user && !subtype && !bot_id) {
      try {
        const teamId = req.body.team_id;
        
        // Fetch poster display name and channel name asynchronously for caching
        const userProfile = await getUserInfo(teamId, user);
        const channelName = await getChannelName(teamId, channel);

        const jobData: SlackMessageJob = {
          teamId,
          channelId: channel,
          channelName,
          messageId: ts,
          threadTs: thread_ts || null,
          userId: user,
          userName: userProfile.realName,
          text,
          messageDate: new Date(parseFloat(ts) * 1000).toISOString()
        };

        // Queue the message to BullMQ for asynchronous LLM classification
        await queueSlackMessage(jobData);
      } catch (error) {
        console.error('Error queueing Slack message event:', error);
      }
    }
  }
});

/**
 * Route: Slack Slash Commands (/recall)
 */
slackRouter.post('/commands', verifySlackSignature, async (req: Request, res: Response) => {
  const { command, text: query, channel_id, team_id, user_id, response_url } = req.body;

  if (command !== '/recall') {
    return res.status(400).send('Unsupported command.');
  }

  const cleanQuery = (query || '').trim();

  // 1. If empty query, reply with help text
  if (!cleanQuery) {
    return res.json({
      response_type: 'ephemeral',
      text: `👋 *Welcome to Recall!* I search and synthesize your workspace's decisions.\n\n*Usage:*\n• \`/recall why did we choose X\`\n• \`/recall release plan for v2\`\n• \`/recall who is working on the database migrations\``
    });
  }

  // 2. Acknowledge Slack immediately to avoid 3s timeout
  res.json({
    response_type: 'ephemeral',
    text: `🔍 Searching memory for: *"${cleanQuery}"*...`
  });

  // 3. Process the query asynchronously using database search and RAG synthesis
  // Running this in a separate promise flow allows us to response_url callback safely.
  (async () => {
    try {
      console.log(`Searching decisions for command request: "${cleanQuery}" (Team: ${team_id})`);

      // Search using full-text search first
      let searchRes = await db.query<Decision>(
        `SELECT *, ts_rank_cd(to_tsvector('english', decision_text || ' ' || COALESCE(rationale, '')), websearch_to_tsquery('english', $2)) as rank
         FROM decisions 
         WHERE workspace_id = $1 
           AND to_tsvector('english', decision_text || ' ' || COALESCE(rationale, '')) @@ websearch_to_tsquery('english', $2)
         ORDER BY rank DESC
         LIMIT 3`,
        [team_id, cleanQuery]
      );

      // Fallback to ILIKE search if no matches found via full-text search (e.g. partial matches)
      if (searchRes.rows.length === 0) {
        const fuzzyPattern = `%${cleanQuery}%`;
        searchRes = await db.query<Decision>(
          `SELECT * FROM decisions 
           WHERE workspace_id = $1 
             AND (decision_text ILIKE $2 OR rationale ILIKE $2)
           ORDER BY message_date DESC
           LIMIT 3`,
          [team_id, fuzzyPattern]
        );
      }

      // Synthesize final answer using Groq LLM (RAG pipeline)
      const synthesizedResponse = await synthesizeSearchResponse(cleanQuery, searchRes.rows);

      // Post final response back to Slack response_url
      await axios.post(response_url, {
        response_type: 'ephemeral', // keeps it private to the user who ran the command
        text: synthesizedResponse,
        replace_original: true // replaces the "Searching..." text
      });

    } catch (error) {
      console.error('Error handling slash command async pipeline:', error);
      try {
        await axios.post(response_url, {
          response_type: 'ephemeral',
          text: `⚠️ *Recall Error:* Had an issue processing your query. Please try again later.`,
          replace_original: true
        });
      } catch (err) {
        console.error('Failed to notify user of command failure:', err);
      }
    }
  })();
});
