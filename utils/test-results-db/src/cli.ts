/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import AdmZip from 'adm-zip';
import { Octokit } from '@octokit/rest';

import { openDb, closeDb, ingestedRuns, rowCount, truncateToSize, fileSize } from './db.ts';

import type { RunMetadata } from './db.ts';

// -- GitHub -----------------------------------------------------------------

/** Artifact name prefix produced by the test workflows' upload-blob-report action. */
const BLOB_ARTIFACT_PREFIX = 'blob-report';

/** Name of the artifact that carries the DuckDB file between runs. */
const DB_ARTIFACT_NAME = 'test-results-db';

/** The repository we ingest from. Overridable via GITHUB_REPOSITORY (CI sets it). */
const DEFAULT_REPO = 'microsoft/playwright';

/** A run that produced blob-report artifacts, with the ids of those artifacts. */
type BlobRun = {
  runId: number;
  artifactIds: number[];
};

// GitHub client + target repo, resolved lazily on first use and memoized: the
// offline `ingest-local` path needs neither, so we don't demand a token or a
// valid GITHUB_REPOSITORY until a command actually talks to GitHub.
let _octokit: Octokit | undefined;
function octokit(): Octokit {
  if (!_octokit) {
    const auth = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!auth)
      throw new Error(`GITHUB_TOKEN (or GH_TOKEN) is required for GitHub access.`);
    _octokit = new Octokit({ auth });
  }
  return _octokit;
}

let _repo: { owner: string; repo: string } | undefined;
function repo(): { owner: string; repo: string } {
  if (!_repo) {
    const value = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
    const [owner, repo] = value.split('/');
    if (!owner || !repo)
      throw new Error(`Invalid repository "${value}". Expected "owner/repo".`);
    _repo = { owner, repo };
  }
  return _repo;
}

/**
 * Find the runs that produced `blob-report*` artifacts within `lookbackDays`.
 *
 * Rather than enumerate workflow runs and guess which are test workflows, we
 * scan the repo's artifacts directly (they're returned newest-first) and keep
 * the ones whose name starts with `blob-report`, grouped by their run. This is
 * fully dynamic — any workflow that uploads blob reports is picked up, no
 * hardcoded workflow-name list. Run metadata (name, event, sha, pr, ...) is
 * then fetched once per matching run.
 */
async function listBlobRuns(lookbackDays: number): Promise<BlobRun[]> {
  const { owner, repo: repoName } = repo();
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  // Map preserves insertion order, and artifacts arrive newest-first, so
  // iterating it later yields runs newest-first too.
  const artifactIdsByRun = new Map<number, number[]>();
  const iterator = octokit().paginate.iterator(octokit().actions.listArtifactsForRepo, {
    owner,
    repo: repoName,
    per_page: 100,
  });
  outer: for await (const { data } of iterator) {
    for (const artifact of data) {
      const createdAt = artifact.created_at ? Date.parse(artifact.created_at) : 0;
      // Artifacts come newest-first, so once we cross the window we're done.
      if (createdAt && createdAt < cutoff)
        break outer;
      if (artifact.expired || !artifact.name.startsWith(BLOB_ARTIFACT_PREFIX))
        continue;
      const runId = artifact.workflow_run?.id;
      if (!runId)
        continue;
      let ids = artifactIdsByRun.get(runId);
      if (!ids)
        artifactIdsByRun.set(runId, ids = []);
      ids.push(artifact.id);
    }
  }
  return [...artifactIdsByRun].map(([runId, artifactIds]) => ({ runId, artifactIds }));
}

// Full run metadata for a single run. This is one API call per run, so we only
// fetch it for runs we're actually about to ingest — never for the (usually
// large) majority that are already in the database.
async function fetchRunMetadata(runId: number): Promise<RunMetadata> {
  const { owner, repo: repoName } = repo();
  const { data: run } = await octokit().actions.getWorkflowRun({
    owner,
    repo: repoName,
    run_id: runId,
  });
  const pr = run.pull_requests && run.pull_requests[0];
  return {
    runId: run.id,
    runAttempt: run.run_attempt ?? 1,
    workflowName: run.name || '',
    event: run.event ?? null,
    headSha: run.head_sha ?? null,
    headBranch: run.head_branch ?? null,
    prNumber: pr ? pr.number : null,
    runStartedAt: run.run_started_at ? Date.parse(run.run_started_at) : null,
  };
}

