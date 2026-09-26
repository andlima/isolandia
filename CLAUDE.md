# Claude Code – Agent-Specific Notes

> **Read `AGENTS.md` first** — it contains all project context, workflow, and conventions.
> This file is strictly additive — it must never contradict or duplicate AGENTS.md content.

## Worktree-Only Editing — Read This First

Before making **any** file changes, read the "Worktree-Only Editing Rule" section in
`AGENTS.md`. Claude Code auto-loads this file but not `AGENTS.md`, so this reminder
exists to prevent the most common mistake: editing directly in the main checkout.

## Tool Preferences

- Use **Edit** (string replacement) for modifying existing files; avoid sed/awk
- Use **Glob** and **Grep** for file/content search; avoid shell find/grep
- Use **Agent** with `subagent_type=Explore` for broad codebase exploration
- Use **Read** to view files; avoid cat/head/tail

## Memory

Claude Code stores project memory in `~/.claude/projects/…/memory/`. Consult memory
files at the start of each session to build on previous experience.

## GitHub CLI (`gh`) in Sandbox

The sandbox proxy causes TLS certificate errors with `gh` (Go's strict TLS verification
rejects the proxy's cert). **Use `curl` with a token instead**:

```bash
GH_TOKEN=$(gh auth token 2>/dev/null)
curl -s -H "Authorization: token $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/OWNER/REPO/..."
```

`git push` works fine through the proxy — only `gh` API calls are affected.

## Permissions

- `.claude/settings.json` — project-level permission allowlists (committed)
- `.claude/settings.local.json` — personal overrides (git-ignored)
