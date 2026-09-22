> 本技能由千问工作台技能降级迁移，原平台专属能力不可用。

# News Summary


## Overview

本 skill **以国内中文 RSS 为主**，面向「国内/中文简报 + 可选国际热点（通过中新网国际频道等）」；**不是**「国际媒体专题 skill」。执行时 **勿**因英文 description 或用户随口说「世界局势」就改去 BBC、Reuters、Guardian 等——**本文列出的源才是规范信源**；若用户明确只要外电，可单独说明并自行选用其它工具，但**默认 workflow 仍用下文 RSS**。


**勿使用**：新华网英文版 `…/english/rss/*.xml`（条目长期停在 2017–2018）、人民网 `people.com.cn/rss/*.xml`（频道已长期不更新）、财新 `caixin.com/rss/home.xml`（返回 404 网页而非 RSS）、央视网旧 `news.cctv.com/rss/`（多为 404）等——避免「能连上但无当日新闻」或假 RSS。

## RSS 源（当前可用 + 内容在更新）

以下每条均可单独复制执行；`-A` 为建议 UA（可按环境改写）。

### 中新网（中文 · 主源）

```bash
# 国际热点（中新网「国际」频道，稿件多为中文；不是让你改用 BBC/Reuters）
curl -sSL -A "Mozilla/5.0 (compatible; NewsBot/1.0)" "https://www.chinanews.com/rss/world.xml"

# 国内 / 时政要闻
curl -sSL -A "Mozilla/5.0 (compatible; NewsBot/1.0)" "https://www.chinanews.com/rss/china.xml"

# 即时滚动
curl -sSL -A "Mozilla/5.0 (compatible; NewsBot/1.0)" "https://www.chinanews.com/rss/scroll-news.xml"

# 财经
curl -sSL -A "Mozilla/5.0 (compatible; NewsBot/1.0)" "https://www.chinanews.com/rss/finance.xml"
```

### 36氪（科技与商业）

```bash
curl -sSL -A "Mozilla/5.0 (compatible; NewsBot/1.0)" "https://36kr.com/feed"
```

### 爱范儿（科技消费）

```bash
curl -sSL -A "Mozilla/5.0 (compatible; NewsBot/1.0)" "https://www.ifanr.com/feed"
```

### 少数派（数字生活 / 效率）

```bash
curl -sSL -A "Mozilla/5.0 (compatible; NewsBot/1.0)" "https://sspai.com/feed"
```

## 拉取前自检（推荐）

确认拿到的是 XML 且日期为最近几天：

```bash
UA='Mozilla/5.0 (compatible; NewsBot/1.0)'
curl -sSL -A "$UA" "https://www.chinanews.com/rss/world.xml" | grep -oE '<pubDate>[^<]+</pubDate>' | head -5
```

若几乎没有近期 `pubDate`，或正文是 HTML（含「404」「页面不存在」），**放弃该 URL**，不要写入简报。

## Parse RSS（示例）

```bash
UA='Mozilla/5.0 (compatible; NewsBot/1.0)'
curl -sSL -A "$UA" "https://www.chinanews.com/rss/world.xml" | \
  grep -E "<title>|<description>" | \
  sed 's/<[^>]*>//g' | \
  sed 's/^[ \t]*//' | \
  head -30
```

# ① 将摘要写入文本文件（用 'EOF' 单引号防止 shell 变量展开）
cat > summary.txt << 'EOF'
（此处粘贴你的新闻摘要全文，支持任意中文、标点、换行）
EOF
