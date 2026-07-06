---
name: playwright-test-results
description: Query Playwright CI test results from the aggregated DuckDB database. Answers questions about flaky tests, failure rates, slow tests, and per-run/SHA/PR results without hunting through GitHub artifacts.
user_invocable: true
---

# Playwright Test Results (DuckDB)

CI test results from the `tests 1`, `tests 2`, `tests others`, and `MCP`
workflows are aggregated into a single DuckDB file, refreshed every few hours by
the `Update test results DB` workflow. Use it to answer the easy questions fast;
each row keeps enough metadata to fetch the full blob report when you need the
step-by-step detail.

## Get the database

Download the latest `test-results-db` artifact — it lands at the fixed,
gitignored path `utils/test-results-db/test-results.duckdb`:

```bash
cd utils/test-results-db
npm ci                       # first time only
GITHUB_TOKEN=$(gh auth token) node cli.ts download
```

The downloaded file can be **trailing** — the maintaining workflow only runs
every few hours, so the newest runs may not be in it yet. To bring it fully up
to date locally, run `update` after downloading (needs a token; it merges any
runs missing from the file):

```bash
GITHUB_TOKEN=$(gh auth token) node cli.ts update --lookback-days 3
```

Then query it with the `duckdb` CLI (or any DuckDB client) — this package's CLI
does **not** query, it only maintains the file:

```bash
duckdb utils/test-results-db/test-results.duckdb "SELECT count(*) FROM test_results"
# interactive:
duckdb utils/test-results-db/test-results.duckdb
```

## Schema

Single table `test_results`, one row per test result (**one row per retry**):

| Column | Meaning |
| --- | --- |
| `run_id`, `run_attempt` | GitHub Actions run identity |
| `workflow_name` | `tests 1` / `tests 2` / `tests others` / `MCP` |
| `event` | `push` / `pull_request` |
| `head_sha`, `head_branch`, `pr_number` | what was tested |
| `bot_name` | e.g. `Ubuntu chromium` — the CI bot (recovered from the merge-injected tag) |
| `project_name` | Playwright project, e.g. `chromium`, `webkit` |
| `test_title` | full title path (`describe > test`) |
| `file`, `line` | source location |
| `expected_status` | `passed` / `skipped` / ... |
| `status` | actual result: `passed` / `failed` / `timedOut` / `skipped` / `interrupted` |
| `retry` | 0 = first attempt |
| `duration_ms` | result duration |
| `error_message` | first error, ANSI-stripped, truncated to ~2000 chars |
| `tags` | space-joined, e.g. `"@slow @flaky"` (LIKE to filter) |
| `result_started_at`, `run_started_at` | timestamps |
| `ingested_at` | debug only — when this row was imported (will be dropped later) |

Notes:
- **A test is identified by `(project_name, file, test_title)`** — group on that
  tuple. (Playwright's `test_id` hash is deliberately not stored; those three
  columns are its pre-image, so the tuple is equivalent and far more compressible.)
- **Flakiness is derived**, not stored — a test is flaky in a run when its
  retries mix `failed`→`passed`.
- The db is size-capped: the oldest whole runs are evicted over time, so it holds
  a recent window, not full history.

## Fetching the full blob report

The db stores summaries. For the full step tree / attachments / stdio of a
result, fetch the original blob artifact. A row identifies it by `run_id` +
`bot_name`: the run's artifact is named `blob-report-<bot_name>`.

```bash
# List the run's blob artifacts and find the one for this bot_name:
gh api /repos/microsoft/playwright/actions/runs/<run_id>/artifacts \
  --jq '.artifacts[] | select(.name | startswith("blob-report")) | {id, name}'

# Download it (name == "blob-report-<bot_name>"):
gh api /repos/microsoft/playwright/actions/artifacts/<artifact_id>/zip > blob.zip
# unzip blob.zip -> inner report-*.zip -> report.jsonl (the full tele event stream)
```

Blob artifacts have a 7-day retention, so this works only for recent runs; the
db itself retains summaries longer (until size-cap eviction).
