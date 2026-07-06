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

import fs from 'fs';

import { DuckDBInstance } from '@duckdb/node-api';

import type { DuckDBConnection } from '@duckdb/node-api';

export type RunMetadata = {
  runId: number;
  runAttempt: number;
  workflowName: string;
  event: string | null;
  headSha: string | null;
  headBranch: string | null;
  prNumber: number | null;
  runStartedAt: number | null;
};

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
  test_title VARCHAR,
  file VARCHAR,
  -- test_id is intentionally omitted since it's a deterministic hash of (project-name, file, test_title)
  line INTEGER,
  expected_status VARCHAR,
  status VARCHAR,
  retry INTEGER,
  duration_ms BIGINT,
  error_message VARCHAR,
  tags VARCHAR,
  result_started_at TIMESTAMP,
  run_started_at TIMESTAMP,
  ingested_at TIMESTAMP DEFAULT now()
)`;
}

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

export async function truncateToSize(db: Db, maxBytes: number): Promise<number> {
  await db.conn.run(`CHECKPOINT`);
  let size = fileSize(db.path);
  while (size > maxBytes) {
    const reader = await db.conn.runAndReadAll(`SELECT count(DISTINCT (run_id, run_attempt)) FROM test_results`);
    const runCount = Number(reader.getRows()[0][0]);
    if (runCount <= 1)
      break;
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
