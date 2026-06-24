import { mkdir } from 'node:fs/promises'
import { type AgentResult, agentLabel, runAgent } from './agents.ts'
import type { Agent, WorkContext } from './config.ts'
import { run } from './exec.ts'
import { commitAll, commitDiff, currentBranch, hasChanges, headSha, worktreeDiff } from './git.ts'
import { emit } from './hooks.ts'
import { appendCandidate, readLessons } from './lessons.ts'
import { log } from './log.ts'
import {
  parseConvergenceVerdict,
  parseReconcileDecision,
  parseRemedy,
  parseReviewVerdict,
  parseShip,
  parseTriage,
} from './markers.ts'
import { recordRun, type StageStat } from './metrics.ts'
import { resolveOnComplete } from './on-complete.ts'
import {
  consolidatePrompt,
  convergePrompt,
  critiquePrompt,
  deploySafetyPrompt,
  feedbackAnalysisPrompt,
  feedbackPrompt,
  fixPrompt,
  implementPrompt,
  type Labeled,
  namePrompt,
  planPrompt,
  planRiskPrompt,
  postmortemPrompt,
  reconcilePrompt,
  remediatePrompt,
  researchPrompt,
  reviewPrompt,
  revisePrompt,
  riskReviewPrompt,
  securityPrompt,
  selectPrompt,
  sharpenPrompt,
  sharpenReviewPrompt,
  shipPrompt,
  triagePrompt,
  uxPlanCritiquePrompt,
  uxReviewPrompt,
} from './prompts.ts'
import {
  formatQuestions,
  parseQuestions,
  parseReview,
  parseSharpen,
  type SharpenResult,
  type Turn,
} from './sharpen.ts'
import {
  appendFailure,
  type Failure,
  markFeedbackConsumed,
  pendingFeedbackCount,
  readAnswers,
  readArtifact,
  readFailures,
  readIntent,
  readPendingFeedback,
  readPlan,
  readySharpenedTask,
  refreshFeedbackState,
  refreshMeta,
  saveMeta,
  setStatus,
  type Task,
  type TaskComplexity,
  writeArtifact,
  writeLiveMeter,
} from './task.ts'

export type TaskOutcome =
  | { ok: true }
  | { ok: false; kind: 'blocked'; reason: string; detail?: string }
  | { ok: false; kind: 'needs-input'; questions: string }
  | { ok: false; kind: 'retrying'; reason: string; retryAt: string; autoRetries: number }

// Print a descriptive stage header and emit the `stage.change` hook, so the pane
// explains what's happening and the environment (e.g. tmux) can reflect the stage.
async function progress(ctx: WorkContext, task: Task, stage: string, desc: string): Promise<void> {
  log.step(`${task.id}: ${desc}`)
  await emit(ctx.root, ctx.config.hooks, 'stage.change', { task: task.id, stage, active: true })
}

function fmtSecs(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

// Per-task running tally of tokens + wall time, plus a per-stage breakdown that
// feeds the telemetry record (one StageStat per agent call + the verify run).
type Meter = {
  task: Task
  inTok: number
  outTok: number
  startedAt: number
  stages: StageStat[]
  writeSeq: Promise<void>
}
function newMeter(task: Task): Meter {
  return {
    task,
    inTok: 0,
    outTok: 0,
    startedAt: Date.now(),
    stages: [],
    writeSeq: Promise.resolve(),
  }
}

async function persistLiveMeter(meter: Meter): Promise<void> {
  const snapshot = {
    startedAt: new Date(meter.startedAt).toISOString(),
    updatedAt: new Date().toISOString(),
    inputTokens: meter.inTok,
    outputTokens: meter.outTok,
    stages: meter.stages.map((s) => ({ ...s })),
  }
  const write = meter.writeSeq.then(async () => {
    try {
      await writeLiveMeter(meter.task, snapshot)
    } catch (err) {
      const msg = err instanceof Error ? err.message : err
      log.warn(`live meter failed for ${meter.task.id}: ${msg}`)
    }
  })
  meter.writeSeq = write
  await write
}

// A long stage is a single await with no output until it finishes, so it can
// look hung. Show a single in-place line that ticks elapsed time while any stage
// runs — it overwrites itself (no scrolling), and concurrent agents (the parallel
// planners) share ONE line. Permanent lines (the ✓ completions) print above it.
const HEARTBEAT_MS = 1000
const running = new Map<number, { label: string; start: number }>()
let beatId = 0
let beatTimer: ReturnType<typeof setInterval> | null = null

function renderBeat(): void {
  if (running.size === 0) {
    return
  }
  const now = Date.now()
  const parts = [...running.values()].map((r) => `${r.label} ${fmtSecs(now - r.start)}`)
  log.status(`  · working… ${parts.join(' · ')}`)
}

async function withHeartbeat<T>(label: string, start: number, work: Promise<T>): Promise<T> {
  const id = beatId++
  running.set(id, { label, start })
  if (!beatTimer) {
    beatTimer = setInterval(renderBeat, HEARTBEAT_MS)
  }
  renderBeat()
  try {
    return await work
  } finally {
    running.delete(id)
    if (running.size === 0) {
      if (beatTimer) {
        clearInterval(beatTimer)
      }
      beatTimer = null
      log.clearStatus()
    } else {
      renderBeat()
    }
  }
}

// Run an agent call; on return, print a completion line with elapsed time and
// token usage (so a long stage shows steady progress), tally it (totals +
// per-stage), hand back text.
async function agentStep(
  meter: Meter,
  stage: string,
  label: string,
  work: Promise<AgentResult>,
  // Live-display name only (heartbeat + done line). Defaults to the agent label;
  // override to disambiguate concurrent same-agent steps (e.g. the review panel,
  // where every expert is the same reviewer agent). The stored `agent` metric
  // stays the bare agent label so per-agent stats aren't fragmented by role.
  display: string = label
): Promise<string> {
  const start = Date.now()
  const { text, usage } = await withHeartbeat(display, start, work)
  const ms = Date.now() - start
  meter.inTok += usage.inputTokens
  meter.outTok += usage.outputTokens
  meter.stages.push({
    stage,
    agent: label,
    inTok: usage.inputTokens,
    outTok: usage.outputTokens,
    ms,
  })
  await persistLiveMeter(meter)
  log.done(
    `${display} ${fmtSecs(ms)} · ${fmtTok(usage.inputTokens)}→${fmtTok(usage.outputTokens)} tok`
  )
  return text
}

function logTotal(meter: Meter): void {
  log.info(
    `task total · ${fmtTok(meter.inTok)}→${fmtTok(meter.outTok)} tok · ${fmtSecs(Date.now() - meter.startedAt)}`
  )
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? text.trim()
  )
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : 'plan'
}

