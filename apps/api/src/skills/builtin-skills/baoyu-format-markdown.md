
# Markdown Formatter

Transforms plain text or markdown into well-structured, reader-friendly markdown. The goal is to help readers quickly grasp key points, highlights, and structure — without changing any original content.

**Core principle**: Only adjust formatting and fix obvious typos. Never add, delete, or rewrite content.

## Environment Requirements

- **Runtime**: `bun` is pre-installed in the cloud environment. If `bun` is not available, fall back to `npx -y bun`. If neither is available, prompt the user to install bun.
- **Dependencies**: Before first use, install dependencies by running:
  ```bash
  cd {baseDir}/scripts && bun install
  ```
  This installs all packages declared in `scripts/package.json` (including `remark-cjk-friendly` and related plugins) so that `scripts/main.ts` can run directly.

## Workspace (output)

- **Root:** `/root/userdata/workspace/baoyu-format-markdown/` — the typography script writes **only** here; it does **not** overwrite the source file.
- **Naming:** input `article.md` (read from any path) becomes `article-formatted.md` under that root (same rule for other extensions). If two sources share the same basename in different folders, the later run overwrites the same workspace filename.
- **Handoff:** On success, **stdout** is `生成成功` and one `MEDIA:<absolute path>` line for the formatted file; the `✓ Formatted: …` line goes to **stderr**.

## Example Output Format

```
生成成功
MEDIA:/root/userdata/workspace/baoyu-format-markdown/article-formatted.md
```

## Script Directory

Scripts in `scripts/` subdirectory. `{baseDir}` = this SKILL.md's directory path. Resolve `${BUN_X}` runtime: if `bun` installed → `bun`; if `npx` available → `npx -y bun`; else suggest installing bun. Replace `{baseDir}` and `${BUN_X}` with actual values.

| Script | Purpose |
|--------|---------|
| `scripts/main.ts` | Main entry point with CLI options (uses remark-cjk-friendly for CJK emphasis) |
| `scripts/quotes.ts` | Replace ASCII quotes with fullwidth quotes |
| `scripts/autocorrect.ts` | Add CJK/English spacing via autocorrect |

## Preferences (EXTEND.md)

Check EXTEND.md existence (priority order):

```bash
# macOS, Linux, WSL, Git Bash
test -f .baoyu-skills/baoyu-format-markdown/EXTEND.md && echo "project"
test -f "${XDG_CONFIG_HOME:-$HOME/.config}/baoyu-skills/baoyu-format-markdown/EXTEND.md" && echo "xdg"
test -f "$HOME/.baoyu-skills/baoyu-format-markdown/EXTEND.md" && echo "user"
```

```powershell
# PowerShell (Windows)
if (Test-Path .baoyu-skills/baoyu-format-markdown/EXTEND.md) { "project" }
$xdg = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { "$HOME/.config" }
if (Test-Path "$xdg/baoyu-skills/baoyu-format-markdown/EXTEND.md") { "xdg" }
if (Test-Path "$HOME/.baoyu-skills/baoyu-format-markdown/EXTEND.md") { "user" }
```

┌──────────────────────────────────────────────────────────┬───────────────────┐
│                           Path                           │     Location      │
├──────────────────────────────────────────────────────────┼───────────────────┤
│ .baoyu-skills/baoyu-format-markdown/EXTEND.md            │ Project directory │
├──────────────────────────────────────────────────────────┼───────────────────┤
│ $HOME/.baoyu-skills/baoyu-format-markdown/EXTEND.md      │ User home         │
└──────────────────────────────────────────────────────────┴───────────────────┘

┌───────────┬───────────────────────────────────────────────────────────────────────────┐
│  Result   │                                  Action                                   │
├───────────┼───────────────────────────────────────────────────────────────────────────┤
│ Found     │ Read, parse, apply settings                                               │
├───────────┼───────────────────────────────────────────────────────────────────────────┤
│ Not found │ Use defaults                                                              │
└───────────┴───────────────────────────────────────────────────────────────────────────┘

**EXTEND.md Supports**:

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `auto_select` | `true`/`false` | `false` | Skip both title and summary selection, auto-pick best |
| `auto_select_title` | `true`/`false` | `false` | Skip title selection only |
| `auto_select_summary` | `true`/`false` | `false` | Skip summary selection only |
| Other | — | — | Default formatting options, typography preferences |

## Usage

The workflow has two phases: **Analyze** (understand the content) then **Format** (apply formatting). Claude performs content analysis and formatting (Steps 1-5), then runs the script for typography fixes (Step 6).

## Workflow

### Step 1: Read & Detect Content Type

Read the user-specified file, then detect content type:

| Indicator | Classification |
|-----------|----------------|
| Has `---` YAML frontmatter | Markdown |
| Has `#`, `##`, `###` headings | Markdown |
| Has `**bold**`, `*italic*`, lists, code blocks, blockquotes | Markdown |
| None of above | Plain text |
3. Typography fixes only (**disabled by default — requires explicit confirmation**)
   - Run typography script on original file in-place
   - No copy created, modifies original file directly


