'use strict';

const fs = require('fs');
const { loadCourseData } = require('./course-data.cjs');

const ACTIVE_KEY_PATTERN = /^(?:lab-\d+|capstone)$/i;
const KEY_MARKER_PATTERN = /<!--\s*course-roadmap-key:\s*([^\s]+)\s*-->/i;
const OLD_BODY_KEY_PATTERN = /(?:^|\n)\s*_?key:_?\s*`?([a-z0-9._-]+)`?/i;
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

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function labelNames(issue) {
  return (issue.labels || [])
    .map((label) => String(label.name || label).trim())
    .filter(Boolean);
}

function markerKey(issue) {
  const match = String(issue.body || '').match(KEY_MARKER_PATTERN);
  return match ? normalizeKey(match[1]) : '';
}

function oldBodyKey(issue) {
  const match = String(issue.body || '').match(OLD_BODY_KEY_PATTERN);
  return match ? normalizeKey(match[1]) : '';
}

function issueKey(issue, knownKeys) {
  const marker = markerKey(issue);
  if (marker) return marker;
  const oldKey = oldBodyKey(issue);
  if (oldKey) return oldKey;
  const names = labelNames(issue);
  const known = names.find((name) => knownKeys.has(normalizeKey(name)));
  if (known) return normalizeKey(known);
  const patterned = names.find((name) => ACTIVE_KEY_PATTERN.test(name));
  return patterned ? normalizeKey(patterned) : '';
}

function statusForIssue(issue) {
  const labels = new Set(labelNames(issue).map(normalizeKey));
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

function isManagedIssue(issue) {
  const labels = new Set(labelNames(issue).map(normalizeKey));
  return Boolean(markerKey(issue))
    || Boolean(oldBodyKey(issue))
    || labels.has('task')
    || labels.has('assignment');
}

function candidateScore(issue, currentKey, aliases) {
  const labels = new Set(labelNames(issue).map(normalizeKey));
  if (labels.has('retired')) return -10_000;

  const marker = markerKey(issue);
  const oldKey = oldBodyKey(issue);
  let score = issue.state === 'open' ? 5 : 0;
  if (marker === currentKey || oldKey === currentKey || labels.has(currentKey)) score += 100;
  else if (aliases.has(marker) || aliases.has(oldKey)
    || [...aliases].some((alias) => labels.has(alias))) score += 80;
  if (labels.has('task')) score += 10;
  return score;
}

function chooseIssue(candidates, currentKey, aliases) {
  const usable = candidates
    .filter((issue) => isManagedIssue(issue))
    .filter((issue) => !labelNames(issue).map(normalizeKey).includes('retired'));
  if (usable.length === 0) return null;
  return [...usable].sort((left, right) => {
    const difference = candidateScore(right, currentKey, aliases)
      - candidateScore(left, currentKey, aliases);
    return difference || left.number - right.number;
  })[0];
}

module.exports = async function updateReadmeStatus({ github, context, core }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const readmePath = locateReadme(core);

  const { sourceConfig, roadmap } = await loadCourseData({
    core,
    roadmap: true,
    labels: false
  });
  const publishedItems = roadmap.filter((item) => (
    item?.published === true && ACTIVE_KEY_PATTERN.test(String(item.key || ''))
  ));
  const activeKeys = new Set(publishedItems.map((item) => normalizeKey(item.key)));
  const knownKeys = new Set(activeKeys);
  for (const [key, aliases] of Object.entries(sourceConfig.issueAliases || {})) {
    knownKeys.add(normalizeKey(key));
    for (const alias of aliases) knownKeys.add(normalizeKey(alias));
  }

  const issues = (await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'all',
    per_page: 100
  })).filter((issue) => !issue.pull_request);

  const issuesByKey = new Map();
  for (const issue of issues) {
    const key = issueKey(issue, knownKeys);
    if (!key) continue;
    const group = issuesByKey.get(key) || [];
    group.push(issue);
    issuesByKey.set(key, group);
  }

  const rows = [];
  for (const item of publishedItems) {
    const key = normalizeKey(item.key);
    const aliases = new Set(sourceConfig.issueAliases?.[key] || []);
    const candidates = [
      ...(issuesByKey.get(key) || []),
      ...[...aliases].flatMap((alias) => issuesByKey.get(alias) || [])
    ];
    const uniqueCandidates = [...new Map(candidates.map((issue) => [issue.number, issue])).values()];
    const issue = chooseIssue(uniqueCandidates, key, aliases);

    if (uniqueCandidates.filter((candidate) => (
      !labelNames(candidate).map(normalizeKey).includes('retired') && isManagedIssue(candidate)
    )).length > 1) {
      core.warning(`Multiple non-retired roadmap Issues map to ${key}; the README shows one row.`);
    }

    rows.push({ item, key, issue });
  }

  const header = '| Item | Key | Status |\n|---|---|---|';
  const body = rows.length > 0
    ? rows.map(({ item, key, issue }) => {
        if (!issue) {
          return `| ${escapeCell(item.title)} | \`${escapeCell(key)}\` | ⚠️ Pending issue sync |`;
        }
        return `| ${escapeCell(issue.title)} [#${issue.number}](${issue.html_url}) | \`${escapeCell(key)}\` | ${statusForIssue(issue)} |`;
      }).join('\n')
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
    core.info(`Updated ${readmePath} with ${rows.length} active roadmap row(s).`);
  } else {
    core.info(`${readmePath} submission status is already current.`);
  }

  core.setOutput('changed', String(changed));
  core.setOutput('path', readmePath);
  core.setOutput('rows', String(rows.length));
  core.setOutput('active', [...activeKeys].join(','));
};
