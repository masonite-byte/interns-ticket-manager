import { describe, it, expect } from 'vitest';
import { extractClosedIssues, verifySlackSignature, verifyGitHubSignature } from './utils.js';

// ── extractClosedIssues ───────────────────────────────────────────────────────

describe('extractClosedIssues', () => {
  it('returns empty array for null/empty body', () => {
    expect(extractClosedIssues(null)).toEqual([]);
    expect(extractClosedIssues('')).toEqual([]);
  });

  it('matches "closes #N"', () => {
    expect(extractClosedIssues('closes #42')).toEqual(['42']);
  });

  it('matches "fixes #N"', () => {
    expect(extractClosedIssues('fixes #7')).toEqual(['7']);
  });

  it('matches "resolves #N"', () => {
    expect(extractClosedIssues('resolves #100')).toEqual(['100']);
  });

  it('matches close/fix/resolve variants (trailing s)', () => {
    expect(extractClosedIssues('close #1 fix #2 resolve #3')).toEqual(['1', '2', '3']);
  });

  it('is case-insensitive', () => {
    expect(extractClosedIssues('Closes #5 FIXES #6')).toEqual(['5', '6']);
  });

  it('deduplicates repeated issue numbers', () => {
    expect(extractClosedIssues('closes #42 fixes #42')).toEqual(['42']);
  });

  it('extracts multiple distinct issues from one PR body', () => {
    const body = 'This PR closes #10, fixes #20, and resolves #30.';
    expect(extractClosedIssues(body)).toEqual(['10', '20', '30']);
  });

  it('ignores bare "#N" references that lack a keyword', () => {
    expect(extractClosedIssues('Related to #99')).toEqual([]);
  });
});

// ── verifySlackSignature ──────────────────────────────────────────────────────

describe('verifySlackSignature', () => {
  const secret = 'test-signing-secret';

  async function makeRequest(body, signingSecret, timestampOffset = 0) {
    const timestamp = Math.floor(Date.now() / 1000) + timestampOffset;
    const sigBase = `v0:${timestamp}:${body}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(signingSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const raw = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sigBase));
    const sig = 'v0=' + Array.from(new Uint8Array(raw))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return new Request('https://example.com', {
      method: 'POST',
      headers: {
        'X-Slack-Request-Timestamp': String(timestamp),
        'X-Slack-Signature': sig,
      },
    });
  }

  it('returns true for a valid signature', async () => {
    const body = 'command=%2Fping';
    const req = await makeRequest(body, secret);
    expect(await verifySlackSignature(req, body, secret)).toBe(true);
  });

  it('returns false for a wrong secret', async () => {
    const body = 'command=%2Fping';
    const req = await makeRequest(body, 'wrong-secret');
    expect(await verifySlackSignature(req, body, secret)).toBe(false);
  });

  it('returns false for a tampered body', async () => {
    const body = 'command=%2Fping';
    const req = await makeRequest(body, secret);
    expect(await verifySlackSignature(req, 'command=%2Fother', secret)).toBe(false);
  });

  it('returns false when timestamp is more than 5 minutes old', async () => {
    const body = 'command=%2Fping';
    const req = await makeRequest(body, secret, -400);
    expect(await verifySlackSignature(req, body, secret)).toBe(false);
  });

  it('returns false when headers are missing', async () => {
    const req = new Request('https://example.com', { method: 'POST' });
    expect(await verifySlackSignature(req, 'body', secret)).toBe(false);
  });
});

// ── verifyGitHubSignature ─────────────────────────────────────────────────────

describe('verifyGitHubSignature', () => {
  const secret = 'my-webhook-secret';

  async function makeRequest(body, signingSecret) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(signingSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const raw = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const sig = 'sha256=' + Array.from(new Uint8Array(raw))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return new Request('https://example.com', {
      method: 'POST',
      headers: { 'X-Hub-Signature-256': sig },
    });
  }

  it('returns true for a valid signature', async () => {
    const body = '{"action":"opened"}';
    const req = await makeRequest(body, secret);
    expect(await verifyGitHubSignature(req, body, secret)).toBe(true);
  });

  it('returns false for a wrong secret', async () => {
    const body = '{"action":"opened"}';
    const req = await makeRequest(body, 'bad-secret');
    expect(await verifyGitHubSignature(req, body, secret)).toBe(false);
  });

  it('returns false for a tampered body', async () => {
    const body = '{"action":"opened"}';
    const req = await makeRequest(body, secret);
    expect(await verifyGitHubSignature(req, '{"action":"closed"}', secret)).toBe(false);
  });

  it('returns false when X-Hub-Signature-256 header is missing', async () => {
    const req = new Request('https://example.com', { method: 'POST' });
    expect(await verifyGitHubSignature(req, 'body', secret)).toBe(false);
  });
});