**Based on user choice:**
- **Optimize**: Continue to Step 2 (full workflow)
- **Keep original**: Skip to Step 5, copy file then run Step 6
- **Typography only**: Before proceeding, display the following warning and require explicit user confirmation:

  > ⚠️ **Warning**: This operation will directly modify the original Markdown file in-place. No backup copy will be created. The original file content will be overwritten.
  >
  > Type **yes** to confirm, or anything else to cancel.

  Only proceed if the user explicitly types `yes`. If the user cancels or does not confirm, abort and offer to use option 1 or 2 instead (which output to `{filename}-formatted.md`).
### Step 2: Analyze Content (Reader's Perspective)

Read the entire content carefully. Think from a reader's perspective: what would help them quickly understand and remember the key information?

Produce an analysis covering these dimensions:

**2.1 Highlights & Key Insights**
- Core arguments or conclusions the author makes
- Surprising facts, data points, or counterintuitive claims
- Memorable quotes or well-phrased sentences (golden quotes)

**2.2 Structure Assessment**
- Does the content have a clear logical flow? What is it?
- Are there natural section boundaries that lack headings?
- Are there long walls of text that could benefit from visual breaks?

**2.3 Reader-Important Information**
- Actionable advice or takeaways
- Definitions, explanations of key concepts
- Lists or enumerations buried in prose
- Comparisons or contrasts that would be clearer as tables

**2.4 Formatting Issues**
- Missing or inconsistent heading hierarchy
- Paragraphs that mix multiple topics
- Parallel items written as prose instead of lists
- Code, commands, or technical terms not marked as code
- Obvious typos or formatting errors

**Save analysis to file**: `{original-filename}-analysis.md`

The analysis file serves as the blueprint for Step 3. Use this format:

```markdown
# Content Analysis: {filename}

## Highlights & Key Insights
- [list findings]

## Structure Assessment
- Current flow: [describe]
- Suggested sections: [list heading candidates with brief rationale]

## Reader-Important Information
- [list actionable items, key concepts, buried lists, potential tables]

## Formatting Issues
- [list specific issues with location references]

## Typos Found
- [list any obvious typos with corrections, or "None found"]
```

### Step 3: Check/Create Frontmatter, Title & Summary

Check for YAML frontmatter (`---` block). Create if missing.

| Field | Processing |
|-------|------------|
| `title` | See **Title Generation** below |
| `slug` | Infer from file path or generate from title |
| `summary` | One-sentence concise summary (see **Summary Generation** below) |
| `description` | Longer descriptive summary (see **Summary Generation** below) |
| `coverImage` | Check if `imgs/cover.png` exists in same directory; if so, use relative path |

**Title Generation:**

Whether or not a title already exists, always run the title optimization flow (unless `auto_select_title` is set).

**Preparation** — read the full text and extract:
- Core argument (one sentence: "what is this article about?")
- Most impactful opinion or conclusion
- Reader pain point or curiosity trigger
- Most memorable metaphor or golden quote

**Generate titles** using formulas from `references/title-formulas.md`:

1. Select the **2-3 best-matching hook formulas** based on the article's content, tone, and structure (see "When to pick each formula" in the reference)
2. Generate **1-2 straightforward titles** (descriptive or declarative, no formula — clear and accurate)
3. If the user specifies a direction (e.g., "make it suspenseful"), prioritize that direction
4. Total: **4-5 candidates**

Use `AskUserQuestion` to present candidates:

```
Pick a title:

1. [Hook title A] — (recommended) [formula name]
2. [Hook title B] — [formula name]
3. [Hook title C] — [formula name]
4. [Straightforward title D] — straightforward
5. [Straightforward title E] — straightforward

Enter number, or type a custom title:
```

Put the strongest hook first and mark it (recommended). See `references/title-formulas.md` for title principles and prohibited patterns.

If first line is H1, extract to frontmatter and remove from body. If frontmatter already has `title`, include it as context but still generate fresh candidates.

**Summary Generation:**

Generate two versions directly (no user selection needed), both stored in frontmatter:

| Field | Length | Purpose |
|-------|--------|---------|
| `summary` | 1 sentence, ~50-80 chars | Concise hook — for feeds, social sharing, SEO meta |
| `description` | 2-3 sentences, ~100-200 chars | Richer context — for article previews, newsletter blurbs |

**Principles:**
- Convey **core value** to the reader, not just the topic
- Use concrete details (numbers, outcomes, specific methods) over vague descriptions
- `summary` should be punchy and self-contained; `description` can expand with supporting details
- If frontmatter already has `summary` or `description`, keep existing and only generate the missing one

**Prohibited patterns:**
- "This article introduces...", "This article explores..."
- Pure topic description without value proposition
- Repeating the title in different words

**EXTEND.md skip behavior:** If `auto_select: true` or `auto_select_title: true` is set in EXTEND.md, skip title selection — generate the best candidate directly without asking.

Once title is in frontmatter, body should NOT have H1 (avoid duplication).

### Step 4: Format Content

Apply formatting guided by the Step 2 analysis. The goal is making the content scannable and the key points impossible to miss.

**Formatting toolkit:**

