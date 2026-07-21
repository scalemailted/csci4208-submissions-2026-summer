'use strict';

const { loadCourseData } = require('./course-data.cjs');

function normalizeLabel(label, index) {
  if (!label || typeof label !== 'object' || Array.isArray(label)) {
    throw new Error(`labels[${index}] must be an object.`);
  }

  const name = String(label.name || '').trim();
  const color = String(label.color || '').replace(/^#/, '').trim().toLowerCase();
  const description = label.description == null ? '' : String(label.description).trim();

  if (!name) throw new Error(`labels[${index}].name is required.`);
  if (name.length > 50) throw new Error(`Label "${name}" exceeds GitHub's 50-character name limit.`);
  if (!/^[0-9a-f]{6}$/.test(color)) {
    throw new Error(`Label "${name}" must use a six-character hexadecimal color.`);
  }
  if (description.length > 100) {
    throw new Error(`Label "${name}" exceeds GitHub's 100-character description limit.`);
  }
  if (label.preserveOnIssueSync !== undefined && typeof label.preserveOnIssueSync !== 'boolean') {
    throw new Error(`Label "${name}" has a non-boolean preserveOnIssueSync value.`);
  }

  return { name, color, description };
}

module.exports = async function syncLabels({ github, context, core }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  const repository = await github.rest.repos.get({ owner, repo });
  if (!repository.data.has_issues) {
    throw new Error(
      'GitHub Issues are disabled for this repository. Enable Settings → General → Features → Issues, then rerun this workflow.'
    );
  }

  const { labels: sourceLabels, labelsUrl } = await loadCourseData({
    core,
    roadmap: false,
    labels: true
  });
  const desired = sourceLabels.map(normalizeLabel);

  const duplicateCheck = new Set();
  for (const label of desired) {
    const normalized = label.name.toLowerCase();
    if (duplicateCheck.has(normalized)) {
      throw new Error(`The course label source contains a duplicate label: ${label.name}`);
    }
    duplicateCheck.add(normalized);
  }

  const existing = await github.paginate(github.rest.issues.listLabelsForRepo, {
    owner,
    repo,
    per_page: 100
  });
  const byName = new Map(existing.map((label) => [label.name.toLowerCase(), label]));

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const label of desired) {
    const current = byName.get(label.name.toLowerCase());
    if (!current) {
      const result = await github.rest.issues.createLabel({ owner, repo, ...label });
      byName.set(label.name.toLowerCase(), result.data);
      created += 1;
      core.info(`Created label: ${label.name}`);
      continue;
    }

    const currentDescription = current.description || '';
    const changed = current.name !== label.name
      || String(current.color || '').toLowerCase() !== label.color
      || currentDescription !== label.description;

    if (!changed) {
      unchanged += 1;
      continue;
    }

    const result = await github.rest.issues.updateLabel({
      owner,
      repo,
      name: current.name,
      new_name: label.name,
      color: label.color,
      description: label.description
    });
    byName.delete(current.name.toLowerCase());
    byName.set(label.name.toLowerCase(), result.data);
    updated += 1;
    core.info(`Updated label: ${label.name}`);
  }

  core.notice(
    `Course labels synchronized from ${labelsUrl}: ${created} created, ${updated} updated, ${unchanged} unchanged. Extra student labels were preserved.`
  );
  core.setOutput('created', String(created));
  core.setOutput('updated', String(updated));
  core.setOutput('unchanged', String(unchanged));
};
