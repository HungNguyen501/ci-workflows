// Posts OCR review results to a PR: inline comments, one sticky summary, and a severity gate.
// Called from .github/workflows/code-review.yaml via actions/github-script.
//
// Env: RESULT_FILE (OCR --format json output), HEAD_SHA, FAIL_ON (none|critical|high|medium|low)

const fs = require('fs');

const SUMMARY_MARKER = '<!-- ocr-review-summary -->';
const INLINE_MARKER = '<!-- ocr-review-inline -->';
const RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const ICON = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;
  const head = process.env.HEAD_SHA;
  const data = JSON.parse(fs.readFileSync(process.env.RESULT_FILE, 'utf8'));

  // OCR comments -> findings. OCR has no title field, so use the first sentence.
  const findings = (data.comments || []).map(c => {
    const body = String(c.content || '').trim();
    const title = body.split(/\n|(?<=[.!?])\s/)[0];
    const start = c.start_line > 0 ? c.start_line : undefined;
    const severity = String(c.severity || '').toLowerCase();
    return {
      path: c.path,
      start,
      end: c.end_line > 0 ? c.end_line : start,
      severity: severity in RANK ? severity : 'low',
      category: c.category || 'general',
      title: title.length > 100 ? `${title.slice(0, 97)}...` : title,
      body,
      existing: c.existing_code,
      suggestion: c.suggestion_code,
    };
  }).filter(f => f.path && f.body)
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.path.localeCompare(b.path));

  // Lines GitHub accepts for inline comments (new-file lines inside the PR's diff hunks).
  const files = await github.paginate(github.rest.pulls.listFiles,
    { owner, repo, pull_number: pr.number, per_page: 100 });
  const diffLines = new Map();
  for (const file of files) {
    const lines = new Set();
    let n = 0;
    for (const l of (file.patch || '').split('\n')) {
      const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) { n = parseInt(hunk[1], 10); continue; }
      if (l.startsWith('-') || l.startsWith('\\')) continue;
      lines.add(n++);
    }
    diffLines.set(file.filename, lines);
  }
  const inDiff = f => {
    if (f.start === undefined) return false;
    for (let i = f.start; i <= f.end; i++) if (!diffLines.get(f.path)?.has(i)) return false;
    return true;
  };

  // Our earlier inline threads. Unresolved ones with no human reply are candidates for
  // auto-resolve below; unresolved, not-outdated ones also stop us posting the same finding twice.
  const threads = [];
  for (let cursor = null, more = true; more;) {
    const res = await github.graphql(`
      query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
          reviewThreads(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { id isResolved isOutdated path line startLine
                    comments(first: 50) { nodes { body } } }
          }
        } }
      }`, { owner, repo, number: pr.number, cursor });
    const page = res.repository.pullRequest.reviewThreads;
    threads.push(...page.nodes);
    ({ hasNextPage: more, endCursor: cursor } = page.pageInfo);
  }
  const ours = threads.filter(t => !t.isResolved &&
    t.comments.nodes.length && t.comments.nodes[0].body.includes(INLINE_MARKER));
  const touches = (t, f) => t.path === f.path && f.start !== undefined &&
    Math.max(t.startLine || t.line, f.start) <= Math.min(t.line, f.end);
  const alreadyPosted = f => ours.some(t => !t.isOutdated && t.line && touches(t, f));

  const inline = findings.filter(inDiff);
  const toPost = inline.filter(f => !alreadyPosted(f)).map(f => {
    let body = `${ICON[f.severity]} **${f.severity.toUpperCase()}** · ${f.category}\n\n${f.body}`;
    if (f.suggestion && f.existing) body += `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``;
    const comment = { path: f.path, line: f.end, side: 'RIGHT', body: `${body}\n\n${INLINE_MARKER}` };
    if (f.start < f.end) Object.assign(comment, { start_line: f.start, start_side: 'RIGHT' });
    return comment;
  });
  let posted = new Set(inline);
  if (toPost.length) {
    try {
      // Always COMMENT: an AI review never approves or blocks.
      await github.rest.pulls.createReview({ owner, repo, pull_number: pr.number,
        commit_id: head, event: 'COMMENT', comments: toPost });
    } catch (e) {
      core.warning(`Inline review failed (${e.message}); listing all findings in the summary.`);
      posted = new Set();
    }
  }

  // Auto-resolve our earlier threads that no longer apply: the code they point at changed
  // (outdated), or a complete run found nothing at those lines. A partial run (some files failed)
  // proves nothing about unreviewed files, so it only resolves outdated threads.
  // Threads a human replied to are left open.
  const complete = !(data.warnings || []).length;
  let resolved = 0;
  for (const t of ours) {
    const humanReplied = t.comments.nodes.some(c => !c.body.includes(INLINE_MARKER));
    const stillFlagged = findings.some(f => !t.isOutdated && t.line && touches(t, f));
    if (humanReplied || (!t.isOutdated && (stillFlagged || !complete))) continue;
    try {
      await github.graphql('mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id } } }', { id: t.id });
      resolved++;
    } catch (e) {
      core.warning(`Could not resolve review threads (${e.message}); skipping the rest.`);
      break;
    }
  }

  // Sticky summary comment.
  const count = s => findings.filter(f => f.severity === s).length;
  const link = f => `https://github.com/${owner}/${repo}/blob/${head}/${f.path}#L${f.start || 1}${f.end > f.start ? `-L${f.end}` : ''}`;
  let body = `${SUMMARY_MARKER}\n## 🤖 AI Code Review — OpenCodeReview\n\n`;
  if (findings.length) {
    body += `🔍 OpenCodeReview found **${findings.length}** issue(s) in this PR.\n\n`;
    body += `✅ Posted inline: ${posted.size} comment(s)\n\n`;
    body += `| 🔴 Critical | 🟠 High | 🟡 Medium | 🔵 Low |\n|:-:|:-:|:-:|:-:|\n`;
    body += `| ${count('critical')} | ${count('high')} | ${count('medium')} | ${count('low')} |\n\n`;
  } else {
    body += '✅ OpenCodeReview found no issues in this PR.\n\n';
  }
  if (resolved) body += `♻️ Resolved ${resolved} earlier comment(s) that no longer apply.\n\n`;
  for (const f of findings) {
    const loc = f.start ? `${f.path}:${f.start}${f.end > f.start ? `-${f.end}` : ''}` : f.path;
    body += `- ${ICON[f.severity]} [\`${loc}\`](${link(f)}) — **${f.title}**${posted.has(f) ? ' _(inline)_' : ''}\n`;
    if (!posted.has(f)) body += `  <details><summary>details</summary>\n\n  ${f.body.replace(/\n/g, '\n  ')}\n  </details>\n`;
  }
  if (Array.isArray(data.warnings) && data.warnings.length) {
    body += `\n> ⚠️ ${data.warnings.length} item(s) could not be reviewed (status: \`${data.status}\`).\n`;
  }
  const s = data.summary || {};
  body += `\n<sub>Commit \`${head.slice(0, 7)}\``;
  if (s.files_reviewed != null) body += ` · ${s.files_reviewed} files reviewed`;
  if (data.llm?.model) body += ` · model \`${data.llm.model}\``;
  if (s.total_tokens) body += ` · ${s.total_tokens} tokens`;
  if (s.elapsed) body += ` · ${s.elapsed}`;
  body += ' · advisory only, not an approval</sub>\n';
  body = body.slice(0, 65000);

  const comments = await github.paginate(github.rest.issues.listComments,
    { owner, repo, issue_number: pr.number, per_page: 100 });
  const previous = comments.find(c => (c.body || '').includes(SUMMARY_MARKER));
  if (previous) await github.rest.issues.updateComment({ owner, repo, comment_id: previous.id, body });
  else await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body });

  // Gate: fail the check when a finding is at or above FAIL_ON.
  const failOn = (process.env.FAIL_ON || 'none').toLowerCase();
  const blocking = failOn in RANK ? findings.filter(f => RANK[f.severity] <= RANK[failOn]).length : 0;
  if (blocking) core.setFailed(`${blocking} finding(s) at or above '${failOn}' severity`);
};