| Element | When to use | Format |
|---------|-------------|--------|
| Headings | Natural topic boundaries, section breaks | `##`, `###` hierarchy |
| Bold | Key conclusions, important terms, core takeaways | `**bold**` |
| Unordered lists | Parallel items, feature lists, examples | `- item` |
| Ordered lists | Sequential steps, ranked items, procedures | `1. item` |
| Tables | Comparisons, structured data, option matrices | Markdown table |
| Code | Commands, file paths, technical terms, variable names | `` `inline` `` or fenced blocks |
| Blockquotes | Notable quotes, important warnings, cited text | `> quote` |
| Separators | Major topic transitions | `---` |

**Formatting principles — what NOT to do:**
- Do NOT add sentences, explanations, or commentary
- Do NOT delete or shorten any content
- Do NOT rephrase or rewrite the author's words
- Do NOT add headings that editorialize (e.g., "Amazing Discovery" — use neutral descriptive headings)
- Do NOT over-format: not every sentence needs bold, not every paragraph needs a heading

**Formatting principles — what TO do:**
- Preserve the author's voice, tone, and every word
- **Bold key conclusions and core takeaways** — the sentences a reader would highlight
- Extract parallel items from prose into lists only when the structure is clearly there
- Add headings where the topic genuinely shifts — prefer vivid, specific headings over generic ones (e.g., "3 天搞定 vs 传统方案" over "方案对比")
- Use tables for comparisons or structured data buried in prose
- Use blockquotes for golden quotes, memorable statements, or important warnings
- Fix obvious typos (based on Step 2 findings)

### Step 5: Save Formatted File

Save the editor-produced draft as the **source** path the script will read. The script will write the typography result to **`/root/userdata/workspace/baoyu-format-markdown/<stem>-formatted.md`** (not next to the source).

**Optional backup** (if a previous `*-formatted.md` already exists in the workspace):

```bash
OUT="/root/userdata/workspace/baoyu-format-markdown/article-formatted.md"
if [ -f "$OUT" ]; then
  mv "$OUT" "${OUT%.md}.backup-$(date +%Y%m%d-%H%M%S).md"
fi
```

### Step 6: Execute Typography Script

Run the script with the **source** markdown path (any absolute path to the file to read). Output path is **fixed** by the tool under the workspace (see **Workspace (output)**).

```bash
${BUN_X} /app/skills/baoyu-format-markdown/scripts/main.ts /path/to/source/article.md [options]
```

**Script Options:**

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--quotes` | `-q` | Replace ASCII quotes with fullwidth quotes `"..."` | false |
| `--no-quotes` | | Do not replace quotes | |
| `--spacing` | `-s` | Add CJK/English spacing via autocorrect | true |
| `--no-spacing` | | Do not add CJK/English spacing | |
| `--emphasis` | `-e` | Fix CJK emphasis punctuation issues | true |
| `--no-emphasis` | | Do not fix CJK emphasis issues | |

**Examples:**

```bash
# Default: spacing + emphasis enabled, quotes disabled
${BUN_X} /app/skills/baoyu-format-markdown/scripts/main.ts /path/to/article.md

# Enable all features including quote replacement
${BUN_X} /app/skills/baoyu-format-markdown/scripts/main.ts /path/to/article.md --quotes

# Only fix emphasis issues, skip spacing
${BUN_X} /app/skills/baoyu-format-markdown/scripts/main.ts /path/to/article.md --no-spacing
```

**Script performs (based on options):**
1. Fix CJK emphasis/bold punctuation issues (default: enabled)
2. Add CJK/English mixed text spacing via autocorrect (default: enabled)
3. Replace ASCII quotes with fullwidth quotes (default: disabled)
4. Format frontmatter YAML (always enabled)

### Step 7: Completion Report

Display a report summarizing all changes made:

```
**Formatting Complete**

**Files:**
- Analysis: `{stem}-analysis.md` (as produced in earlier steps)
- Formatted: `/root/userdata/workspace/baoyu-format-markdown/{stem}-formatted.md` (from Step 6; relay `MEDIA:` from script stdout to the user)

**Content Analysis Summary:**
- Highlights found: X key insights
- Golden quotes: X memorable sentences
- Formatting issues fixed: X items

**Changes Applied:**
- Frontmatter: [added/updated] (title, slug, summary)
- Headings added: X (##: N, ###: N)
- Bold markers added: X
- Lists created: X (from prose → list conversion)
- Tables created: X
- Code markers added: X
- Blockquotes added: X
- Typos fixed: X [list each: "original" → "corrected"]

**Typography Script:**
- CJK spacing: [applied/skipped]
- Emphasis fixes: [applied/skipped]
- Quote replacement: [applied/skipped]
```

Adjust the report to reflect actual changes — omit categories where no changes were made.

## Notes

- Preserve original writing style and tone
- Specify correct language for code blocks (e.g., `python`, `javascript`)
- Maintain CJK/English spacing standards
- The analysis file is a working document — it helps maintain consistency between what was identified and what was formatted

## Extension Support

Custom configurations via EXTEND.md. See **Preferences** section for paths and supported options.
