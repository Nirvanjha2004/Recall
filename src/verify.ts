import { db, pool } from './db';
import { verifySlackSignature } from './routes/slack';
import { classifyAndExtractDecision, synthesizeSearchResponse } from './services/groq';
import { config } from './config';
import crypto from 'crypto';
import { Response } from 'express';

async function runDatabaseTests() {
  console.log('\n--- 1. Testing PostgreSQL Database ---');
  try {
    // Check connection by running simple select
    console.log('Connecting to database...');
    const connTest = await db.query('SELECT NOW()');
    console.log('✓ Connected successfully at:', connTest.rows[0].now);

    // Insert dummy workspace
    console.log('Inserting mock workspace...');
    const mockTeamId = 'T_TEST_123';
    await db.query(
      `INSERT INTO workspaces (team_id, team_name, bot_token, bot_user_id) 
       VALUES ($1, $2, $3, $4) 
       ON CONFLICT (team_id) DO UPDATE SET team_name = EXCLUDED.team_name`,
      [mockTeamId, 'Mock Workspace', 'xoxb-mock-token', 'U_MOCK_BOT']
    );
    console.log('✓ Mock workspace upserted.');

    // Insert dummy decisions
    console.log('Inserting mock decisions...');
    const messageId1 = '1234567890.111111';
    const messageId2 = '1234567890.222222';
    
    await db.query(
      `INSERT INTO decisions (workspace_id, channel_id, channel_name, message_id, thread_ts, user_id, user_name, category, decision_text, rationale, slack_link, message_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (message_id) DO NOTHING`,
      [mockTeamId, 'C_ENG', 'engineering', messageId1, null, 'U_JOHN', 'John Doe', 'decision', 'We decided to use Redis for job queuing', 'Because BullMQ requires it and it offers low latency.', 'https://slack.com/mock-link-1']
    );

    await db.query(
      `INSERT INTO decisions (workspace_id, channel_id, channel_name, message_id, thread_ts, user_id, user_name, category, decision_text, rationale, slack_link, message_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (message_id) DO NOTHING`,
      [mockTeamId, 'C_ENG', 'engineering', messageId2, null, 'U_SARAH', 'Sarah Connor', 'commitment', 'Sarah will set up the docker-compose template by Friday', 'To allow simple local development bootups.', 'https://slack.com/mock-link-2']
    );
    console.log('✓ Mock decisions inserted.');

    // Test search capabilities (ILIKE and full-text search)
    console.log('Testing search query on mock decisions...');
    const searchQuery = 'Redis';
    const searchRes = await db.query(
      `SELECT * FROM decisions 
       WHERE workspace_id = $1 
         AND (decision_text ILIKE $2 OR rationale ILIKE $2)`,
      [mockTeamId, `%${searchQuery}%`]
    );
    console.log(`✓ Search results found: ${searchRes.rows.length} record(s).`);
    searchRes.rows.forEach((row, i) => {
      console.log(`  [Match ${i+1}] Category: ${row.category} | Text: "${row.decision_text}"`);
    });

    // Clean up test data
    console.log('Cleaning up mock database records...');
    await db.query('DELETE FROM decisions WHERE workspace_id = $1', [mockTeamId]);
    await db.query('DELETE FROM workspaces WHERE team_id = $1', [mockTeamId]);
    console.log('✓ Cleaned up.');

  } catch (error) {
    console.error('❌ Database Test Failed:', error);
  }
}

