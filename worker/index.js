import {
  extractClosedIssues, verifySlackSignature, verifyGitHubSignature, parseSlackMention,
  incrementStat, BLOCKER_OPTIONS, blockerLabel, formatBlockerReport, searchTilEntries,
} from './utils.js';

const TIL_NUDGE_CRON = '0 21 * * 1-5';

const HELP_TEXT = [
  'Supported slash commands:',
  '/claim     - pick an unclaimed issue to work on.',
  '/abandon   - drop an issue you previously claimed.',
  '/progress  - post a status update on one of your claimed issues.',
  '/til       - share something you learned today.',
  '/til-search - search past TILs by keyword.',
  '/whois     - see what issues someone has claimed.',
  '/stats     - show the leaderboard.',
  '/tickets   - show all currently claimed tickets.',
  '/ping      - check that the bot is alive.',
  '/help      - show this help text.',
].join('\n');

const ABOUT_TEXT = [
  '🤖 *Intern Ticket Manager*',
  '',
  'Built by Mason Womack to make sure tickets actually get moved.',
  '',
  'Capabilities:',
  '• Tracks tickets interns forget to mark as in-progress',
  '• Lets interns claim open GitHub issues from Slack',
  '• Posts channel announcements when PRs are opened or merged',
  '• Runs on Cloudflare because servers cost money',
].join('\n');

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function triggerWorkflow(workflowFile, env, inputs = {}) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'interns-ticket-manager',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ ref: 'main', inputs }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API ${resp.status}: ${text}`);
  }
}

function ghHeaders(env) {
  return {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'interns-ticket-manager',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function fetchUnclaimedIssues(env) {
  const { keys } = await env.TICKET_STORE.list({ prefix: 'claim:' });
  const claimedNumbers = new Set(keys.map(k => k.name.replace('claim:', '')));

  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/issues?state=open&assignee=none&per_page=50&sort=created&direction=asc`;
  const resp = await fetch(url, { headers: ghHeaders(env) });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API ${resp.status}: ${text}`);
  }
  const issues = await resp.json();

  return issues
    .filter(i => !i.pull_request && !claimedNumbers.has(String(i.number)))
    .slice(0, 10);
}

async function lookupSlackId(githubUsername, env) {
  const { keys } = await env.TICKET_STORE.list({ prefix: 'github_user:' });
  for (const { name } of keys) {
    const stored = await env.TICKET_STORE.get(name);
    if (stored === githubUsername) return name.replace('github_user:', '');
  }
  return null;
}

async function fetchUserPRs(githubUsername, env) {
  const q = encodeURIComponent(`type:pr state:open author:${githubUsername} repo:${env.GITHUB_REPO}`);
  const resp = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=20`, { headers: ghHeaders(env) });
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.items || []).map(i => ({ number: i.number, title: i.title, url: i.html_url }));
}

async function fetchPRReviewState(prNumber, env) {
  const resp = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/pulls/${prNumber}/reviews`,
    { headers: ghHeaders(env) },
  );
  if (!resp.ok) return 'pending';
  const reviews = await resp.json();
  const byReviewer = {};
  for (const r of reviews) {
    if (r.state !== 'COMMENTED') byReviewer[r.user.login] = r.state;
  }
  const states = Object.values(byReviewer);
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.length > 0 && states.every(s => s === 'APPROVED')) return 'approved';
  return 'pending';
}

// ── Slack API helpers ─────────────────────────────────────────────────────────

async function postMessage(channelId, text, env, extra = {}) {
  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: channelId, text, ...extra }),
  });
  return resp.json();
}

async function getPermalink(channelId, messageTs, env) {
  const url = `https://slack.com/api/chat.getPermalink?channel=${encodeURIComponent(channelId)}&message_ts=${encodeURIComponent(messageTs)}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  const data = await resp.json();
  return data.ok ? data.permalink : null;
}

async function postEphemeral(channelId, userId, text, env) {
  await fetch('https://slack.com/api/chat.postEphemeral', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: channelId, user: userId, text }),
  });
}

async function openModal(triggerId, view, env) {
  const resp = await fetch('https://slack.com/api/views.open', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ trigger_id: triggerId, view }),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`views.open failed: ${data.error}`);
}

