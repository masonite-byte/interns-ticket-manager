# Intern Ticket Manager

A Slack bot that keeps intern tickets from falling through the cracks. Interns claim GitHub issues directly from Slack, post progress updates, and get nudged automatically when things go quiet.

Built on Cloudflare Workers (JavaScript) with Go binaries for GitHub operations, triggered via GitHub Actions workflow dispatch.

---

## Commands

| Command | Description |
|---|---|
| `/claim` | Pick an unclaimed GitHub issue to work on. Assigns you on GitHub, adds the `in-progress` label, and posts a comment. |
| `/abandon` | Drop an issue you claimed. Unassigns you on GitHub, removes the label, and cleans up the comment. |
| `/progress` | Post a status update on one of your claimed issues. Resets the staleness clock. |
| `/whois [@user]` | See what issues someone has claimed. Defaults to yourself if no mention. |
| `/tickets` | Show all currently claimed tickets across the team. |
| `/standup` | Show a standup-style summary of everyone's active claims. |
| `/stats` | Leaderboard ranked by issues closed, then claimed. |
| `/ping` | Check that the bot is alive. |

## Automatic behaviors

- **PR announcements** — when an intern opens a PR that references a claimed issue (`closes #N`, `fixes #N`, `resolves #N`), the bot posts to the channel. On merge, it marks the issue closed and updates stats.
- **Issue closed** — if an issue is closed directly on GitHub (without a PR), the claim is cleaned up automatically.
- **Staleness alerts** — weekdays at 9am UTC, the bot DMs any intern whose claimed issue hasn't had a `/progress` update in 3+ days.

---

## Setup

### Prerequisites

- Cloudflare account with Workers and KV enabled
- Slack app with bot token and signing secret
- GitHub repo with a PAT that has `repo` and `workflow` scopes

### Environment variables

Set these as encrypted secrets in your Cloudflare Worker settings (`npx wrangler secret put <NAME>`):

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot token from your Slack app (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Signing secret from your Slack app's Basic Information page |
| `GITHUB_TOKEN` | Personal access token with `repo` and `workflow` scopes |
| `GITHUB_WEBHOOK_SECRET` | Random secret shared between GitHub and Cloudflare to verify webhook payloads — generate with `openssl rand -hex 32` |

Also set these as plain vars in `wrangler.toml` (already present):

| Variable | Description |
|---|---|
| `GITHUB_REPO` | `owner/repo` of the repo containing the issues |
| `SLACK_CHANNEL_ID` | Channel ID where announcements are posted |
| `ADMIN_USER_ID` | Slack user ID of the bot admin |

### Slack app configuration

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Under **OAuth & Permissions**, add these bot scopes: `chat:write`, `commands`, `im:write`
3. Under **Slash Commands**, register each command pointing to:
   `https://<your-worker>.workers.dev/slack/commands`

   Commands: `/claim`, `/abandon`, `/progress`, `/whois`, `/tickets`, `/standup`, `/stats`, `/ping`

4. Under **Interactivity & Shortcuts**, set the Request URL to:
   `https://<your-worker>.workers.dev/slack/interactions`

5. Install the app to your workspace

### GitHub webhook

In your repo: **Settings → Webhooks → Add webhook**

- **Payload URL**: `https://<your-worker>.workers.dev/github/webhook`
- **Content type**: `application/json`
- **Secret**: your `GITHUB_WEBHOOK_SECRET` value
- **Events**: select **Issues** and **Pull requests**

The `in-progress` label also needs to exist in the repo before `/claim` can apply it — create it once under **Issues → Labels**.

### Deploy

```bash
npm install
npx wrangler deploy
```

---

## Architecture

```
Slack → POST /slack/commands      → Cloudflare Worker (JS)
Slack → POST /slack/interactions  → Cloudflare Worker (JS)
GitHub → POST /github/webhook     → Cloudflare Worker (JS)

Worker → GitHub Actions workflow_dispatch → Go binary (cmd/claim or cmd/abandon)
  → GitHub API (assign/unassign, comment, label)
  → Slack API (DM + channel announcement)

Cloudflare KV (TICKET_STORE):
  claim:{issueNumber}   → claim record (userId, githubUsername, issueTitle, ...)
  github_user:{userId}  → cached GitHub username
  stats:{userId}        → { claimed, closed, abandoned }
```

The Worker handles all Slack-facing requests. Go binaries run in GitHub Actions (triggered via `workflow_dispatch`) for GitHub operations that don't need to complete within Slack's 3-second response deadline.

---

## Development

### Run tests

```bash
# Go
go test ./...

# JavaScript
npm test
```

### Project structure

```
cmd/
  claim/    Go binary — assign issue, post comment, add label, notify Slack
  abandon/  Go binary — unassign issue, delete comment, remove label, notify Slack
worker/
  index.js        Cloudflare Worker entry point
  utils.js        Pure utility functions (exported for testing)
  utils.test.js
  worker.test.js
.github/
  workflows/
    claim.yml     Dispatched by worker to run cmd/claim
    abandon.yml   Dispatched by worker to run cmd/abandon
    ci.yml        Runs Go and JS tests on push/PR
```
