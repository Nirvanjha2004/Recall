import dotenv from 'dotenv';
import path from 'path';

// Load .env file
dotenv.config({ path: path.join(__dirname, '../../.env') });

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin',
  
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'recall',
    connectionString: process.env.DATABASE_URL || undefined,
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
  },

  slack: {
    clientId: process.env.SLACK_CLIENT_ID || '',
    clientSecret: process.env.SLACK_CLIENT_SECRET || '',
    signingSecret: process.env.SLACK_SIGNING_SECRET || '',
    redirectUri: process.env.SLACK_REDIRECT_URI || 'http://localhost:3000/slack/oauth/callback',
  }
};

// Simple validations
if (!config.groq.apiKey && config.nodeEnv !== 'test') {
  console.warn('WARNING: GROQ_API_KEY is not defined. LLM operations will fail.');
}

if (!config.slack.signingSecret && config.nodeEnv !== 'test') {
  console.warn('WARNING: SLACK_SIGNING_SECRET is not defined. Slack requests will not be verified.');
}