async function openClaimModal(triggerId, issues, channelId, userId, env) {
  const storedGhUser = await env.TICKET_STORE.get(`github_user:${userId}`) || '';

  const options = issues.map(issue => ({
    text: { type: 'plain_text', text: `#${issue.number} ${issue.title}`.slice(0, 75) },
    value: String(issue.number),
  }));

  await openModal(triggerId, {
    type: 'modal',
    callback_id: 'claim_issue',
    private_metadata: JSON.stringify({ channel_id: channelId }),
    title: { type: 'plain_text', text: 'Claim an Issue' },
    submit: { type: 'plain_text', text: 'Claim' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Pick an open issue to claim. It will be assigned to you on GitHub.' },
      },
      {
        type: 'input',
        block_id: 'issue_select',
        label: { type: 'plain_text', text: 'Issue' },
        element: {
          type: 'static_select',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'Select an issue...' },
          options,
        },
      },
      {
        type: 'input',
        block_id: 'github_username',
        label: { type: 'plain_text', text: 'Your GitHub Username' },
        hint: { type: 'plain_text', text: "We'll save this so you only need to enter it once." },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'e.g. masonite-byte' },
          ...(storedGhUser ? { initial_value: storedGhUser } : {}),
        },
      },
    ],
  }, env);
}

async function openAbandonModal(triggerId, claims, channelId, env) {
  const options = claims.map(claim => ({
    text: { type: 'plain_text', text: `#${claim.issueNumber} ${claim.issueTitle}`.slice(0, 75) },
    value: String(claim.issueNumber),
  }));

  await openModal(triggerId, {
    type: 'modal',
    callback_id: 'abandon_issue',
    private_metadata: JSON.stringify({ channel_id: channelId }),
    title: { type: 'plain_text', text: 'Abandon an Issue' },
    submit: { type: 'plain_text', text: 'Abandon' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Pick an issue to drop. It will be unassigned on GitHub and back in the pool.' },
      },
      {
        type: 'input',
        block_id: 'issue_select',
        label: { type: 'plain_text', text: 'Issue' },
        element: {
          type: 'static_select',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'Select an issue...' },
          options,
        },
      },
    ],
  }, env);
}

async function openProgressModal(triggerId, claims, channelId, env) {
  const options = claims.map(claim => ({
    text: { type: 'plain_text', text: `#${claim.issueNumber} ${claim.issueTitle}`.slice(0, 75) },
    value: String(claim.issueNumber),
  }));

  await openModal(triggerId, {
    type: 'modal',
    callback_id: 'post_progress',
    private_metadata: JSON.stringify({ channel_id: channelId }),
    title: { type: 'plain_text', text: 'Post an Update' },
    submit: { type: 'plain_text', text: 'Post' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'issue_select',
        label: { type: 'plain_text', text: 'Issue' },
        element: {
          type: 'static_select',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'Select an issue...' },
          options,
        },
      },
      {
        type: 'input',
        block_id: 'update_text',
        label: { type: 'plain_text', text: 'Update' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'e.g. Almost done — just need to add tests.' },
        },
      },
    ],
  }, env);
}

async function sendBlockerCheck(claim, env) {
  await postMessage(claim.userId, `Still working on #${claim.issueNumber}: ${claim.issueTitle}?`, env, {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `It's been quiet on <${claim.issueUrl}|#${claim.issueNumber}: ${claim.issueTitle}> for a few days — what's going on?`,
        },
      },
      {
        type: 'actions',
        block_id: 'blocker_check',
        elements: BLOCKER_OPTIONS.map(opt => ({
          type: 'button',
          action_id: `blocker_reason_${opt.value}`,
          text: { type: 'plain_text', text: opt.label },
          value: `${claim.issueNumber}|${opt.value}`,
          style: 'primary',
        })),
      },
    ],
  });
}

// ── Response helpers ──────────────────────────────────────────────────────────

