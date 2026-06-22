# ## Outcome

# Plan: Improve `factory report` Cost Readability

## Intent

Make `factory report` easier to scan for token-cost intuition without changing telemetry collection, storage, lifecycle behavior, command routing, or pricing semantics.

The report should show:

- Total input tokens
- Total output tokens
- Combined total tokens
- Median total tokens per task
- One per-stage table combining token usage and time
- Stage rows ordered by total tokens descending

Token usage remains the cost proxy. Do not add dollar estimates, pricing config, schema changes, or new telemetry.

## Design Decisions

Use existing recorded telemetry as the only source of truth.

Do not touch agent usage parsing, conductor metering, CLI routing, config, storage layout, or task lifecycle behavior.

Keep top-level token totals run-based, from the `runs` table:

- `SUM(in_tokens)`
- `SUM(out_tokens)`
- combined total derived as `input + output`

Keep median token behavior unchanged:

- Median over `SUM(in_tokens + out_tokens) GROUP BY task`

Use a single combined stage aggregate from the `stages` table:

- stage
- input tokens
- output tokens
- total tokens
- elapsed milliseconds

Order stages by:

```sql
ORDER BY totalTokens DESC, stage ASC
```

The secondary `stage ASC` sort prevents low-token or zero-token rows from flickering between report runs.

Compute per-stage percentage columns from the displayed stage rows:

- `token share = stage.totalTokens / sum(displayed stage totalTokens)`
- `time share = stage.ms / sum(displayed stage ms)`

This makes the combined table internally coherent: both percentage columns describe the share of the rows being shown. If the denominator is zero, render the share as `—`. A normal zero-token `verify` row with nonzero stage-token denominator should render `0%`.

Preserve existing report degradation behavior:

- Missing telemetry DB still prints the existing “no telemetry yet” message.
- Read failures warn and return.
- Report read failures must never reset, delete, or recreate telemetry.
- No stage rows means omit the stage table.

Preserve existing report metrics:

- first-pass yield
- escalation rate
- blocked rate
- retry success
- outcomes
- cycle-time median
- median tokens per task

## Files

### `src/metrics.ts`

Add an explicit stage report type:

```ts
export type ReportStage = {
  stage: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  ms: number
}
```

Update `Report` so token fields are split by input/output and stages are combined:

```ts
export type Report = {
  tasks: number
  runs: number
  outcomes: { outcome: string; count: number }[]
  implementRuns: number
  firstPassYield: number | null
  escalations: number
  escalationRate: number | null
  blockedRate: number | null
  retryRuns: number
  retrySuccess: number | null
  inputTokensTotal: number
  outputTokensTotal: number
  tokensMedianPerTask: number | null
  stages: ReportStage[]
  cycleMedianMs: number | null
}
```

Remove the separate stage arrays from the report shape:

```ts
stageTokens
stageMs
```

In `readReport`, replace the old combined token total query with separate totals:

```sql
SELECT COALESCE(SUM(in_tokens), 0) c FROM runs
SELECT COALESCE(SUM(out_tokens), 0) c FROM runs
```

Keep the existing median-per-task query semantics unchanged.

Replace the separate stage token/time queries with one aggregate:

```sql
SELECT
  stage,
  COALESCE(SUM(in_tokens), 0) inputTokens,
  COALESCE(SUM(out_tokens), 0) outputTokens,
  COALESCE(SUM(in_tokens + out_tokens), 0) totalTokens,
  COALESCE(SUM(ms), 0) ms
FROM stages
GROUP BY stage
ORDER BY totalTokens DESC, stage ASC
```

Keep readonly DB open/close behavior unchanged.

### `src/view.ts`

Extract successful report rendering into a pure helper:

```ts
export function formatReport(report: Report): string[]
```

`printReport(ctx)` should remain responsible for:

- locating the telemetry DB
- missing DB behavior
- catching read errors
- handling `readReport(...) === null`
- logging lines

After reading a report successfully:

```ts
for (const line of formatReport(report)) {
  log.log(line)
}
```

Update the top-level cost line to include input, output, total, and median:

```text
cost             input 12.3k tok · output 4.5k tok · total 16.8k tok · median 8.4k tok/task
```

The combined total should be derived in rendering from:

```ts
report.inputTokensTotal + report.outputTokensTotal
```

Replace the old sections:

```text
tokens by stage:
time by stage:
```

with one table:

```text
stage cost and time:
  stage          input  output   total  token %    time  time %
  implement       8.0k    2.0k   10.0k      63%     40s     50%
```

Rendering rules:

- Use `report.stages` order directly.
- Omit the stage table when there are no stages.
- Use existing helpers such as `tokens`, `durMs`, and `pctOf`.
- Keep columns aligned with explicit padding.
- Render zero-token time-only rows, such as `verify`, normally.
- If total displayed stage tokens are zero, token share renders as `—`.

### `tests/metrics.test.ts`

Add focused aggregation tests using a temporary metrics DB, `recordRun`, and `readReport`.

Cover:

- Separate input and output run-token totals.
- Combined total remains derivable as `input + output`.
- Median total tokens per task is still computed over grouped task totals.
- Stage rows aggregate duplicate stage names into one record.
- Stage rows include input tokens, output tokens, total tokens, and milliseconds.
- Stage rows are ordered by `totalTokens DESC, stage ASC`.
- A zero-token time-only stage such as `verify` is preserved.
- At least one existing report metric, such as outcomes or first-pass yield, still behaves as before.

Do not add brittle tests around nonexistent DB paths in `readReport`; missing-file behavior belongs to `printReport`.

### `tests/report-view.test.ts`

Add pure rendering tests for `formatReport`.

Use a handcrafted `Report` object.

Assert:

- The cost line includes input tokens, output tokens, combined total tokens, and median tokens per task.
- The output contains one `stage cost and time:` section.
- The output does not contain `tokens by stage:` or `time by stage:`.
- The table header includes stage, input, output, total, token share, time, and time share.
- At least one representative row is asserted exactly enough to catch alignment regressions.
- A zero-token `verify` row renders with `0` token counts, `0%` token share when the denominator is nonzero, and nonzero time.

### `README.md`

Update only the `factory report` documentation.

Say the report includes:

- first-pass yield
- escalation rate
- blocked rate
- retry success
- token-cost proxy using total input tokens, total output tokens, combined total tokens, and median total tokens per task
- median cycle time
- one per-stage table combining token usage and wall-clock time

Keep the existing explanation that dollar cost is not shown because the CLIs do not expose a consistent dollar figure.

## Verification

After implementation, ask for permission before running:

```sh
bun run test
```

That gate should cover Biome, TypeScript, and unit tests.
