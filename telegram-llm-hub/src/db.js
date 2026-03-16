import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, '..', 'hub.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    api_key TEXT,
    model TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_local INTEGER NOT NULL DEFAULT 0,
    base_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT 'New Chat',
    provider_name TEXT,
    model TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_id INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'planning',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    position INTEGER NOT NULL DEFAULT 0,
    requires_input INTEGER NOT NULL DEFAULT 0,
    input_question TEXT,
    input_answer TEXT,
    tools_needed TEXT,
    qa_status TEXT NOT NULL DEFAULT 'pending',
    qa_result TEXT,
    execution_log TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    url TEXT,
    title TEXT,
    description TEXT,
    content TEXT,
    source_type TEXT DEFAULT 'link',
    status TEXT NOT NULL DEFAULT 'new',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER PRIMARY KEY,
    config TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS user_state (
    user_id INTEGER PRIMARY KEY,
    active_session_id INTEGER,
    active_board_id INTEGER,
    active_workflow_id INTEGER,
    mode TEXT DEFAULT 'chat',
    awaiting_input TEXT
  );

  CREATE TABLE IF NOT EXISTS gamification (
    user_id INTEGER PRIMARY KEY,
    xp INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 1,
    tasks_completed INTEGER NOT NULL DEFAULT 0,
    boards_created INTEGER NOT NULL DEFAULT 0,
    workflows_run INTEGER NOT NULL DEFAULT 0,
    messages_sent INTEGER NOT NULL DEFAULT 0,
    streak_days INTEGER NOT NULL DEFAULT 0,
    last_active DATE,
    achievements TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workflow_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    node_type TEXT NOT NULL DEFAULT 'process',
    inputs TEXT DEFAULT '[]',
    outputs TEXT DEFAULT '[]',
    config TEXT DEFAULT '{}',
    position INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workflow_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id INTEGER NOT NULL,
    from_node_id INTEGER NOT NULL,
    to_node_id INTEGER NOT NULL,
    from_output TEXT DEFAULT 'default',
    to_input TEXT DEFAULT 'default',
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
    FOREIGN KEY (from_node_id) REFERENCES workflow_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (to_node_id) REFERENCES workflow_nodes(id) ON DELETE CASCADE
  );
`);

// Migrations
try {
  db.prepare("SELECT custom_script FROM workflow_nodes LIMIT 0").get();
} catch {
  db.exec("ALTER TABLE workflow_nodes ADD COLUMN custom_script TEXT DEFAULT NULL");
}

// Add output_type to tasks
try {
  db.prepare("SELECT output_type FROM tasks LIMIT 0").get();
} catch {
  db.exec("ALTER TABLE tasks ADD COLUMN output_type TEXT DEFAULT 'text'");
}

// Add webhook_id to workflows
try {
  db.prepare("SELECT webhook_id FROM workflows LIMIT 0").get();
} catch {
  db.exec("ALTER TABLE workflows ADD COLUMN webhook_id TEXT DEFAULT NULL");
}

// Workflow schedules table
db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    cron_expression TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at DATETIME,
    next_run_at DATETIME,
    run_count INTEGER NOT NULL DEFAULT 0,
    last_status TEXT DEFAULT 'pending',
    last_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workflow_run_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    trigger_type TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'running',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    node_count INTEGER DEFAULT 0,
    passed_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    results TEXT,
    error TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_ws_workflow_id ON workflow_schedules(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_ws_user_id ON workflow_schedules(user_id);
  CREATE INDEX IF NOT EXISTS idx_wrh_workflow_started ON workflow_run_history(workflow_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_wrh_user_id ON workflow_run_history(user_id);

  -- Workflow Templates Marketplace
  CREATE TABLE IF NOT EXISTS workflow_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL DEFAULT 'general',
    tags TEXT DEFAULT '[]',
    nodes_json TEXT NOT NULL,
    edges_json TEXT NOT NULL DEFAULT '[]',
    author TEXT DEFAULT 'system',
    uses INTEGER NOT NULL DEFAULT 0,
    rating REAL NOT NULL DEFAULT 0,
    ratings_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Multi-Model Arena
  CREATE TABLE IF NOT EXISTS arena_battles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    providers TEXT NOT NULL,
    responses TEXT NOT NULL DEFAULT '{}',
    winner TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_arena_user ON arena_battles(user_id);

  -- Persistent Memory / Knowledge Base
  CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_memory_user ON memory(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_user_key ON memory(user_id, key);

  -- Cost Tracker
  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost REAL NOT NULL DEFAULT 0,
    action TEXT DEFAULT 'chat',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage_log(user_id, created_at);

  -- Daily Challenges
  CREATE TABLE IF NOT EXISTS challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    action TEXT NOT NULL,
    target INTEGER NOT NULL DEFAULT 1,
    xp_reward INTEGER NOT NULL DEFAULT 50,
    category TEXT DEFAULT 'general',
    is_daily INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS user_challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    challenge_id INTEGER NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    assigned_date DATE NOT NULL,
    completed_at DATETIME,
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_uc_user_date ON user_challenges(user_id, assigned_date);

  -- Workflow Collaboration / Sharing
  CREATE TABLE IF NOT EXISTS workflow_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    share_token TEXT NOT NULL UNIQUE,
    is_public INTEGER NOT NULL DEFAULT 0,
    fork_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ws_token ON workflow_shares(share_token);

  -- API Key Vault
  CREATE TABLE IF NOT EXISTS vault (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    scope TEXT DEFAULT 'global',
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, key_name)
  );
  CREATE INDEX IF NOT EXISTS idx_vault_user ON vault(user_id);

  -- Plugins
  CREATE TABLE IF NOT EXISTS plugins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    file_path TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT DEFAULT '{}',
    loaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- AI-Generated Projects
  CREATE TABLE IF NOT EXISTS gen_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    tech_stack TEXT DEFAULT 'nodejs',
    keypoints TEXT DEFAULT '[]',
    chat_history TEXT DEFAULT '[]',
    status TEXT DEFAULT 'draft',
    project_path TEXT DEFAULT '',
    run_command TEXT DEFAULT '',
    install_command TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_genproj_user ON gen_projects(user_id);
`);

export default db;
