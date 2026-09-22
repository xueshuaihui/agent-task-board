# Guizang Social Card Skill

Create polished social card packages for Xiaohongshu/Rednote, WeChat Official Account, article covers, and platform thumbnails.

This skill is self-contained. It borrows visual principles from the Guizang PPT style system, but it must not edit the original PPT skill, its templates, or its references. If the original PPT skill is available, you may read it for reference only.

Generated work must live in a task folder, not in the skill root. Default to `local-tests/<slug>/` inside this repository, or use the explicit output folder requested by the user. In the openclaw gateway runtime, put the task folder under `/root/userdata/workspace/social_card/<slug>/` instead, so all artifacts stay inside `/root/userdata` and the outbound pipeline can deliver them. Do not create root-level task folders such as `social-card-*`, `livephoto-*`, `wechat-*`, `output/`, or loose rendered assets next to `SKILL.md`.

## What To Produce

Use this skill for:

- Social card / carousel image sets: cover plus content pages, especially Xiaohongshu/Rednote 3:4.
- Short Live Photo motion cards when the user asks for Live Photo / 实况照片 and supplies video evidence or screen recordings.
- Material-first Live Photo puzzle layouts when the user has high-quality video assets and wants single-video, two-grid, three-grid, or four-grid motion cards with little or no added text.
- Triple Live Photo collages when the user has three short videos, three results, three viewpoints, or a high-information comparison that should stay inside one image-card unit.
- Long-video intake for Live Photo: diagnose whether to trim, speed up, split into a triple collage, or ask the user for a specific time range before rendering.
- WeChat Official Account cover pairs: one `21:9` main cover plus one `1:1` square cover, composed together in the same HTML for visual checking.
- Screenshot-heavy product posts, article covers, tutorial carousels, outdoor/lifestyle notes, AI/product update explainers.
- Social images that need Guizang-style Swiss or editorial magazine layouts.

Do not use this skill for:

- Full slide decks or horizontal PPT websites. Use the PPT skill for that.
- Long-form video generation. Use a video skill for that. This skill only supports short, layout-bound Live Photo cards that replace a still image slot with video.
- Pure image editing with no layout or article extraction requirement.

### Rednote Category Capability (capability circle)

The 11 most-common Rednote (小红书) categories fall into three buckets. See `references/category-cookbook.md` for the recipe-by-recipe routing.

**Strong end-to-end** (text, structure, and image story all in scope):

- 旅行 (Travel), 职场 (Workplace), 推荐 (Recommended, after specifying a subtype).

**Strong on text & structure; image needs to come from the user or a sourced library:**

- 游戏 (Game), 影视 (Film/TV), 美食 食谱方向 (Food — recipes only), 彩妆 教程方向 (Makeup — tutorials only), 健身 (Fitness), 家居 (Home), 穿搭 精选方向 (Outfit — capsule/essay only).

**Outside scope — push back honestly rather than promise a result:**

- 美食 菜品大片摆盘 (food-photography showcase).
- 穿搭 日常 OOTD 全身 (daily OOTD body shots; we cannot generate or simulate).
- 情感 梦核 / 氛围感装饰风 (dreamcore / aesthetic-light styling — clashes with both Editorial and Swiss).
- Y2K / 千禧辣妹 / 哥特萝莉 / kawaii decorated aesthetics.
- Pure photography showcase posts where the image is the entire deliverable.

When a request falls in the third bucket, name what we cannot do at intake — do not silently retrofit a layout that misses the user's intent.

## Core Principle

Expression comes first. The goal is not to squeeze text into posters; it is to turn the source into a clear visual argument.

For each page, decide:

- What should the viewer understand in one glance?
- What evidence, screenshot, or image supports it?
- Which words must be large, and which can become captions or metadata?
- What can be removed because it belongs in the post body, not the image?

## Workflow

### 1. Intake

Gather only the missing information that changes the output:

