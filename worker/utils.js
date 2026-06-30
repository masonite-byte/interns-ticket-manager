/**
 * Extracts a Slack user ID from a mention string like "<@U123ABC>" or
 * "<@U123ABC|name>". Returns null if no mention is found.
 */
export function parseSlackMention(text) {
  if (!text) return null;
  const match = text.match(/<@([A-Z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Increments a stat counter (claimed/closed/abandoned) for a user in KV.
 * Accepts the KV namespace directly so it can be injected in tests.
 */
export async function incrementStat(userId, field, kv) {
  const key = `stats:${userId}`;
  const stats = (await kv.get(key, 'json')) || { claimed: 0, closed: 0, abandoned: 0 };
  stats[field] = (stats[field] || 0) + 1;
  await kv.put(key, JSON.stringify(stats));
}

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

/**
 * Reasons an intern can give when nudged about a stale ticket.
 * `value` is the Slack button payload; `label` is what humans see.
 */
export const BLOCKER_OPTIONS = [
  { value: 'waiting_review', label: 'Waiting on review' },
  { value: 'waiting_pr', label: 'Waiting on another PR' },
  { value: 'confused', label: 'Confused' },
  { value: 'busy', label: 'Busy with other work' },
  { value: 'forgot_to_close', label: 'Finished but forgot to close' },
];

export function blockerLabel(value) {
  const opt = BLOCKER_OPTIONS.find(o => o.value === value);
  return opt ? opt.label : value;
}

/**
 * Builds the manager-facing blocker report from a list of stale claims,
 * bucketed by blockerReason. Claims with no response yet get their own
 * bucket. Returns null when there's nothing stale to report.
 */
export function formatBlockerReport(staleClaims) {
  if (!staleClaims || staleClaims.length === 0) return null;

  const buckets = {};
  for (const claim of staleClaims) {
    const key = claim.blockerReason || 'no_response';
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(claim);
  }

  const order = [...BLOCKER_OPTIONS, { value: 'no_response', label: 'No response yet' }];
  const lines = ['📊 *Blocker Report* — stale tickets and why', ''];
  for (const { value, label } of order) {
    const claims = buckets[value];
    if (!claims || claims.length === 0) continue;
    lines.push(`*${label}* (${claims.length})`);
    for (const claim of claims) {
      lines.push(`• <@${claim.userId}> — <${claim.issueUrl}|#${claim.issueNumber}: ${claim.issueTitle}>`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Filters TIL entries by a case-insensitive substring match against `text`,
 * sorted most recent first.
 */
export function searchTilEntries(entries, keyword) {
  const needle = keyword.toLowerCase();
  return entries
    .filter(t => t.text.toLowerCase().includes(needle))
    .sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));
}
