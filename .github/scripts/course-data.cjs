'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.join('.github', 'course-source.json');

class RemoteUnavailableError extends Error {}
class RemoteContentError extends Error {}

function readJsonFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read ${filePath}: ${error.message}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalStringArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array when supplied.`);
  return value.map((entry, index) => requireString(entry, `${label}[${index}]`));
}

function normalizeSourceConfig(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`${SOURCE_PATH} must contain a JSON object.`);
  }

  const issueAliases = {};
  if (source.issueAliases !== undefined) {
    if (!source.issueAliases || typeof source.issueAliases !== 'object' || Array.isArray(source.issueAliases)) {
      throw new Error(`${SOURCE_PATH}.issueAliases must be an object when supplied.`);
    }
    for (const [key, aliases] of Object.entries(source.issueAliases)) {
      const normalizedKey = requireString(key, `${SOURCE_PATH}.issueAliases key`).toLowerCase();
      issueAliases[normalizedKey] = optionalStringArray(
        aliases,
        `${SOURCE_PATH}.issueAliases.${key}`
      ).map((entry) => entry.toLowerCase());
    }
  }

  return {
    ...source,
    manifestUrl: requireString(source.manifestUrl, `${SOURCE_PATH}.manifestUrl`),
    issueAliases,
    retireKeys: optionalStringArray(source.retireKeys, `${SOURCE_PATH}.retireKeys`)
      .map((entry) => entry.toLowerCase()),
    removeLabelsOnSync: optionalStringArray(
      source.removeLabelsOnSync,
      `${SOURCE_PATH}.removeLabelsOnSync`
    ),
    closeStaleRoadmapIssues: source.closeStaleRoadmapIssues !== false
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cacheBustedUrl(input) {
  const url = new URL(input);
  url.searchParams.set(
    'course_sync',
    `${process.env.GITHUB_RUN_ID || 'local'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}-${Date.now()}`
  );
  return url.toString();
}

async function fetchJson(inputUrl, label, core) {
  const url = requireString(inputUrl, `${label} URL`);
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      core?.info?.(`Fetching ${label}: ${url} (attempt ${attempt}/3)`);
      const response = await fetch(cacheBustedUrl(url), {
        headers: {
          accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
          'cache-control': 'no-cache',
          'user-agent': 'csci4208-summer-student-automation'
        },
        signal: AbortSignal.timeout(20_000)
      });

      if (!response.ok) {
        const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
        const message = `HTTP ${response.status} ${response.statusText}`;
        if (retryable) throw new RemoteUnavailableError(message);
        throw new RemoteContentError(`${label} could not be loaded from ${url}: ${message}`);
      }

      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new RemoteContentError(`${label} at ${url} is not valid JSON: ${error.message}`);
      }
    } catch (error) {
      if (error instanceof RemoteContentError) throw error;
      lastError = error;
      if (attempt < 3) await sleep(attempt * 750);
    }
  }

  throw new RemoteUnavailableError(
    `Unable to fetch ${label} from ${url} after three attempts: ${lastError?.message || 'unknown network error'}. No student Issues were changed; rerun the workflow when the source is available.`
  );
}

function encodeRepositoryPath(filePath) {
  return requireString(filePath, 'repository file path')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function getSourceCoordinates(manifest) {
  const source = manifest?.source || {};
  return {
    owner: requireString(source.owner, 'manifest.source.owner'),
    repository: requireString(source.repository, 'manifest.source.repository'),
    ref: requireString(source.ref, 'manifest.source.ref')
  };
}

function rawFileUrl(manifest, filePath) {
  const { owner, repository, ref } = getSourceCoordinates(manifest);
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${encodeURIComponent(ref)}/${encodeRepositoryPath(filePath)}`;
}

function repositoryFileUrl(manifest, filePath) {
  if (/^https?:\/\//i.test(String(filePath || ''))) return String(filePath);
  const { owner, repository, ref } = getSourceCoordinates(manifest);
  const rawPath = requireString(filePath, 'repository file path');
  const view = rawPath.endsWith('/') ? 'tree' : 'blob';
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${view}/${encodeURIComponent(ref)}/${encodeRepositoryPath(rawPath)}`;
}

function courseRepositoryUrl(manifest) {
  const configured = manifest?.links?.courseRepository;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  const { owner, repository } = getSourceCoordinates(manifest);
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}

function courseDisplayName(manifest) {
  const course = manifest?.course || {};
  return [course.code, course.term]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' — ') || 'Course roadmap';
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Course manifest must be a JSON object.');
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported course manifest schemaVersion: ${manifest.schemaVersion}`);
  }
  getSourceCoordinates(manifest);
  requireString(manifest?.files?.roadmap, 'manifest.files.roadmap');
  requireString(manifest?.files?.labels, 'manifest.files.labels');
}

async function loadCourseData({ core, roadmap = true, labels = true } = {}) {
  const sourceConfig = normalizeSourceConfig(readJsonFile(SOURCE_PATH));
  const manifestUrl = (process.env.COURSE_MANIFEST_URL || sourceConfig.manifestUrl).trim();

  const manifest = await fetchJson(manifestUrl, 'course manifest', core);
  validateManifest(manifest);

  const roadmapUrl = (process.env.ROADMAP_SRC || rawFileUrl(manifest, manifest.files.roadmap)).trim();
  const labelsUrl = (process.env.LABELS_SRC || rawFileUrl(manifest, manifest.files.labels)).trim();

  const [roadmapDocument, labelsDocument] = await Promise.all([
    roadmap ? fetchJson(roadmapUrl, 'course roadmap', core) : Promise.resolve(null),
    labels ? fetchJson(labelsUrl, 'course labels', core) : Promise.resolve(null)
  ]);

  if (roadmap && !Array.isArray(roadmapDocument)) {
    throw new Error(`Course roadmap from ${roadmapUrl} must be a JSON array.`);
  }
  if (labels && !Array.isArray(labelsDocument)) {
    throw new Error(`Course labels from ${labelsUrl} must be a JSON array.`);
  }

  return {
    sourceConfig,
    manifest,
    manifestUrl,
    roadmap: roadmapDocument,
    roadmapUrl: roadmap ? roadmapUrl : null,
    labels: labelsDocument,
    labelsUrl: labels ? labelsUrl : null
  };
}

module.exports = {
  SOURCE_PATH,
  courseDisplayName,
  courseRepositoryUrl,
  loadCourseData,
  rawFileUrl,
  repositoryFileUrl
};