async function downloadArtifactZip(artifactId: number): Promise<Buffer> {
  const { owner, repo: repoName } = repo();
  const response = await octokit().actions.downloadArtifact({
    owner,
    repo: repoName,
    artifact_id: artifactId,
    archive_format: 'zip',
  });
  return Buffer.from(response.data as ArrayBuffer);
}

/**
 * Id of the most recent, non-expired `test-results-db` artifact in the repo, or
 * null if none exists yet. Artifacts come newest-first, so the first
 * non-expired one is the latest.
 */
async function findLatestDbArtifactId(): Promise<number | null> {
  const { owner, repo: repoName } = repo();
  const iterator = octokit().paginate.iterator(octokit().actions.listArtifactsForRepo, {
    owner,
    repo: repoName,
    name: DB_ARTIFACT_NAME,
    per_page: 100,
  });
  for await (const { data } of iterator) {
    for (const artifact of data) {
      if (!artifact.expired)
        return artifact.id;
    }
  }
  return null;
}

// The database lives at a fixed, package-relative location (gitignored). It is
// not configurable via a flag — the reporter, the CLI and the workflow all
// agree on it. `TRDB_DB_PATH` may override it (tests); the reporter reads that
// same var to learn where to write.
const DEFAULT_DB_PATH = fileURLToPath(new URL('../test-results.duckdb', import.meta.url));

function resolveDbPath(): string {
  const override = process.env.TRDB_DB_PATH;
  return override ? path.resolve(override) : DEFAULT_DB_PATH;
}

type Args = {
  positionals: string[];
  options: Map<string, string>;
};

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options.set(key, next);
        i++;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, options };
}

function num(args: Args, key: string, fallback: number): number {
  const value = args.options.get(key);
  if (value === undefined)
    return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`--${key} must be a number, got "${value}"`);
  return parsed;
}

/** Extract the first `.duckdb` file from an artifact zip buffer to destPath. */
function extractDbFromZip(zipBuffer: Buffer, destPath: string): boolean {
  const zip = new AdmZip(zipBuffer);
  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory && entry.entryName.endsWith('.duckdb')) {
      fs.writeFileSync(destPath, entry.getData());
      return true;
    }
  }
  return false;
}

/**
 * Extract a blob-report artifact zip into `destDir`, writing each inner blob
 * report (`*.zip`) flat. Mirrors the `unzip -n` behavior of the repo's
 * download-artifact action: never overwrite an existing file (blob report
 * names are unique across bots via their command hash). Returns the number of
 * blob report files written.
 */
function extractBlobZips(zipBuffer: Buffer, destDir: string): number {
  const zip = new AdmZip(zipBuffer);
  let written = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.endsWith('.zip'))
      continue;
    const dest = path.join(destDir, path.basename(entry.entryName));
    if (fs.existsSync(dest))
      continue;
    fs.writeFileSync(dest, entry.getData());
    written++;
  }
  return written;
}

async function cmdDownload(): Promise<void> {
  const dest = resolveDbPath();
  const artifactId = await findLatestDbArtifactId();
  if (artifactId === null) {
    console.log(`No existing "${DB_ARTIFACT_NAME}" artifact found; starting a fresh database.`);
    const db = await openDb(dest);
    await closeDb(db);
    console.log(`Created empty database at ${dest}`);
    return;
  }
  console.log(`Downloading "${DB_ARTIFACT_NAME}" artifact #${artifactId} ...`);
  const zipBuffer = await downloadArtifactZip(artifactId);
  if (!extractDbFromZip(zipBuffer, dest))
    throw new Error(`Artifact #${artifactId} did not contain a .duckdb file.`);
  console.log(`Downloaded database to ${dest} (${formatBytes(fileSize(dest))})`);
}