- Target platforms and ratios.
- Source text, subtitles, article, or title.
- **Rednote category** — if the user names one of the 11 common types (旅行 / 职场 / 游戏 / 影视 / 美食 / 彩妆 / 穿搭 / 家居 / 健身 / 情感 / 推荐), route via `references/category-cookbook.md` to find the right recipes and to confirm the request is inside the capability circle (see "Rednote Category Capability" above). If a request lands in the outside-scope bucket, surface that to the user **before** designing, do not silently retrofit.
- Supplied images/screenshots and where each should appear. **For News / Tutorial / Data / Review content, actively prompt for screenshots or photos** — they are the evidence layer. A poster with no real artifact tends to read as filler.
- Supplied video assets, if the user asks for Live Photo. Treat user-provided video as the normal path; web-sourced free video is only for demo/promo cases or when the user explicitly asks for sourced material. Confirm the target platform because duration differs: Xiaohongshu supports `5s`; WeChat Official Account Live Photo should stay at `3s` and must be uploaded from iPhone. Before cutting, read `references/live-photo-production.md` and classify the request as single Live Photo, triple collage, or long-video intake. If the source is too long or contains multiple usable moments, do a low-cost diagnosis first, then ask once whether to trim, speed up, split into multiple wells, or use a user-specified time range. If the source is shorter than the target duration, ask whether to provide a longer clip, accept a shorter Live Photo, or explicitly allow a hold/slowdown. If the important focus is ambiguous, suggest possible crop/enlarge options but let the user decide before executing.
- **If the user supplies only text (no images at all), ask once before designing:**

  ```
  这篇我需要 1-2 张图。三种走法：
  A. 你自己有照片 / 截图，传给我（推荐——最不“AI 感”）
  B. 我用 image-search skill 去找（真实产品 / 建筑 / 人物）
  C. 用 AI 生图
  ```

  Recommend A in one line — your own photo is what makes a poster not look AI-generated. Accept whatever the user picks (including "都行你看着办") and proceed. **Do not re-prompt later, do not keep nudging toward A across multiple turns.** This question is one-shot.
- Preferred style if specified: Swiss Style, magazine/editorial, tech, outdoor, etc.
- Hard constraints: title text, no image on 1:1 cover, must include a hardware photo, keep screenshot readable, and so on.

If the user has already supplied enough context, proceed with reasonable assumptions.

If the content involves current product releases, policies, prices, claims, or news, verify unstable facts with browsing and cite sources in the final response.

### 2. Extract The Story

Turn the source into a page plan before designing.

For Rednote:

- Page 1 is the cover hook.
- Pages 2-N each carry one idea only.
- Use 5-9 pages for most posts. Compress or combine pages when lower areas become empty.
- Keep the post body for nuance; images should carry hooks, comparisons, checklists, and sharp takeaways.

For WeChat:

- Always produce a paired system: `21:9` main cover and `1:1` square cover.
- Build both covers in the same HTML file and add a combined preview section so their visual relationship can be checked together.
- `21:9` keeps the full or near-full title, subtitle, and one strong visual relation.
- `1:1` uses a simplified short title derived from the long title: big centered type, no image by default, no cramped subtitles.

### 3. Choose Style Mode

Pick one mode per package. **The two systems are not bound to specific content types** — what changes is the visual stance, not which topic you can talk about. A workplace essay can be Editorial; a travel ledger can be Swiss. Pick by the feeling you want, not by category lookup.

**Editorial Magazine x E-ink** brings:

- Serif/Songti display + quiet sans body, paper + ink palette.
- Atmosphere layer (paper grain / ink wash / WebGL canvas) over a warm paper base.
- Ledger rows, marginalia, pull quotes, large photo wells — magazine-feature feel.
- Best when you want the page to feel slow, considered, hand-set.

**Swiss International** brings:

- Inter / Helvetica feel, very light display at large sizes, mono labels at small.
- Strict left-aligned grid, hairline rules, one high-saturation accent.
- Card-fill matrices, KPI towers, h-bar charts, numbered statements — system / data feel.
- Best when you want the page to feel engineered, quantified, decisive.

If both feel viable for a piece of content, the question becomes editorial intent: "is this a feature story or a release note?" That decides the mode, not the topic itself.

Do not mix the two visual systems inside the same image set unless the user explicitly asks for a hybrid.

Then pick one theme:

- Editorial Magazine x E-ink uses one of 6 magazine palettes: Ink Classic, Indigo Porcelain, Forest Ink, Kraft Paper, Dune, or Midnight Ink (the only dark variant; reserved for game key art / night photography / cinematic covers).
- Swiss International uses one of 4 accent palettes: IKB Blue, Lemon Yellow, Lemon Green, or Safety Orange.

Read `references/theme-presets.md` for exact CSS tokens. Do not invent arbitrary colors unless the user has a strict brand requirement.

### 4. Plan Pages

Create a concise internal plan:

