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
 * A Playwright reporter that writes one row per test result into the DuckDB
 * test-results database (schema and write path live in `db.ts`).
 *
 * It is invoked by `merge-reports`:
 *
 *   playwright merge-reports <blob-dir> --reporter <this file>
 *
 * `merge-reports` replays a whole run's merged blob reports through the normal
 * reporter API, so this reporter sees standard `TestCase` / `TestResult`
 * objects — no wire-format parsing.
 *
 * The merge step prepends `@<botName>` to every test's tags (see `IdsPatcher`
 * in packages/playwright/src/reporters/merge.ts). We recover the bot name from
 * that tag and strip it back out. GitHub run metadata (run id, sha, pr, ...)
 * isn't present in blob reports, so the CLI injects it as one JSON `TRDB_RUN`
 * env var (plus `TRDB_DB_PATH` for where to write).
 */

import { TABLE_NAME, closeDb, openDb } from './db.ts';

import { timestampValue } from '@duckdb/node-api';

import type { Db, RunMetadata } from './db.ts';
import type { DuckDBAppender } from '@duckdb/node-api';
import type { FullResult, Reporter, TestCase, TestError, TestResult } from '@playwright/test/reporter';

// eslint-disable-next-line no-control-regex
const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const MAX_ERROR_LENGTH = 2000;

function firstError(errors: TestError[]): string | null {
  for (const error of errors || []) {
    const raw = error.message ?? error.value;
    if (raw)
      return raw.replace(ansiRegex, '').slice(0, MAX_ERROR_LENGTH);
  }
  return null;
}

/**
 * Blob reports carry OS-absolute test paths — e.g. `/home/runner/.../tests/x`
 * on Linux, `D:\a\...\tests\x` on Windows — so the same test looks different
 * per runner. Normalize to a forward-slash path relative to the repo test dir
 * (`tests/...`) so a test's rows agree across operating systems.
 */
function relativeTestFile(file: string): string {
  const posix = file.replaceAll('\\', '/');
  const i = posix.indexOf('/tests/');
  return i === -1 ? posix : posix.slice(i + 1);
}

/**
 * Split the merge-injected `@<botName>` tag out of a test's tags. Returns the
 * recovered bot name and the remaining (real) tags.
 */
function splitBotTag(tags: string[]): { botName: string | null; rest: string[] } {
  // IdsPatcher unshifts `@<botName>` to the front, so it's the first tag.
  if (tags.length && tags[0].startsWith('@')) {
    const [first, ...rest] = tags;
    return { botName: first.slice(1), rest };
  }
  return { botName: null, rest: tags };
}

/**
 * Reporter runtime, opened once at module load. The reporter always runs in a
 * dedicated `merge-reports` child process (spawned by cli.ts), so we
 * open the db and create the Appender up front via top-level `await` — that
 * makes both available synchronously in `onTestEnd` (Appender append/endRow are
 * sync; only `createAppender` is async), so a run's rows stream straight to
 * disk instead of piling up in a buffer.
 */
const dbPath = process.env.TRDB_DB_PATH;
const runJson = process.env.TRDB_RUN;
if (!dbPath || !runJson)
  throw new Error(`DuckDBReporter: TRDB_DB_PATH and TRDB_RUN env vars are required.`);
const db: Db = await openDb(dbPath);
const appender: DuckDBAppender = await db.conn.createAppender(TABLE_NAME);
const run: RunMetadata = JSON.parse(runJson);

// Appender column helpers for the genuinely-nullable columns: null -> SQL NULL,
// otherwise the typed value. Columns the reporter API guarantees are appended
// directly below without going through these.
const varchar = (v: string | null) => v === null ? appender.appendNull() : appender.appendVarchar(v);
const integer = (v: number | null) => v === null ? appender.appendNull() : appender.appendInteger(v);
// Stored values are epoch-milliseconds; TIMESTAMP columns are microseconds.
const tsMillis = (v: number | null) => v === null ? appender.appendNull() : appender.appendTimestamp(timestampValue(BigInt(v) * 1000n));

class DuckDBReporter implements Reporter {
  private _written = 0;

  printsToStdio(): boolean {
    // Returning true tells merge-reports we own stdout, which suppresses its
    // own progress chatter ("extracting: …", "merging events", "building final
    // report", …). We print a single clean summary line in onEnd instead.
    return true;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const { botName, rest } = splitBotTag(test.tags || []);
    // titlePath(): [ '', projectName, file, ...titles ]. Index 1 is the project.
    const titlePath = test.titlePath();
    const projectName = titlePath[1] || null;
    const title = titlePath.slice(3).join(' > ') || test.title;
    // Columns must be appended in table order (see createTableSql in db.ts).
    // Values the reporter API / RunMetadata type guarantee non-null are
    // appended directly; the varchar/integer/tsMillis helpers mark the columns
    // that can genuinely be NULL. ingested_at is left to its DEFAULT now().
    appender.appendBigInt(BigInt(run.runId));
    appender.appendInteger(run.runAttempt);
    appender.appendVarchar(run.workflowName);
    varchar(run.event);
    varchar(run.headSha);
    varchar(run.headBranch);
    integer(run.prNumber);
    varchar(botName);
    varchar(projectName);
    // test_id intentionally not stored — see the schema comment in db.ts.
    appender.appendVarchar(title);
    appender.appendVarchar(relativeTestFile(test.location.file));
    appender.appendInteger(test.location.line);
    appender.appendVarchar(test.expectedStatus);
    appender.appendVarchar(result.status);
    appender.appendInteger(result.retry);
    appender.appendBigInt(BigInt(Math.round(result.duration)));
    varchar(firstError(result.errors));
    varchar(rest.length ? rest.join(' ') : null);
    tsMillis(result.startTime.getTime());
    tsMillis(run.runStartedAt);
    appender.appendDefault(); // ingested_at DEFAULT now()
    appender.endRow();
    this._written++;
  }

  async onEnd(_result: FullResult): Promise<void> {
    try {
      appender.flushSync();
      appender.closeSync();
      // eslint-disable-next-line no-console
      console.log(`  wrote ${this._written} rows`);
    } finally {
      await closeDb(db);
    }
  }
}

export default DuckDBReporter;
