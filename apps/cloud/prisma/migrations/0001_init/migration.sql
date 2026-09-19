-- 0001 云端市场初始结构：云账号 + 市场全流程（发布/版本/订阅/评分/评论/收藏/举报/反馈）。
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  algo TEXT NOT NULL DEFAULT 'scrypt',
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('MEMBER','ADMIN')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE market_listings (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  type TEXT NOT NULL,
  license TEXT NOT NULL DEFAULT '',
  compatible_clients TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL DEFAULT '{}',
  mcp_dependencies TEXT NOT NULL DEFAULT '[]',
  current_version TEXT NOT NULL DEFAULT '0.1.0',
  publisher_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED','DELISTED')),
  rating_avg REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  subscriber_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_market_listings_status ON market_listings(status);
CREATE INDEX idx_market_listings_publisher ON market_listings(publisher_account_id);

CREATE TABLE market_listing_versions (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '{}',
  changelog TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_market_versions_listing ON market_listing_versions(listing_id, created_at);

CREATE TABLE market_subscriptions (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  snapshot_content TEXT NOT NULL DEFAULT '{}',
  snapshot_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SYNCED' CHECK (status IN ('SYNCED','HAS_UPDATE','DELISTED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, listing_id)
);
CREATE INDEX idx_market_subs_listing ON market_subscriptions(listing_id);

CREATE TABLE market_ratings (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, listing_id)
);

CREATE TABLE market_comments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_market_comments_listing ON market_comments(listing_id, created_at);

CREATE TABLE market_favorites (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, listing_id)
);

CREATE TABLE market_reports (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE market_feedbacks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','FIXED_PENDING_VERIFY','RESOLVED','WONTFIX')),
  author_response TEXT NOT NULL DEFAULT '',
  responded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_market_feedbacks_listing ON market_feedbacks(listing_id);
CREATE INDEX idx_market_feedbacks_account ON market_feedbacks(account_id);
