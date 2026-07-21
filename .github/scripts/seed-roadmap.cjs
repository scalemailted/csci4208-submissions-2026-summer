'use strict';

const {
  courseDisplayName,
  courseRepositoryUrl,
  loadCourseData,
  repositoryFileUrl
} = require('./course-data.cjs');

const KEY_PATTERN = /^(?:lab-\d+|capstone)$/i;
const KEY_MARKER_PATTERN = /<!--\s*course-roadmap-key:\s*([^\s]+)\s*-->/i;
const MANAGED_START = '<!-- course-managed:start -->';
const MANAGED_END = '<!-- course-managed:end -->';
const STUDENT_START = '<!-- student-submission:start -->';
const STUDENT_END = '<!-- student-submission:end -->';

function labelNames(issue) {
  return (issue.labels || [])
    .map((label) => String(label.name || label).trim())
    .filter(Boolean);
}

function issueKey(issue) {
  const marker = String(issue.body || '').match(KEY_MARKER_PATTERN);
  if (marker && KEY_PATTERN.test(marker[1])) return marker[1].trim();
  return labelNames(issue).find((name) => KEY_PATTERN.test(name)) || '';
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
  const isProject = String(item.key).toLowerCase() === 'capstone';
  const lines = isProject
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
    String(item.key).toLowerCase() === 'capstone' ? '- **Project repository:** ' : '- **Live lab URL:** ',
    String(item.key).toLowerCase() === 'capstone'
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
    '<!-- course-automation-version: 3 -->',
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

  return definitions;
}

function validateRoadmap(roadmap, labelDefinitions) {
  if (!Array.isArray(roadmap)) throw new Error('Course roadmap must be a JSON array.');
  const keys = new Set();
  const titles = new Set();
  const published = [];

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
    if (!KEY_PATTERN.test(key)) {
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
    published.push(item);
  });

  return published;
}

function desiredLabels(existingNames, requiredNames, labelDefinitions) {
  const result = new Map();

  for (const name of existingNames) {
    const normalized = name.toLowerCase();
    const definition = labelDefinitions.get(normalized);
    if (!definition || definition.preserveOnIssueSync === true) {
      result.set(normalized, name);
    }
  }

  for (const name of requiredNames) {
    result.set(name.toLowerCase(), name);
  }

  return [...result.values()];
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
    manifest,
    roadmap,
    labels: canonicalLabels,
    roadmapUrl
  } = await loadCourseData({ core, roadmap: true, labels: true });

  const labelDefinitions = validateLabelDefinitions(canonicalLabels);
  const publishedItems = validateRoadmap(roadmap, labelDefinitions);
  const unpublishedCount = roadmap.length - publishedItems.length;
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

  const requiredLabelNames = new Set();
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
    const key = issueKey(issue).toLowerCase();
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

  const respectClosed = String(process.env.RESPECT_CLOSED || 'true').toLowerCase() !== 'false';
  const doNotReopen = new Set(
    String(process.env.DONT_REOPEN_IF_LABELED || 'completed,approved')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
  const closeWhenLabeled = new Set(
    String(process.env.CLOSE_WHEN_LABELED || 'approved')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );

  let createdCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  for (const item of publishedItems) {
    const requiredLabels = [...new Map(
      [...item.labels, 'task', item.key]
        .map((name) => String(name || '').trim())
        .filter(Boolean)
        .map((name) => [name.toLowerCase(), name])
    ).values()];
    const milestone = await ensureMilestone(item.milestone);
    const key = item.key.toLowerCase();
    const keyedCandidates = issuesByKey.get(key) || [];
    let existing;

    if (keyedCandidates.length > 0) {
      existing = keyedCandidates.find((issue) => {
        const marker = String(issue.body || '').match(KEY_MARKER_PATTERN);
        return marker && marker[1].toLowerCase() === key;
      }) || [...keyedCandidates].sort((left, right) => left.number - right.number)[0];

      if (keyedCandidates.length > 1) {
        core.warning(
          `Multiple Issues use roadmap key ${item.key}; updating #${existing.number}. Review the duplicates manually.`
        );
      }
    } else {
      existing = issuesByTitle.get(item.title.trim().toLowerCase());
    }

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
      allIssues.push(issue);
      issuesByKey.set(key, [issue]);
      issuesByTitle.set(item.title.trim().toLowerCase(), issue);
      core.info(`Created #${issue.number}: ${item.title}`);
      continue;
    }

    const existingLabels = labelNames(existing);
    const mergedLabels = desiredLabels(existingLabels, requiredLabels, labelDefinitions);
    const body = buildIssueBody(item, existing.body || '', manifest);
    const normalizedExistingLabels = new Set(existingLabels.map((name) => name.toLowerCase()));
    const hasProtectedLabel = [...doNotReopen].some((name) => normalizedExistingLabels.has(name));
    const shouldClose = [...closeWhenLabeled].some((name) => normalizedExistingLabels.has(name));

    let desiredState = existing.state;
    if (existing.state === 'open' && shouldClose) {
      desiredState = 'closed';
    } else if (existing.state === 'closed' && !respectClosed && !hasProtectedLabel) {
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
    issuesByKey.set(key, [issue, ...keyedCandidates.filter((candidate) => candidate.number !== issue.number)]);
    issuesByTitle.set(item.title.trim().toLowerCase(), issue);
    core.info(`Updated #${existing.number}: ${item.title}`);
  }

  core.notice(
    `Roadmap sync complete from ${roadmapUrl}: ${createdCount} created, ${updatedCount} updated, ${unchangedCount} unchanged, ${unpublishedCount} unpublished item(s) skipped.`
  );
  core.setOutput('created', String(createdCount));
  core.setOutput('updated', String(updatedCount));
  core.setOutput('unchanged', String(unchangedCount));
  core.setOutput('unpublished', String(unpublishedCount));
};
