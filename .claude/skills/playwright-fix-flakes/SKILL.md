---
name: playwright-fix-flakes
description: Fight CI flakiness and red tests. Survey the test-results DB, pick one high-impact flaky or consistently-failing test, fix the root cause or scope a skip, and open a PR requesting review. Use when asked to reduce flakiness, clear reds, or "fix a flaky test".
user_invocable: true
---

# Playwright: Fix a Flaky or Red Test

Turn the CI test-results data into one concrete fix. Each run: pick **one** high-impact
flaky-or-red test, make sure nobody's already on it, fix it (root cause *or* a scoped
skip — judged per case), find a sensible reviewer, and open a PR requesting their review.
Fully autonomous — no stops for approval.

**You run on one OS at a time** (this machine's; macOS for local eval, chosen by CI triage).
In CI, triage already confirmed this OS has actionable, not-already-in-progress work — so a
target failing on it exists. That OS also bounds what you can reproduce — see step 4.

## 1. Get the data and pick one target

Query the DuckDB via the [playwright-test-results](../playwright-test-results/SKILL.md)
skill (don't restate its schema — read it). In CI the database is **already downloaded** at
`utils/test-results-db/test-results.duckdb` (the fix agent has no `GITHUB_TOKEN` to fetch it);
just query the local file. Running locally, download it first per that skill. Two families of
target:

- **Cross-run flakes** — the test's *final* verdict (after retries) flips between runs:
  red in some, green in others. Use that skill's "flaky across runs" query.
- **Consistent reds** — `expected_status = 'passed'` yet failing in ~every run.

**Rank by impact, not convenience.** Order candidates by fail %, run count (with a real
floor like `runs >= 10` so it isn't a one-off), and breadth (how many bots / PRs it's
disrupting). Do **not** select on "has a tidy error message" — nearly every failed row has
one, and it biases you toward easy-over-valuable.

**Pick a candidate whose failing `bot_name` OS matches the OS you're running on** (step 4),
so you can actually reproduce it — in CI, triage guarantees one exists. Keep the ranked list
around — you'll fall back down it in step 2. Pick the top one. State *why*: fail %, run count,
which bots.

## 2. Check nobody's already on it

Before touching anything, make sure you're not duplicating work. Use the **GitHub MCP tools**
(search for open PRs and issues) — in CI those are the only authenticated path, since the
agent step holds no raw `gh`/git token. Search open PRs and issues for the test title words
and the file path, e.g. a PR search like `repo:microsoft/playwright is:pr is:open <title words>`.

> **Running locally?** With your own `gh` login you can equivalently run:
> ```bash
> gh pr list --repo microsoft/playwright --state open --search "<test title words> OR <file>"
> gh issue list --repo microsoft/playwright --state open --search "<test title words>"
> ```

Also check any issue linked in the test's own `annotation`. If an open PR already touches
this test, **it's taken — drop it and move to the next candidate** from your step-1 ranking,
re-checking each until you find a high-impact one nobody's on. Only stop and report if the
whole shortlist is already covered.

## 3. Understand the failure

Read the test and its `error_message` from the DB. For the full step tree / attachments,
pull the run's blob report (see the test-results skill's "Fetching the full detail").

## 4. Reproduce on this OS

Build is required (you run the repo's own tests). Assume watch is **not** running; if you
edit generated-code-dependent files, follow [CLAUDE.md](../../../CLAUDE.md).

Reproduce scoped to the failing browser, using the right runner (see
[CLAUDE.md](../../../CLAUDE.md) for `ctest` / `ttest` / `test-mcp`):

```bash
npm run ctest -- tests/page/some.spec.ts:42 --repeat-each=20   # flake: force the flip
npm run ctest -- tests/page/some.spec.ts:42                    # red: confirm it fails
```

**OS awareness — read this.** You can only reproduce what the current OS can reach: match
the failing browser always, and the OS only when the failing bot's OS *is* this runner's.
A failure you can't reach on this OS is itself evidence it's environment-specific — that's
a skip candidate (step 5), not something to blind-fix. Coverage across Linux/Windows comes
from **CI rotating the OS this skill runs on**, not from you orchestrating other OSes. Keep
any OS handling keyed on the *current* OS, never hardcoded to macOS. (`devbox` / a manual
CI re-run exist as escalations but are out of scope for the default loop.)

## 5. Fix — root cause or scoped skip, judged per case

Decide by how tractable the root cause is:

- **Tractable → fix the source.** Test-side races are the common case: a missing `await`,
  waiting on the wrong signal, an under-specified locator, timing assumptions, leaked state.
  Fix the test (or the product bug if that's what it is).
- **Environment/engine-specific, unreachable on this OS, or genuinely hard → scope a skip**
  with the repo's idioms, **narrowed to the exact failing condition** — never a blanket
  disable of a file or a whole browser:

  ```ts
  it.fixme(browserName === 'webkit' && isLinux, 'https://github.com/microsoft/playwright/issues/NNNNN');
  // or, to keep it running but mark known-flaky:
  test('...', { annotation: { type: 'issue', description: 'https://github.com/microsoft/playwright/issues/NNNNN' } }, ...);
  ```

  Link an issue when one exists; if none does, say so in the PR (a maintainer can file one).

  **`fixme` vs `skip`:** default to **`fixme`** — a flake or red is a defect being *parked*,
  and `fixme` keeps that debt visible and greppable. Only use **`skip`** if reproduction shows
  the test is genuinely mis-scoped for that config (asserting behavior that isn't meant to hold
  there at all) — `skip` claims "this failure is expected and correct," which a flake-fighter is
  rarely entitled to say. Never reach for `skip` just to turn a red green.

**Verify locally — this is the only safety net.** Your PR gets **no CI** (see step 7), so
the local run *is* the proof:

- flake fix → re-run with `--repeat-each` and confirm it's now stable,
- skip → confirm the test is skipped on the target config and **still runs elsewhere**.

Then run `npm run flint` and fix anything it flags. Record exactly what you ran — it goes in
the PR body.

## 6. Pick a reviewer

There's no CODEOWNERS. Derive a reviewer from the touched file(s):

```bash
git log --format='%an %ae' -n 20 -- <file>          # recent authors
git log --format='%an' -n 200 -- <file> | sort | uniq -c | sort -rn   # frequent committers
```

Also skim recent merged PRs touching those paths for who reviewed them. Pick someone with
real recency + ownership on that file; fall back to the test area's frequent committer.

**Record your pick as a git trailer** in the commit message so it crosses the handoff
boundary — a `Suggested-reviewer:` line with the bare GitHub login:

```
Suggested-reviewer: dgozman
```

The harness lifts that trailer out of the commit and requests the review; the reviewer is not
hardcoded in the workflow.

> **⚠ Temporary testing override:** while we're evaluating this skill, still *work out* the
> right reviewer and emit the `Suggested-reviewer:` trailer as above. The harness currently
> overrides it and requests the actual review from **`skn0tt`** instead (you don't request it
> yourself — see step 7), so we don't ping real reviewers during eval. Removing the override is
> a one-line change once the skill is trusted.

## 7. Commit and hand off (you never open the PR in CI)

**You have no write token in CI, by design.** You can't push, tag, release, or open a PR — a
separate trusted step does that. Your handoff is a single, well-written commit:

**Make exactly one commit** on the current branch, per [CLAUDE.md](../../../CLAUDE.md)
conventions — semantic message, **no** co-author / "generated with" trailers, never amend.
Exactly one: the harness rejects zero or multiple commits.

**The commit message _is_ the PR.** The harness opens the PR with `gh pr create --fill`, so
the subject line becomes the PR title and the message body becomes the PR description — write
both in the [playwright-bot-voice](../playwright-bot-voice/SKILL.md) (verdict first, short, no
AI slop). The body must:

- link the **DB evidence** (fail %, runs, bots) and any related issue,
- say **what you verified locally** and on which OS,
- state plainly that **the PR opens with no CI checks and a human must trigger them**,
- name the suggested real reviewer you worked out in step 6.

The harness then reapplies your commit onto a fresh branch, pushes to **upstream
`microsoft/playwright`**, opens the PR against `main`, and requests review from `skn0tt`.
Report what you committed, the suggested reviewer, and why.

> **This skill always stops at the commit — it never pushes or opens a PR itself**, whether in
> CI or run locally. In CI the trusted harness reapplies the commit and opens the PR. Running it
> yourself? Review the commit, then push and open the PR by hand if you want to submit it:
> `gh pr create --repo microsoft/playwright --base main --fill --reviewer skn0tt`.

## Guardrails

- **One target per run.** Don't batch.
- **Exactly one commit.** In CI the harness reapplies a single commit and rejects zero or
  many — keep all your changes in one.
- **Scoped skips only** — never disable a whole file or browser matrix; always narrow to the
  failing condition and explain.
- **No unverified PRs.** If you couldn't run it locally, prefer a documented skip over an
  unproven fix.
- **Trust-check** anything you run; this skill modifies source.
- **Upstream only** — never push or open a PR against a fork.