async function cmdUpdate(args: Args): Promise<void> {
  const dest = resolveDbPath();
  const lookbackDays = num(args, 'lookback-days', 3);
  const maxSizeMb = num(args, 'max-size-mb', 200);
  const maxRuns = num(args, 'max-runs', Infinity);

  // Read the dedupe set, then close the db: the merge reporter needs exclusive
  // write access to the file (DuckDB is single-writer).
  let ingested: Set<string>;
  let startingRows: number;
  {
    const db = await openDb(dest);
    ingested = await ingestedRuns(db);
    startingRows = await rowCount(db);
    await closeDb(db);
  }
  console.log(`Test results database`);
  console.log(`  ${startingRows} rows from ${ingested.size} runs`);

  const blobRuns = await listBlobRuns(lookbackDays);
  // The dedupe set keys are `${runId}:${runAttempt}`. Artifacts don't carry the
  // attempt, so we skip at runId granularity — a re-run of an already-ingested
  // run won't be re-ingested, which is fine for this tool.
  const ingestedRunIds = new Set([...ingested].map(key => Number(key.split(':')[0])));
  const newRuns = blobRuns.filter(({ runId }) => !ingestedRunIds.has(runId));
  console.log(`\nScanning for new runs (last ${lookbackDays} days)`);
  console.log(`  found ${blobRuns.length} runs with blob-report artifacts`);
  console.log(`  ${newRuns.length} not yet ingested${newRuns.length > maxRuns ? `, ingesting ${maxRuns}` : ''}`);

  let importedRuns = 0;
  for (const [index, { runId, artifactIds }] of newRuns.entries()) {
    if (importedRuns >= maxRuns) {
      console.log(`\nReached --max-runs=${maxRuns}; stopping.`);
      break;
    }
    const progress = `(${index + 1}/${newRuns.length})`;

    // Disk-frugal: download this run's blobs to a fresh temp dir, merge/ingest,
    // then delete the temp dir before touching the next run — never accumulate
    // all runs' blobs on the (small) runner disk.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `trdb-run-${runId}-`));
    try {
      let blobFiles = 0;
      for (const artifactId of artifactIds) {
        const zipBuffer = await downloadArtifactZip(artifactId);
        blobFiles += extractBlobZips(zipBuffer, tempDir);
      }
      if (!blobFiles) {
        console.log(`\nrun ${runId} ${progress}`);
        console.log(`  artifacts held no blob reports, skipping`);
        continue;
      }
      const run = await fetchRunMetadata(runId);
      console.log(`\nrun ${runId} (${run.workflowName}) ${progress}`);
      console.log(`  merging ${blobFiles} blob reports from ${artifactIds.length} artifacts`);
      mergeRunIntoDb(tempDir, run, dest);
      importedRuns++;
    } catch (error) {
      // Skip a bad run rather than aborting the whole update.
      console.error(`  failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // Reopen once at the end for truncation and the final row count.
  const db = await openDb(dest);
  try {
    const maxBytes = maxSizeMb * 1024 * 1024;
    const before = fileSize(dest);
    const after = await truncateToSize(db, maxBytes);
    console.log(`\nSummary`);
    console.log(`  imported ${importedRuns} new runs`);
    if (after < before)
      console.log(`  truncated ${formatBytes(before)} → ${formatBytes(after)} (cap ${maxSizeMb} MB)`);
    else
      console.log(`  size ${formatBytes(after)}, within the ${maxSizeMb} MB cap`);
    console.log(`  ${await rowCount(db)} rows total`);
  } finally {
    await closeDb(db);
  }

  // Let CI skip the artifact upload when nothing changed.
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `imported=${importedRuns}\n`);
}

async function cmdIngestLocal(args: Args): Promise<void> {
  const dir = args.positionals[0];
  if (!dir)
    throw new Error(`Usage: ingest-local <blob-report-dir> [--run-id <n>]`);
  const dest = resolveDbPath();
  const runId = num(args, 'run-id', 1);

  const zips = fs.readdirSync(dir).filter(f => f.endsWith('.zip'));
  if (!zips.length)
    throw new Error(`No blob report .zip files found in ${dir}. Point this at a directory of merge-ready blob reports.`);

  const metadata: RunMetadata = {
    runId,
    runAttempt: 1,
    workflowName: 'local',
    event: 'local',
    headSha: null,
    headBranch: null,
    prNumber: null,
    runStartedAt: Date.now(),
  };
  console.log(`Merging ${zips.length} blob reports from ${dir} (run ${runId})`);
  mergeRunIntoDb(dir, metadata, dest);

  const db = await openDb(dest);
  try {
    console.log(`\n${await rowCount(db)} rows total (${formatBytes(fileSize(dest))})`);
  } finally {
    await closeDb(db);
  }
}

// -- Merge runner -----------------------------------------------------------

// Path to the DuckDB reporter, resolved relative to this file so it works from
// any cwd. It lives next to this CLI in src/.
const REPORTER_PATH = fileURLToPath(new URL('./duckdbReporter.ts', import.meta.url));

// The Playwright repo root, which provides the `merge-reports` CLI. This file
// always lives at `<repoRoot>/utils/test-results-db/src/cli.ts`, so the root is
// a fixed three levels up.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// Merge config forcing cross-OS blob reports (different absolute testDirs) to
// merge. See mergeConfig.ts.
const MERGE_CONFIG_PATH = fileURLToPath(new URL('./mergeConfig.ts', import.meta.url));

/**
 * Merge the blob reports in `blobDir` and write rows into `dbPath` via the
 * DuckDB reporter, by spawning the repo's own `merge-reports` CLI. Run metadata
 * is passed to the reporter as one JSON `TRDB_RUN` env var (blob reports don't
 * carry it). Returns when merge-reports exits 0; throws otherwise.
 */
function mergeRunIntoDb(blobDir: string, run: RunMetadata, dbPath: string): void {
  const cli = path.join(REPO_ROOT, 'packages/playwright/cli.js');
  const args = ['merge-reports', path.resolve(blobDir), '-c', MERGE_CONFIG_PATH, '--reporter', REPORTER_PATH];
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.TRDB_DB_PATH = path.resolve(dbPath);
  env.TRDB_RUN = JSON.stringify(run);
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  });
  if (result.error)
    throw result.error;
  if (result.status !== 0)
    throw new Error(`merge-reports exited with code ${result.status} for run ${run.runId}`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const USAGE = `test-results-db — maintain a DuckDB file of Playwright CI test results.

This CLI only *maintains* the file. To query it, use the DuckDB CLI directly:

  duckdb ${DEFAULT_DB_PATH} "SELECT * FROM test_results LIMIT 10"

Ingestion runs a whole CI run's blob reports through the repo's own
"merge-reports" CLI, pointed at a DuckDB reporter (src/duckdbReporter.ts).

Usage:
  cli download                                          fetch the latest db artifact
  cli update  [--lookback-days <n>] [--max-size-mb <n>] [--max-runs <n>]
  cli ingest-local <blob-report-dir> [--run-id <n>]     (offline/dev)

The database is kept at a fixed, gitignored location:
  ${DEFAULT_DB_PATH}
(override with the TRDB_DB_PATH env var).

Environment:
  GITHUB_TOKEN        required for download/update
  GITHUB_REPOSITORY   repo (owner/repo); defaults to microsoft/playwright
  TRDB_DB_PATH        override the database location
`;

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (command) {
    case 'download':
      await cmdDownload();
      break;
    case 'update':
      await cmdUpdate(args);
      break;
    case 'ingest-local':
      await cmdIngestLocal(args);
      break;
    case 'help':
    case '--help':
    case undefined:
      console.log(USAGE);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
