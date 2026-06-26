const HELP_TEXT = [
  'Supported slash commands:',
  '/claim     - pick an unclaimed issue to work on.',
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
  '• Runs on Cloudflare because servers cost money',
].join('\n');

// ── Signature verification ────────────────────────────────────────────────────

async function verifySlackSignature(request, body, signingSecret) {
  const timestamp = request.headers.get('X-Slack-Request-Timestamp');
  const slackSig = request.headers.get('X-Slack-Signature');
  if (!timestamp || !slackSig) return false;

  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const raw = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  const computed = 'v0=' + Array.from(new Uint8Array(raw))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return computed === slackSig;
}

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
            claimedAt: new Date().toISOString(),
          }));

          if (githubUsername) {
            await triggerWorkflow('claim.yml', env, {
              issue_number: issueNumber,
              github_username: githubUsername,
              slack_user_id: userId,
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
  }

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

    return new Response('Not found', { status: 404 });
  },
};
