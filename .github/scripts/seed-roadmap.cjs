'use strict';

const {
  courseDisplayName,
  courseRepositoryUrl,
  loadCourseData,
  repositoryFileUrl
} = require('./course-data.cjs');

const ACTIVE_KEY_PATTERN = /^(?:lab-\d+|capstone)$/i;
const LEGACY_NUMBERED_KEY_PATTERN = /^(?:project-\d+|capstone-\d+(?:-proposal)?)$/i;
const KEY_MARKER_PATTERN = /<!--\s*course-roadmap-key:\s*([^\s]+)\s*-->/i;
const OLD_BODY_KEY_PATTERN = /(?:^|\n)\s*_?key:_?\s*`?([a-z0-9._-]+)`?/i;
const MANAGED_START = '<!-- course-managed:start -->';
const MANAGED_END = '<!-- course-managed:end -->';
const STUDENT_START = '<!-- student-submission:start -->';
const STUDENT_END = '<!-- student-submission:end -->';

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function labelNames(issue) {
  return (issue.labels || [])
    .map((label) => String(label.name || label).trim())
    .filter(Boolean);
}

function markerKey(issue) {
  const marker = String(issue.body || '').match(KEY_MARKER_PATTERN);
  return marker ? normalizeKey(marker[1]) : '';
}

function oldBodyKey(issue) {
  const match = String(issue.body || '').match(OLD_BODY_KEY_PATTERN);
  return match ? normalizeKey(match[1]) : '';
}

function issueKey(issue, knownKeys = new Set()) {
  const marker = markerKey(issue);
  if (marker) return marker;

  const oldKey = oldBodyKey(issue);
  if (oldKey) return oldKey;

  const names = labelNames(issue);
  const known = names.find((name) => knownKeys.has(normalizeKey(name)));
  if (known) return normalizeKey(known);

  const patterned = names.find((name) => (
    ACTIVE_KEY_PATTERN.test(name) || LEGACY_NUMBERED_KEY_PATTERN.test(name)
  ));
  return patterned ? normalizeKey(patterned) : '';
}

function hasManagedIdentity(issue, knownKeys) {
  const labels = new Set(labelNames(issue).map(normalizeKey));
  return Boolean(markerKey(issue))
    || Boolean(oldBodyKey(issue))
    || labels.has('task')
    || labels.has('assignment')
    || [...labels].some((name) => knownKeys.has(name));
}

function normalizeChecklistText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function extractMarkedSection(body, startMarker, endMarker) {
  const text = String(body || '');
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1 || end < start) return '';
  return text.slice(start, end + endMarker.length).trim();
}

function checkedChecklistItems(body) {
  const managed = extractMarkedSection(body, MANAGED_START, MANAGED_END);
  const text = managed || String(body || '');
  const checked = new Set();
  const pattern = /^\s*-\s*\[([xX])\]\s+(.+)$/gm;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    checked.add(normalizeChecklistText(match[2]));
  }
  return checked;
}

function defaultStudentSection(item) {
  const isCapstone = normalizeKey(item.key) === 'capstone';
  const lines = isCapstone
    ? [
        '### 🔗 Student submission',
        '',
        '> Edit only this section of the Issue body. Course updates preserve everything between these markers.',
        '',
        '- **Project repository:** ',
        '- **Deployed application:** ',
        '- **Demonstration notes:** '
      ]
    : [
        '### 🔗 Student submission',
        '',
        '> Edit only this section of the Issue body. Course updates preserve everything between these markers.',
        '',
        '- **Live lab URL:** ',
        `- **Source folder:** \`${item.submissionPath || ''}\``,
        '- **Reflection or notes:** '
      ];

  return [STUDENT_START, ...lines, STUDENT_END].join('\n');
}

