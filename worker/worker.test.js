import { describe, it, expect } from 'vitest';
import worker from './index.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeKV() {
  const store = new Map();
  return {
    get: async (key, type) => {
      const val = store.get(key);
      if (val === undefined) return null;
      return type === 'json' ? JSON.parse(val) : val;
    },
    put: async (key, value) => store.set(key, value),
    delete: async (key) => store.delete(key),
    list: async ({ prefix }) => ({
      keys: [...store.keys()]
        .filter(k => k.startsWith(prefix))
        .map(name => ({ name })),
    }),
    _store: store,
  };
}

function makeEnv(overrides = {}) {
  return {
    SLACK_SIGNING_SECRET: 'test-signing-secret',
    SLACK_BOT_TOKEN: 'xoxb-test',
    GITHUB_TOKEN: 'ghp-test',
    GITHUB_WEBHOOK_SECRET: 'gh-webhook-secret',
    GITHUB_REPO: 'owner/repo',
    SLACK_CHANNEL_ID: 'C123',
    TICKET_STORE: makeKV(),
    _ctx: { waitUntil: () => {} },
    ...overrides,
  };
}

const ctx = {};

async function signedSlackRequest(path, body, secret, timestampOffset = 0) {
  const timestamp = Math.floor(Date.now() / 1000) + timestampOffset;
  const sigBase = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const raw = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sigBase));
  const sig = 'v0=' + Array.from(new Uint8Array(raw))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Slack-Request-Timestamp': String(timestamp),
      'X-Slack-Signature': sig,
    },
    body,
  });
}

async function signedGitHubRequest(path, body, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const raw = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const sig = 'sha256=' + Array.from(new Uint8Array(raw))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': sig,
      'X-GitHub-Event': 'pull_request',
    },
    body,
  });
}

// ── Routing ───────────────────────────────────────────────────────────────────

describe('routing', () => {
  it('returns 404 for GET /', async () => {
    const req = new Request('https://example.com/', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown POST path', async () => {
    const req = new Request('https://example.com/unknown', { method: 'POST' });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(404);
  });
});

// ── Auth gates ────────────────────────────────────────────────────────────────

describe('auth gates', () => {
  it('POST /slack/commands with no signature returns 401', async () => {
    const req = new Request('https://example.com/slack/commands', {
      method: 'POST',
      body: 'command=%2Fping',
    });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(401);
  });

  it('POST /slack/commands with wrong secret returns 401', async () => {
    const req = await signedSlackRequest('/slack/commands', 'command=%2Fping', 'wrong-secret');
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(401);
  });

  it('POST /slack/interactions with no signature returns 401', async () => {
    const req = new Request('https://example.com/slack/interactions', {
      method: 'POST',
      body: 'payload=%7B%7D',
    });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(401);
  });

  it('POST /github/webhook with no signature returns 401', async () => {
    const req = new Request('https://example.com/github/webhook', {
      method: 'POST',
      body: '{}',
    });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(401);
  });

  it('POST /github/webhook with wrong secret returns 401', async () => {
    const req = await signedGitHubRequest('/github/webhook', '{}', 'wrong-secret');
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(401);
  });
});

// ── /ping ─────────────────────────────────────────────────────────────────────

describe('/ping', () => {
  it('returns Pong with a valid signature', async () => {
    const env = makeEnv();
    const body = 'command=%2Fping&user_id=U1&channel_id=C1&trigger_id=T1&text=';
    const req = await signedSlackRequest('/slack/commands', body, env.SLACK_SIGNING_SECRET);
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.text).toContain('Pong');
  });
});

// ── /whois ────────────────────────────────────────────────────────────────────

