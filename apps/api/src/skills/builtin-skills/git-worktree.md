<!-- grok-harness-invoke:start -->
**Grok Build (`plugins/soleur/lib/harness.ts` `invokeSkill()`):** Read this SKILL.md in this process and run it to completion. A one-segment `soleur:<name>` in this document names a SKILL — on Grok Build, Read `plugins/soleur/skills/<name>/SKILL.md` in this process; it is not a nested tool_use. A multi-segment id such as `soleur:<domain>:<name>` names an AGENT: spawn it, never Read it, and on Grok Build spawn_subagent takes the id with its colons replaced by hyphens (`agentIdToGrokSubagentType`). **Claude Code:** Skill tool for a skill (`soleur:<name>`), Task tool with `subagent_type` for an agent. Forbidden is executing a subset, not the Read.
<!-- grok-harness-invoke:end -->

# Git Worktree Manager

This skill provides a unified interface for managing Git worktrees across your development workflow. Whether you're reviewing PRs in isolation or working on features in parallel, this skill handles all the complexity.

## What This Skill Does

- **Create worktrees** from main branch with clear branch names
- **List worktrees** with current status
- **Switch between worktrees** for parallel work
- **Clean up completed worktrees** automatically
- **Interactive confirmations** at each step
- **Automatic .gitignore management** for worktree directory
- **Automatic .env file copying** from main repo to new worktrees
- **Write guard enforcement** via PreToolUse hook (`.claude/hooks/worktree-write-guard.sh`) -- blocks Write/Edit to main checkout when worktrees exist

## CRITICAL: Always Use the Manager Script

**NEVER call `git worktree add` directly.** Always use the `worktree-manager.sh` script.

The script handles critical setup that raw git commands don't:

1. Copies `.env`, `.env.local`, `.env.test`, etc. from main repo
2. Ensures `.worktrees` is in `.gitignore`
3. Creates consistent directory structure
4. Detects bare repos (`core.bare = true`) and derives `GIT_ROOT` via `--absolute-git-dir` instead of `--show-toplevel`
5. Sources the shared `plugins/soleur/scripts/resolve-git-root.sh` helper -- all scripts that need `GIT_ROOT` should source this helper instead of inlining their own detection logic

**After creating a worktree**, run `npm install` if the project has a `package.json` — worktrees do not share `node_modules/` with the main working tree, and build commands (`npx @11ty/eleventy`, etc.) will silently hang instead of erroring.

```bash
# ✅ CORRECT - Always use the script
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh create feature-name

# ❌ WRONG - Never do this directly
git worktree add .worktrees/feature-name -b feature-name main
```

## When to Use This Skill

Use this skill in these scenarios:

1. **Code Review (`soleur:review`)**: If NOT already on the target branch (PR branch or requested branch), offer worktree for isolated review
2. **Feature Work (`soleur:work`)**: Always ask if user wants parallel worktree or live branch work
3. **Parallel Development**: When working on multiple features simultaneously
4. **Cleanup**: After completing work in a worktree

## How to Use

### In Claude Code Workflows

The skill is automatically called from the `soleur:review` and `soleur:work` skills:

```
# For review: offers worktree if not on PR branch
# For work: always asks - new branch or worktree?
```

### Manual Usage

You can also invoke the skill directly from bash:

```bash
# Create a new worktree (copies .env files automatically)
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh create feature-login

# List all worktrees
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh list

# Switch to a worktree
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh switch feature-login

# Copy .env files to an existing worktree (if they weren't copied)
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh copy-env feature-login

# Clean up completed worktrees
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh cleanup
```

## Commands

### `create <branch-name> [from-branch]`

Creates a new worktree with the given branch name.

**Options:**

- `branch-name` (required): The name for the new branch. The worktree DIRECTORY is the slug of it — every `/` becomes `-`, so `ci/rule-metrics` creates branch `ci/rule-metrics` in `.worktrees/ci-rule-metrics`. Identical for any name without a slash. Read the path the script prints; do not construct `.worktrees/<branch-name>` yourself. `create` refuses if the target directory already holds a different branch (`SOLEUR_WORKTREE_SLUG_COLLISION`) — the transform is many-to-one, so `ci/foo` and `ci-foo` would otherwise share one directory.
- `from-branch` (optional): Base branch to create from (defaults to `main`)

