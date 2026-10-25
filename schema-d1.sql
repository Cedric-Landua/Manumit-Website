-- Shared Manumit D1 schema for the shared-account architecture.
-- Apply only to a new D1 database after preparing the account import.

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleting')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_identities (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  identifier TEXT NOT NULL,
  normalized_identifier TEXT NOT NULL,
  credential_hash TEXT,
  credential_scheme TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, normalized_identifier)
);

CREATE INDEX idx_user_identities_user ON user_identities(user_id);

CREATE TABLE products (
  key TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
);

INSERT INTO products (key, name) VALUES
  ('split-task', 'Split Task'),
  ('study-app', 'Study App');

CREATE TABLE user_products (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_key TEXT NOT NULL REFERENCES products(key),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, product_key)
);

CREATE INDEX idx_user_products_product ON user_products(product_key, status);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE organization_memberships (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'suspended')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX idx_organization_memberships_user ON organization_memberships(user_id, status);

CREATE TABLE organization_products (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_key TEXT NOT NULL REFERENCES products(key),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, product_key)
);

CREATE TABLE split_task_settings (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  light_color TEXT NOT NULL DEFAULT '#344271',
  dark_color TEXT,
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
  task_deadline_push_enabled INTEGER NOT NULL DEFAULT 1,
  app_font TEXT NOT NULL DEFAULT 'Inter',
  secure_notes_wrapped_key TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE split_task_categories (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE split_task_items (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'task' CHECK (type IN ('task', 'event')),
  title TEXT NOT NULL,
  category_id TEXT NOT NULL DEFAULT 'default',
  item_date TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT,
  notes TEXT,
  deadline TEXT,
  due_date TEXT,
  start_time TEXT,
  end_time TEXT,
  location TEXT,
  recurrence TEXT NOT NULL DEFAULT '{}',
  recurrence_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE split_task_notes (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  category_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  hidden INTEGER NOT NULL DEFAULT 0,
  text_is_encrypted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE split_task_sync_versions (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX idx_split_task_items_user_date ON split_task_items(user_id, item_date);
CREATE INDEX idx_split_task_items_user_category ON split_task_items(user_id, category_id);
CREATE INDEX idx_split_task_items_user_recurrence ON split_task_items(user_id, recurrence_id);
CREATE INDEX idx_split_task_notes_user_category ON split_task_notes(user_id, category_id);