describe('/whois', () => {
  it('returns "no claimed issues" for a user with nothing claimed', async () => {
    const env = makeEnv();
    const body = 'command=%2Fwhois&user_id=U1&channel_id=C1&trigger_id=T1&text=';
    const req = await signedSlackRequest('/slack/commands', body, env.SLACK_SIGNING_SECRET);
    const res = await worker.fetch(req, env, ctx);
    const json = await res.json();
    expect(json.text).toContain("don't have any claimed issues");
  });

  it('shows claims for the mentioned user', async () => {
    const env = makeEnv();
    await env.TICKET_STORE.put('claim:42', JSON.stringify({
      userId: 'U2',
      issueNumber: 42,
      issueTitle: 'Fix the thing',
      issueUrl: 'https://github.com/owner/repo/issues/42',
    }));
    const body = 'command=%2Fwhois&user_id=U1&channel_id=C1&trigger_id=T1&text=%3C%40U2%3E';
    const req = await signedSlackRequest('/slack/commands', body, env.SLACK_SIGNING_SECRET);
    const res = await worker.fetch(req, env, ctx);
    const json = await res.json();
    expect(json.text).toContain('U2');
    expect(json.text).toContain('Fix the thing');
  });

  it('falls back to the caller when no mention is provided', async () => {
    const env = makeEnv();
    await env.TICKET_STORE.put('claim:7', JSON.stringify({
      userId: 'U1',
      issueNumber: 7,
      issueTitle: 'My issue',
      issueUrl: 'https://github.com/owner/repo/issues/7',
    }));
    const body = 'command=%2Fwhois&user_id=U1&channel_id=C1&trigger_id=T1&text=';
    const req = await signedSlackRequest('/slack/commands', body, env.SLACK_SIGNING_SECRET);
    const res = await worker.fetch(req, env, ctx);
    const json = await res.json();
    expect(json.text).toContain('My issue');
  });
});

// ── /tickets ──────────────────────────────────────────────────────────────────

describe('/tickets', () => {
  it('returns empty message when no tickets are claimed', async () => {
    const env = makeEnv();
    const body = 'command=%2Ftickets&user_id=U1&channel_id=C1&trigger_id=T1&text=';
    const req = await signedSlackRequest('/slack/commands', body, env.SLACK_SIGNING_SECRET);
    const res = await worker.fetch(req, env, ctx);
    const json = await res.json();
    expect(json.text).toContain('No tickets');
  });

  it('lists all claimed tickets', async () => {
    const env = makeEnv();
    await env.TICKET_STORE.put('claim:1', JSON.stringify({
      userId: 'U1', issueNumber: 1, issueTitle: 'Alpha', issueUrl: 'https://github.com/owner/repo/issues/1',
    }));
    await env.TICKET_STORE.put('claim:2', JSON.stringify({
      userId: 'U2', issueNumber: 2, issueTitle: 'Beta', issueUrl: 'https://github.com/owner/repo/issues/2',
    }));
    const body = 'command=%2Ftickets&user_id=U1&channel_id=C1&trigger_id=T1&text=';
    const req = await signedSlackRequest('/slack/commands', body, env.SLACK_SIGNING_SECRET);
    const res = await worker.fetch(req, env, ctx);
    const json = await res.json();
    expect(json.text).toContain('Alpha');
    expect(json.text).toContain('Beta');
  });
});

// ── /stats ────────────────────────────────────────────────────────────────────

describe('/stats', () => {
  it('returns "no stats yet" when KV is empty', async () => {
    const env = makeEnv();
    const body = 'command=%2Fstats&user_id=U1&channel_id=C1&trigger_id=T1&text=';
    const req = await signedSlackRequest('/slack/commands', body, env.SLACK_SIGNING_SECRET);
    const res = await worker.fetch(req, env, ctx);
    const json = await res.json();
    expect(json.text).toContain('No stats yet');
  });

  it('shows stats sorted by closed descending', async () => {
    const env = makeEnv();
    await env.TICKET_STORE.put('stats:U1', JSON.stringify({ claimed: 3, closed: 1, abandoned: 0 }));
    await env.TICKET_STORE.put('stats:U2', JSON.stringify({ claimed: 2, closed: 3, abandoned: 1 }));
    const body = 'command=%2Fstats&user_id=U1&channel_id=C1&trigger_id=T1&text=';
    const req = await signedSlackRequest('/slack/commands', body, env.SLACK_SIGNING_SECRET);
    const res = await worker.fetch(req, env, ctx);
    const json = await res.json();
    const u2pos = json.text.indexOf('U2');
    const u1pos = json.text.indexOf('U1');
    expect(u2pos).toBeLessThan(u1pos);
  });
});
