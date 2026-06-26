/**
 * Parses "closes #42", "fixes #7", "resolves #100" etc. from a PR body.
 * Returns an array of unique issue number strings.
 */
export function extractClosedIssues(body) {
  if (!body) return [];
  const pattern = /(?:close[sd]?|closes|fix(?:es|ed)?|resolve[sd]?|resolves)\s+#(\d+)/gi;
  const numbers = [];
  let match;
  while ((match = pattern.exec(body)) !== null) {
    numbers.push(match[1]);
  }
  return [...new Set(numbers)];
}

/**
 * Verifies a Slack request signature (HMAC-SHA256).
 * Returns true if valid.
 */
export async function verifySlackSignature(request, body, signingSecret) {
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

/**
 * Verifies a GitHub webhook signature (HMAC-SHA256, X-Hub-Signature-256).
 * Returns true if valid.
 */
export async function verifyGitHubSignature(request, body, secret) {
  const sig = request.headers.get('X-Hub-Signature-256');
  if (!sig) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const raw = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const computed = 'sha256=' + Array.from(new Uint8Array(raw))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return computed === sig;
}
