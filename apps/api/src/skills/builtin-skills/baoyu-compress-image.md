
# Image Compressor

Compresses images using best available tool (sips → cwebp → ImageMagick → Sharp).

## Environment

The cloud environment has the following pre-installed:
- **bun** — runtime for executing `scripts/main.ts`
- **cwebp** — WebP encoder (preferred compression tool)
- **ImageMagick** (`convert`) — fallback compression tool

If neither `cwebp` nor ImageMagick is available, the script falls back to `sips` (macOS) or `sharp` (Node.js).

## Workspace (output)

- **Root:** `/root/userdata/workspace/baoyu-compress-image/` — all compressed files are written **only** under this directory (mirroring subfolders when processing a directory input). The input file or folder may be **any** path.
- **`--output` / `-o`:** only the **basename** is used; any directory in the flag is ignored (file lands in the workspace root under that name).
- **Success (`stdout`, no `--json`):** first line `生成成功`, then one `MEDIA:<absolute path>` line per output file (single or batch). Progress text goes to **stderr**.

## Example Output Format

```
生成成功
MEDIA:/root/userdata/workspace/baoyu-compress-image/photo.webp
```

Batch runs emit **multiple** `MEDIA:` lines. With `--json`, paths are in the `media` array instead of the text handoff.

## Default Behavior: No Overwrite

> ⚠️ **By default, this skill does NOT overwrite the original image.** The compressed output is saved as a new file with a different extension (e.g., `image.png` → `image.webp`).
>
> To replace the original file in-place, use the `--keep` flag and specify the same output path explicitly. The skill will warn you before overwriting.

| Scenario | Behavior |
|----------|----------|
| Default (no `--output`) | Output saved in the workspace as `{original-name}.webp` (or chosen format; original on disk unchanged unless rename logic below applies) |
| `-o` / `--output` | **Basename** only, under the workspace root (e.g. `-o out.webp` → `.../baoyu-compress-image/out.webp`) |
| `--keep` | Keeps original file; if same extension, uses `*-compressed.*` in the workspace |

## Script Directory

Scripts in `scripts/` subdirectory. `{baseDir}` = this SKILL.md's directory path. Resolve `${BUN_X}` runtime: if `bun` installed → `bun`; if `npx` available → `npx -y bun`; else suggest installing bun. Replace `{baseDir}` and `${BUN_X}` with actual values.

| Script | Purpose |
|--------|---------|
| `scripts/main.ts` | Image compression CLI |

## Preferences (EXTEND.md)

Check EXTEND.md existence (priority order):

```bash
# macOS, Linux, WSL, Git Bash
test -f .baoyu-skills/baoyu-compress-image/EXTEND.md && echo "project"
test -f "${XDG_CONFIG_HOME:-$HOME/.config}/baoyu-skills/baoyu-compress-image/EXTEND.md" && echo "xdg"
test -f "$HOME/.baoyu-skills/baoyu-compress-image/EXTEND.md" && echo "user"
```

```powershell
# PowerShell (Windows)
if (Test-Path .baoyu-skills/baoyu-compress-image/EXTEND.md) { "project" }
$xdg = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { "$HOME/.config" }
if (Test-Path "$xdg/baoyu-skills/baoyu-compress-image/EXTEND.md") { "xdg" }
if (Test-Path "$HOME/.baoyu-skills/baoyu-compress-image/EXTEND.md") { "user" }
```

┌────────────────────────────────────────────────────────┬───────────────────┐
│                          Path                          │     Location      │
├────────────────────────────────────────────────────────┼───────────────────┤
│ .baoyu-skills/baoyu-compress-image/EXTEND.md           │ Project directory │
├────────────────────────────────────────────────────────┼───────────────────┤
│ $HOME/.baoyu-skills/baoyu-compress-image/EXTEND.md     │ User home         │
└────────────────────────────────────────────────────────┴───────────────────┘

┌───────────┬───────────────────────────────────────────────────────────────────────────┐
│  Result   │                                  Action                                   │
├───────────┼───────────────────────────────────────────────────────────────────────────┤
│ Found     │ Read, parse, apply settings                                               │
├───────────┼───────────────────────────────────────────────────────────────────────────┤
│ Not found │ Use defaults                                                              │
└───────────┴───────────────────────────────────────────────────────────────────────────┘

**EXTEND.md Supports**: Default format | Default quality | Keep original preference

## Usage

```bash
${BUN_X} {baseDir}/scripts/main.ts <input> [options]
```

Compressed outputs are always under `/root/userdata/workspace/baoyu-compress-image/`; see **Workspace (output)**.

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `<input>` | | File or directory (read from anywhere) | Required |
| `--output` | `-o` | **Basename** of output in workspace | Auto name from input |
| `--format` | `-f` | webp, png, jpeg | webp |
| `--quality` | `-q` | Quality 0-100 | 80 |
| `--keep` | `-k` | Keep original | false |
| `--recursive` | `-r` | Process subdirs | false |
| `--json` | | JSON output | false |

## Examples

```bash
# Single file → WebP in workspace (input path may be absolute)
${BUN_X} /app/skills/baoyu-compress-image/scripts/main.ts /root/userdata/incoming/photo.png

# Named output (basename only)
${BUN_X} /app/skills/baoyu-compress-image/scripts/main.ts /path/to/photo.png -o out.webp

# Keep PNG format
${BUN_X} /app/skills/baoyu-compress-image/scripts/main.ts /path/to/image.png -f png --keep

# Directory recursive (outputs mirror subdirs under workspace)
${BUN_X} /app/skills/baoyu-compress-image/scripts/main.ts /path/to/images/ -r -q 75

# JSON (includes `media` paths; no `生成成功` / `MEDIA` text block)
${BUN_X} /app/skills/baoyu-compress-image/scripts/main.ts /path/to/image.png --json
```

**Output** (no `--json`, on stderr: `... → ... (size…)`; on **stdout**: `生成成功` and `MEDIA:` lines as in **Example Output Format**):
```
生成成功
MEDIA:/root/userdata/workspace/baoyu-compress-image/photo.webp
```

## Extension Support

Custom configurations via EXTEND.md. See **Preferences** section for paths and supported options.