type FeedbackContext = {
  count: number
  raw: string
  analysis: string
}

async function analyzeFeedbackIfPending(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  intent: string,
  finalPlan: string
): Promise<FeedbackContext | null> {
  if (pendingFeedbackCount(task) === 0) {
    return null
  }
  const raw = await readPendingFeedback(task)
  if (!raw) {
    return null
  }
  await progress(ctx, task, 'feedback', 'feedback — generalizing your feedback')
  const analysis = await agentStep(
    meter,
    'feedback',
    agentLabel(ctx.agents.implementer),
    runAgent(ctx.agents.implementer, {
      root: ctx.root,
      prompt: feedbackAnalysisPrompt(intent, raw, await worktreeDiff(ctx.root), finalPlan),
      access: 'read',
      outFile: `${task.dir}/human-feedback.analysis.md`,
    })
  )
  return { count: task.meta.feedbackCount, raw, analysis }
}

// A model id (e.g. "grok-4", "anthropic/claude-x") made filesystem/label-safe.
function labelSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9.-]+/g, '-').replace(/^-+|-+$/g, '')
}

// Filesystem/label-safe names for the planner ensemble. When several planners
// share a cli (e.g. two codex backends on different providers), the model name
// disambiguates the artifacts (plan.grok-4.md vs plan.codex.md) — far more legible
// than codex-1/codex-2; a -N suffix is the final fallback for any collision.
function plannerLabels(planners: Agent[]): string[] {
  const cliCount = new Map<string, number>()
  for (const a of planners) {
    cliCount.set(a.cli, (cliCount.get(a.cli) ?? 0) + 1)
  }
  const bases = planners.map((a) =>
    (cliCount.get(a.cli) ?? 0) > 1 && a.model ? labelSafe(a.model) : a.cli
  )
  const baseCount = new Map<string, number>()
  for (const b of bases) {
    baseCount.set(b, (baseCount.get(b) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  return bases.map((b) => {
    if ((baseCount.get(b) ?? 0) === 1) {
      return b
    }
    const n = (seen.get(b) ?? 0) + 1
    seen.set(b, n)
    return `${b}-${n}`
  })
}

// Run-level facts for the telemetry record, mutated as the task progresses so
// whatever terminal path fires has the current values.
type RunStats = {
  triage: 'trivial' | 'complex' | null
  retries: number
  verifyFirstTry: boolean | null
}

export type ComplexityDecision =
  | { source: 'declared'; trivial: boolean; complexity: TaskComplexity }
  | { source: 'triage' }
  | { source: 'none' }

export function decideComplexity(
  declared: TaskComplexity | null,
  triageEnabled: boolean
): ComplexityDecision {
  if (declared === 'trivial') {
    return { source: 'declared', trivial: true, complexity: declared }
  }
  if (declared === 'complex') {
    return { source: 'declared', trivial: false, complexity: declared }
  }
  return triageEnabled ? { source: 'triage' } : { source: 'none' }
}

// Persist one telemetry record for this pass. Best-effort: recordRun never throws,
// so a telemetry failure can't break the task.
function recordTask(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  outcome: 'done' | 'blocked' | 'needs-input',
  stats: RunStats
): void {
  recordRun(ctx.metricsPath, {
    task: task.id,
    ts: new Date().toISOString(),
    createdAt: task.meta.createdAt,
    outcome,
    triage: stats.triage,
    retries: stats.retries,
    verifyFirstTry: stats.verifyFirstTry,
    ms: Date.now() - meter.startedAt,
    inTokens: meter.inTok,
    outTokens: meter.outTok,
    stages: meter.stages,
  })
}

// A blocked outcome also drops a raw signal into the lesson candidates, so
// recurring failure modes become visible for the meta loop.
async function blocked(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  stats: RunStats,
  reason: string,
  detail?: string
): Promise<TaskOutcome> {
  logTotal(meter)
  recordTask(ctx, task, meter, 'blocked', stats)
  await postmortem(ctx, task, meter, reason)
  return { ok: false, kind: 'blocked', reason, detail }
}

// Diagnose a block: write a postmortem (a fast human-triage briefing) and append a
// distilled, generalizable lesson candidate — richer than the raw block reason, and
// classified by root cause. Best-effort: any failure (or postmortem disabled)
// falls back to the raw signal so the candidate is always recorded.
async function postmortem(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  reason: string
): Promise<void> {
  if (!ctx.config.postmortem) {
    await appendCandidate(ctx, `blocked · ${task.id} · ${reason}`)
    return
  }
  try {
    const intent = await readIntent(task)
    const history = (await readFailures(task)).map((f) => `${f.gate}: ${f.summary}`)
    const diff = await worktreeDiff(ctx.root)
    const out = await agentStep(
      meter,
      'postmortem',
      agentLabel(ctx.agents.reviewer),
      runAgent(ctx.agents.reviewer, {
        root: ctx.root,
        prompt: postmortemPrompt(intent, history, diff, reason),
        access: 'read',
        outFile: `${task.dir}/postmortem.md`,
      })
    )
    const category = /CATEGORY:\s*(\w+)/i.exec(out)?.[1]?.toLowerCase() ?? 'other'
    const lesson = /LESSON:\s*(.+)/i.exec(out)?.[1]?.trim()
    await appendCandidate(
      ctx,
      lesson ? `blocked · ${task.id} · [${category}] ${lesson}` : `blocked · ${task.id} · ${reason}`
    )
  } catch (err) {
    log.warn(`postmortem failed for ${task.id}: ${err instanceof Error ? err.message : err}`)
    await appendCandidate(ctx, `blocked · ${task.id} · ${reason}`)
  }
}

// Auto-resume policy for TRANSIENT gate failures (verify, ship): rather than
// hard-block, set the task aside with a growing backoff so the run loop retries it
// — up to AUTO_CAP times — letting an env/CI flake recover with no human action.
// Once the cap is spent it escalates to a real block (the attention signal). Code-
// judgment gates (review, security) never come here — they block immediately.
export const AUTO_CAP = 5
const BACKOFF_MS = [120_000, 300_000, 900_000, 1_800_000, 3_600_000] // 2m, 5m, 15m, 30m, 60m
function backoffMs(n: number): number {
  return BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)] ?? 3_600_000
}

async function setAside(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  stats: RunStats,
  reason: string,
  detail?: string
): Promise<TaskOutcome> {
  if (task.meta.autoRetries >= AUTO_CAP) {
    return await blocked(
      ctx,
      task,
      meter,
      stats,
      `${reason} (gave up after ${AUTO_CAP} auto-retries)`,
      detail
    )
  }
  logTotal(meter)
  const retryAt = new Date(Date.now() + backoffMs(task.meta.autoRetries)).toISOString()
  return { ok: false, kind: 'retrying', reason, retryAt, autoRetries: task.meta.autoRetries + 1 }
}

// After a gate failure, decide whether to keep fixing. Replaces a blind retry
// count: a convergence judge reads the whole failure history and says CONTINUE
// (genuinely new problem — progress) or STUCK (same root cause recurring /
// oscillating). The failure is logged either way (so the history spans resumes and
// feeds the next fixer). `attempt` is 0-based; `hardCap` is the runaway backstop —
// at/over it we stop without judging (also covers the no-re-implement resume pass).
async function assessFailure(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  intent: string,
  failures: Failure[],
  attempt: number,
  hardCap: number,
  gate: string,
  detail: string
): Promise<'continue' | 'stop'> {
  if (attempt + 1 >= hardCap) {
    const entry: Failure = { attempt, gate, summary: firstLine(detail).slice(0, 200), detail }
    failures.push(entry)
    await appendFailure(task, entry)
    return 'stop'
  }
  const priorSummaries = failures.map((f) => `${f.gate}: ${f.summary}`)
  const judgment = await agentStep(
    meter,
    'converge',
    agentLabel(ctx.agents.reviewer),
    runAgent(ctx.agents.reviewer, {
      root: ctx.root,
      prompt: convergePrompt(intent, priorSummaries, detail),
      access: 'read',
      outFile: `${task.dir}/converge.md`,
    })
  )
  const summary = /SUMMARY:\s*(.+)/i.exec(judgment)?.[1]?.trim() || firstLine(detail).slice(0, 200)
  const verdict = parseConvergenceVerdict(judgment)
  const stuck = verdict !== 'CONTINUE'
  const entry: Failure = { attempt, gate, summary, detail }
  failures.push(entry)
  await appendFailure(task, entry)
  return stuck ? 'stop' : 'continue'
}

// How many rounds of automated ENVIRONMENT remediation a single verify gate will
// attempt before giving up. Env fixes (install deps, build, start a service) take
// one or two rounds; this caps a doctor that keeps claiming a fix while verify
// still fails the same way.
const REMEDIATE_CAP = 3

// The verdict from running the verify gate (with self-remediation):
//   pass  — verify succeeded (possibly after an environment repair).
//   code  — a real code/test defect → the code-fix loop (the historical path).
//   aside — a flake or an environment problem remediation couldn't fix → back off
//           and auto-retry; don't churn code over it.
type VerifyVerdict =
  | { kind: 'pass' }
  | { kind: 'code'; detail: string }
  | { kind: 'aside'; reason: string; detail: string }

// Run the task's verify command, with autonomous self-remediation. On failure a
// full-access "doctor" classifies the failure; when it's an ENVIRONMENT/setup
// problem (missing deps, an uninstalled tool — verify exits 127 — an un-run build,
// a service that's down) it repairs the environment in place and we re-run, WITHOUT
// touching the code or spending a code-fix attempt. A genuine code defect routes to
// the code-fix loop; a flake or an unfixable environment problem routes to the
// backoff retry. This is why a missing `node_modules` self-heals instead of burning
// the whole fix budget re-implementing code that was never the problem.
async function verifyGate(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  intent: string,
  verify: string
): Promise<VerifyVerdict> {
  const remedies: string[] = []
  while (true) {
    await setStatus(task, 'verifying')
    await progress(ctx, task, 'verify', `verify — ${verify}`)
    const vstart = Date.now()
    const result = await withHeartbeat(
      'verify',
      vstart,
      run(['bash', '-lc', verify], { cwd: ctx.root })
    )
    const vms = Date.now() - vstart
    meter.stages.push({ stage: 'verify', agent: '-', inTok: 0, outTok: 0, ms: vms })
    await persistLiveMeter(meter)
    log.done(`verify ${fmtSecs(vms)}`)
    await writeArtifact(task, 'verify.log', `$ ${verify}\n\n${result.stdout}\n${result.stderr}`)
    if (result.code === 0) {
      return { kind: 'pass' }
    }
    const detail = `Verify \`${verify}\` failed (exit ${result.code}):\n${`${result.stdout}\n${result.stderr}`.slice(-4000)}`
    if (!ctx.config.remediate || remedies.length >= REMEDIATE_CAP) {
      // Remediation disabled or exhausted: fall back to the historical behavior —
      // treat the failure as a code problem and let the code-fix loop have it.
      return { kind: 'code', detail }
    }
    // Diagnose, and (for environment problems) repair — full access so it can
    // install deps/tools, build, or start services.
    const n = remedies.length + 1
    await progress(
      ctx,
      task,
      'remediate',
      `remediate — diagnosing verify failure (${n}/${REMEDIATE_CAP})`
    )
    const out = await agentStep(
      meter,
      'remediate',
      agentLabel(ctx.agents.implementer),
      runAgent(ctx.agents.implementer, {
        root: ctx.root,
        prompt: remediatePrompt(intent, verify, detail, remedies),
        access: 'full',
        outFile: `${task.dir}/remediate${n > 1 ? `.${n}` : ''}.md`,
      })
    )
    const summary = /SUMMARY:\s*(.+)/i.exec(out)?.[1]?.trim() || firstLine(out).slice(0, 200)
    switch (parseRemedy(out)) {
      case 'ENV-FIXED':
        remedies.push(summary)
        continue // re-run verify against the repaired environment
      case 'FLAKE':
        return { kind: 'aside', reason: 'verify hit a transient/external flake', detail }
      case 'ENV-BLOCKED':
        return {
          kind: 'aside',
          reason: `verify blocked on an environment problem: ${summary}`,
          detail,
        }
      default:
        // CODE or an unparseable verdict → the code-fix loop (preserves the prior
        // default that a verify failure means the code needs fixing).
        return { kind: 'code', detail }
    }
  }
}

type PlanResult = { plan: string } | { pause: TaskOutcome }

// The planning ensemble: each planner drafts, they cross-critique (when ≥2), the
// lead reconciles (may pause for the human), planners revise, the lead selects.
async function planEnsemble(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  intent: string,
  verify: string | null,
  answers: string | null,
  lessons: string | null,
  userFacing: boolean
): Promise<PlanResult> {
  const planners = ctx.agents.planners
  const labels = plannerLabels(planners)
  const lead = ctx.agents.implementer
  const labeled = (texts: string[]): Labeled[] =>
    texts.map((text, i) => ({ label: labels[i] ?? `plan-${i + 1}`, text }))

  // 1. RESEARCH — one subagent gathers the factual groundwork (relevant code,
  // existing patterns, git history of the target areas, prior plans, gotchas)
  // so the whole ensemble plans from grounded facts, not assumptions.
  await setStatus(task, 'planning')
  await progress(ctx, task, 'research', 'research — mapping the relevant code & history')
  const research = await agentStep(
    meter,
    'research',
    agentLabel(lead),
    runAgent(lead, {
      root: ctx.root,
      prompt: researchPrompt(intent, verify, ctx.plansDir, userFacing),
      access: 'research',
      outFile: `${task.dir}/research.md`,
    })
  )

  // 2. PLAN — every planner drafts in parallel (read-only).
  await progress(ctx, task, 'plan', 'plan — drafting')
  const plans = await Promise.all(
    planners.map((agent, i) =>
      agentStep(
        meter,
        'plan',
        labels[i] ?? agent.cli,
        runAgent(agent, {
          root: ctx.root,
          prompt: planPrompt(intent, verify, answers, lessons, research, userFacing),
          access: 'read',
          outFile: `${task.dir}/plan.${labels[i]}.md`,
        })
      )
    )
  )

  // 3. CRITIQUE — each planner critiques the others' plans (only with ≥2).
  let critiques: string[] = []
  if (planners.length >= 2) {
    await progress(ctx, task, 'crit', 'critique — cross-reviewing the plans')
    critiques = await Promise.all(
      planners.map((agent, i) => {
        const others = plans.filter((_, j) => j !== i).join('\n\n---\n\n')
        return agentStep(
          meter,
          'critique',
          labels[i] ?? agent.cli,
          runAgent(agent, {
            root: ctx.root,
            prompt: critiquePrompt(intent, others, answers, lessons, research),
            access: 'read',
            outFile: `${task.dir}/critique.${labels[i]}.md`,
          })
        )
      })
    )
  }

  // 3.6 UX/IA CRITIQUE — for user-facing work, an independent design pass (the
  // reviewer agent) on the plan's information architecture and experience, separate
  // from the code critique. Flows into reconcile/revise/select like any critique.
  let uxCritique: string | null = null
  if (userFacing) {
    await progress(ctx, task, 'ux', 'ux — reviewing information architecture & UX')
    uxCritique = await agentStep(
      meter,
      'ux',
      agentLabel(ctx.agents.reviewer),
      runAgent(ctx.agents.reviewer, {
        root: ctx.root,
        prompt: uxPlanCritiquePrompt(intent, labeled(plans), research),
        access: 'read',
        outFile: `${task.dir}/ux.plan.md`,
      })
    )
  }
  const critiquesForReconcile: Labeled[] = uxCritique
    ? [...labeled(critiques), { label: 'ux/ia', text: uxCritique }]
    : labeled(critiques)

  // 3.5 RECONCILE — the lead decides proceed vs. pause for the human.
  await progress(ctx, task, 'recon', 'reconcile — proceed or ask?')
  const reconcile = await agentStep(
    meter,
    'reconcile',
    agentLabel(lead),
    runAgent(lead, {
      root: ctx.root,
      prompt: reconcilePrompt(intent, labeled(plans), critiquesForReconcile, answers),
      access: 'read',
      outFile: `${task.dir}/reconcile.md`,
    })
  )
  if (parseReconcileDecision(reconcile) === 'ASK') {
    const questions = reconcile.replace(/^\s*DECISION:\s*ASK\s*/i, '').trim() || reconcile
    await writeArtifact(task, 'questions.md', questions)
    await appendCandidate(ctx, `needs-input · ${task.id} · ${firstLine(questions)}`)
    logTotal(meter)
    return { pause: { ok: false, kind: 'needs-input', questions } }
  }

  // 4. REVISE — each planner improves its own plan using the critiques (≥2 only).
  let revised = plans
  if (planners.length >= 2) {
    await progress(ctx, task, 'revise', 'revise — improving each plan')
    const allCritiques =
      critiques.map((text, i) => `## Critique (${labels[i]})\n${text}`).join('\n\n') +
      (uxCritique ? `\n\n## Critique (ux/ia)\n${uxCritique}` : '')
    revised = await Promise.all(
      planners.map((agent, i) =>
        agentStep(
          meter,
          'revise',
          labels[i] ?? agent.cli,
          runAgent(agent, {
            root: ctx.root,
            prompt: revisePrompt(intent, plans[i] ?? '', allCritiques),
            access: 'read',
            outFile: `${task.dir}/plan.${labels[i]}.v2.md`,
          })
        )
      )
    )
  }

  // 5. SELECT — the lead picks or merges the final plan.
  await progress(ctx, task, 'select', 'select — choosing the final plan')
  const finalPlan = await agentStep(
    meter,
    'select',
    agentLabel(lead),
    runAgent(lead, {
      root: ctx.root,
      prompt: selectPrompt(intent, labeled(revised), uxCritique),
      access: 'read',
      outFile: `${task.dir}/plan.final.md`,
    })
  )
  return { plan: finalPlan }
}

type SharpenStageResult = { result: SharpenResult } | { pause: TaskOutcome }

function transcript(turns: Turn[]): string {
  return turns.map((t) => `${t.role}: ${t.text}`).join('\n\n')
}

function questionsOutcome(text: string): TaskOutcome {
  return { ok: false, kind: 'needs-input', questions: text }
}

async function finalizeSharpen(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  turns: Turn[],
  fallback: SharpenResult
): Promise<SharpenResult> {
  await progress(ctx, task, 'sharpen', 'sharpen — finalizing spec')
  const out = await agentStep(
    meter,
    'sharpen',
    agentLabel(ctx.agents.implementer),
    runAgent(ctx.agents.implementer, {
      root: ctx.root,
      prompt: sharpenPrompt(transcript(turns), true),
      access: 'read',
      outFile: `${task.dir}/sharpen.final.md`,
    })
  )
  const parsed = parseSharpen(out)
  if (!parsed.ready || !parsed.spec) {
    log.warn('sharpen: could not synthesize a spec — keeping the original intent')
    return fallback
  }
  return { intent: parsed.spec, verify: parsed.verify ?? fallback.verify }
}

async function reviewSharpenSpec(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  turns: Turn[],
  spec: SharpenResult
): Promise<SharpenStageResult> {
  await progress(ctx, task, 'sharpen', 'sharpen — checking spec')
  const out = await agentStep(
    meter,
    'sharpen-review',
    agentLabel(ctx.agents.reviewer),
    runAgent(ctx.agents.reviewer, {
      root: ctx.root,
      prompt: sharpenReviewPrompt(transcript(turns), spec.intent, spec.verify),
      access: 'read',
      outFile: `${task.dir}/sharpen.review.md`,
    })
  )
  const review = parseReview(out)
  if (review.kind === 'pass') {
    return { result: spec }
  }
  if (review.kind === 'questions') {
    const questions = formatQuestions(review.preamble, review.questions)
    await writeArtifact(task, 'questions.md', questions)
    await appendCandidate(ctx, `needs-input · ${task.id} · ${firstLine(questions)}`)
    return { pause: questionsOutcome(questions) }
  }
  turns.push({
    role: 'reviewer',
    text: `Internal spec review asked for a revision before planning:\n\n${review.message}`,
  })
  return { result: await finalizeSharpen(ctx, task, meter, turns, spec) }
}

async function runSharpenStage(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  intent: string,
  verify: string | null,
  answers: string | null
): Promise<SharpenStageResult> {
  await setStatus(task, 'sharpening')
  await progress(ctx, task, 'sharpen', 'sharpen — refining intent')
  const turns: Turn[] = [{ role: 'human', text: intent }]
  if (answers) {
    turns.push({ role: 'human', text: `Answers already provided:\n\n${answers}` })
  }
  const out = await agentStep(
    meter,
    'sharpen',
    agentLabel(ctx.agents.implementer),
    runAgent(ctx.agents.implementer, {
      root: ctx.root,
      prompt: sharpenPrompt(transcript(turns), false),
      access: 'read',
      outFile: `${task.dir}/sharpen.md`,
    })
  )
  turns.push({ role: 'agent', text: out })

  const parsed = parseSharpen(out)
  let candidate: SharpenResult
  if (parsed.ready && parsed.spec) {
    candidate = { intent: parsed.spec, verify: parsed.verify ?? verify }
  } else {
    const { preamble, questions } = parseQuestions(out)
    if (questions.length > 0) {
      const questionText = formatQuestions(preamble, questions)
      await writeArtifact(task, 'questions.md', questionText)
      await appendCandidate(ctx, `needs-input · ${task.id} · ${firstLine(questionText)}`)
      return { pause: questionsOutcome(questionText) }
    }
    candidate = await finalizeSharpen(ctx, task, meter, turns, { intent, verify })
  }

  return reviewSharpenSpec(ctx, task, meter, turns, candidate)
}

// Run a single task. A trivial task (per triage) takes the fast path — straight
// to implement — while a complex one goes through the full planning ensemble.
// Run a single task. A trivial task (per triage or declared metadata) takes the fast
// path — straight to implement — while a complex one goes through the full planning ensemble.
// Both are then reviewed, verified, committed, and (if configured) shipped.
export async function runTask(ctx: WorkContext, task: Task): Promise<TaskOutcome> {
  let intent = await readIntent(task)
  let verify = task.meta.verify
  const meter = newMeter(task)
  await persistLiveMeter(meter)
  const lead = ctx.agents.implementer
  const stats: RunStats = { triage: null, retries: 0, verifyFirstTry: null }

  const baselineDiff = await worktreeDiff(ctx.root)
  const baselineHasChanges = await hasChanges(ctx.root)
  await writeArtifact(task, 'baseline.patch', baselineDiff)
  if (baselineHasChanges) {
    log.warn(
      `${task.id}: worktree already has changes; factory will review and commit the whole worktree`
    )
  }
  // Whether this task is user-facing (gates the UI/UX lenses). Set by triage on a
  // fresh run; derived from the existing diff on resume (triage doesn't re-run).
  let userFacing = false

  // RESUME — reuse the saved plan + the existing worktree and pick up where the
  // task left off, skipping the (expensive) planning ensemble. The marker + any
  // human note are consumed here, so a later re-run starts fresh again.
  const resuming = task.meta.resume
  const resumeKind = task.meta.resumeKind
  let resumeNote: string | null = null
  let finalPlan: string
  let riskAssessment: string | null = null
  if (resuming) {
    finalPlan = (await readPlan(task)) ?? intent
    riskAssessment = await readArtifact(task, 'risk.plan.md')
    resumeNote = task.meta.resumeNote
    task.meta.resume = false
    task.meta.resumeNote = null
    task.meta.resumeKind = null
    await saveMeta(task)
    log.info(
      `${task.id}: resuming — reusing plan + existing work${resumeNote ? ' (with your note)' : ''}`
    )
  } else {
    const answers = await readAnswers(task)
    const lessons = await readLessons(ctx)

    // 0. TRIAGE — classify the task; trivial ones skip the whole plan ensemble.
    let trivial = false
    const complexityDecision = decideComplexity(task.meta.complexity, ctx.config.triage)
    if (complexityDecision.source === 'declared') {
      trivial = complexityDecision.trivial
      const label = complexityDecision.complexity
      log.info(`${task.id}: ${label} — using declared complexity (skipping triage)`)
    } else if (complexityDecision.source === 'triage') {
      await progress(ctx, task, 'triage', 'triage — trivial or complex?')
      const verdict = await agentStep(
        meter,
        'triage',
        agentLabel(lead),
        runAgent(lead, {
          root: ctx.root,
          prompt: triagePrompt(intent, verify),
          access: 'read',
          outFile: `${task.dir}/triage.md`,
        })
      )
      const triage = parseTriage(verdict)
      trivial = triage.trivial
      stats.triage = trivial ? 'trivial' : 'complex'
      userFacing = ctx.config.ux && triage.userFacing
    }

    if (trivial && task.meta.sharpen === 'pending') {
      task.meta.sharpen = 'skipped'
      await saveMeta(task)
    }

    if (trivial) {
      log.info(`${task.id}: trivial — fast path (skipping the plan ensemble)`)
      finalPlan = intent
    } else {
      if (task.meta.sharpen === 'pending') {
        const sharpened = await runSharpenStage(ctx, task, meter, intent, verify, answers)
        if ('pause' in sharpened) {
          logTotal(meter)
          recordTask(ctx, task, meter, 'needs-input', stats)
          return sharpened.pause
        }
        await readySharpenedTask(task, sharpened.result.intent, sharpened.result.verify)
        intent = sharpened.result.intent
        verify = sharpened.result.verify
      }

      const planned = await planEnsemble(
        ctx,
        task,
        meter,
        intent,
        verify,
        answers,
        lessons,
        userFacing
      )
      if ('pause' in planned) {
        recordTask(ctx, task, meter, 'needs-input', stats)
        return planned.pause
      }
      finalPlan = planned.plan
    }

    if (!trivial) {
      await progress(ctx, task, 'risk', 'risk — scoring plan risk')
      riskAssessment = await agentStep(
        meter,
        'risk',
        agentLabel(ctx.agents.reviewer),
        runAgent(ctx.agents.reviewer, {
          root: ctx.root,
          prompt: planRiskPrompt(intent, finalPlan),
          access: 'read',
          outFile: `${task.dir}/risk.plan.md`,
        })
      )
    }

    // Write the clean final plan to the committed plans dir under a descriptive,
    // AI-summarized, number-free, collision-safe name. Skipped on the fast path.
    if (ctx.plansDir && !trivial) {
      await progress(ctx, task, 'name', 'name — summarizing the change for the plan filename')
      const suggested = await agentStep(
        meter,
        'name',
        agentLabel(lead),
        runAgent(lead, {
          root: ctx.root,
          prompt: namePrompt(intent, finalPlan),
          access: 'read',
        })
      )
      await mkdir(ctx.plansDir, { recursive: true })
      const base = slugify(firstLine(suggested) || task.id)
      let name = base
      for (let n = 2; await Bun.file(`${ctx.plansDir}/${name}.md`).exists(); n++) {
        name = `${base}-${n}`
      }
      // The selected plan is already the committed document; prepending the raw
      // task intent turns user prompts into awkward or invalid markdown headings.
      await Bun.write(`${ctx.plansDir}/${name}.md`, `${finalPlan.trim()}\n`)
    }

    // Persist the selected plan as a task artifact so a resume can reuse it.
    await writeArtifact(task, 'plan.md', finalPlan)
  }

  const feedbackContext = await analyzeFeedbackIfPending(ctx, task, meter, intent, finalPlan)

  // A resume whose work already committed only has delivery left — skip the build.
  if (resuming && task.meta.commit) {
    return shipAndFinish(ctx, task, intent, meter, stats)
  }

  // On resume, triage didn't run — derive user-facing from the existing diff so the
  // fix pass still gets the design-context note. (The UX review gate detects it too.)
  if (resuming && ctx.config.ux) {
    userFacing = uiInDiff(await worktreeDiff(ctx.root))
  }

  // 5–7. IMPLEMENT → REVIEW → VERIFY with auto-fix: on a failed gate, feed the
  // failure back into a fix pass. Termination is by the convergence judge (keep
  // going while failures are genuinely new, stop when stuck — see assessFailure),
  // with config.retries as the hard-cap backstop. Failures accumulate across the
  // whole task (loaded here so the history survives resumes) and feed the fixer.
  let attempt = 0
  const hardCap = ctx.config.retries
  const failures = await readFailures(task)
  // On resume with an existing diff, re-enter at the gates: run them against the
  // work already in the worktree, and only implement (a fix pass) if one fails.
  let skipImplement = resuming && (await hasChanges(ctx.root))
  // A note-less resume is a transient retry: re-run the gates on the existing diff
  // but DON'T re-implement (a verify env-flake mustn't churn code) — so jump to the
  // hard cap, letting any failure escalate at once (verify→backoff retry,
  // review-panel→block). A note means the human wants a change, so keep iterating.
  if (skipImplement && resumeKind === 'auto-retry' && !resumeNote && !feedbackContext) {
    attempt = hardCap
  }
  if (skipImplement && (resumeNote || feedbackContext)) {
    skipImplement = false
    attempt = Math.max(1, failures.length)
  }
  while (true) {
    stats.retries = attempt
    if (skipImplement) {
      skipImplement = false
    } else {
      await setStatus(task, 'implementing')
      const fixing = attempt > 0
      await progress(
        ctx,
        task,
        'impl',
        fixing ? `implement — fix attempt ${attempt}` : 'implement — writing code'
      )
      // Fix context: the most recent failure in full + the human's note (if any),
      // plus a summary of every earlier attempt so the fixer doesn't re-tread them.
      const latest = failures.at(-1)
      const parts: string[] = []
      if (latest) {
        parts.push(latest.detail)
      }
      if (resumeNote) {
        parts.push(`Human guidance on retry: ${resumeNote}`)
      }
      if (feedbackContext && !latest) {
        parts.push('Human feedback requires a follow-up fix pass.')
      }
      const failureCtx = parts.join('\n\n')
      const priorSummaries = failures.slice(0, -1).map((f) => `${f.gate}: ${f.summary}`)
      const stagePrompt = fixing
        ? fixPrompt(
            intent,
            finalPlan,
            failureCtx,
            priorSummaries,
            await worktreeDiff(ctx.root),
            userFacing,
            riskAssessment,
            feedbackContext?.analysis ?? null
          )
        : implementPrompt(
            intent,
            finalPlan,
            verify,
            userFacing,
            riskAssessment,
            feedbackContext?.analysis ?? null
          )
      await agentStep(
        meter,
        'implement',
        agentLabel(lead),
        runAgent(lead, {
          root: ctx.root,
          prompt: stagePrompt,
          access: 'write',
          outFile: `${task.dir}/implement.log.md`,
        })
      )

      if (!(await hasChanges(ctx.root))) {
        return blocked(ctx, task, meter, stats, 'implementation produced no changes')
      }
    }

    // REVIEW PHASE — a parallel panel of independent expert finders, consolidated
    // into ONE verdict + ONE fix list (mirrors the planning ensemble). Experts are
    // read-only and run concurrently; only the consolidator decides blocking vs
    // advisory, so adding an expert can't independently block or thrash. Verify
    // stays a separate objective gate after this.
    await setStatus(task, 'reviewing')
    const diff = await worktreeDiff(ctx.root)
    await writeArtifact(task, 'diff.patch', diff)
    const reviewer = ctx.agents.reviewer
    const panel: Array<{ key: string; label: string; prompt: string }> = [
      {
        key: 'review',
        label: 'correctness',
        prompt: reviewPrompt(
          intent,
          verify,
          finalPlan,
          diff,
          baselineHasChanges ? baselineDiff : null
        ),
      },
    ]
    if (ctx.config.security) {
      panel.push({
        key: 'security',
        label: 'security',
        prompt: securityPrompt(intent, finalPlan, diff, baselineHasChanges ? baselineDiff : null),
      })
    }
    panel.push(
      {
        key: 'risk',
        label: 'risk',
        prompt: riskReviewPrompt(intent, finalPlan, diff, baselineHasChanges ? baselineDiff : null),
      },
      {
        key: 'deploy',
        label: 'deploy safety',
        prompt: deploySafetyPrompt(
          intent,
          finalPlan,
          diff,
          baselineHasChanges ? baselineDiff : null
        ),
      }
    )
    if (ctx.config.ux && (userFacing || uiInDiff(diff))) {
      panel.push({
        key: 'ux',
        label: 'ux/design',
        prompt: uxReviewPrompt(intent, finalPlan, diff, baselineHasChanges ? baselineDiff : null),
      })
    }
    await progress(ctx, task, 'review', `review — ${panel.length}-expert panel`)
    const reports = await Promise.all(
      panel.map((e) =>
        agentStep(
          meter,
          e.key,
          agentLabel(reviewer),
          runAgent(reviewer, {
            root: ctx.root,
            prompt: e.prompt,
            access: 'read',
            outFile: `${task.dir}/${e.key}.md`,
          }),
          `${agentLabel(reviewer)} · ${e.label}`
        ).then((text): Labeled => ({ label: e.label, text }))
      )
    )

    // CONSOLIDATE — one judge dedupes, drops nits, resolves conflicts by priority,
    // classifies blocking vs advisory, and emits one verdict + one fix list. A FAIL
    // feeds the same auto-fix loop; advisory findings live in consolidated.md
    // (read with `factory show <id> consolidate`) and never block.
    await progress(ctx, task, 'consolidate', 'consolidate — judging the panel')
    const consolidated = await agentStep(
      meter,
      'consolidate',
      agentLabel(reviewer),
      runAgent(reviewer, {
        root: ctx.root,
        prompt: consolidatePrompt(
          intent,
          finalPlan,
          diff,
          reports,
          baselineHasChanges ? baselineDiff : null
        ),
        access: 'read',
        outFile: `${task.dir}/consolidated.md`,
      })
    )
    const verdict = parseReviewVerdict(consolidated)
    if (verdict !== 'PASS') {
      const detail = `The review panel found blocking issues:\n${consolidated}`
      const action = await assessFailure(
        ctx,
        task,
        meter,
        intent,
        failures,
        attempt,
        hardCap,
        'review',
        detail
      )
      if (action === 'continue') {
        attempt++
        continue
      }
      return blocked(
        ctx,
        task,
        meter,
        stats,
        `review blocked after ${attempt + 1} attempts`,
        consolidated
      )
    }

    // VERIFY — run the task's verification command, with self-remediation: an
    // environment/setup failure is repaired in place and re-run (no code churn);
    // only a real code defect feeds the code-fix loop, and a flake / unfixable env
    // problem goes straight to the backoff retry instead of burning fix attempts.
    if (verify) {
      const v = await verifyGate(ctx, task, meter, intent, verify)
      if (v.kind === 'code') {
        const action = await assessFailure(
          ctx,
          task,
          meter,
          intent,
          failures,
          attempt,
          hardCap,
          'verify',
          v.detail
        )
        if (action === 'continue') {
          attempt++
          continue
        }
        return setAside(
          ctx,
          task,
          meter,
          stats,
          `verify failed after ${attempt + 1} attempts`,
          v.detail
        )
      }
      if (v.kind === 'aside') {
        // Flake or an environment problem remediation couldn't fix: don't re-implement
        // code over it. Record the failure to history (so it's visible and feeds the
        // next pass) and hand to the backoff auto-retry — env issues like a service
        // that isn't up yet often clear on their own; truly stuck ones block at the cap.
        const entry: Failure = {
          attempt,
          gate: 'verify',
          summary: firstLine(v.detail).slice(0, 200),
          detail: v.detail,
        }
        failures.push(entry)
        await appendFailure(task, entry)
        return setAside(ctx, task, meter, stats, v.reason, v.detail)
      }
      // Passed verify — first try iff no prior code-fix attempts (an environment
      // remediation isn't a code fix, so it doesn't disqualify first-try).
      stats.verifyFirstTry = attempt === 0
    } else {
      log.warn(`${task.id}: no verify command — skipping verification gate`)
    }

    break // both gates passed
  }

  // Gate passed: record proof and commit on the branch.
  const proof = [
    `# Proof — ${task.id}`,
    '',
    '## Selected plan (head)',
    finalPlan.split('\n').slice(0, 3).join('\n'),
    '',
    '## Review',
    'VERDICT: PASS',
    '',
    `## Verify\n${verify ? `\`${verify}\` passed` : 'no verify command'}`,
  ].join('\n')
  await writeArtifact(task, 'proof.md', proof)

  await commitAll(ctx.root, commitMessage(intent))
  task.meta.commit = await headSha(ctx.root)
  if (feedbackContext) {
    await refreshFeedbackState(task)
    markFeedbackConsumed(task, feedbackContext.count)
  }
  await saveMeta(task)

  return shipAndFinish(ctx, task, intent, meter, stats)
}

// 8. onComplete — opt-in, outward-facing delivery via the delivery agent (run a
// skill or follow a policy). Split out so a resume whose work already committed can
// re-run just this step. A ship failure is transient (CI/network), so it feeds the
// same backoff auto-retry as verify rather than hard-blocking.
const FEEDBACK_INPUT_LIMIT = 12_000

function clipFeedbackInput(text: string | null, max: number = FEEDBACK_INPUT_LIMIT): string | null {
  if (!text) {
    return null
  }
  if (text.length <= max) {
    return text
  }
  return `${text.slice(0, max)}\n\n[clipped for feedback prompt]`
}

async function writeCompletionFeedback(ctx: WorkContext, task: Task, intent: string, meter: Meter) {
  try {
    await progress(ctx, task, 'feedback', 'summarizing handoff')
    const diff = task.meta.commit ? await commitDiff(ctx.root, task.meta.commit) : null
    await agentStep(
      meter,
      'feedback',
      agentLabel(ctx.agents.delivery),
      runAgent(ctx.agents.delivery, {
        root: ctx.root,
        prompt: feedbackPrompt({
          taskId: task.id,
          intent: clipFeedbackInput(intent) ?? '',
          finalPlan: clipFeedbackInput(await readPlan(task)),
          verify: task.meta.verify,
          diff: clipFeedbackInput(diff),
          proof: clipFeedbackInput(await readArtifact(task, 'proof.md')),
          verifyLog: clipFeedbackInput(await readArtifact(task, 'verify.log')),
          ship: clipFeedbackInput(await readArtifact(task, 'ship.md')),
        }),
        access: 'read',
        outFile: `${task.dir}/feedback.md`,
      }),
      'handoff'
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`${task.id}: handoff unavailable (task still done) — ${message}`)
  }
}

async function shipAndFinish(
  ctx: WorkContext,
  task: Task,
  intent: string,
  meter: Meter,
  stats: RunStats
): Promise<TaskOutcome> {
  await refreshMeta(task)
  const onComplete = resolveOnComplete(task.meta.onComplete, ctx.config.onComplete)
  if (onComplete) {
    await setStatus(task, 'shipping')
    await progress(ctx, task, 'ship', 'onComplete — delivering')
    const branch = await currentBranch(ctx.root)
    const shipOut = await agentStep(
      meter,
      'ship',
      agentLabel(ctx.agents.delivery),
      runAgent(ctx.agents.delivery, {
        root: ctx.root,
        prompt: shipPrompt(intent, branch, onComplete),
        access: 'full',
        outFile: `${task.dir}/ship.md`,
      })
    )
    const ship = parseShip(shipOut)
    if (!ship.ok) {
      return setAside(ctx, task, meter, stats, `ship failed: ${ship.reason}`, shipOut)
    }
  }

  await writeCompletionFeedback(ctx, task, intent, meter)
  logTotal(meter)
  recordTask(ctx, task, meter, 'done', stats)
  return { ok: true }
}

function commitMessage(intent: string): string {
  const subject = (intent.trim().split('\n', 1)[0] ?? 'Apply task').replace(/\.$/, '').slice(0, 72)
  return subject.length > 0 ? subject : 'Apply task'
}

// User-facing file extensions, used to fire the UX review on a diff even when
// triage didn't flag the task (or wasn't run, e.g. on resume). Covers the common
// web/component and server-template surfaces.
const UI_FILE = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|styl|html|astro|mdx|erb|haml|slim)$/i
function uiInDiff(diff: string): boolean {
  return diff
    .split('\n')
    .some(
      (line) => line.startsWith('+++ ') && UI_FILE.test(line.replace(/^\+\+\+ (b\/)?/, '').trim())
    )
}
