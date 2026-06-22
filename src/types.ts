export interface Workspace {
  id?: number;
  team_id: string;
  team_name: string;
  bot_token: string;
  bot_user_id: string;
  created_at?: Date;
}

export type DecisionCategory = 'decision' | 'commitment' | 'resolved_question';

export interface Decision {
  id?: number;
  workspace_id: string;
  channel_id: string;
  channel_name: string | null;
  message_id: string; // The ts of the message
  thread_ts: string | null;
  user_id: string;
  user_name: string | null;
  category: DecisionCategory;
  decision_text: string;
  rationale: string | null;
  slack_link: string | null;
  message_date: Date;
  created_at?: Date;
}

export interface SlackMessageJob {
  teamId: string;
  channelId: string;
  channelName: string | null;
  messageId: string; // TS
  threadTs: string | null;
  userId: string;
  userName: string | null;
  text: string;
  messageDate: string; // ISO string
}

export interface GroqExtractionResult {
  isDecision: boolean;
  category: DecisionCategory | null;
  decisionText: string | null;
  rationale: string | null;
  ownerId: string | null; // Slack User ID who made the decision or resolved the Q
}
