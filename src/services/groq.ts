import Groq from 'groq-sdk';
import { config } from '../config';
import { GroqExtractionResult, Decision } from '../types';

let groqClient: Groq | null = null;

function getGroqClient(): Groq {
  if (!groqClient) {
    if (!config.groq.apiKey) {
      throw new Error('GROQ_API_KEY is not configured.');
    }
    groqClient = new Groq({ apiKey: config.groq.apiKey });
  }
  return groqClient;
}

/**
 * Classifies a Slack message to see if it represents a decision, commitment, or resolved question.
 * Extracts details if it is.
 */
export async function classifyAndExtractDecision(
  messageText: string,
  senderId: string,
  threadHistory: string[] = []
): Promise<GroqExtractionResult> {
  try {
    const client = getGroqClient();
    
    const contextStr = threadHistory.length > 0 
      ? `\n\nThread Context (previous messages for context, ordered oldest to newest):\n${threadHistory.join('\n')}`
      : '';

    const systemPrompt = `You are an AI assistant designed to extract organization knowledge from Slack messages.
Analyze the message (and any provided thread context) to determine if it contains:
1. A decision (e.g., "We will use PostgreSQL", "We decided to delay the release")
2. A commitment/action item (e.g., "@john will fix the API login issue by Tuesday", "I will write the docs")
3. A resolved question (e.g., Question: "Why are tests failing?", Answer: "@sarah: because DB credentials expired" -> resolved decision/explanation of why something is the way it is).

You MUST return a JSON object with the following fields:
{
  "isDecision": boolean (true if it matches one of the categories above, false otherwise),
  "category": "decision" | "commitment" | "resolved_question" | null,
  "decisionText": "A clear, concise, self-contained summary of the decision, commitment, or resolved question (do not include meta prefix like 'We decided that...'). Make it understandable stand-alone.",
  "rationale": "The reasons, context, or why behind this choice, if explicitly mentioned in the text. Null if not mentioned.",
  "ownerId": "The Slack user ID who is responsible for the commitment, who made the decision, or who answered the question. Look for Slack user ID formats like 'U12345678' or '@U12345678' mentioned. If the sender says 'I will do X' or makes the decision directly, use the sender's user ID: '${senderId}'. If unspecified, use the sender's user ID."
}

Rules:
- Be strict. Informal chats like "let's have lunch", "good job", "thanks" are NOT decisions/commitments.
- If it is not a clear decision, commitment, or resolution, set isDecision to false.
- Ensure the JSON is valid. Do not include markdown code block formatting like \`\`\`json. Output ONLY the JSON.`;

    const userContent = `Message Sender User ID: ${senderId}
Slack Message: "${messageText}"${contextStr}`;

    const chatCompletion = await client.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      model: 'llama-3.3-70b-versatile', // Llama 3.3 70B is highly capable of JSON output and accurate reasoning
      response_format: { type: 'json_object' },
      temperature: 0.1, // low temperature for consistent JSON and high accuracy
    });

    const content = chatCompletion.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Groq returned empty response');
    }

    const parsed: GroqExtractionResult = JSON.parse(content);
    
    // Clean up ownerId format (remove '@', '<', '>', etc.)
    if (parsed.ownerId) {
      parsed.ownerId = parsed.ownerId.replace(/[<@>]/g, '').trim();
    }
    
    return parsed;
  } catch (error) {
    console.error('Error in Groq classification service:', error);
    return {
      isDecision: false,
      category: null,
      decisionText: null,
      rationale: null,
      ownerId: null,
    };
  }
}

/**
 * Synthesizes a response to a search query based on a list of matching decisions (RAG pipeline).
 */
export async function synthesizeSearchResponse(
  query: string,
  decisions: Decision[]
): Promise<string> {
  if (decisions.length === 0) {
    return `🔍 I searched Recall's memory database but couldn't find any recorded decisions related to: *"${query}"*.\n\n_Tip: If this was decided in a channel, make sure the Recall bot is invited to it!_`;
  }

  try {
    const client = getGroqClient();

    const decisionListStr = decisions.map((d, index) => {
      const dateStr = d.message_date ? new Date(d.message_date).toLocaleDateString() : 'unknown date';
      return `[Decision ${index + 1}]:
- Type: ${d.category.toUpperCase()}
- What was decided: ${d.decision_text}
- Rationale: ${d.rationale || 'None specified'}
- Decided by: <@${d.user_id}> (${d.user_name || 'unknown'})
- Date: ${dateStr}
- Channel: #${d.channel_name || 'unknown'}
- Link: ${d.slack_link || 'No link available'}`;
    }).join('\n\n');

    const systemPrompt = `You are Recall, the team's Decision Memory assistant. 
Your goal is to answer the user's question using the captured decisions below.
Provide a concise, professional, synthesized answer based ONLY on the provided decisions. 

Formatting Rules:
- Mention WHO made the decision (format as <@user_id> if available, or name), WHEN, and WHY (rationale).
- Include the Slack link as a markdown link so the user can easily jump to the thread (e.g. "<https://slack.com/...|Jump to Slack Thread>" using Slack link formatting: <URL|text>). Note: Slack slash commands require the <URL|text> link format, NOT markdown [text](URL).
- Keep the response short and readable. Use bullet points if referencing multiple decisions.
- If the query cannot be answered using the provided decisions, say so politely. Do not make up facts.`;

    const userContent = `User Query: "${query}"

Available Captured Decisions:
${decisionListStr}`;

    const chatCompletion = await client.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
    });

    const responseText = chatCompletion.choices[0]?.message?.content;
    if (!responseText) {
      return `🔍 I found matching records but had an issue generating an answer. Here is a quick link to the decision:\n• *${decisions[0].decision_text}* (by <@${decisions[0].user_id}> in #${decisions[0].channel_name}) - <${decisions[0].slack_link}|Thread>`;
    }

    return responseText;
  } catch (error) {
    console.error('Error in Groq search synthesis:', error);
    return `⚠️ Error generating answer. Found ${decisions.length} matching decisions:\n` + 
      decisions.map(d => `• *${d.decision_text}* (<${d.slack_link}|Jump to thread>)`).join('\n');
  }
}
