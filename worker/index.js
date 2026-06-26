import { extractClosedIssues, verifySlackSignature, verifyGitHubSignature, parseSlackMention, incrementStat } from './utils.js';

const HELP_TEXT = [
  'Supported slash commands:',
  '/claim     - pick an unclaimed issue to work on.',
  '/abandon   - drop an issue you previously claimed.',
  '/progress  - post a status update on one of your claimed issues.',
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

async function openClaimModal(triggerId, issues, channelId, userId, env) {
  const storedGhUser = await env.TICKET_STORE.get(`github_user:${userId}`) || '';

  const options = issues.map(issue => ({
    text: { type: 'plain_text', text: `#${issue.number} ${issue.title}`.slice(0, 75) },
    value: String(issue.number),
  }));

  const modal = {
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
  };

  const resp = await fetch('https://slack.com/api/views.open', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ trigger_id: triggerId, view: modal }),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`views.open failed: ${data.error}`);
}

async function openAbandonModal(triggerId, claims, channelId, env) {
  const options = claims.map(claim => ({
    text: { type: 'plain_text', text: `#${claim.issueNumber} ${claim.issueTitle}`.slice(0, 75) },
    value: String(claim.issueNumber),
  }));

  const modal = {
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
  };

  const resp = await fetch('https://slack.com/api/views.open', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ trigger_id: triggerId, view: modal }),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`views.open failed: ${data.error}`);
}

async function openProgressModal(triggerId, claims, channelId, env) {
  const options = claims.map(claim => ({
    text: { type: 'plain_text', text: `#${claim.issueNumber} ${claim.issueTitle}`.slice(0, 75) },
    value: String(claim.issueNumber),
  }));

  const modal = {
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
  };

  const resp = await fetch('https://slack.com/api/views.open', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ trigger_id: triggerId, view: modal }),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`views.open failed: ${data.error}`);
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

// ── Slash command handler ─────────────────────────────────────────────────────

async function handleSlashCommand(request, env) {
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
      if (typeof env._ctx?.waitUntil === 'function') env._ctx.waitUntil(work());
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
      if (typeof env._ctx?.waitUntil === 'function') env._ctx.waitUntil(work());
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
      if (typeof env._ctx?.waitUntil === 'function') env._ctx.waitUntil(work());
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

async function handleInteraction(request, env) {
  const body = await request.text();

  if (!await verifySlackSignature(request, body, env.SLACK_SIGNING_SECRET)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const params = new URLSearchParams(body);
  const payload = JSON.parse(params.get('payload') || '{}');

  if (payload.type === 'block_actions') {
    const action = payload.actions?.[0];
    console.log('block_action:', action?.action_id);
    return ok();
  }

  if (payload.type === 'view_submission') {
    const callbackId = payload.view?.callback_id;

    if (callbackId === 'abandon_issue') {
      const userId = payload.user?.id;
      const issueNumber = payload.view?.state?.values?.issue_select?.value?.selected_option?.value;
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
      if (typeof env._ctx?.waitUntil === 'function') env._ctx.waitUntil(work());
      return ok();
    }

    if (callbackId === 'claim_issue') {
      const userId = payload.user?.id;
      const issueNumber = payload.view?.state?.values?.issue_select?.value?.selected_option?.value;
      const githubUsername = payload.view?.state?.values?.github_username?.value?.value?.trim();
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
      if (typeof env._ctx?.waitUntil === 'function') env._ctx.waitUntil(work());
      return ok();
    }

    if (callbackId === 'post_progress') {
      const userId = payload.user?.id;
      const issueNumber = payload.view?.state?.values?.issue_select?.value?.selected_option?.value;
      const updateText = payload.view?.state?.values?.update_text?.value?.value?.trim();
      let meta = {};
      try { meta = JSON.parse(payload.view?.private_metadata || '{}'); } catch {}
      const channelId = meta.channel_id || env.SLACK_CHANNEL_ID;

      const work = async () => {
        try {
          const claim = await env.TICKET_STORE.get(`claim:${issueNumber}`, 'json');
          const title = claim?.issueTitle || `#${issueNumber}`;
          const url = claim?.issueUrl || '';

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
      if (typeof env._ctx?.waitUntil === 'function') env._ctx.waitUntil(work());
      return ok();
    }
  }

  return ok();
}

// ── GitHub webhook handler ────────────────────────────────────────────────────

async function handleGitHubWebhook(request, env) {
  const body = await request.text();

  if (!await verifyGitHubSignature(request, body, env.GITHUB_WEBHOOK_SECRET)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const event = request.headers.get('X-GitHub-Event');
  if (event !== 'pull_request') return ok();

  const payload = JSON.parse(body);
  const action = payload.action;
  const pr = payload.pull_request;
  const prUrl = pr.html_url;
  const prTitle = pr.title;
  const prAuthor = pr.user.login;
  const issueNumbers = extractClosedIssues(pr.body);

  if (issueNumbers.length === 0) return ok();

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

  if (typeof env._ctx?.waitUntil === 'function') env._ctx.waitUntil(work());
  return ok();
}

// ── Main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    env._ctx = ctx;

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/slack/commands') {
      return handleSlashCommand(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/slack/interactions') {
      return handleInteraction(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/github/webhook') {
      return handleGitHubWebhook(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};