```text
Page 01 / cover / hook / image source / layout intent
Page 02 / point / key copy / visual evidence / layout intent
...
（超长示例代码，迁移时略去）text
<query>xxx</query><route>aigc</route><ratio>W*H</ratio>
```

- **`<query>` 一律用中文**（品牌名 / 专有名词可保留原文），用完整一段生图描述，细节可以多一些（主体 / 风格 / 光线 / 构图 / “无文字无 logo” 等约束）。
- `route=aigc` — 生图。**必须带 `<ratio>`，默认 `768*768`。**
- `<ratio>` 格式严格为 `W*H`（星号分隔的正整数，如 `768*1024`；不是 `768x1024`），两条硬边界：
  - 总像素 `W×H` 须在 `[768*768=589824, 4096*4096=16777216]` 之间。例如 `512*512` 太小、`4500*4500` 太大，都非法。
  - 宽高比 `W:H` 须在 `[1:8, 8:1]` 之间。例如 `7680*768`（10:1）非法。
  - 脚本会在提交前做兜底校验（格式 / 像素 / 宽高比），非法值直接拒绝不会发给服务端；但不要依赖报错重试，写 query 时就按边界给值。
  - 尽量贴合目标图槽：3:4 用 `768*1024`，1:1 用 `768*768`，21:9 用 `2016*864`。

Call example:

```bash
# 生图（route=aigc，ratio 必填；query 用中文写完整一段描述）
python3 -u {skill-root}/scripts/run_image_source_task.py \
  --query "<query>杂志纪实风照片，夏季山间徒步小径，清晨薄雾，柔和自然光，构图干净留白充足，无文字无 logo</query><route>aigc</route><ratio>768*1024</ratio>"
```

Handling results:

- The script always submits with **`storage: "claw"`**, so deliverables are written as local files under `/root/userdata` (default output dir: `/root/userdata/workspace/social_card_assets/`; override with `--dest-path`, which must also be under `/root/userdata`). Local files are what this skill wants — the deck is rendered to PNG by Playwright, so a local image cannot break on a flaky network.
- The script prints one `MEDIA:<absolute path>` line per deliverable, plus a `🖼 <filename> → <path>` line on stderr so you can tell which image belongs in which slot.
- Copy each delivered image into the task folder's `assets/` directory and name the file by purpose, not by hash: `assets/hero-mountain.jpg`, `assets/ui-pulse-card.png`. Reference them from the HTML with the relative `assets/...` path, never with the `/root/userdata` absolute path.
- If the generated images themselves are the thing the user asked to see (e.g. they want to pick from candidates before composing), echo the `MEDIA:` lines verbatim in your reply — `MEDIA:` lines are the only legal way to show media, same as other skills. Never use Markdown image syntax or bare paths.
- Record the provenance in `assets/SOURCES.md` next to the images (one line per file): `hero-mountain.jpg ← aigc: <prompt>` or `hero-mountain.jpg ← search: <source/tool> <keywords>`. Always do this — it preserves provenance for the human author.
- If no deliverable line comes back at all, the task produced nothing: report the script error to the user instead of falling back to a placeholder.

### 7. Deliver

**Show user first, validate on request.** Auto-running the validator after every render takes too long and delays the user from seeing results. Default flow:

1. After rendering completes, immediately show the user the rendered images with a one-sentence summary of what was built. **Output format is aligned with other skills (e.g. visual-agent): each deliverable is one `MEDIA:<absolute path>` line, all `MEDIA:` lines come first in the reply, then the text summary.** Never use Markdown image syntax, HTML tags, or bare paths; paths must be copied verbatim from the actual files on disk. In the gateway runtime the files must live under `/root/userdata` (the task folder rule above guarantees this) or the pipeline cannot deliver them.
2. Ask one question: **"先你自己看，还是我先自动核查一遍？"** (Do you want to review first, or should I run the auto-check?)
3. If the user says "我自己看" / "先给我" / "no need" — stop here, let them inspect, and respond to whatever they raise.
4. If the user says "你查吧" / "auto-check" / "yes" — only then run `node validate-social-deck.mjs <task-dir>`, fix any FAIL, and re-render before final delivery. Mention density/cap WARNs.

Never silently run the validator before showing the user — it costs minutes per pass and the user often spots issues faster.

Final response (after the user has reviewed or asked for auto-check) should include:

