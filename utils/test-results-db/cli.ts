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

const BLOB_ARTIFACT_PREFIX = 'blob-report';

const DB_ARTIFACT_NAME = 'test-results-db';

const REPO_OWNER = 'microsoft';
const REPO_NAME = 'playwright';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN || process.env.GH_TOKEN });

async function listBlobRuns(lookbackDays: number) {
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const artifactIdsByRun = new Map<number, number[]>();
  const iterator = octokit.paginate.iterator(octokit.actions.listArtifactsForRepo, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    per_page: 100,
  });
  outer: for await (const { data } of iterator) {
    for (const artifact of data) {
      const createdAt = artifact.created_at ? Date.parse(artifact.created_at) : 0;
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

async function fetchRunMetadata(runId: number): Promise<RunMetadata> {
  const { data: run } = await octokit.actions.getWorkflowRun({
    owner: REPO_OWNER,
    repo: REPO_NAME,
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
  const response = await octokit.actions.downloadArtifact({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    artifact_id: artifactId,
    archive_format: 'zip',
  });
  return Buffer.from(response.data as ArrayBuffer);
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length)
        return;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function findLatestDbArtifactId(): Promise<number | null> {
  const iterator = octokit.paginate.iterator(octokit.actions.listArtifactsForRepo, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
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

let DB_PATH = fileURLToPath(new URL('./test-results.duckdb', import.meta.url));
if (process.env.TRDB_DB_PATH)
  DB_PATH = path.resolve(process.env.TRDB_DB_PATH);

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

function extractBlobZips(zipBuffer: Buffer, destDir: string): number {
  const zip = new AdmZip(zipBuffer);
  let written = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.endsWith('.zip'))
      continue;
    const dest = path.join(destDir, path.basename(entry.entryName));
    if (fs.existsSync(dest))
      throw new Error(`Duplicate blob report name in batch: ${path.basename(entry.entryName)}`);
    fs.writeFileSync(dest, entry.getData());
    written++;
  }
  return written;
}

async function cmdDownload(): Promise<void> {
  const artifactId = await findLatestDbArtifactId();
  if (artifactId === null) {
    console.log(`No existing "${DB_ARTIFACT_NAME}" artifact found; starting a fresh database.`);
    const db = await openDb(DB_PATH);
    await closeDb(db);
    console.log(`Created empty database at ${DB_PATH}`);
    return;
  }
  console.log(`Downloading "${DB_ARTIFACT_NAME}" artifact #${artifactId} ...`);
  const zipBuffer = await downloadArtifactZip(artifactId);
  if (!extractDbFromZip(zipBuffer, DB_PATH))
    throw new Error(`Artifact #${artifactId} did not contain a .duckdb file.`);
  console.log(`Downloaded database to ${DB_PATH} (${formatBytes(fileSize(DB_PATH))})`);
}

async function cmdUpdate(args: Args): Promise<void> {
  const lookbackDays = num(args, 'lookback-days', 3);
  const maxSizeMb = num(args, 'max-size-mb', 800);
  const maxRuns = num(args, 'max-runs', Infinity);

  let ingested: Set<string>;
  let startingRows: number;
  {
    const db = await openDb(DB_PATH);
    ingested = await ingestedRuns(db);
    startingRows = await rowCount(db);
    await closeDb(db);
  }
  console.log(`Test results database`);
  console.log(`  ${startingRows} rows from ${ingested.size} runs`);

  const blobRuns = await listBlobRuns(lookbackDays);
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

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `trdb-run-${runId}-`));
    try {
      let blobFiles = 0;
      let downloadedBytes = 0;
      const downloadStart = Date.now();
      const zipBuffers = await mapWithConcurrency(artifactIds, 8, downloadArtifactZip);
      const downloadMs = Date.now() - downloadStart;
      for (const zipBuffer of zipBuffers) {
        downloadedBytes += zipBuffer.length;
        blobFiles += extractBlobZips(zipBuffer, tempDir);
      }
      if (!blobFiles) {
        console.log(`\nrun ${runId} ${progress}`);
        console.log(`  artifacts held no blob reports, skipping`);
        continue;
      }
      const run = await fetchRunMetadata(runId);
      console.log(`\nrun ${runId} (${run.workflowName}) ${progress}`);
      console.log(`  downloaded ${formatBytes(downloadedBytes)} from ${artifactIds.length} artifacts in ${(downloadMs / 1000).toFixed(1)}s`);
      console.log(`  merging ${blobFiles} blob reports`);
      const mergeStart = Date.now();
      mergeRunIntoDb(tempDir, run);
      console.log(`  merged in ${((Date.now() - mergeStart) / 1000).toFixed(1)}s`);
      importedRuns++;
    } catch (error) {
      console.error(`  failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const db = await openDb(DB_PATH);
  try {
    const maxBytes = maxSizeMb * 1024 * 1024;
    const before = fileSize(DB_PATH);
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

  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `imported=${importedRuns}\n`);
}

async function cmdIngestLocal(args: Args): Promise<void> {
  const dir = args.positionals[0];
  if (!dir)
    throw new Error(`Usage: ingest-local <blob-report-dir> [--run-id <n>]`);
  const runId = num(args, 'run-id', 1);

  const zips = fs.readdirSync(dir).filter(f => f.endsWith('.zip'));
  if (!zips.length)
    throw new Error(`No blob report .zip files found in ${dir}. Point this at a directory of merge-ready blob reports.`);

  console.log(`Merging ${zips.length} blob reports from ${dir} (run ${runId})`);
  mergeRunIntoDb(dir, {
    runId,
    runAttempt: 1,
    workflowName: 'local',
    event: 'local',
    headSha: null,
    headBranch: null,
    prNumber: null,
    runStartedAt: Date.now(),
  });

  const db = await openDb(DB_PATH);
  try {
    console.log(`\n${await rowCount(db)} rows total (${formatBytes(fileSize(DB_PATH))})`);
  } finally {
    await closeDb(db);
  }
}

function mergeRunIntoDb(blobDir: string, run: RunMetadata) {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'packages/playwright/cli.js'),
      'merge-reports',
      path.resolve(blobDir),
      '-c', fileURLToPath(new URL('./mergeConfig.ts', import.meta.url)),
      '--reporter', fileURLToPath(new URL('./duckdbReporter.ts', import.meta.url))
    ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TRDB_DB_PATH: path.resolve(DB_PATH),
      TRDB_RUN: JSON.stringify(run),
    },
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

  duckdb ${DB_PATH} "SELECT * FROM test_results LIMIT 10"

Ingestion runs a whole CI run's blob reports through the repo's own
"merge-reports" CLI, pointed at a DuckDB reporter (duckdbReporter.ts).

Usage:
  cli download                                          fetch the latest db artifact
  cli update  [--lookback-days <n>] [--max-size-mb <n>] [--max-runs <n>]
  cli ingest-local <blob-report-dir> [--run-id <n>]     (offline/dev)

The database is kept at a fixed, gitignored location:
  ${DB_PATH}

Environment:
  GITHUB_TOKEN        required for download/update
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