**Example:**

```bash
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh create feature-login
```

**What happens:**

1. Checks if worktree already exists
2. Fetches `refs/remotes/origin/<from-branch>` (the local `<from-branch>` ref is NOT touched — this lets `create` succeed even when a sibling worktree has `<from-branch>` checked out; see #3741)
3. Creates the new worktree from `origin/<from-branch>` with `--no-track` (preserves the pre-fix upstream-unset state so downstream `git push -u origin <branch>` flows are unchanged)
4. **Copies all .env files from main repo** (.env, .env.local, .env.test, etc.)
5. Shows path for cd-ing to the worktree

**Opt-in: also update local `<from-branch>`**

Pass `--update-local-main` (as a global flag, before `create`) to additionally fast-forward the local `<from-branch>` ref. Default behavior leaves the local ref untouched.

```bash
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh --update-local-main create feature-login
```

### `list` or `ls`

Lists all available worktrees with their branches and current status.

**Example:**

```bash
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh list
```

**Output shows:**

- Worktree name
- Branch name
- Which is current (marked with ✓)
- Main repo status

### `switch <name>` or `go <name>`

Switches to an existing worktree and cd's into it.

**Example:**

```bash
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh switch feature-login
```

**Optional:**

- If name not provided, lists available worktrees and prompts for selection

### `cleanup` or `clean`

Interactively cleans up inactive worktrees with confirmation.

**Example:**

```bash
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh cleanup
```

**What happens:**

1. Lists all inactive worktrees
2. Asks for confirmation
3. Removes selected worktrees
4. Cleans up empty directories

### `sync-bare-files` or `sync`

Syncs stale on-disk files from git HEAD in a bare repo. Only needed when the repo uses `core.bare=true` — on-disk files at the bare root become stale after merges since git never updates them. Auto-called after `cleanup-merged` cleans branches in bare repo context.

**Example:**

```bash
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh sync-bare-files
```

**What it syncs: EVERY tracked file at HEAD — there is no allowlist.**

The implementation builds a throwaway index from `HEAD` and runs
`git checkout-index -a -f` against the bare root, so every path git tracks is
materialized. That pass is **additive** — it never removes anything — so a
separate prune step afterwards deletes on-disk leftovers for paths that were
tracked once and are absent from HEAD. The two together are what make the bare
root equal HEAD exactly. It then re-applies execute bits for the scripts and
hooks the plugin loader and SessionStart hooks exec.

> **Corrected 2026-08-10 (#7409).** This section previously enumerated a
> seven-entry list (`AGENTS.md`, `plugins/soleur/hooks/*`, `.claude/hooks/*.sh`,
> `resolve-git-root.sh`, …) and told readers that "any file Claude Code executes
> at runtime from the bare repo root **must be added to the sync list**". Both
> halves were wrong: the enumeration described a whitelist the code has not
> had, and the instruction sent readers to register files in a list that does
> not exist. Worth stating precisely rather than deleting, because the
> difference is load-bearing — when #7409 moved the session-state lock/lease
> library to `plugins/soleur/scripts/lib/`, a genuine whitelist would have left
> the bare root's repointed `.claude/hooks/*` sources pointing at a file the
> mirror never copied, and they degrade **silently** (`|| true`). The full
> mirror is what makes that a non-event.

**Still important:** run `sync-bare-files` after any merge that moves or adds a
file executed from the bare root. The mirror is complete, but it is not
automatic — on-disk files at a `core.bare=true` root are never updated by git
itself, so a stale copy survives until this runs.

## Workflow Examples

### Code Review with Worktree

```bash
# Claude Code recognizes you're not on the PR branch
# Offers: "Use worktree for isolated review? (y/n)"

# You respond: yes
# Script runs (copies .env files automatically):
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh create pr-123-feature-name

# You're now in isolated worktree for review with all env vars
cd .worktrees/pr-123-feature-name

# After review, return to main:
cd ../..
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh cleanup
```

### Parallel Feature Development

```bash
# For first feature (copies .env files):
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh create feature-login

# Later, start second feature (also copies .env files):
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh create feature-notifications

# List what you have:
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh list

# Switch between them as needed:
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh switch feature-login

# Return to main and cleanup when done:
cd .
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh cleanup
```

## Key Design Principles

### KISS (Keep It Simple, Stupid)

- **One manager script** handles all worktree operations
- **Simple commands** with sensible defaults
- **Interactive prompts** prevent accidental operations
- **Clear naming** using branch names directly

### Opinionated Defaults

- Worktrees always created from **main** (unless specified)
- Worktrees stored in **.worktrees/** directory
- Branch name becomes worktree name
- **.gitignore** automatically managed

### Safety First

- **Confirms before creating** worktrees
- **Confirms before cleanup** to prevent accidental removal
- **Won't remove current worktree**
- **Clear error messages** for issues

## Integration with Workflows

### `soleur:review`

Instead of always creating a worktree:

```
1. Check current branch
2. If ALREADY on target branch (PR branch or requested branch) → stay there, no worktree needed
3. If DIFFERENT branch than the review target → offer worktree:
   "Use worktree for isolated review? (y/n)"
   - yes → call git-worktree skill
   - no → proceed with PR diff on current branch
```

### `soleur:work`

Always offer choice:

```
1. Ask: "How do you want to work?
   1. New branch on current worktree (live work)
   2. Worktree (parallel work)"

2. If choice 1 → create new branch normally
3. If choice 2 → call git-worktree skill to create from main
```

## Troubleshooting

### "Worktree already exists"

If you see this, the script will ask if you want to switch to it instead.

### "Cannot remove worktree: it is the current worktree"

Switch out of the worktree first (to main repo), then cleanup:

Navigate to the repository root directory, then run:

```bash
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh cleanup
```

### Lost in a worktree?

See where you are:

```bash
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh list
```

### .env files missing in worktree?

If a worktree was created without .env files (e.g., via raw `git worktree add`), copy them:

```bash
bash ${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/skills/git-worktree/scripts/worktree-manager.sh copy-env feature-name
```

Navigate back to the repository root directory.

### node_modules missing in worktree?

A worktree created without an install step (raw `git worktree add`, a
harness-created agent worktree, or a `create` whose dep install warned and
continued) carries no `node_modules`. Since #8580 the pre-commit lint hook
resolves its pinned binary from a sibling checkout's `node_modules`
automatically — accepted only when the sibling's package manifests report
CLI+engine versions equal to this checkout's pins (verified by file reads, so
an unchecked binary never runs) — so docs commits work without any install.
Everything else (vitest, tsx-driven suites, `npm run` scripts) still needs
the real install inside the worktree — run both from the worktree root:

```bash
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix apps/web-platform   # needed by the webplat arm of scripts/test-all.sh
```

## Sharp Edges

- **A `cd <abs path under the bare root>` from inside a worktree SUCCEEDS, and every command after it reads `main`.** The bare checkout carries the same tree (`apps/web-platform`, `plugins/soleur`, …) as every worktree, so a path written from memory resolves there without error and the suite you run reports on a branch you are not on — measured on #8418: `cd /data/…/soleur/apps/web-platform 2>/dev/null || cd <worktree>/apps/web-platform` took the FIRST arm and `vitest` printed 57/57 about `main`. The only tell is the harness's `# Environment update` notice. Anchor every `cd` on `$PWD` or `git rev-parse --show-toplevel`, never on a remembered absolute; `hr-when-in-a-worktree-never-read-from-bare` has no hook, so the discipline is the guard. **Why:** #8418.
- **A git hook running in a LINKED WORKTREE exports `GIT_DIR` and `GIT_INDEX_FILE` as ABSOLUTE
  paths, and they override a subprocess's `cwd` and `git -C`.** A plain clone exports no
  `GIT_DIR` at all, and only a RELATIVE `GIT_INDEX_FILE` (`.git/index`) which resolves
  against the subprocess's own cwd and is harmless — so this reproduces only here; anyone
  diagnosing it in a fresh clone will measure nothing and wrongly conclude the report is stale.
  Consequence: a test fixture's `git init` initialises nothing and its commits land on the
  worktree's live branch, moving the tip. Test-side convention and the `rc=97` tripwire that now
  refuses such a run: `plugins/soleur/AGENTS.md` §Test Fixture Conventions (#7833).

- **`.git` is a FILE in a worktree, so every `.git/<state>` probe silently answers "no".** A rebase-resolution loop gated on `[ -d .git/rebase-merge ]` exits immediately reporting success while the rebase is still mid-flight — measured, it claimed completion with **six commits unapplied** and a conflict staged. Resolve the real path with `git rev-parse --git-path rebase-merge` (it returns the worktree's own `…/worktrees/<name>/rebase-merge`). Same for `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `HEAD`, and anything else under the git dir. Nothing was lost — the reflog held every commit — but the loop reported the opposite of the truth.
- **A test can sandbox correctly and still commit into YOUR worktree, because the escape is the `cd` INTO the sandbox, not the sandbox.** `( cd "$X" && … )` is safe — `&&` short-circuits. `( cd "$X"` followed by a newline is not: on a failed `cd` the subshell keeps the INHERITED cwd and every command below runs against whatever worktree `test-all.sh` was invoked from. It is reachable whenever setup can fail silently, and `git worktree add … >/dev/null 2>&1` (which swallows "branch already exists" from a crashed prior run) is the usual way it does. Measured 2026-08-20: `lease-protects-active.test.sh` — which sandboxes properly with `mktemp -d` and its own bare repo — committed `victim change`/`victim2`/`v9`/`v12` onto a live feature branch, moved the ref off six review commits, then checked that worktree out to `main` and pulled; a fifth unguarded site ends in `git push origin main`. Recovery order matters: the commits survive as OBJECTS, so `git push origin <sha>:refs/heads/<branch>` FIRST (durability before local surgery), then `git update-ref <ref> <good> <bad>` as a compare-and-swap, then restore the checkout. Guard every non-`&&` `( cd "$X"` with `|| { echo "FATAL: cd to sandbox failed; refusing to write git objects in $(pwd)" >&2; exit 90; }`, and verify by asserting `git rev-parse HEAD` is UNCHANGED across a full run — not by the guard's presence, which passed a first, incomplete fix. **Why:** #7546. See `knowledge-base/project/learnings/2026-08-20-every-guard-i-fixed-was-narrower-than-the-claim-it-carried.md`.
- If `worktree-manager.sh` reports success but `cd` to the worktree path fails or `git branch --show-current` returns an unexpected branch, the worktree was not properly created. Fall back to `git worktree add` directly: `git worktree add .worktrees/<name> -b <name> main`. The script includes post-creation verification (#1806) but edge cases on bare repos may still produce partial directories. Tracked in #1854.
- The `draft-pr` subcommand uses `SCRIPT_DIR` for path resolution -- invoke it from inside the worktree, not from the bare repo root.
- **`fatal: this operation must be run in a work tree` in an intact worktree means `extensions.worktreeConfig` is set on the SHARED bare-repo config while `config.worktree` files do not set `bare = false` — it takes every worktree down at once, not just yours.** Enabling that extension makes git read `.git/worktrees/<name>/config.worktree` per worktree; when those do not set `bare = false`, nothing overrides `core.bare = true` from the common config, so `git rev-parse --is-inside-work-tree` returns `false` everywhere despite valid `.git`/`gitdir`/`commondir` pointers. Repair BOTH halves: `git config -f <bare>/.git/config --unset-all extensions.worktreeConfig`, **and** write `[core]\n\tbare = false` into each `config.worktree` — the second is what leaves the fleet immune to a re-add. Verify with a loop over `git worktree list` before continuing. **Why:** 2026-08-09 (#7332) — all 14 worktrees wedged mid-rebase; the key is already classed as harmful by #4826, but that heal (`apps/web-platform/server/worktree-config-seed.ts`) is scoped to Concierge workspace provisioning and never runs against an operator's local bare repo. See `knowledge-base/project/learnings/2026-08-09-one-shared-config-key-took-all-fourteen-worktrees-down-mid-rebase.md`.

  **This is now largely a fallback — `worktree-manager.sh` performs both halves itself (#7394, [ADR-173](../../../../knowledge-base/engineering/architecture/decisions/ADR-173-bare-config-polarity-for-linked-worktrees.md)).** `ensure_bare_config` removes the extension on every `create` / `create-for-feature` / `cleanup-merged`, `create` seeds `core.bare = false` into each new worktree's `config.worktree`, and a detection-time self-heal repairs the CURRENT worktree the moment git reports it as bare — so an already-wedged worktree recovers on first use rather than waiting for a session-start gate. The root cause of #7332 was that `ensure_bare_config` was **dead code** on the operator's bare-repo-in-`.git` layout: its guard branched on the gitdir's SHAPE (`.git` is a directory) which is true of that layout too. Reach for the manual repair only if `SOLEUR_GIT_BARE_SELFHEAL … branch=failed` or a `worktree wedge: could not …` line shows the automated path could not write. **Do not gate on `SOLEUR_GIT_BARE_POISON`** — it is emitted on the SUCCESS path too (`branch=clean` fires on every healthy run), so treating its presence as a failure signal sends you into config surgery on a healthy repo. **Correction to the text above:** the per-worktree files are typically **absent**, not 0 bytes — measured on git 2.53.0, `git worktree add` writes no `config.worktree` at all, so test for non-existence rather than for an empty file.
- When creating worktrees manually (not via the script), always use absolute paths. Relative paths resolve from CWD, not from `GIT_DIR`, creating nested worktrees that are difficult to clean up. The script handles this correctly but manual `git worktree add` commands are susceptible.
- **A manually-added worktree holds NO LEASE and is reapable by any sibling's `cleanup-merged` — and RECOVERING an existing branch is exactly the case that forces you into the manual path.** `worktree-manager.sh create` runs `git worktree add -b "$branch"`, which fails when the branch already exists, so recovering a branch whose worktree was removed (or whose PR is mid-flight) cannot go through the script — and the lease wiring lives only in the script's `create`. After any manual `git worktree add`, acquire the lease explicitly:

  ```bash
  # Run this from INSIDE the new worktree. The lease key is the worktree
  # DIRECTORY name, not the branch. Since #8400 cleanup-merged probes TWO keys per
  # candidate — `is_lease_active "$(_safe_worktree_name "$branch")"` first, then
  # `is_lease_active "$(basename "$worktree_path")"` — and holding EITHER is a hold.
  # The directory basename is still the key to use here, because it is the one that
  # survives `switch`'s legacy-nested fallback (which leases under `foo` for a branch
  # `ci/foo`, where the safe name is `ci-foo`). For a worktree created flat by the
  # script the two keys are the same slug. The branch-keyed probe is the one that runs
  # for a merged branch whose worktree is ALREADY GONE — the cohort that used to
  # short-circuit every guard in the loop. The acquire side keys on
  # the same slug (every `/` becomes `-`). Passing a branch name with a slash
  # writes nothing at all — the validator rejects `/` — and says so only in a
  # per-PID log file the agent never reads, so the worktree runs unleased and
  # reapable with no visible signal. `basename "$PWD"` is also exactly what the
  # matching `release_lease` calls in one-shot and work use.
  SS_LIB="${CLAUDE_PLUGIN_ROOT:-./plugins/soleur}/scripts/lib/session-state.sh"
  WT_KEY="$(basename "$PWD")"
  if [[ -r "$SS_LIB" ]]; then
    source "$SS_LIB" && acquire_lease "$WT_KEY" "<skill>" <minutes>
    # rc=0 is NOT proof the lease exists: acquire_lease returns 0 and writes
    # nothing when the layer is disabled. Assert the FILE, and reuse the marker
    # the script already emits — it is mirrored and paged, so a new name here
    # would be observable to nobody.
    if [[ ! -f "$(git rev-parse --git-common-dir)/soleur-session-state/leases/$WT_KEY.lease" ]]; then
      echo "SOLEUR_WORKTREE_LEASE_ACQUIRE_FAILED key=$WT_KEY site=manual reason=file-absent"
    fi
  else
    # NEVER silent (#7409). Unlike release_lease and with_lock — advisory
    # operations that degrade open quietly — this call IS the acquisition of
    # the protection itself. There is nothing else to do when the library is
    # absent, but degrading open without saying so manufactures exactly the
    # exposure the lease exists to prevent: an unleased worktree that a
    # sibling `cleanup-merged` is now free to reap.
    echo "SOLEUR_SESSION_STATE_UNAVAILABLE path=$SS_LIB reason=worktree-UNLEASED-and-reapable"
  fi
  ```