- All final deliverables as `MEDIA:<absolute path>` lines, first in the reply.
- Output folder path.
- A short note on dimensions and verification (or "not yet validated, awaiting your review").
- For any image obtained via `route=aigc` or system search: the source route / prompt / keywords used, recorded in `assets/SOURCES.md`.
- For Live Photo: the `.pvt` package path, the debug `JPG + MOV` pair, target platform duration, and validation summary.
- For Live Photo publishing: remind the user of two things: platform limits (`5s` Xiaohongshu, `3s` WeChat Official Account) and publish path (AirDrop the `.pvt` package as one item to iPhone, then publish from the matching mobile app path; desktop/web upload paths generally cannot recognize `.pvt` as a publishable Live Photo).
- If the user cannot use the iPhone/AirDrop publishing path (e.g. desktop-only workflow, Android, or a platform that does not support Live Photo), offer a degraded delivery: export a short looping GIF or a silent MP4 clip from the same MOV source. The GIF/MP4 keeps the motion evidence but loses the Live Photo tap-to-play experience. Confirm with the user before switching to this fallback.
- Any unresolved risks, such as source images being low resolution.

## Non-Negotiables

- Never edit the original Guizang PPT skill or any upstream skill copied from elsewhere.
- Never create generated work in the skill root. All task artifacts must be under `local-tests/<slug>/` by default, or under a user-requested output folder. Root-level generated folders like `social-card-*`, `livephoto-*`, `wechat-*`, and loose output assets are forbidden.
- Do not create random decorative SVG ovals, blobs, rain drops, stickers, or meaningless circles.
- Do not use nested cards or generic SaaS card layouts as the default.
- Do not let text overflow, touch the edge, or collide with the footer band. Pin `.foot` with `margin-top: auto` inside a flex column, never with `position: absolute` over growing content.
- When content overflows, measure the amount before editing. Small overflows should get small fixes: `1-40px` means nudge/tighten, `40-90px` means local compaction, `90-160px` means slight title or paragraph compression, and only `160px+` should trigger recipe changes or content removal. After fixing, check R8 bottom whitespace so the page does not swing from overflow to a giant empty lower band.
- Do not let a title touch the next content block. Main display titles should usually keep at least `28px` below; local headings should keep at least `16px`. Use validator R9 before relying on visual inspection.
- Do not let text become too small to read on mobile.
- Do not write inline `font-size` + `font-weight` on display titles in Swiss. Use the typed classes (`.h-hero` / `.h-statement` / `.h-xl` / `.num-mega`). A 80-120px headline at weight 700-900 is not Swiss; "the larger, the lighter" is a hard rule.
- Do not deliver Editorial posters with a flat paper background, mono labels on every row, and no atmosphere layer. Run the Editorial Identity Test in `references/style-system.md` — a serif title alone does not make a poster Editorial.
- Do not fake data, release details, or percentages.
- Do not crop faces, key UI text, or hardware/product details unless the user explicitly accepts it.
- Do not turn a video card into a fake still sequence without saying so. If a source is shorter than the target duration, ask for a longer source, use a shorter platform-safe duration, or explicitly document any hold/slowdown.
- Do not skip the first-frame preview for Live Photo. Video is an image well with motion; its first frame must satisfy the static 3:4 layout and crop rules before rendering the MOV.
- Do not let result videos scroll through section boundaries in a shallow crop; this creates the "overlapping video" failure. Inspect contact sheets and choose a stable time window before packaging.
- Do not guess the user's visual priority when enlarging/cropping video for readability. Offer the crop/enlarge tradeoff and apply it after the user confirms, unless the request already makes the focal region explicit.
- Do not reuse a 21:9 cover by blindly cropping it into 1:1. Compose each ratio separately.
- **3:4 卡必须吃满画布**。Content (text + image + data) 必须覆盖 ≥75% 画布高度。任何 >15% 画布高度的纯空白带都需要"留白理由"：(a) hero image 自带呼吸、(b) 单句宣言式 hero statement、(c) 段落顶/底 leading & trailing whitespace（前后总和 ≤15%）。**禁止用 `<div style="flex: 1"></div>` 上下夹击把内容塞到中段**——杂志页留白逻辑不适用于社交卡（杂志靠对开页吸收留白，社交卡逐张独立刷，欠填看着像 PPT 漏排）。Recipe-by-recipe 最小密度见 `references/layout-recipes.md` 每条 recipe 的「Minimum density」段。Render 后必须跑 `qa-checklist.md` 的 4 横带密度检查。