function studentSection(item, existingBody) {
  const preserved = extractMarkedSection(existingBody, STUDENT_START, STUDENT_END);
  if (preserved) return preserved;

  const existing = String(existingBody || '').trim();
  if (!existing) return defaultStudentSection(item);

  return [
    STUDENT_START,
    '### 🔗 Student submission',
    '',
    '> Edit only this section of the Issue body. Course updates preserve everything between these markers.',
    '',
    normalizeKey(item.key) === 'capstone' ? '- **Project repository:** ' : '- **Live lab URL:** ',
    normalizeKey(item.key) === 'capstone'
      ? '- **Deployed application:** '
      : `- **Source folder:** \`${item.submissionPath || ''}\``,
    '- **Reflection or notes:** ',
    '',
    '<details>',
    '<summary>Previous Issue body preserved during automation migration</summary>',
    '',
    existing,
    '',
    '</details>',
    STUDENT_END
  ].join('\n');
}

function buildIssueBody(item, existingBody, manifest) {
  const checked = checkedChecklistItems(existingBody);
  const acceptance = Array.isArray(item.acceptance) ? item.acceptance : [];
  const checklist = acceptance.length
    ? acceptance.map((text) => {
        const cleanText = String(text).trim();
        const mark = checked.has(normalizeChecklistText(cleanText)) ? 'x' : ' ';
        return `- [${mark}] ${cleanText}`;
      }).join('\n')
    : '- [ ] Review the course instructions for requirements.';

  const courseUrl = courseRepositoryUrl(manifest);
  const guideUrl = manifest?.links?.studentGuide || courseUrl;
  const instructionsUrl = item.instructions
    ? repositoryFileUrl(manifest, item.instructions)
    : guideUrl;
  const dueDisplay = item.due ? String(item.due) : 'No date published';

  const managed = [
    `<!-- course-roadmap-key: ${item.key} -->`,
    '<!-- course-automation-version: 4 -->',
    MANAGED_START,
    '### 🎯 Assignment',
    '',
    String(item.task || '').trim(),
    '',
    `- **Course:** [${courseDisplayName(manifest)}](${courseUrl})`,
    `- **Instructions:** [Open the assignment instructions](${instructionsUrl})`,
    `- **Roadmap key:** \`${item.key}\``,
    `- **Milestone:** ${item.milestone || '—'}`,
    `- **Due:** ${dueDisplay}`,
    `- **Submission location:** \`${item.submissionPath || 'See assignment instructions'}\``,
    '',
    '### ✅ Acceptance checklist',
    '',
    checklist,
    '',
    `📖 [Course submission guide](${guideUrl})`,
    MANAGED_END
  ].join('\n');

  return `${managed}\n\n${studentSection(item, existingBody)}\n`;
}

function normalizeDue(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T23:59:59Z`
    : text;
  const timestamp = Date.parse(candidate);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid milestoneDue value: ${text}`);
  }
  return new Date(timestamp).toISOString();
}

