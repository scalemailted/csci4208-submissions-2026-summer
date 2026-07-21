'use strict';

const fs = require('fs');

const KEY_PATTERN = /^(?:lab-\d+|capstone)$/i;
const KEY_MARKER_PATTERN = /<!--\s*course-roadmap-key:\s*([^\s]+)\s*-->/i;
const STATUS_START = '<!-- STATUS:START -->';
const STATUS_END = '<!-- STATUS:END -->';

const STATUS_LABELS = [
  ['blocked', '⛔ Blocked'],
  ['changes-requested', '🔁 Changes requested'],
  ['peer-review-requested', '👀 Peer review requested'],
  ['reviewed', '🔎 Reviewed'],
  ['ready-for-approval', '📬 Ready for approval'],
  ['completed', '✅ Completed'],
  ['approved', '✅ Approved'],
  ['deployed', '🚀 Deployed']
];

function labelNames(issue) {
  return (issue.labels || [])
    .map((label) => String(label.name || label).trim())
    .filter(Boolean);
}

function markerKey(issue) {
  const match = String(issue.body || '').match(KEY_MARKER_PATTERN);
  return match && KEY_PATTERN.test(match[1]) ? match[1].trim() : '';
}

function keyForIssue(issue) {
  return markerKey(issue)
    || labelNames(issue).find((name) => KEY_PATTERN.test(name))
    || '';
}

function isRoadmapIssue(issue) {
  if (markerKey(issue)) return true;
  const labels = new Set(labelNames(issue).map((name) => name.toLowerCase()));
  return labels.has('task') || labels.has('assignment');
}

function statusForIssue(issue) {
  const labels = new Set(labelNames(issue).map((name) => name.toLowerCase()));
  const statuses = STATUS_LABELS
    .filter(([name]) => labels.has(name))
    .map(([, display]) => display);

  if (statuses.length > 0) return statuses.join('<br>');
  return issue.state === 'closed' ? 'Closed' : 'Open';
}

function escapeCell(value) {
  return String(value || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function sortKey(key) {
  const normalized = String(key || '').toLowerCase();
  if (normalized === 'capstone') return '2-00000';
  const match = normalized.match(/^lab-(\d+)$/i);
  if (!match) return `9-${normalized}`;
  return `1-${String(Number(match[1])).padStart(5, '0')}`;
}

function scaffoldReadme() {
  return [
    '# CSCI 4208 — Summer 2026 Student Submissions',
    '',
    '- **Student:** <Your Name>',
    '- **Live portfolio:** <https://USERNAME.github.io/REPOSITORY/>',
    '',
    '## Submission status',
    '',
    STATUS_START,
    '| Item | Key | Status |',
    '|---|---|---|',
    '| No assignments have been published yet. | — | — |',
    STATUS_END,
    ''
  ].join('\n');
}

function locateReadme(core) {
  const candidates = ['README.md', 'README.MD', 'readme.md'];
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (existing) return existing;

  fs.writeFileSync('README.md', scaffoldReadme());
  core.info('Created README.md with submission-status markers.');
  return 'README.md';
}

function chooseIssueForKey(current, candidate) {
  if (!current) return candidate;
  const currentHasMarker = Boolean(markerKey(current));
  const candidateHasMarker = Boolean(markerKey(candidate));
  if (candidateHasMarker !== currentHasMarker) return candidateHasMarker ? candidate : current;
  return candidate.number < current.number ? candidate : current;
}

module.exports = async function updateReadmeStatus({ github, context, core }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const readmePath = locateReadme(core);

  const issues = (await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'all',
    per_page: 100
  })).filter((issue) => !issue.pull_request);

  const selectedByKey = new Map();
  const duplicateKeys = new Set();

  for (const issue of issues) {
    const key = keyForIssue(issue);
    if (!key || !isRoadmapIssue(issue)) continue;

    const normalizedKey = key.toLowerCase();
    const current = selectedByKey.get(normalizedKey);
    if (current) duplicateKeys.add(normalizedKey);
    selectedByKey.set(normalizedKey, chooseIssueForKey(current, issue));
  }

  for (const key of duplicateKeys) {
    core.warning(`Multiple roadmap Issues use key ${key}; the README shows one row for that key.`);
  }

  const rows = [...selectedByKey.entries()].map(([key, issue]) => ({
    key,
    title: issue.title,
    number: issue.number,
    url: issue.html_url,
    status: statusForIssue(issue)
  }));
  rows.sort((left, right) => sortKey(left.key).localeCompare(sortKey(right.key)));

  const header = '| Item | Key | Status |\n|---|---|---|';
  const body = rows.length > 0
    ? rows.map((row) => (
        `| ${escapeCell(row.title)} [#${row.number}](${row.url}) | \`${escapeCell(row.key)}\` | ${row.status} |`
      )).join('\n')
    : '| No assignments have been published yet. | — | — |';
  const table = `${header}\n${body}`;

  let readme = fs.readFileSync(readmePath, 'utf8');
  const firstStart = readme.indexOf(STATUS_START);
  const firstEnd = readme.indexOf(STATUS_END, firstStart + STATUS_START.length);

  if (firstStart === -1 && firstEnd === -1) {
    readme = `${readme.trimEnd()}\n\n## Submission status\n\n${STATUS_START}\n${table}\n${STATUS_END}\n`;
  } else if (firstStart === -1 || firstEnd === -1 || firstEnd < firstStart) {
    throw new Error(`README status markers are malformed in ${readmePath}. Keep exactly one ${STATUS_START} and ${STATUS_END} pair.`);
  }

  const start = readme.indexOf(STATUS_START);
  const end = readme.indexOf(STATUS_END, start + STATUS_START.length);
  const secondStart = readme.indexOf(STATUS_START, start + STATUS_START.length);
  const secondEnd = readme.indexOf(STATUS_END, end + STATUS_END.length);
  if (secondStart !== -1 || secondEnd !== -1) {
    throw new Error(`README contains more than one submission-status marker pair in ${readmePath}.`);
  }

  const updated = [
    readme.slice(0, start),
    STATUS_START,
    '\n',
    table,
    '\n',
    STATUS_END,
    readme.slice(end + STATUS_END.length)
  ].join('');

  const changed = updated !== readme;
  if (changed) {
    fs.writeFileSync(readmePath, updated);
    core.info(`Updated ${readmePath} with ${rows.length} roadmap row(s).`);
  } else {
    core.info(`${readmePath} submission status is already current.`);
  }

  core.setOutput('changed', String(changed));
  core.setOutput('path', readmePath);
  core.setOutput('rows', String(rows.length));
};