function ephemeral(text, status = 200) {
  return new Response(JSON.stringify({ response_type: 'ephemeral', text }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ok() {
  return new Response('', { status: 200 });
}

// Reads a modal state value regardless of whether the block holds a select or text input.
// All blocks in this app use action_id 'value', so the shape is values[blockId].value.{selected_option.value|value}.
function stateVal(payload, blockId) {
  const action = payload.view?.state?.values?.[blockId]?.value;
  return action?.selected_option?.value ?? action?.value ?? null;
}

// ── Slash command handler ─────────────────────────────────────────────────────

async function handleSlashCommand(request, env, ctx) {
  const body = await request.text();

  if (!await verifySlackSignature(request, body, env.SLACK_SIGNING_SECRET)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const params = new URLSearchParams(body);
  const command = params.get('command') || '';
  const text = (params.get('text') || '').trim();
  const userId = params.get('user_id') || '';
  const channelId = params.get('channel_id') || '';
  const triggerId = params.get('trigger_id') || '';

  switch (command) {
    case '/ping':
      return ephemeral('Pong! 🏓');

    case '/help':
      return ephemeral(HELP_TEXT);

    case '/about':
      return ephemeral(ABOUT_TEXT);

    case '/claim': {
      const work = async () => {
        try {
          const issues = await fetchUnclaimedIssues(env);
          if (issues.length === 0) {
            await postEphemeral(channelId, userId, 'No unclaimed issues found right now. 🎉', env);
            return;
          }
          await openClaimModal(triggerId, issues, channelId, userId, env);
        } catch (e) {
          console.error('/claim error:', e);
          await postEphemeral(channelId, userId, `Failed to load issues: ${e.message}`, env);
        }
      };
      ctx.waitUntil(work());
      return ok();
    }

    case '/abandon': {
      const work = async () => {
        try {
          const { keys } = await env.TICKET_STORE.list({ prefix: 'claim:' });
          const all = await Promise.all(keys.map(k => env.TICKET_STORE.get(k.name, 'json')));
          const mine = all.filter(c => c && c.userId === userId);
          if (mine.length === 0) {
            await postEphemeral(channelId, userId, "You don't have any claimed issues to abandon.", env);
            return;
          }
          await openAbandonModal(triggerId, mine, channelId, env);
        } catch (e) {
          console.error('/abandon error:', e);
          await postEphemeral(channelId, userId, `Failed to load your issues: ${e.message}`, env);
        }
      };
      ctx.waitUntil(work());
      return ok();
    }

    case '/progress': {
      const work = async () => {
        try {
          const { keys } = await env.TICKET_STORE.list({ prefix: 'claim:' });
          const all = await Promise.all(keys.map(k => env.TICKET_STORE.get(k.name, 'json')));
          const mine = all.filter(c => c && c.userId === userId);
          if (mine.length === 0) {
            await postEphemeral(channelId, userId, "You don't have any claimed issues to update.", env);
            return;
          }
          await openProgressModal(triggerId, mine, channelId, env);
        } catch (e) {
          console.error('/progress error:', e);
          await postEphemeral(channelId, userId, `Failed to load your issues: ${e.message}`, env);
        }
      };
      ctx.waitUntil(work());
      return ok();
    }

    case '/til': {
      if (!text) {
        return ephemeral('Usage: `/til <something you learned today>`');
      }
      const work = async () => {
        try {
          const postedAt = new Date().toISOString();
          const posted = await postMessage(env.SLACK_CHANNEL_ID, `📚 *TIL from <@${userId}>:* ${text}`, env);
          const permalink = posted.ok ? await getPermalink(posted.channel, posted.ts, env) : null;
          await env.TICKET_STORE.put(`til:${postedAt}:${userId}`, JSON.stringify({ userId, text, postedAt, permalink }));
        } catch (e) {
          console.error('/til error:', e);
          await postEphemeral(channelId, userId, `Failed to post TIL: ${e.message}`, env);
        }
      };
      ctx.waitUntil(work());
      return ok();
    }

    case '/til-search': {
      if (!text) {
        return ephemeral('Usage: `/til-search <keyword>`');
      }
      const { keys } = await env.TICKET_STORE.list({ prefix: 'til:' });
      const all = (await Promise.all(keys.map(k => env.TICKET_STORE.get(k.name, 'json')))).filter(Boolean);
      const matches = searchTilEntries(all, text);

      if (matches.length === 0) {
        return ephemeral(`No TILs found matching "${text}".`);
      }

      const lines = [`*TILs matching "${text}":*`];
      for (const t of matches.slice(0, 10)) {
        const link = t.permalink ? ` — <${t.permalink}|view>` : '';
        lines.push(`• <@${t.userId}>: ${t.text}${link}`);
      }
      return ephemeral(lines.join('\n'));
    }

    case '/prs': {
      const work = async () => {
        try {
          const githubUsername = await env.TICKET_STORE.get(`github_user:${userId}`);
          if (!githubUsername) {
            await postEphemeral(channelId, userId, 'No GitHub username on file — use `/claim` to register one.', env);
            return;
          }
          const prs = await fetchUserPRs(githubUsername, env);
          if (prs.length === 0) {
            await postEphemeral(channelId, userId, 'You have no open PRs.', env);
            return;
          }
          const reviewStates = await Promise.all(prs.map(pr => fetchPRReviewState(pr.number, env)));
          const badges = { changes_requested: '🔴', approved: '✅', pending: '⏳' };
          const lines = ['*Your open PRs:*'];
          prs.forEach((pr, i) => {
            lines.push(`${badges[reviewStates[i]]} <${pr.url}|#${pr.number}: ${pr.title}>`);
          });
          await postEphemeral(channelId, userId, lines.join('\n'), env);
        } catch (e) {
          console.error('/prs error:', e);
          await postEphemeral(channelId, userId, `Failed to load PRs: ${e.message}`, env);
        }
      };
      ctx.waitUntil(work());
      return ok();
    }

    case '/whois': {
      const targetId = parseSlackMention(text) || userId;

      const { keys } = await env.TICKET_STORE.list({ prefix: 'claim:' });
      const all = await Promise.all(keys.map(k => env.TICKET_STORE.get(k.name, 'json')));
      const theirs = all.filter(c => c && c.userId === targetId);

      if (theirs.length === 0) {
        const msg = targetId === userId
          ? "You don't have any claimed issues."
          : `<@${targetId}> doesn't have any claimed issues.`;
        return ephemeral(msg);
      }

      const lines = [`*Issues claimed by <@${targetId}>:*`];
      for (const claim of theirs) {
        lines.push(`• #${claim.issueNumber} *${claim.issueTitle}* — <${claim.issueUrl}|view>`);
      }
      return ephemeral(lines.join('\n'));
    }

    case '/stats': {
      const { keys } = await env.TICKET_STORE.list({ prefix: 'stats:' });
      if (keys.length === 0) {
        return ephemeral('No stats yet — get to work! 💪');
      }

      const allStats = await Promise.all(keys.map(async k => {
        const uid = k.name.replace('stats:', '');
        const s = (await env.TICKET_STORE.get(k.name, 'json')) || {};
        return { uid, claimed: s.claimed || 0, closed: s.closed || 0, abandoned: s.abandoned || 0 };
      }));

      allStats.sort((a, b) => b.closed - a.closed || b.claimed - a.claimed);

      const medals = ['🥇', '🥈', '🥉'];
      const lines = ['📊 *Intern Stats*', ''];
      allStats.forEach((s, i) => {
        const medal = medals[i] || '•';
        lines.push(`${medal} <@${s.uid}> — ${s.closed} closed, ${s.claimed} claimed, ${s.abandoned} abandoned`);
      });
      return ephemeral(lines.join('\n'));
    }

    case '/standup': {
      const { keys } = await env.TICKET_STORE.list({ prefix: 'claim:' });
      if (keys.length === 0) {
        return ephemeral('No tickets are currently claimed. 🎉');
      }
      const claims = (await Promise.all(keys.map(k => env.TICKET_STORE.get(k.name, 'json')))).filter(Boolean);

      const byUser = {};
      for (const claim of claims) {
        if (!byUser[claim.userId]) byUser[claim.userId] = [];
        byUser[claim.userId].push(claim);
      }

      const lines = ['📋 *Standup Summary*', ''];
      for (const [uid, userClaims] of Object.entries(byUser)) {
        lines.push(`<@${uid}>:`);
        for (const claim of userClaims) {
          lines.push(`  • #${claim.issueNumber} *${claim.issueTitle}* — <${claim.issueUrl}|view>`);
        }
        lines.push('');
      }
      return ephemeral(lines.join('\n').trimEnd());
    }

    case '/tickets': {
      const { keys } = await env.TICKET_STORE.list({ prefix: 'claim:' });
      if (keys.length === 0) {
        return ephemeral('No tickets have been claimed yet.');
      }
      const claims = await Promise.all(keys.map(k => env.TICKET_STORE.get(k.name, 'json')));
      const lines = ['*Claimed Tickets:*'];
      for (const claim of claims.filter(Boolean)) {
        lines.push(`• #${claim.issueNumber} *${claim.issueTitle}* — <@${claim.userId}> — <${claim.issueUrl}|view>`);
      }
      return ephemeral(lines.join('\n'));
    }

    default:
      return ephemeral(`Unknown command: ${command}`);
  }
}

// ── Interaction handler (block_actions / modal submissions) ──────────────────

async function handleInteraction(request, env, ctx) {
  const body = await request.text();

  if (!await verifySlackSignature(request, body, env.SLACK_SIGNING_SECRET)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const params = new URLSearchParams(body);
  const payload = JSON.parse(params.get('payload') || '{}');

  if (payload.type === 'block_actions') {
    const action = payload.actions?.[0];

    if (action?.action_id?.startsWith('blocker_reason_')) {
      const [issueNumber, reasonValue] = (action.value || '').split('|');
      const userId = payload.user?.id;
      const responseUrl = payload.response_url;

      const work = async () => {
        try {
          const claim = await env.TICKET_STORE.get(`claim:${issueNumber}`, 'json');
          if (!claim || claim.userId !== userId) return;

          await env.TICKET_STORE.put(`claim:${issueNumber}`, JSON.stringify({
            ...claim,
            blockerReason: reasonValue,
            blockerRespondedAt: new Date().toISOString(),
          }));

          if (responseUrl) {
            await fetch(responseUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                replace_original: true,
                text: `✅ Got it — *#${issueNumber}* marked as *"${blockerLabel(reasonValue)}"*. Thanks for the update!`,
              }),
            });
          }

          if (reasonValue === 'confused') {
            await postMessage(claim.channelId || env.SLACK_CHANNEL_ID,
              `🆘 <@${userId}> could use a hand on <${claim.issueUrl}|#${issueNumber}: ${claim.issueTitle}>`,
              env,
            );
          }
        } catch (e) {
          console.error('blocker_reason action error:', e);
        }
      };
      ctx.waitUntil(work());
      return ok();
    }

    console.log('block_action:', action?.action_id);
    return ok();
  }

  if (payload.type === 'view_submission') {
    const callbackId = payload.view?.callback_id;

    if (callbackId === 'abandon_issue') {
      const userId = payload.user?.id;
      const issueNumber = stateVal(payload, 'issue_select');
      let meta = {};
      try { meta = JSON.parse(payload.view?.private_metadata || '{}'); } catch {}
      const channelId = meta.channel_id || userId;

      const work = async () => {
        try {
          const claim = await env.TICKET_STORE.get(`claim:${issueNumber}`, 'json');
          const githubUsername = claim?.githubUsername || null;

          await env.TICKET_STORE.delete(`claim:${issueNumber}`);
          await incrementStat(userId, 'abandoned', env.TICKET_STORE);

          if (githubUsername) {
            await triggerWorkflow('abandon.yml', env, {
              issue_number: issueNumber,
              github_username: githubUsername,
              slack_user_id: userId,
              slack_channel_id: channelId,
            });
          }
        } catch (e) {
          console.error('abandon_issue submission error:', e);
          await postMessage(userId, `❌ Failed to abandon issue: ${e.message}`, env);
        }
      };
      ctx.waitUntil(work());
      return ok();
    }

    if (callbackId === 'claim_issue') {
      const userId = payload.user?.id;
      const issueNumber = stateVal(payload, 'issue_select');
      const githubUsername = stateVal(payload, 'github_username')?.trim();
      let meta = {};
      try { meta = JSON.parse(payload.view?.private_metadata || '{}'); } catch {}
      const channelId = meta.channel_id || userId;

      const work = async () => {
        try {
          if (githubUsername) {
            await env.TICKET_STORE.put(`github_user:${userId}`, githubUsername);
          }

          const issueResp = await fetch(
            `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}`,
            { headers: ghHeaders(env) },
          );
          if (!issueResp.ok) throw new Error(`GitHub API ${issueResp.status}`);
          const issue = await issueResp.json();

          await env.TICKET_STORE.put(`claim:${issueNumber}`, JSON.stringify({
            userId,
            githubUsername: githubUsername || null,
            issueNumber: parseInt(issueNumber, 10),
            issueTitle: issue.title,
            issueUrl: issue.html_url,
            channelId,
            claimedAt: new Date().toISOString(),
          }));

          await incrementStat(userId, 'claimed', env.TICKET_STORE);

          if (githubUsername) {
            await triggerWorkflow('claim.yml', env, {
              issue_number: issueNumber,
              github_username: githubUsername,
              slack_user_id: userId,
              slack_channel_id: channelId,
            });
          }
        } catch (e) {
          console.error('claim_issue submission error:', e);
          await postMessage(userId, `❌ Failed to claim issue: ${e.message}`, env);
        }
      };
      ctx.waitUntil(work());
      return ok();
    }

    if (callbackId === 'post_progress') {
      const userId = payload.user?.id;
      const issueNumber = stateVal(payload, 'issue_select');
      const updateText = stateVal(payload, 'update_text')?.trim();
      let meta = {};
      try { meta = JSON.parse(payload.view?.private_metadata || '{}'); } catch {}
      const channelId = meta.channel_id || env.SLACK_CHANNEL_ID;

      const work = async () => {
        try {
          const claim = await env.TICKET_STORE.get(`claim:${issueNumber}`, 'json');
          const title = claim?.issueTitle || `#${issueNumber}`;
          const url = claim?.issueUrl || '';

          if (claim) {
            await env.TICKET_STORE.put(`claim:${issueNumber}`, JSON.stringify({
              ...claim,
              lastProgressAt: new Date().toISOString(),
              blockerReason: null,
              blockerPromptedAt: null,
              blockerRespondedAt: null,
            }));
          }

          const msg = [
            `📝 *Update from <@${userId}>* on <${url}|#${issueNumber}: ${title}>`,
            updateText,
          ].join('\n');

          await postMessage(channelId, msg, env);
        } catch (e) {
          console.error('post_progress submission error:', e);
          await postMessage(userId, `❌ Failed to post update: ${e.message}`, env);
        }
      };
      ctx.waitUntil(work());
      return ok();
    }
  }

  return ok();
}

// ── GitHub webhook handler ────────────────────────────────────────────────────

async function handleGitHubWebhook(request, env, ctx) {
  const body = await request.text();

  if (!await verifyGitHubSignature(request, body, env.GITHUB_WEBHOOK_SECRET)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const event = request.headers.get('X-GitHub-Event');
  if (event !== 'pull_request' && event !== 'issues' && event !== 'pull_request_review') return ok();

  const payload = JSON.parse(body);
  const action = payload.action;

  if (event === 'pull_request_review') {
    if (payload.action === 'submitted' && payload.review?.state === 'changes_requested') {
      const ghUsername = payload.pull_request?.user?.login;
      const prUrl = payload.pull_request?.html_url;
      const prTitle = payload.pull_request?.title;
      const prNumber = payload.pull_request?.number;
      const reviewer = payload.review?.user?.login;
      const work = async () => {
        const slackId = await lookupSlackId(ghUsername, env);
        if (slackId) {
          await postMessage(slackId,
            `🔴 Changes requested on your PR <${prUrl}|#${prNumber}: ${prTitle}> by @${reviewer}`,
            env,
          );
        }
      };
      ctx.waitUntil(work());
    }
    return ok();
  }

  if (event === 'issues') {
    if (action === 'closed') {
      const num = String(payload.issue.number);
      const claim = await env.TICKET_STORE.get(`claim:${num}`, 'json');
      if (claim) {
        await env.TICKET_STORE.delete(`claim:${num}`);
        await incrementStat(claim.userId, 'closed', env.TICKET_STORE);
      }
    }
    return ok();
  }

  const pr = payload.pull_request;
  const prUrl = pr.html_url;
  const prTitle = pr.title;
  const issueNumbers = extractClosedIssues(pr.body);

  if (issueNumbers.length === 0) {
    if (action === 'opened') {
      const ghUsername = pr.user?.login;
      if (ghUsername) {
        const work = async () => {
          const { keys } = await env.TICKET_STORE.list({ prefix: 'claim:' });
          const claims = (await Promise.all(keys.map(k => env.TICKET_STORE.get(k.name, 'json')))).filter(Boolean);
          const hasClaim = claims.some(c => c.githubUsername === ghUsername);
          if (hasClaim) {
            const slackId = await lookupSlackId(ghUsername, env);
            if (slackId) {
              await postMessage(slackId,
                `👀 Your PR <${prUrl}|${prTitle}> doesn't close any tracked issue — did you mean to add \`Closes #N\`?`,
                env,
              );
            }
          }
        };
        ctx.waitUntil(work());
      }
    }
    return ok();
  }

  const work = async () => {
    for (const num of issueNumbers) {
      const claim = await env.TICKET_STORE.get(`claim:${num}`, 'json');
      if (!claim) continue;

      const channel = claim.channelId || env.SLACK_CHANNEL_ID;

      if (action === 'opened') {
        await postMessage(channel,
          `🔀 <@${claim.userId}> opened a PR for <${claim.issueUrl}|#${num}: ${claim.issueTitle}>\n<${prUrl}|${prTitle}>`,
          env,
        );
      }

      if (action === 'closed' && pr.merged) {
        await postMessage(channel,
          `🎉 <@${claim.userId}> merged a PR and closed <${claim.issueUrl}|#${num}: ${claim.issueTitle}> — nice work!\n<${prUrl}|${prTitle}>`,
          env,
        );
        await env.TICKET_STORE.delete(`claim:${num}`);
        await incrementStat(claim.userId, 'closed', env.TICKET_STORE);
      }
    }
  };

  ctx.waitUntil(work());
  return ok();
}

// ── Main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === 'POST' && url.pathname === '/slack/commands') {
        return handleSlashCommand(request, env, ctx);
      }

      if (request.method === 'POST' && url.pathname === '/slack/interactions') {
        return handleInteraction(request, env, ctx);
      }

      if (request.method === 'POST' && url.pathname === '/github/webhook') {
        return handleGitHubWebhook(request, env, ctx);
      }

      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.error('unhandled fetch error:', e);
      return new Response('Internal Server Error', { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    if (event.cron === TIL_NUDGE_CRON) {
      await postMessage(env.SLACK_CHANNEL_ID,
        "📚 What's one small thing you learned today? Share it with `/til <your answer>`.",
        env,
      );
      return;
    }

    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const { keys } = await env.TICKET_STORE.list({ prefix: 'claim:' });
    const claims = (await Promise.all(
      keys.map(k => env.TICKET_STORE.get(k.name, 'json')),
    )).filter(Boolean);

    const byUser = {};
    for (const claim of claims) {
      if (!byUser[claim.userId]) byUser[claim.userId] = [];
      byUser[claim.userId].push(claim);
    }

    const staleClaims = [];

    for (const [userId, userClaims] of Object.entries(byUser)) {
      const githubUsername = await env.TICKET_STORE.get(`github_user:${userId}`);

      let prs = [];
      if (githubUsername) {
        try { prs = await fetchUserPRs(githubUsername, env); } catch {}
      }

      const lines = ['📋 *Your morning update*', '', '*Issues:*'];
      for (const claim of userClaims) {
        const lastActivity = claim.lastProgressAt || claim.claimedAt;
        const stale = lastActivity && (now - new Date(lastActivity).getTime()) >= THREE_DAYS_MS;
        lines.push(`• <${claim.issueUrl}|#${claim.issueNumber}: ${claim.issueTitle}>${stale ? ' ⚠️' : ''}`);
        if (stale) staleClaims.push(claim);
      }

      if (prs.length > 0) {
        lines.push('', '*PRs:*');
        const badges = { changes_requested: '🔴', approved: '✅', pending: '⏳' };
        for (const pr of prs) {
          let state = 'pending';
          try { state = await fetchPRReviewState(pr.number, env); } catch {}
          lines.push(`${badges[state]} <${pr.url}|#${pr.number}: ${pr.title}>`);
        }
      }

      await postMessage(userId, lines.join('\n'), env);
    }

    // Ask why, once per staleness episode (cleared again when /progress is posted).
    for (const claim of staleClaims) {
      if (claim.blockerPromptedAt) continue;
      await env.TICKET_STORE.put(`claim:${claim.issueNumber}`, JSON.stringify({
        ...claim,
        blockerPromptedAt: new Date().toISOString(),
      }));
      await sendBlockerCheck(claim, env);
    }

    const report = formatBlockerReport(staleClaims);
    if (report && env.ADMIN_USER_ID) {
      await postMessage(env.ADMIN_USER_ID, report, env);
    }
  },
};