function sameLabels(left, right) {
  const normalize = (values) => values.map((value) => value.toLowerCase()).sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function validateLabelDefinitions(labels) {
  if (!Array.isArray(labels)) throw new Error('Course labels must be a JSON array.');
  const definitions = new Map();

  labels.forEach((label, index) => {
    if (!label || typeof label !== 'object' || Array.isArray(label)) {
      throw new Error(`labels[${index}] must be an object.`);
    }
    const name = String(label.name || '').trim();
    const color = String(label.color || '').replace(/^#/, '').toLowerCase();
    if (!name) throw new Error(`labels[${index}].name is required.`);
    if (!/^[0-9a-f]{6}$/.test(color)) {
      throw new Error(`Label "${name}" must use a six-character hexadecimal color.`);
    }
    if (label.preserveOnIssueSync !== undefined && typeof label.preserveOnIssueSync !== 'boolean') {
      throw new Error(`Label "${name}" has a non-boolean preserveOnIssueSync value.`);
    }
    const normalized = name.toLowerCase();
    if (definitions.has(normalized)) {
      throw new Error(`Duplicate course label: ${name}`);
    }
    definitions.set(normalized, { ...label, name, color });
  });

  if (!definitions.has('retired')) {
    throw new Error('The canonical labels file must define the retired label.');
  }
  return definitions;
}

function validateRoadmap(roadmap, labelDefinitions) {
  if (!Array.isArray(roadmap)) throw new Error('Course roadmap must be a JSON array.');
  const keys = new Set();
  const titles = new Set();
  const publishedItems = [];

  roadmap.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`roadmap[${index}] must be an object.`);
    }

    const key = String(item.key || '').trim();
    const title = String(item.title || '').trim();
    if (!key) throw new Error(`roadmap[${index}].key is required.`);
    if (!title) throw new Error(`${key}: title is required.`);
    if (typeof item.published !== 'boolean') {
      throw new Error(`${key}: published must be explicitly true or false.`);
    }

    const normalizedKey = key.toLowerCase();
    const normalizedTitle = title.toLowerCase();
    if (keys.has(normalizedKey)) throw new Error(`Duplicate roadmap key: ${key}`);
    if (titles.has(normalizedTitle)) throw new Error(`Duplicate roadmap title: ${title}`);
    keys.add(normalizedKey);
    titles.add(normalizedTitle);

    if (!Array.isArray(item.labels)) throw new Error(`${key}: labels must be an array.`);
    const itemLabels = new Set();
    for (const rawName of item.labels) {
      const name = String(rawName || '').trim();
      if (!name) throw new Error(`${key}: labels may not contain empty values.`);
      const normalized = name.toLowerCase();
      if (itemLabels.has(normalized)) throw new Error(`${key}: duplicate label ${name}.`);
      if (!labelDefinitions.has(normalized)) {
        throw new Error(`${key}: label "${name}" is missing from the canonical labels file.`);
      }
      itemLabels.add(normalized);
    }

    if (!item.published) return;
    if (!ACTIVE_KEY_PATTERN.test(key)) {
      throw new Error(`Published roadmap key "${key}" must match lab-## or capstone.`);
    }
    if (!String(item.task || '').trim()) throw new Error(`${key}: task is required.`);
    if (!String(item.milestone || '').trim()) throw new Error(`${key}: milestone is required.`);
    if (!String(item.instructions || '').trim()) throw new Error(`${key}: instructions is required.`);
    if (!String(item.submissionPath || '').trim()) throw new Error(`${key}: submissionPath is required.`);
    if (!Array.isArray(item.acceptance) || item.acceptance.length === 0) {
      throw new Error(`${key}: acceptance must contain at least one checklist item.`);
    }
    if (!item.acceptance.every((entry) => String(entry || '').trim())) {
      throw new Error(`${key}: acceptance entries must be non-empty strings.`);
    }
    if (!itemLabels.has('task')) throw new Error(`${key}: labels must include task.`);
    if (!itemLabels.has(normalizedKey)) throw new Error(`${key}: labels must include ${key}.`);
    if (normalizedKey.startsWith('lab-') && !itemLabels.has('lab')) {
      throw new Error(`${key}: lab items must include the lab label.`);
    }
    if (normalizedKey === 'capstone' && !itemLabels.has('capstone')) {
      throw new Error(`${key}: capstone items must include the capstone label.`);
    }
    normalizeDue(item.milestoneDue);
    publishedItems.push(item);
  });

  return { publishedItems, allKeys: keys };
}

function removalLabelSet(sourceConfig) {
  const result = new Set([
    'assignment',
    'project',
    'project-02',
    'capstone-01',
    'capstone-01-proposal'
  ]);
  for (const name of sourceConfig.removeLabelsOnSync || []) result.add(normalizeKey(name));
  for (const aliases of Object.values(sourceConfig.issueAliases || {})) {
    for (const alias of aliases) result.add(normalizeKey(alias));
  }
  for (const key of sourceConfig.retireKeys || []) result.add(normalizeKey(key));
  return result;
}

function shouldRemoveManagedLabel(name, removalSet) {
  const normalized = normalizeKey(name);
  return removalSet.has(normalized) || LEGACY_NUMBERED_KEY_PATTERN.test(normalized);
}

function desiredLabels(existingNames, requiredNames, labelDefinitions, removalSet) {
  const result = new Map();

  for (const name of existingNames) {
    const normalized = normalizeKey(name);
    if (shouldRemoveManagedLabel(normalized, removalSet)) continue;
    const definition = labelDefinitions.get(normalized);
    if (!definition || definition.preserveOnIssueSync === true) {
      result.set(normalized, name);
    }
  }

  for (const name of requiredNames) {
    result.set(normalizeKey(name), name);
  }

  return [...result.values()];
}

