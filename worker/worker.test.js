import { describe, it, expect, vi, afterEach } from 'vitest';
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

async function signedGitHubRequest(path, body, secret, event = 'pull_request') {
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
      'X-GitHub-Event': event,
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

// ── /standup ──────────────────────────────────────────────────────────────────

describe('/standup', () => {
  it('returns empty message when no tickets are claimed', async () => {
    const env = makeEnv();
    const body = 'command=%2Fstandup&user_id=U1&channel_id=C1&trigger_id=T1&text=';
    const req = await signedSlackRequest('/slack/commands', body, env.SLACK_SIGNING_SECRET);
    const res = await worker.fetch(req, env, ctx);
    const json = await res.json();
    expect(json.text).toContain('No tickets');
  });

  it('groups claims by user', async () => {
    const env = makeEnv();
    await env.TICKET_STORE.put('claim:1', JSON.stringify({
      userId: 'U1', issueNumber: 1, issueTitle: 'Fix login', issueUrl: 'https://github.com/o/r/issues/1',
    }));
    await env.TICKET_STORE.put('claim:2', JSON.stringify({
      userId: 'U2', issueNumber: 2, issueTitle: 'Add tests', issueUrl: 'https://github.com/o/r/issues/2',
    }));
    await env.TICKET_STORE.put('claim:3', JSON.stringify({
      userId: 'U1', issueNumber: 3, issueTitle: 'Fix typo', issueUrl: 'https://github.com/o/r/issues/3',
    }));
    const body = 'command=%2Fstandup&user_id=U1&channel_id=C1&trigger_id=T1&text=';
    const req = await signedSlackRequest('/slack/commands', body, env.SLACK_SIGNING_SECRET);
    const res = await worker.fetch(req, env, ctx);
    const json = await res.json();
    expect(json.text).toContain('U1');
    expect(json.text).toContain('Fix login');
    expect(json.text).toContain('Fix typo');
    expect(json.text).toContain('U2');
    expect(json.text).toContain('Add tests');
  });
});

// ── scheduled (morning digest) ───────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scheduled', () => {
  it('sends a digest DM to users with claimed issues', async () => {
    const env = makeEnv();
    await env.TICKET_STORE.put('claim:1', JSON.stringify({
      userId: 'U1',
      issueNumber: 1,
      issueTitle: 'Fix the thing',
      issueUrl: 'https://github.com/o/r/issues/1',
      claimedAt: new Date().toISOString(),
    }));

    const mockFetch = vi.fn().mockResolvedValue({ json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', mockFetch);

    await worker.scheduled({}, env, {});

    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({ method: 'POST' }),
    );
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.channel).toBe('U1');
    expect(callBody.text).toContain('Fix the thing');
  });

  it('flags stale issues with a warning badge', async () => {
    const env = makeEnv();
    const oldDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    await env.TICKET_STORE.put('claim:1', JSON.stringify({
      userId: 'U1',
      issueNumber: 1,
      issueTitle: 'Old issue',
      issueUrl: 'https://github.com/o/r/issues/1',
      claimedAt: oldDate,
    }));

    const mockFetch = vi.fn().mockResolvedValue({ json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', mockFetch);

    await worker.scheduled({}, env, {});

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.text).toContain('⚠️');
  });

  it('does not flag fresh claims with a warning badge', async () => {
    const env = makeEnv();
    await env.TICKET_STORE.put('claim:1', JSON.stringify({
      userId: 'U1',
      issueNumber: 1,
      issueTitle: 'Recent issue',
      issueUrl: 'https://github.com/o/r/issues/1',
      claimedAt: new Date().toISOString(),
    }));

    const mockFetch = vi.fn().mockResolvedValue({ json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', mockFetch);

    await worker.scheduled({}, env, {});

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.text).not.toContain('⚠️');
  });

  it('uses lastProgressAt over claimedAt when checking staleness', async () => {
    const env = makeEnv();
    const oldClaim = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const recentProgress = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    await env.TICKET_STORE.put('claim:1', JSON.stringify({
      userId: 'U1',
      issueNumber: 1,
      issueTitle: 'Active issue',
      issueUrl: 'https://github.com/o/r/issues/1',
      claimedAt: oldClaim,
      lastProgressAt: recentProgress,
    }));

    const mockFetch = vi.fn().mockResolvedValue({ json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', mockFetch);

    await worker.scheduled({}, env, {});

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.text).not.toContain('⚠️');
  });

  it('does not send a digest when there are no claims', async () => {
    const env = makeEnv();
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    await worker.scheduled({}, env, {});
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── /prs ─────────────────────────────────────────────────────────────────────

describe('/prs', () => {
  it('returns "no GitHub username" message when none is stored', async () => {
    const env = makeEnv();
    let ephemeralText = null;
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url === 'https://slack.com/api/chat.postEphemeral') {
        return { json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', mockFetch);

    const waitUntilPromises = [];
    const ctx = { waitUntil: (p) => waitUntilPromises.push(p) };
    const body = 'command=%2Fprs&user_id=U1&channel_id=C1&trigger_id=T1&text=';
    const req = await signedSlackRequest('/slack/commands', body, env.SLACK_SIGNING_SECRET);
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);

    await Promise.all(waitUntilPromises);
    const ephemeralCall = mockFetch.mock.calls.find(([url]) => url === 'https://slack.com/api/chat.postEphemeral');
    expect(ephemeralCall).toBeDefined();
    const ephBody = JSON.parse(ephemeralCall[1].body);
    expect(ephBody.text).toContain('/claim');
  });

  it('posts an ephemeral list of open PRs with review state badges', async () => {
    const env = makeEnv();
    await env.TICKET_STORE.put('github_user:U1', 'masonite-byte');

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('/search/issues')) {
        return { ok: true, json: async () => ({ items: [{ number: 99, title: 'My PR', html_url: 'https://github.com/o/r/pull/99' }] }) };
      }
      if (url.includes('/pulls/99/reviews')) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal('fetch', mockFetch);

    const waitUntilPromises = [];
    const ctx = { waitUntil: (p) => waitUntilPromises.push(p) };
    const body = 'command=%2Fprs&user_id=U1&channel_id=C1&trigger_id=T1&text=';
    const req = await signedSlackRequest('/slack/commands', body, env.SLACK_SIGNING_SECRET);
    await worker.fetch(req, env, ctx);
    await Promise.all(waitUntilPromises);

    const ephemeralCall = mockFetch.mock.calls.find(([url]) => url === 'https://slack.com/api/chat.postEphemeral');
    expect(ephemeralCall).toBeDefined();
    const ephBody = JSON.parse(ephemeralCall[1].body);
    expect(ephBody.text).toContain('My PR');
    expect(ephBody.text).toContain('⏳');
  });
});

// ── PR link check ─────────────────────────────────────────────────────────────

describe('PR link check', () => {
  it('DMs intern when they open a PR with no linked issue but have a claim', async () => {
    const env = makeEnv();
    await env.TICKET_STORE.put('claim:5', JSON.stringify({
      userId: 'U1', issueNumber: 5, issueTitle: 'Some issue', githubUsername: 'masonite-byte',
    }));
    await env.TICKET_STORE.put('github_user:U1', 'masonite-byte');

    const mockFetch = vi.fn().mockResolvedValue({ json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', mockFetch);

    const prPayload = JSON.stringify({
      action: 'opened',
      pull_request: {
        html_url: 'https://github.com/o/r/pull/10',
        title: 'Add feature',
        body: 'No closes keyword here.',
        user: { login: 'masonite-byte' },
      },
    });
    const waitUntilPromises = [];
    const ctx = { waitUntil: (p) => waitUntilPromises.push(p) };
    const req = await signedGitHubRequest('/github/webhook', prPayload, env.GITHUB_WEBHOOK_SECRET, 'pull_request');
    await worker.fetch(req, env, ctx);
    await Promise.all(waitUntilPromises);

    const dmCall = mockFetch.mock.calls.find(([url]) => url === 'https://slack.com/api/chat.postMessage');
    expect(dmCall).toBeDefined();
    const dmBody = JSON.parse(dmCall[1].body);
    expect(dmBody.channel).toBe('U1');
    expect(dmBody.text).toContain('Closes #N');
  });

  it('does not DM when the PR author has no claimed issues', async () => {
    const env = makeEnv();

    const mockFetch = vi.fn().mockResolvedValue({ json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', mockFetch);

    const prPayload = JSON.stringify({
      action: 'opened',
      pull_request: {
        html_url: 'https://github.com/o/r/pull/10',
        title: 'Unrelated PR',
        body: 'Just a chore.',
        user: { login: 'masonite-byte' },
      },
    });
    const waitUntilPromises = [];
    const ctx = { waitUntil: (p) => waitUntilPromises.push(p) };
    const req = await signedGitHubRequest('/github/webhook', prPayload, env.GITHUB_WEBHOOK_SECRET, 'pull_request');
    await worker.fetch(req, env, ctx);
    await Promise.all(waitUntilPromises);

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── changes-requested DM ──────────────────────────────────────────────────────

describe('changes-requested DM', () => {
  it('DMs the PR author when changes are requested', async () => {
    const env = makeEnv();
    await env.TICKET_STORE.put('github_user:U1', 'masonite-byte');

    const mockFetch = vi.fn().mockResolvedValue({ json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', mockFetch);

    const reviewPayload = JSON.stringify({
      action: 'submitted',
      review: { state: 'changes_requested', user: { login: 'reviewer-jane' } },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/o/r/pull/7',
        title: 'My feature',
        user: { login: 'masonite-byte' },
      },
    });
    const waitUntilPromises = [];
    const ctx = { waitUntil: (p) => waitUntilPromises.push(p) };
    const req = await signedGitHubRequest('/github/webhook', reviewPayload, env.GITHUB_WEBHOOK_SECRET, 'pull_request_review');
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    await Promise.all(waitUntilPromises);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({ method: 'POST' }),
    );
    const dmBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(dmBody.channel).toBe('U1');
    expect(dmBody.text).toContain('🔴');
    expect(dmBody.text).toContain('reviewer-jane');
  });

  it('does not DM for approved reviews', async () => {
    const env = makeEnv();
    await env.TICKET_STORE.put('github_user:U1', 'masonite-byte');

    const mockFetch = vi.fn().mockResolvedValue({ json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', mockFetch);

    const reviewPayload = JSON.stringify({
      action: 'submitted',
      review: { state: 'approved', user: { login: 'reviewer-jane' } },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/o/r/pull/7',
        title: 'My feature',
        user: { login: 'masonite-byte' },
      },
    });
    const waitUntilPromises = [];
    const ctx = { waitUntil: (p) => waitUntilPromises.push(p) };
    const req = await signedGitHubRequest('/github/webhook', reviewPayload, env.GITHUB_WEBHOOK_SECRET, 'pull_request_review');
    await worker.fetch(req, env, ctx);
    await Promise.all(waitUntilPromises);

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── GitHub issues closed event ────────────────────────────────────────────────

describe('GitHub issues closed webhook', () => {
  it('deletes the claim when an issue is closed directly', async () => {
    const env = makeEnv();
    await env.TICKET_STORE.put('claim:42', JSON.stringify({
      userId: 'U1', issueNumber: 42, issueTitle: 'Do a thing',
    }));

    const body = JSON.stringify({ action: 'closed', issue: { number: 42 } });
    const req = await signedGitHubRequest('/github/webhook', body, env.GITHUB_WEBHOOK_SECRET, 'issues');
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(200);
    expect(env.TICKET_STORE._store.has('claim:42')).toBe(false);
  });

  it('increments the closed stat when an issue is closed directly', async () => {
    const env = makeEnv();
    await env.TICKET_STORE.put('claim:42', JSON.stringify({
      userId: 'U1', issueNumber: 42, issueTitle: 'Do a thing',
    }));

    const body = JSON.stringify({ action: 'closed', issue: { number: 42 } });
    const req = await signedGitHubRequest('/github/webhook', body, env.GITHUB_WEBHOOK_SECRET, 'issues');
    await worker.fetch(req, env, ctx);

    const stats = JSON.parse(env.TICKET_STORE._store.get('stats:U1'));
    expect(stats.closed).toBe(1);
  });

  it('is a no-op when the closed issue has no claim', async () => {
    const env = makeEnv();
    const body = JSON.stringify({ action: 'closed', issue: { number: 99 } });
    const req = await signedGitHubRequest('/github/webhook', body, env.GITHUB_WEBHOOK_SECRET, 'issues');
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
  });

  it('ignores non-closed issue actions', async () => {
    const env = makeEnv();
    await env.TICKET_STORE.put('claim:42', JSON.stringify({
      userId: 'U1', issueNumber: 42, issueTitle: 'Do a thing',
    }));

    const body = JSON.stringify({ action: 'labeled', issue: { number: 42 } });
    const req = await signedGitHubRequest('/github/webhook', body, env.GITHUB_WEBHOOK_SECRET, 'issues');
    await worker.fetch(req, env, ctx);

    expect(env.TICKET_STORE._store.has('claim:42')).toBe(true);
  });
});
