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

function relativeTestFile(file: string): string {
  const posix = file.replaceAll('\\', '/');
  const i = posix.indexOf('/tests/');
  return i === -1 ? posix : posix.slice(i + 1);
}

function splitBotTag(tags: string[]): { botName: string | null; rest: string[] } {
  if (tags.length && tags[0].startsWith('@')) {
    const [first, ...rest] = tags;
    return { botName: first.slice(1), rest };
  }
  return { botName: null, rest: tags };
}

const dbPath = process.env.TRDB_DB_PATH;
const runJson = process.env.TRDB_RUN;
if (!dbPath || !runJson)
  throw new Error(`DuckDBReporter: TRDB_DB_PATH and TRDB_RUN env vars are required.`);
const db: Db = await openDb(dbPath);
const appender: DuckDBAppender = await db.conn.createAppender(TABLE_NAME);
const run: RunMetadata = JSON.parse(runJson);

const varchar = (v: string | null) => v === null ? appender.appendNull() : appender.appendVarchar(v);
const integer = (v: number | null) => v === null ? appender.appendNull() : appender.appendInteger(v);
const tsMillis = (v: number | null) => v === null ? appender.appendNull() : appender.appendTimestamp(timestampValue(BigInt(v) * 1000n));

class DuckDBReporter implements Reporter {
  private _written = 0;

  printsToStdio(): boolean {
    return true;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const { botName, rest } = splitBotTag(test.tags || []);
    const titlePath = test.titlePath();
    const projectName = titlePath[1] || null;
    const title = titlePath.slice(3).join(' > ') || test.title;
    appender.appendBigInt(BigInt(run.runId));
    appender.appendInteger(run.runAttempt);
    appender.appendVarchar(run.workflowName);
    varchar(run.event);
    varchar(run.headSha);
    varchar(run.headBranch);
    integer(run.prNumber);
    varchar(botName);
    varchar(projectName);
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
    appender.appendDefault();
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