function retiredLabels(existingNames, labelDefinitions, removalSet) {
  const result = new Map();
  for (const name of existingNames) {
    const normalized = normalizeKey(name);
    if (shouldRemoveManagedLabel(normalized, removalSet)) continue;
    const definition = labelDefinitions.get(normalized);
    if (!definition || definition.preserveOnIssueSync === true) {
      result.set(normalized, name);
    }
  }
  result.set('retired', labelDefinitions.get('retired').name);
  return [...result.values()];
}

function candidateKeysFor(itemKey, sourceConfig) {
  const key = normalizeKey(itemKey);
  return [key, ...(sourceConfig.issueAliases?.[key] || [])];
}

function chooseCandidate(candidates, currentKey, aliasKeys, claimedNumbers) {
  const available = candidates.filter((issue) => !claimedNumbers.has(issue.number));
  if (available.length === 0) return null;

  const aliases = new Set(aliasKeys);
  const score = (issue) => {
    const marker = markerKey(issue);
    const bodyKey = oldBodyKey(issue);
    const names = new Set(labelNames(issue).map(normalizeKey));
    let value = issue.state === 'open' ? 5 : 0;
    if (marker === currentKey || bodyKey === currentKey || names.has(currentKey)) value += 100;
    else if (aliases.has(marker) || aliases.has(bodyKey)
      || [...aliases].some((alias) => names.has(alias))) value += 80;
    return value;
  };

  return [...available].sort((left, right) => {
    const difference = score(right) - score(left);
    return difference || left.number - right.number;
  })[0];
}

function environmentBoolean(name, fallback) {
  if (process.env[name] === undefined || process.env[name] === '') return fallback;
  return String(process.env[name]).toLowerCase() === 'true';
}

