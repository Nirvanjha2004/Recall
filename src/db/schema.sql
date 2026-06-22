-- Create workspaces table for Slack installations
CREATE TABLE IF NOT EXISTS workspaces (
    id SERIAL PRIMARY KEY,
    team_id VARCHAR(50) UNIQUE NOT NULL,
    team_name VARCHAR(100),
    bot_token VARCHAR(255) NOT NULL,
    bot_user_id VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create decisions table to store decision memory
CREATE TABLE IF NOT EXISTS decisions (
    id SERIAL PRIMARY KEY,
    workspace_id VARCHAR(50) NOT NULL REFERENCES workspaces(team_id) ON DELETE CASCADE,
    channel_id VARCHAR(50) NOT NULL,
    channel_name VARCHAR(100),
    message_id VARCHAR(50) UNIQUE NOT NULL, -- message ts from Slack
    thread_ts VARCHAR(50),                  -- parent thread ts if it's a threaded reply
    user_id VARCHAR(50) NOT NULL,           -- user ID who made decision
    user_name VARCHAR(100),                 -- user profile real name/display name
    category VARCHAR(50) NOT NULL,          -- 'decision' | 'commitment' | 'resolved_question'
    decision_text TEXT NOT NULL,            -- summary of decision
    rationale TEXT,                         -- context/reasons behind the decision
    slack_link TEXT,                        -- deep link to Slack message
    message_date TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for workspace lookups
CREATE INDEX IF NOT EXISTS decisions_workspace_idx ON decisions(workspace_id);

-- GIN Full-Text Search index for Postgres search
CREATE INDEX IF NOT EXISTS decisions_search_idx ON decisions 
USING gin(to_tsvector('english', decision_text || ' ' || COALESCE(rationale, '')));
