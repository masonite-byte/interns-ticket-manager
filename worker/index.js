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

  switch (command) {
    case '/ping':
      return ephemeral('Pong! 🏓');

    case '/help':
      return ephemeral(HELP_TEXT);

    case '/about':
      return ephemeral(ABOUT_TEXT);

    case '/claim':
      return ephemeral('Coming soon.');

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
    console.log('view_submission:', callbackId);
    return ok();
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