function runSignatureVerificationTests() {
  console.log('\n--- 2. Testing Slack Signature Verification ---');
  try {
    const signingSecret = config.slack.signingSecret || 'test-signing-secret';
    // Back up config secret and assign test secret
    const originalSecret = config.slack.signingSecret;
    config.slack.signingSecret = signingSecret;

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const rawBody = '{"type":"url_verification","challenge":"hello_world"}';
    const baseString = `v0:${timestamp}:${rawBody}`;
    
    const hmac = crypto.createHmac('sha256', signingSecret);
    const validSignature = `v0=${hmac.update(baseString).digest('hex')}`;

    console.log('Testing with valid signature headers...');
    let nextCalled = false;
    const reqMock: any = {
      headers: {
        'x-slack-signature': validSignature,
        'x-slack-request-timestamp': timestamp
      },
      rawBody: rawBody
    };
    const resMock: any = {
      status: (code: number) => ({
        send: (msg: string) => {
          throw new Error(`Should not send response on success: ${code} - ${msg}`);
        }
      })
    };
    const nextMock = () => { nextCalled = true; };

    verifySlackSignature(reqMock, resMock as Response, nextMock);
    console.log(nextCalled ? '✓ Signature verification passed successfully!' : '❌ Next was not called.');

    console.log('Testing replay attack protection...');
    const oldTimestamp = (Math.floor(Date.now() / 1000) - 400).toString(); // 6 mins ago
    const oldBaseString = `v0:${oldTimestamp}:${rawBody}`;
    const oldHmac = crypto.createHmac('sha256', signingSecret);
    const oldSignature = `v0=${oldHmac.update(oldBaseString).digest('hex')}`;
    
    let errorStatus = 0;
    const reqOldMock: any = {
      headers: {
        'x-slack-signature': oldSignature,
        'x-slack-request-timestamp': oldTimestamp
      },
      rawBody: rawBody
    };
    const resOldMock: any = {
      status: (code: number) => {
        errorStatus = code;
        return { send: (msg: string) => {} };
      }
    };
    
    verifySlackSignature(reqOldMock, resOldMock as Response, nextMock);
    if (errorStatus === 401) {
      console.log('✓ Successfully blocked expired timestamp signature (Replay Attack).');
    } else {
      console.log('❌ Failed to block expired timestamp signature. Status code:', errorStatus);
    }

    // Restore original config
    config.slack.signingSecret = originalSecret;
  } catch (error) {
    console.error('❌ Signature Verification Test Failed:', error);
  }
}

async function runGroqLLMTests() {
  console.log('\n--- 3. Testing Groq LLM Services ---');
  if (!config.groq.apiKey || config.groq.apiKey === 'gsk_your_groq_api_key_here') {
    console.log('⚠️ Skipping Groq LLM check: Valid GROQ_API_KEY is not defined in .env.');
    return;
  }

  try {
    console.log('Testing Groq classification...');
    const mockMsg = 'I will build the postgres database tables by Friday and deploy it, because we need to persist workspace authorizations. @U98765 is leading it.';
    console.log(`Sending message: "${mockMsg}"`);
    
    const extraction = await classifyAndExtractDecision(mockMsg, 'U12345');
    console.log('✓ Received response from Groq:');
    console.log(JSON.stringify(extraction, null, 2));

    console.log('\nTesting RAG answer synthesis...');
    const dummyDecisions = [
      {
        workspace_id: 'T_MOCK',
        channel_id: 'C_MOCK',
        channel_name: 'development',
        message_id: '1',
        thread_ts: null,
        user_id: 'U12345',
        user_name: 'Jane Doe',
        category: 'decision' as const,
        decision_text: 'We decided to choose PostgreSQL over MongoDB.',
        rationale: 'Postgres provides better relations, ACID compliance, and full text search indexes.',
        slack_link: 'https://workspace.slack.com/archives/C123/p1',
        message_date: new Date(),
      }
    ];

    const answer = await synthesizeSearchResponse('Why did we pick Postgres?', dummyDecisions);
    console.log('✓ Synthesized response text:');
    console.log(`----------------------------------------\n${answer}\n----------------------------------------`);
  } catch (error) {
    console.error('❌ Groq LLM Test Failed:', error);
  }
}

async function main() {
  console.log('Starting Recall verification script...');
  await runDatabaseTests();
  runSignatureVerificationTests();
  await runGroqLLMTests();
  
  // Close the DB connection pool so script exits cleanly
  await pool.end();
  console.log('\nVerification run finished. Connection pool closed.');
}

main().catch(console.error);
