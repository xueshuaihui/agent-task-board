-- 0919 云端市场对接层：
-- 1) market_listings.source 词表放宽：新增 'cloud'（云端来源影子 listing，订阅落地用）。
--    SQLite 无法修改 CHECK，按 0005 的先例整表重建。
-- 2) 新增 cloud_listing_id：本地发布上云后记云端 listing id；云端影子 listing 也用它存云端原始 id。
-- 重建期间外键已由 bootstrap 关闭（PRAGMA foreign_keys = OFF），订阅/评分/评论等子表引用不动。

CREATE TABLE market_listings_new (
  id                   TEXT PRIMARY KEY,
  slug                 TEXT NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  category             TEXT NOT NULL DEFAULT '',
  tags                 TEXT NOT NULL DEFAULT '[]',
  type                 TEXT NOT NULL
                       CHECK (type IN ('prompt','steps','flow','script','knowledge','composite','workflow')),
  source               TEXT NOT NULL DEFAULT 'published'
                       CHECK (source IN ('builtin','published','cloud')),
  cloud_listing_id     TEXT,
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

INSERT INTO market_listings_new
  (id, slug, name, description, category, tags, type, source, cloud_listing_id, license,
   compatible_clients, content, mcp_dependencies, current_version, publisher_account_id,
   status, review_note, rating_avg, rating_count, subscriber_count, view_count,
   published_at, created_at, updated_at)
SELECT
  id, slug, name, description, category, tags, type, source, NULL, license,
  compatible_clients, content, mcp_dependencies, current_version, publisher_account_id,
  status, review_note, rating_avg, rating_count, subscriber_count, view_count,
  published_at, created_at, updated_at
FROM market_listings;

DROP TABLE market_listings;
ALTER TABLE market_listings_new RENAME TO market_listings;

CREATE UNIQUE INDEX uniq_market_listings_slug ON market_listings(slug);
CREATE INDEX idx_market_listings_status ON market_listings(status, category);
CREATE INDEX idx_market_listings_publisher ON market_listings(publisher_account_id);
CREATE INDEX idx_market_listings_cloud ON market_listings(cloud_listing_id);
