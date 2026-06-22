import { WebClient } from '@slack/web-api';
import { db } from '../db';
import { Workspace } from '../types';
import { config } from '../config';

// In-memory cache for token/names to minimize API calls
const botClientCache = new Map<string, WebClient>();
const userCache = new Map<string, { realName: string; displayName: string }>();
const channelCache = new Map<string, string>();

/**
 * Fetch the Bot Token for a given team ID from the DB
 */
export async function getBotToken(teamId: string): Promise<string> {
  const result = await db.query<Workspace>(
    'SELECT bot_token FROM workspaces WHERE team_id = $1',
    [teamId]
  );
  if (result.rows.length === 0) {
    throw new Error(`No workspace registered for Team ID: ${teamId}`);
  }
  return result.rows[0].bot_token;
}

/**
 * Get an initialized Slack WebClient for a workspace
 */
export async function getWebClient(teamId: string): Promise<WebClient> {
  let client = botClientCache.get(teamId);
  if (!client) {
    const token = await getBotToken(teamId);
    client = new WebClient(token);
    botClientCache.set(teamId, client);
  }
  return client;
}

/**
 * Force refresh client cache (useful after workspace reinstall/update)
 */
export function clearClientCache(teamId: string) {
  botClientCache.delete(teamId);
}

/**
 * Fetch user names
 */
export async function getUserInfo(teamId: string, userId: string): Promise<{ realName: string; displayName: string }> {
  const cacheKey = `${teamId}:${userId}`;
  if (userCache.has(cacheKey)) {
    return userCache.get(cacheKey)!;
  }

  try {
    const client = await getWebClient(teamId);
    const res = await client.users.info({ user: userId });
    
    const info = {
      realName: res.user?.profile?.real_name || res.user?.real_name || 'Unknown User',
      displayName: res.user?.profile?.display_name || res.user?.name || 'Unknown User'
    };

    userCache.set(cacheKey, info);
    return info;
  } catch (error) {
    console.error(`Error fetching user info for ${userId}:`, error);
    return { realName: 'Slack User', displayName: 'Slack User' };
  }
}

/**
 * Fetch channel name
 */
export async function getChannelName(teamId: string, channelId: string): Promise<string> {
  const cacheKey = `${teamId}:${channelId}`;
  if (channelCache.has(cacheKey)) {
    return channelCache.get(cacheKey)!;
  }

  try {
    const client = await getWebClient(teamId);
    const res = await client.conversations.info({ channel: channelId });
    const name = res.channel?.name || 'unknown-channel';
    
    channelCache.set(cacheKey, name);
    return name;
  } catch (error) {
    console.error(`Error fetching channel info for ${channelId}:`, error);
    return 'unknown-channel';
  }
}

/**
 * Get message permalink
 */
export async function getMessageLink(teamId: string, channelId: string, messageTs: string): Promise<string | null> {
  try {
    const client = await getWebClient(teamId);
    const res = await client.chat.getPermalink({
      channel: channelId,
      message_ts: messageTs
    });
    return res.permalink || null;
  } catch (error) {
    console.error(`Error getting permalink for message ${messageTs}:`, error);
    return null;
  }
}

/**
 * Fetch thread history (replies) up to the current message to give LLM context
 */
export async function getThreadHistory(
  teamId: string,
  channelId: string,
  threadTs: string,
  currentMessageTs: string
): Promise<string[]> {
  try {
    const client = await getWebClient(teamId);
    const res = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 50 // Limit context history to avoid blowing up tokens
    });

    if (!res.messages) return [];

    const messages = res.messages;
    const history: string[] = [];

    for (const msg of messages) {
      // Only include messages up to (but not after) the current message being processed
      if (parseFloat(msg.ts || '0') > parseFloat(currentMessageTs)) {
        continue;
      }

      // Skip empty text or subtype messages (like channel joins)
      if (!msg.text || (msg as any).subtype) {
        continue;
      }

      // Attempt to resolve the poster's display name
      const posterName = msg.user 
        ? (await getUserInfo(teamId, msg.user)).displayName 
        : 'Bot/System';

      history.push(`${posterName} (ID: ${msg.user || 'N/A'}): ${msg.text}`);
    }

    return history;
  } catch (error) {
    console.error(`Error fetching thread history for thread ${threadTs}:`, error);
    return [];
  }
}

/**
 * Post an ephemeral message (visible only to the triggering user) in response to a command
 */
export async function postEphemeralMessage(
  teamId: string,
  channelId: string,
  userId: string,
  text: string
): Promise<void> {
  try {
    const client = await getWebClient(teamId);
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: text
    });
  } catch (error) {
    console.error('Error posting ephemeral message to Slack:', error);
  }
}

/**
 * Exchange OAuth authorization code for permanent workspace credentials
 */
export async function exchangeOAuthCode(code: string): Promise<Workspace> {
  // Use a clean new WebClient without tokens for the OAuth exchange
  const client = new WebClient();
  
  const response = await client.oauth.v2.access({
    client_id: config.slack.clientId,
    client_secret: config.slack.clientSecret,
    code,
    redirect_uri: config.slack.redirectUri
  });

  if (!response.ok || !response.access_token || !response.team?.id) {
    throw new Error(`Slack OAuth failed: ${response.error || 'Unknown error'}`);
  }

  const workspace: Workspace = {
    team_id: response.team.id,
    team_name: response.team.name || 'Unknown Workspace',
    bot_token: response.access_token,
    bot_user_id: response.bot_user_id || ''
  };

  // Upsert the workspace into our database
  await db.query(
    `INSERT INTO workspaces (team_id, team_name, bot_token, bot_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (team_id) 
     DO UPDATE SET 
       team_name = EXCLUDED.team_name,
       bot_token = EXCLUDED.bot_token,
       bot_user_id = EXCLUDED.bot_user_id,
       created_at = CURRENT_TIMESTAMP`,
    [workspace.team_id, workspace.team_name, workspace.bot_token, workspace.bot_user_id]
  );

  // Clear in-memory client cache so we grab the new token on subsequent operations
  clearClientCache(workspace.team_id);

  return workspace;
}
