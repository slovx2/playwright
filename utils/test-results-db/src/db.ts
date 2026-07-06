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

/**
 * The DuckDB test-results file: schema, open/close, the row Appender, and the
 * read/maintenance queries the CLI uses. Imported both by the CLI (to read and
 * truncate the file) and by the reporter (to write into it) — so this module is
 * intentionally free of top-level side effects.
 */

import fs from 'fs';

import { DuckDBInstance } from '@duckdb/node-api';

import type { DuckDBConnection } from '@duckdb/node-api';

/**
 * Run-level metadata, gathered from the GitHub Actions run that produced the
 * blob-report artifacts (or synthesized for `ingest-local`). Injected into the
 * DuckDB reporter via `TRDB_*` env vars and attached to every result row, so
 * the db can answer "what failed on this SHA / PR" without re-fetching the run.
 */
export type RunMetadata = {
  runId: number;
  runAttempt: number;
  workflowName: string;
  /** GitHub event that triggered the run, e.g. 'push' | 'pull_request'. */
  event: string | null;
  headSha: string | null;
  headBranch: string | null;
  prNumber: number | null;
  /** Run start time, epoch milliseconds. */
  runStartedAt: number | null;
};

/**
 * One row in `test_results` is a single test result (one per retry). Rows are
 * produced by merging a whole run's blob reports through `merge-reports`, so
 * per-shard / per-artifact identity is intentionally not preserved. To fetch
 * the full blob report for a row, locate the run's `blob-report-<bot_name>`
 * artifact via `run_id` + `bot_name`. The reporter appends rows directly (see
 * duckdbReporter.ts `onTestEnd`), so there is no shared row type.
 */

/** Name of the single results table, shared by the schema and the Appender. */
export const TABLE_NAME = 'test_results';

function createTableSql(qualifiedName: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${qualifiedName} (
  run_id BIGINT,
  run_attempt INTEGER,
  workflow_name VARCHAR,
  event VARCHAR,
  head_sha VARCHAR,
  head_branch VARCHAR,
  pr_number INTEGER,
  bot_name VARCHAR,
  project_name VARCHAR,
  -- Playwright's test_id is intentionally omitted. It's a deterministic hash of
  -- (project.id, file, full title path) — see bindFileSuiteToProject in
  -- packages/playwright/src/common/suiteUtils.ts. Those exact inputs are already
  -- stored verbatim as (project_name, file, test_title), so test_id carries no
  -- identifying information the tuple doesn't. It was also the single largest
  -- column (~44% of the file: a high-entropy 40-char SHA that compresses poorly),
  -- so dropping it roughly halves storage. Identify a test across runs by
  -- grouping on (project_name, file, test_title).
  test_title VARCHAR,
  file VARCHAR,
  line INTEGER,
  expected_status VARCHAR,
  status VARCHAR,
  retry INTEGER,
  duration_ms BIGINT,
  error_message VARCHAR,
  tags VARCHAR,
  result_started_at TIMESTAMP,
  run_started_at TIMESTAMP,
  -- Debugging aid: when this row was ingested. Not part of the intended query
  -- surface — expect to drop this column once the pipeline is trusted.
  ingested_at TIMESTAMP DEFAULT now()
)`;
}

/**
 * An open DuckDB file. A plain handle passed to the `db*` functions below.
 * `instance`/`conn` are reassigned by `compact`, so it's a mutable record
 * rather than an immutable value.
 */
export type Db = {
  instance: DuckDBInstance;
  conn: DuckDBConnection;
  readonly path: string;
};

export async function openDb(path: string): Promise<Db> {
  const instance = await DuckDBInstance.create(path);
  const conn = await instance.connect();
  await conn.run(createTableSql(TABLE_NAME));
  return { instance, conn, path };
}

export async function closeDb(db: Db): Promise<void> {
  db.conn.closeSync();
  db.instance.closeSync();
}

/**
 * Set of runs already ingested, keyed `"runId:runAttempt"` — the dedupe set
 * for `update`. Derived from the rows themselves (a run is "present" if it
 * contributed at least one result row).
 */
export async function ingestedRuns(db: Db): Promise<Set<string>> {
  const reader = await db.conn.runAndReadAll(`SELECT DISTINCT run_id, run_attempt FROM test_results`);
  const runs = new Set<string>();
  for (const row of reader.getRows())
    runs.add(`${row[0]}:${row[1]}`);
  return runs;
}

export async function rowCount(db: Db): Promise<number> {
  const reader = await db.conn.runAndReadAll(`SELECT count(*) FROM test_results`);
  return Number(reader.getRows()[0][0]);
}

/**
 * Enforce a file-size cap. DuckDB doesn't shrink on plain DELETE, so we delete
 * the oldest whole runs, then compact by copying into a fresh file. Repeats
 * until under the cap or only one run remains.
 *
 * Returns the final on-disk size in bytes.
 */
export async function truncateToSize(db: Db, maxBytes: number): Promise<number> {
  // Flush the WAL so the on-disk file reflects the true size before measuring.
  await db.conn.run(`CHECKPOINT`);
  let size = fileSize(db.path);
  while (size > maxBytes) {
    const reader = await db.conn.runAndReadAll(`SELECT count(DISTINCT (run_id, run_attempt)) FROM test_results`);
    const runCount = Number(reader.getRows()[0][0]);
    if (runCount <= 1)
      break;
    // Evict the oldest ~20% of runs (at least one) per pass in one atomic
    // DELETE, then compact to reclaim disk. evict is a computed int, safe to
    // interpolate.
    const evict = Math.max(1, Math.floor(runCount * 0.2));
    await db.conn.run(`
      DELETE FROM test_results
      WHERE (run_id, run_attempt) IN (
        SELECT run_id, run_attempt
        FROM test_results
        GROUP BY run_id, run_attempt
        ORDER BY min(run_started_at) ASC NULLS FIRST, run_id ASC
        LIMIT ${evict}
      )`);
    await compact(db);
    size = fileSize(db.path);
  }
  return size;
}

/** Copy live data into a fresh db file to actually reclaim disk space. */
async function compact(db: Db): Promise<void> {
  const tmpPath = `${db.path}.compact.tmp`;
  for (const p of [tmpPath, `${tmpPath}.wal`]) {
    if (fs.existsSync(p))
      fs.rmSync(p);
  }
  await db.conn.run(`ATTACH '${tmpPath.replace(/'/g, "''")}' AS compacted`);
  await db.conn.run(createTableSql('compacted.test_results'));
  await db.conn.run(`INSERT INTO compacted.test_results SELECT * FROM test_results`);
  await db.conn.run(`DETACH compacted`);
  await closeDb(db);

  fs.rmSync(db.path);
  if (fs.existsSync(`${db.path}.wal`))
    fs.rmSync(`${db.path}.wal`);
  fs.renameSync(tmpPath, db.path);

  db.instance = await DuckDBInstance.create(db.path);
  db.conn = await db.instance.connect();
}

export function fileSize(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}
