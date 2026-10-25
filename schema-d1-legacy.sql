-- Legacy username-keyed TaskFlow D1 schema. Retained for rollback/reference.
-- SQLite syntax. Apply this to the single D1 database used by ST-DATABASE.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  username TEXT NOT NULL PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_settings (
  username TEXT NOT NULL PRIMARY KEY,

  light_color TEXT NOT NULL DEFAULT '#344271',
  dark_color TEXT DEFAULT NULL,
  color_palette TEXT NOT NULL DEFAULT '["#344271"]',
  is_dark_mode INTEGER NOT NULL DEFAULT 0,
  is_dim_mode INTEGER NOT NULL DEFAULT 0,
  theme_level INTEGER NOT NULL DEFAULT 0,
  week_calendar_days INTEGER NOT NULL DEFAULT 7,

  enable_animations INTEGER NOT NULL DEFAULT 1,
  confetti_enabled INTEGER NOT NULL DEFAULT 1,
  completion_sounds INTEGER NOT NULL DEFAULT 1,
  popup_overlay_enabled INTEGER NOT NULL DEFAULT 1,
  page_transitions_enabled INTEGER NOT NULL DEFAULT 1,
  smooth_dropdowns_enabled INTEGER NOT NULL DEFAULT 1,
  deletion_fade_enabled INTEGER NOT NULL DEFAULT 1,
  split_view_shift_enabled INTEGER NOT NULL DEFAULT 1,
  button_feedback_enabled INTEGER NOT NULL DEFAULT 1,
  split_task_page INTEGER NOT NULL DEFAULT 1,
  calendar_days INTEGER NOT NULL DEFAULT 1,

  week_start INTEGER NOT NULL DEFAULT 0,
  day_start TEXT NOT NULL DEFAULT '07:00',
  day_end TEXT NOT NULL DEFAULT '20:00',
  timeline_increment INTEGER NOT NULL DEFAULT 15,
  task_creation_increment INTEGER NOT NULL DEFAULT 15,
  future_recurrences INTEGER NOT NULL DEFAULT 2,
  use_military_time INTEGER NOT NULL DEFAULT 0,

  task_notifications TEXT NOT NULL DEFAULT '[]',
  event_notifications TEXT NOT NULL DEFAULT '[]',

  quick_add_only INTEGER NOT NULL DEFAULT 0,
  split_ratio REAL NOT NULL DEFAULT 0.5,
  delete_after_days INTEGER NOT NULL DEFAULT 30,
  -- Settings > General > "Push back past due date": 1 = incomplete tasks keep
  -- rolling forward even past their due date, 0 = they roll only until they
  -- reach it. (Column name predates the due-date feature.)
  task_deadline_push_enabled INTEGER NOT NULL DEFAULT 1,
  -- App-wide typeface label from Settings > General > App font (allow-listed
  -- set of names like 'Inter'/'Times New Roman' or the sentinel 'Default';
  -- see Split Task/src/fonts.js).
  app_font TEXT NOT NULL DEFAULT 'Inter',

  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT NOT NULL,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, username),
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT NOT NULL,
  username TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'task' CHECK (type IN ('task', 'event')),
  title TEXT NOT NULL,
  category_id TEXT NOT NULL DEFAULT 'default',
  item_date TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT,
  notes TEXT,
  -- Task-only pair: the time the task is due on its due date. Legacy rows (and
  -- quick-added tasks) carry the time without a due_date.
  deadline TEXT,
  -- Task-only: the day the task must be done by, 'YYYY-MM-DD'. NULL = no due
  -- date, so the task rolls forward freely. Compared against item_date to flag
  -- an item that push-back has walked onto its deadline.
  due_date TEXT,
  start_time TEXT,
  end_time TEXT,
  location TEXT,
  recurrence TEXT NOT NULL DEFAULT '{}',
  recurrence_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, username),
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT NOT NULL,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  category_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, username),
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT NOT NULL PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- Bookkeeping for the worker's daily sweep (retention cleanup + task
-- deadline push). Stores the last day (UTC) the sweep ran so it only
-- executes once per day even though both the cron trigger and the
-- lazy GET /api/sync path invoke it. The worker also creates this
-- table on demand (CREATE TABLE IF NOT EXISTS), so running this here
-- is optional.
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_categories_username ON categories(username);
CREATE INDEX IF NOT EXISTS idx_notes_username ON notes(username);
CREATE INDEX IF NOT EXISTS idx_items_username ON items(username);
CREATE INDEX IF NOT EXISTS idx_items_username_date ON items(username, item_date);
CREATE INDEX IF NOT EXISTS idx_items_recurrence_id ON items(recurrence_id);
CREATE INDEX IF NOT EXISTS idx_items_username_category ON items(username, category_id);
CREATE INDEX IF NOT EXISTS idx_notes_username_category ON notes(username, category_id);

-- Per-user change counter behind the conditional pull. GET /api/sync?version=N
-- compares N against this row and, when it matches, answers `{ unchanged: true }`
-- WITHOUT reading the user's items/categories/settings - so an idle client costs
-- two tiny lookups instead of three result sets. Every POST /api/sync write
-- bumps it by one, which is also what tells a user's other devices to re-fetch.
-- The worker creates this table on demand (ensureSchema), so running this here
-- is optional.
CREATE TABLE IF NOT EXISTS user_versions (
  username TEXT NOT NULL PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);
