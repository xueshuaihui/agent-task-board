-- 0919 需求：云端市场（1.md 第九章 9.1-9.5 + 8.8 技能源 + 2.md 十二/十三/十四章原型）。
-- 约定与 0002/0003 一致：JSON 列在 SQLite 里是 TEXT，服务层 parse/stringify；
-- listing 全局共享（无 account_id 隔离），订阅/评分/评论/收藏/反馈/举报按账号。
-- 市场订阅落地的本地技能用 skills.source='market' 标记（列在本迁移里补）。

CREATE TABLE market_listings (
  id                   TEXT PRIMARY KEY,
  slug                 TEXT NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  category             TEXT NOT NULL DEFAULT '',
  tags                 TEXT NOT NULL DEFAULT '[]',
  type                 TEXT NOT NULL
                       CHECK (type IN ('prompt','steps','flow','script','knowledge','composite','workflow')),
  source               TEXT NOT NULL DEFAULT 'published'
                       CHECK (source IN ('builtin','published')),
  license              TEXT NOT NULL DEFAULT '',
  compatible_clients   TEXT NOT NULL DEFAULT '[]',
  content              TEXT NOT NULL DEFAULT '{"blocks":[],"entryBlockId":null}',
  mcp_dependencies     TEXT NOT NULL DEFAULT '[]',
  current_version      TEXT NOT NULL DEFAULT 'v0.1.0',
  publisher_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'PENDING_REVIEW'
                       CHECK (status IN ('PENDING_REVIEW','PUBLISHED','REJECTED','DELISTED','UNLISTED')),
  review_note          TEXT NOT NULL DEFAULT '',
  rating_avg           REAL NOT NULL DEFAULT 0,
  rating_count         INTEGER NOT NULL DEFAULT 0,
  subscriber_count     INTEGER NOT NULL DEFAULT 0,
  view_count           INTEGER NOT NULL DEFAULT 0,
  published_at         TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- slug 同库唯一（跨账号），发布时服务层 slugify + 冲突加后缀
CREATE UNIQUE INDEX uniq_market_listings_slug ON market_listings(slug);
CREATE INDEX idx_market_listings_status ON market_listings(status, category);
CREATE INDEX idx_market_listings_publisher ON market_listings(publisher_account_id);

CREATE TABLE market_subscriptions (
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id       TEXT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  snapshot_content TEXT NOT NULL DEFAULT '{"blocks":[],"entryBlockId":null}',
  snapshot_version TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'SYNCED'
                   CHECK (status IN ('SYNCED','HAS_UPDATE','DELISTED')),
  -- 订阅时在本账号 skills 表落地的本地技能；本地技能被删则置空（9.4 快照仍在）
  skill_id         TEXT REFERENCES skills(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, listing_id)
);

CREATE INDEX idx_market_subscriptions_account ON market_subscriptions(account_id, status);

CREATE TABLE market_ratings (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  score      INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, listing_id)
);

CREATE TABLE market_comments (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_market_comments_listing ON market_comments(listing_id);

CREATE TABLE market_favorites (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, listing_id)
);

CREATE TABLE market_reports (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE market_feedbacks (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  listing_id      TEXT NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','FIXED_PENDING_VERIFY','RESOLVED','WONTFIX')),
  author_response TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at    TEXT
);

CREATE INDEX idx_market_feedbacks_account ON market_feedbacks(account_id);
CREATE INDEX idx_market_feedbacks_listing ON market_feedbacks(listing_id);

-- 8.8 技能源标记：市场订阅落地的本地技能 source='market'，内置/本地创作/第三方沿用各自值
ALTER TABLE skills ADD COLUMN source TEXT NOT NULL DEFAULT 'local';