module.exports = async function seedRoadmap({ github, context, core }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const repository = await github.rest.repos.get({ owner, repo });

  if (!repository.data.has_issues) {
    throw new Error(
      'GitHub Issues are disabled for this repository. Enable Settings → General → Features → Issues, then rerun this workflow.'
    );
  }

  const {
    sourceConfig,
    manifest,
    roadmap,
    labels: canonicalLabels,
    roadmapUrl
  } = await loadCourseData({ core, roadmap: true, labels: true });

  const labelDefinitions = validateLabelDefinitions(canonicalLabels);
  const { publishedItems, allKeys } = validateRoadmap(roadmap, labelDefinitions);
  const unpublishedCount = roadmap.length - publishedItems.length;
  const activeKeys = new Set(publishedItems.map((item) => normalizeKey(item.key)));
  const knownKeys = new Set([
    ...allKeys,
    ...(sourceConfig.retireKeys || [])
  ]);
  for (const [key, aliases] of Object.entries(sourceConfig.issueAliases || {})) {
    knownKeys.add(normalizeKey(key));
    for (const alias of aliases) knownKeys.add(normalizeKey(alias));
  }

  core.info(
    `Loaded ${roadmap.length} roadmap item(s): ${publishedItems.length} published, ${unpublishedCount} unpublished.`
  );

  const repositoryLabels = await github.paginate(github.rest.issues.listLabelsForRepo, {
    owner,
    repo,
    per_page: 100
  });
  const repositoryLabelMap = new Map(
    repositoryLabels.map((label) => [label.name.toLowerCase(), label])
  );

  const requiredLabelNames = new Set(['retired']);
  for (const item of publishedItems) {
    for (const name of [...item.labels, 'task', item.key]) {
      const clean = String(name || '').trim();
      if (clean) requiredLabelNames.add(clean);
    }
  }

  for (const name of requiredLabelNames) {
    if (repositoryLabelMap.has(name.toLowerCase())) continue;
    const definition = labelDefinitions.get(name.toLowerCase());
    const created = await github.rest.issues.createLabel({
      owner,
      repo,
      name,
      color: definition?.color || '6a737d',
      description: String(definition?.description || 'Course roadmap label').slice(0, 100)
    });
    repositoryLabelMap.set(name.toLowerCase(), created.data);
    core.warning(`Created missing label during roadmap seeding: ${name}`);
  }

  const milestones = await github.paginate(github.rest.issues.listMilestones, {
    owner,
    repo,
    state: 'all',
    per_page: 100
  });
  const milestoneMap = new Map(milestones.map((milestone) => [milestone.title, milestone]));

  const milestoneDue = new Map();
  for (const item of publishedItems) {
    const due = normalizeDue(item.milestoneDue);
    if (!due) continue;
    const current = milestoneDue.get(item.milestone);
    if (!current || Date.parse(due) > Date.parse(current)) {
      milestoneDue.set(item.milestone, due);
    }
  }

  async function ensureMilestone(title) {
    const dueOn = milestoneDue.get(title) || null;
    let milestone = milestoneMap.get(title);

    if (!milestone) {
      milestone = (await github.rest.issues.createMilestone({
        owner,
        repo,
        title,
        due_on: dueOn || undefined
      })).data;
      milestoneMap.set(title, milestone);
      core.info(`Created milestone: ${title}`);
      return milestone;
    }

    const currentDue = milestone.due_on ? normalizeDue(milestone.due_on) : null;
    if (dueOn && currentDue !== dueOn) {
      milestone = (await github.rest.issues.updateMilestone({
        owner,
        repo,
        milestone_number: milestone.number,
        due_on: dueOn
      })).data;
      milestoneMap.set(title, milestone);
      core.info(`Updated milestone due date: ${title}`);
    }
    return milestone;
  }

  const allIssues = (await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'all',
    per_page: 100
  })).filter((issue) => !issue.pull_request);

  const issuesByKey = new Map();
  for (const issue of allIssues) {
    const key = issueKey(issue, knownKeys);
    if (!key) continue;
    const group = issuesByKey.get(key) || [];
    group.push(issue);
    issuesByKey.set(key, group);
  }

  const issuesByTitle = new Map();
  for (const issue of allIssues) {
    const title = String(issue.title || '').trim().toLowerCase();
    if (title && !issuesByTitle.has(title)) issuesByTitle.set(title, issue);
  }

  const respectClosed = environmentBoolean('RESPECT_CLOSED', true);
  const doNotReopen = new Set(
    String(process.env.DONT_REOPEN_IF_LABELED || 'completed,approved')
      .split(',')
      .map(normalizeKey)
      .filter(Boolean)
  );
  const closeWhenLabeled = new Set(
    String(process.env.CLOSE_WHEN_LABELED || 'approved')
      .split(',')
      .map(normalizeKey)
      .filter(Boolean)
  );
  const closeStale = environmentBoolean(
    'CLOSE_STALE_ROADMAP_ISSUES',
    sourceConfig.closeStaleRoadmapIssues !== false
  );
  const removalSet = removalLabelSet(sourceConfig);

  let createdCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  let retiredCount = 0;
  const claimedIssueNumbers = new Set();

  for (const item of publishedItems) {
    const requiredLabels = [...new Map(
      [...item.labels, 'task', item.key]
        .map((name) => String(name || '').trim())
        .filter(Boolean)
        .map((name) => [name.toLowerCase(), name])
    ).values()];
    const milestone = await ensureMilestone(item.milestone);
    const key = normalizeKey(item.key);
    const candidateKeys = candidateKeysFor(item.key, sourceConfig);
    const aliasKeys = candidateKeys.slice(1);
    const keyedCandidates = candidateKeys.flatMap((candidateKey) => issuesByKey.get(candidateKey) || []);
    const titleCandidate = issuesByTitle.get(item.title.trim().toLowerCase());
    const candidatePool = [...new Map(
      [...keyedCandidates, ...(titleCandidate ? [titleCandidate] : [])]
        .map((issue) => [issue.number, issue])
    ).values()];
    const existing = chooseCandidate(candidatePool, key, aliasKeys, claimedIssueNumbers);

    if (!existing) {
      const body = buildIssueBody(item, '', manifest);
      const created = await github.rest.issues.create({
        owner,
        repo,
        title: item.title,
        body,
        labels: requiredLabels,
        milestone: milestone.number
      });
      createdCount += 1;
      const issue = created.data;
      claimedIssueNumbers.add(issue.number);
      allIssues.push(issue);
      issuesByKey.set(key, [...(issuesByKey.get(key) || []), issue]);
      issuesByTitle.set(item.title.trim().toLowerCase(), issue);
      core.info(`Created #${issue.number}: ${item.title}`);
      continue;
    }

    claimedIssueNumbers.add(existing.number);
    const existingLabels = labelNames(existing);
    const existingKey = issueKey(existing, knownKeys);
    const mergedLabels = desiredLabels(
      existingLabels,
      requiredLabels,
      labelDefinitions,
      removalSet
    );
    const body = buildIssueBody(item, existing.body || '', manifest);
    const normalizedExistingLabels = new Set(existingLabels.map(normalizeKey));
    const hasProtectedLabel = [...doNotReopen].some((name) => normalizedExistingLabels.has(name));
    const shouldClose = [...closeWhenLabeled].some((name) => normalizedExistingLabels.has(name));
    const wasRetired = normalizedExistingLabels.has('retired');
    const migratedAlias = existingKey && existingKey !== key && aliasKeys.includes(existingKey);

    let desiredState = existing.state;
    if (existing.state === 'open' && shouldClose) {
      desiredState = 'closed';
    } else if (
      existing.state === 'closed'
      && !hasProtectedLabel
      && (wasRetired || migratedAlias || !respectClosed)
    ) {
      desiredState = 'open';
    }

    const changed = existing.title !== item.title
      || String(existing.body || '') !== body
      || !sameLabels(existingLabels, mergedLabels)
      || existing.milestone?.number !== milestone.number
      || existing.state !== desiredState;

    if (!changed) {
      unchangedCount += 1;
      core.info(`Unchanged #${existing.number}: ${item.title}`);
      continue;
    }

    const updated = await github.rest.issues.update({
      owner,
      repo,
      issue_number: existing.number,
      title: item.title,
      body,
      labels: mergedLabels,
      milestone: milestone.number,
      state: desiredState
    });
    updatedCount += 1;
    const issue = updated.data;
    const index = allIssues.findIndex((candidate) => candidate.number === issue.number);
    if (index >= 0) allIssues[index] = issue;
    issuesByKey.set(key, [issue, ...(issuesByKey.get(key) || []).filter((candidate) => candidate.number !== issue.number)]);
    issuesByTitle.set(item.title.trim().toLowerCase(), issue);
    core.info(
      `${migratedAlias ? 'Migrated' : 'Updated'} #${existing.number}: ${item.title}`
    );
  }

  if (closeStale) {
    for (const issue of allIssues) {
      if (claimedIssueNumbers.has(issue.number)) continue;
      if (!hasManagedIdentity(issue, knownKeys)) continue;

      const key = issueKey(issue, knownKeys);
      if (!key) continue;

      const isDuplicateActiveKey = activeKeys.has(key);
      const isInactiveKey = !activeKeys.has(key);
      if (!isDuplicateActiveKey && !isInactiveKey) continue;

      const existingLabels = labelNames(issue);
      const nextLabels = retiredLabels(existingLabels, labelDefinitions, removalSet);
      const desiredState = 'closed';
      const changed = issue.state !== desiredState || !sameLabels(existingLabels, nextLabels);
      if (!changed) continue;

      const updated = await github.rest.issues.update({
        owner,
        repo,
        issue_number: issue.number,
        state: desiredState,
        labels: nextLabels
      });
      retiredCount += 1;
      core.info(
        `Retired #${issue.number}: ${issue.title} (${isDuplicateActiveKey ? `duplicate ${key}` : `${key} is not published`})`
      );
      const index = allIssues.findIndex((candidate) => candidate.number === updated.data.number);
      if (index >= 0) allIssues[index] = updated.data;
    }
  }

  core.notice(
    `Roadmap sync complete from ${roadmapUrl}: ${createdCount} created, ${updatedCount} updated, ${unchangedCount} unchanged, ${retiredCount} retired, ${unpublishedCount} unpublished item(s) skipped. Active keys: ${[...activeKeys].join(', ')}.`
  );
  core.setOutput('created', String(createdCount));
  core.setOutput('updated', String(updatedCount));
  core.setOutput('unchanged', String(unchangedCount));
  core.setOutput('retired', String(retiredCount));
  core.setOutput('unpublished', String(unpublishedCount));
  core.setOutput('active', [...activeKeys].join(','));
};
