import { mkdir } from 'node:fs/promises'
import { type AgentResult, agentLabel, runAgent } from './agents.ts'
import { cleanCommitMessage, fallbackCommitMessage } from './commit-message.ts'
import { type Agent, normAgent, type WorkContext } from './config.ts'
import { buildDeckHtml } from './deck.ts'
import {
  appendDeliveryHistory,
  applyDeliveryConfirmation,
  type DeliverySkill,
  deliveryAction,
  deliveryLabel,
  deliveryNeedsConfirmation,
  deliveryRecommendation,
  formatDeliveryHistory,
  listDeliverySkills,
  readDeliveryHistory,
  type TaskDelivery,
} from './delivery.ts'
import { run } from './exec.ts'
import {
  type AuthorCommitSubjects,
  commitAll,
  commitDiff,
  currentBranch,
  hasChanges,
  headSha,
  recentAuthorCommitSubjects,
  recentCommitSubjects,
  worktreeDiff,
} from './git.ts'
import {
  applicableGuidance,
  createGuidanceFromDistillation,
  type GuidanceStage,
  loadGuidance,
  recordGuidanceOutcome,
  renderGuidanceBlock,
} from './guidance.ts'
import { emit } from './hooks.ts'
import { appendCandidate, readLessons } from './lessons.ts'
import { log } from './log.ts'
import {
  parseConvergenceVerdict,
  parseDeliverySelection,
  parseGateFix,
  parseReconcileDecision,
  parseRemedy,
  parseReviewVerdict,
  parseShip,
  parseShipUrl,
  parseTriage,
} from './markers.ts'
import { recentFirstPassYield, recordRun, type StageStat } from './metrics.ts'
import { appendEnvPlaybook, readEnvPlaybook } from './playbook.ts'
import {
  commitMessagePrompt,
  consolidatePrompt,
  convergePrompt,
  critiquePrompt,
  deckPrompt,
  deliverySelectPrompt,
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
  prototypePrompt,
  quickFixPrompt,
  reconcilePrompt,
  remediatePrompt,
  rescuePrompt,
  researchPrompt,
  researchScoutPrompt,
  researchSynthesisPrompt,
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
  workforcePlanPrompt,
} from './prompts.ts'
import {
  PROTOTYPE_RAW,
  prototypeContext,
  writePrototypeFallback,
  writePrototypeOutput,
} from './prototype.ts'
import { readAskStats, renderAskCalibration } from './question-stats.ts'
import {
  formatQuestions,
  parseQuestions,
  parseReview,
  parseSharpen,
  type SharpenResult,
  sanitizeVerifyCommand,
  type Turn,
} from './sharpen.ts'
import {
  appendFailure,
  appendPassMeter,
  type Failure,
  findAnsweredQuestion,
  type LiveMeter,
  latestAnswerValueAfter,
  markFeedbackConsumed,
  NEEDS_INPUT_PREAMBLE,
  pendingFeedbackCount,
  readAnswers,
  readArtifact,
  readFailures,
  readIntent,
  readLiveMeter,
  readPendingFeedback,
  readPlan,
  readySharpenedTask,
  refreshFeedbackState,
  refreshMeta,
  rollArtifactHistory,
  saveMeta,
  setStatus,
  setTaskDelivery,
  type Task,
  type TaskComplexity,
  writeArtifact,
  writeLiveMeter,
} from './task.ts'
import {
  parseWorkforcePlan,
  RESEARCH_SCOUTS,
  REVIEW_LENSES,
  type ResearchScout,
  type ReviewLens,
  serializeWorkforcePlan,
  type WorkforceEntry,
  type WorkforcePlan,
} from './workforce.ts'

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

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
  // Guidance records actually injected into this pass's prompts, so the outcome
  // can be attributed back to them (lessons must earn their context window).
  guidanceIds: Set<string>
}
function newMeter(task: Task): Meter {
  return {
    task,
    inTok: 0,
    outTok: 0,
    startedAt: Date.now(),
    stages: [],
    writeSeq: Promise.resolve(),
    guidanceIds: new Set(),
  }
}

function meterSnapshot(meter: Meter): LiveMeter {
  return {
    startedAt: new Date(meter.startedAt).toISOString(),
    updatedAt: new Date().toISOString(),
    inputTokens: meter.inTok,
    outputTokens: meter.outTok,
    stages: meter.stages.map((s) => ({ ...s })),
  }
}

// A meter.json left by a pass that never reached an outcome (killed loop, crash)
// is swept into meters.jsonl before the new pass overwrites it — dedupe by
// startedAt makes this a no-op when the prior pass recorded itself normally.
async function sweepInterruptedMeter(task: Task): Promise<void> {
  try {
    const prior = await readLiveMeter(task)
    if (prior) {
      await appendPassMeter(task, prior, 'interrupted')
    }
  } catch (err) {
    log.warn(`interrupted meter sweep failed for ${task.id}: ${formatErr(err)}`)
  }
}

async function persistLiveMeter(meter: Meter): Promise<void> {
  const snapshot = meterSnapshot(meter)
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

// Run independent agent steps concurrently, tolerating individual crashes: one
// flaky CLI invocation must not discard the healthy rest of a parallel stage.
// (With Promise.all, a single rejected planner/scout/expert blocked the whole
// task — five clean reviews thrown away because a sixth hiccuped.) Fulfilled
// results keep their keys so callers can re-align positional structures; below
// `min` fulfilled, the stage genuinely failed and the error propagates.
async function settleStage<T>(
  taskId: string,
  stage: string,
  work: Array<{ key: string; promise: Promise<T> }>,
  min: number = 1
): Promise<Array<{ key: string; value: T }>> {
  const settled = await Promise.allSettled(work.map((w) => w.promise))
  const ok: Array<{ key: string; value: T }> = []
  const failed: string[] = []
  settled.forEach((res, i) => {
    const key = work[i]?.key ?? String(i)
    if (res.status === 'fulfilled') {
      ok.push({ key, value: res.value })
    } else {
      failed.push(key)
      log.warn(`${taskId}: ${stage} agent '${key}' failed: ${formatErr(res.reason)}`)
    }
  })
  if (ok.length < min) {
    throw new Error(
      `${stage}: ${failed.length}/${work.length} agents failed (${failed.join(', ')}) — ` +
        `below the stage quorum of ${min}`
    )
  }
  return ok
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

type AgentChoice = { id: string; agent: Agent; label: string }

function agentChoices(ctx: WorkContext): AgentChoice[] {
  const choices: AgentChoice[] = [
    { id: 'implementer', agent: ctx.agents.implementer, label: agentLabel(ctx.agents.implementer) },
    { id: 'reviewer', agent: ctx.agents.reviewer, label: agentLabel(ctx.agents.reviewer) },
    {
      id: 'workforce',
      agent: normAgent(ctx.config.agents.workforce),
      label: agentLabel(normAgent(ctx.config.agents.workforce)),
    },
    {
      id: 'rescue',
      agent: normAgent(ctx.config.agents.rescue),
      label: agentLabel(normAgent(ctx.config.agents.rescue)),
    },
  ]
  const labels = plannerLabels(ctx.agents.planners)
  for (const [i, agent] of ctx.agents.planners.entries()) {
    choices.push({ id: `planner.${labels[i] ?? agent.cli}`, agent, label: agentLabel(agent) })
  }
  for (const [name, spec] of Object.entries(ctx.config.agents.researchers)) {
    const agent = normAgent(spec)
    choices.push({ id: `researcher.${name}`, agent, label: agentLabel(agent) })
  }
  for (const [name, spec] of Object.entries(ctx.config.agents.reviewers)) {
    const agent = normAgent(spec)
    choices.push({ id: `reviewer.${name}`, agent, label: agentLabel(agent) })
  }
  return choices
}

function agentChoiceMap(ctx: WorkContext): Map<string, Agent> {
  return new Map(agentChoices(ctx).map((choice) => [choice.id, choice.agent]))
}

function defaultResearchAgentId(ctx: WorkContext, kind: ResearchScout): string {
  return kind in ctx.config.agents.researchers ? `researcher.${kind}` : 'implementer'
}

function defaultReviewAgentId(ctx: WorkContext, kind: ReviewLens): string {
  return kind in ctx.config.agents.reviewers ? `reviewer.${kind}` : 'reviewer'
}

function normalizeWorkforcePlan(
  ctx: WorkContext,
  plan: WorkforcePlan,
  userFacing: boolean
): WorkforcePlan {
  const fallbackResearch: Array<WorkforceEntry<ResearchScout>> = [
    {
      kind: 'code',
      agent: defaultResearchAgentId(ctx, 'code'),
      policies: [],
      reason: 'Required baseline code research.',
    },
  ]
  const research = plan.research.length ? plan.research : fallbackResearch
  const review = ensureReviewLens(
    ensureReviewLens(
      userFacing && ctx.config.ux ? ensureReviewLens(plan.review, ctx, 'ux') : plan.review,
      ctx,
      'correctness'
    ),
    ctx,
    'security',
    !ctx.config.security
  )
  return { research, review }
}

function reviewWorkforceForDiff(
  ctx: WorkContext,
  plan: WorkforcePlan,
  userFacing: boolean,
  diff: string
): Array<WorkforceEntry<ReviewLens>> {
  let entries = plan.review
  entries = ensureReviewLens(entries, ctx, 'correctness')
  entries = ensureReviewLens(entries, ctx, 'security', !ctx.config.security)
  entries = ensureReviewLens(entries, ctx, 'ux', !(ctx.config.ux && (userFacing || uiInDiff(diff))))
  return entries
}

function ensureReviewLens(
  entries: Array<WorkforceEntry<ReviewLens>>,
  ctx: WorkContext,
  kind: ReviewLens,
  skip: boolean = false
): Array<WorkforceEntry<ReviewLens>> {
  if (skip || entries.some((entry) => entry.kind === kind)) {
    return entries
  }
  return [
    ...entries,
    {
      kind,
      agent: defaultReviewAgentId(ctx, kind),
      policies: [],
      reason: 'Required safety floor.',
    },
  ]
}

function expandTildePath(path: string): string {
  return path.startsWith('~') ? `${process.env['HOME'] ?? ''}${path.slice(1)}` : path
}

function resolvePolicyPath(root: string, path: string): string {
  const expanded = expandTildePath(path)
  return expanded.startsWith('/') ? expanded : `${root}/${expanded}`
}

async function renderPolicies(
  ctx: WorkContext,
  ids: string[],
  appliesTo: string
): Promise<string | null> {
  const blocks: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    const policy = ctx.config.specialists[id]
    if (!policy) {
      log.warn(`specialist policy ${id} is not configured; ignoring`)
      continue
    }
    if (policy.appliesTo.length > 0 && !policy.appliesTo.includes(appliesTo)) {
      log.warn(`specialist policy ${id} does not apply to ${appliesTo}; ignoring`)
      continue
    }
    const path = resolvePolicyPath(ctx.root, policy.path)
    const file = Bun.file(path)
    if (!(await file.exists())) {
      log.warn(`specialist policy ${id} missing at ${path}; ignoring`)
      continue
    }
    blocks.push(`### ${id}\n${(await file.text()).trim()}`)
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null
}

function combineGuidance(...blocks: Array<string | null>): string | null {
  const rendered = blocks.filter((block): block is string => Boolean(block?.trim()))
  return rendered.length > 0 ? rendered.join('\n\n') : null
}

async function runWorkforcePlanner(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  intent: string,
  verify: string | null,
  userFacing: boolean
): Promise<WorkforcePlan | null> {
  if (!ctx.config.workforce) {
    return null
  }
  await progress(ctx, task, 'workforce', 'workforce — choosing scouts and reviewers')
  const raw = await agentStep(
    meter,
    'workforce',
    agentLabel(normAgent(ctx.config.agents.workforce)),
    runAgent(normAgent(ctx.config.agents.workforce), {
      root: ctx.root,
      prompt: workforcePlanPrompt({
        intent,
        verify,
        userFacing,
        securityEnabled: ctx.config.security,
        uxEnabled: ctx.config.ux,
        agents: agentChoices(ctx).map((choice) => ({ id: choice.id, label: choice.label })),
        researchScouts: [...RESEARCH_SCOUTS],
        reviewLenses: REVIEW_LENSES.filter(
          (lens) => (lens !== 'security' || ctx.config.security) && (lens !== 'ux' || ctx.config.ux)
        ),
        policies: Object.entries(ctx.config.specialists).map(([id, policy]) => ({
          id,
          description: policy.description,
          appliesTo: policy.appliesTo,
        })),
      }),
      access: 'read',
      outFile: `${task.dir}/workforce.raw.json`,
    })
  )
  const parsed = parseWorkforcePlan(raw)
  if (!parsed) {
    log.warn(`${task.id}: workforce plan malformed; using legacy research/review defaults`)
    return null
  }
  const normalized = normalizeWorkforcePlan(ctx, parsed, userFacing)
  await writeArtifact(task, 'workforce.json', serializeWorkforcePlan(normalized))
  return normalized
}

async function readWorkforcePlan(task: Task): Promise<WorkforcePlan | null> {
  const raw = await readArtifact(task, 'workforce.json')
  return raw ? parseWorkforcePlan(raw) : null
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

export function implementationAttemptCount(failures: Failure[]): number {
  return failures.filter((failure) => failure.remediation === 'code-fix').length
}

export function resumeUserFacing(
  uxEnabled: boolean,
  persisted: boolean | undefined,
  diffUserFacing: boolean
): boolean {
  return uxEnabled && (persisted ?? diffUserFacing)
}

async function stageGuidanceForRun(ctx: WorkContext, meter: Meter): Promise<StageGuidance> {
  const guidance = await loadGuidance().catch((err) => {
    log.warn(`guidance load failed: ${err instanceof Error ? err.message : err}`)
    return []
  })
  return (stage) => renderGuidanceBlock(applicableGuidance(guidance, ctx, stage), meter.guidanceIds)
}

// Persist one telemetry record for this pass. Best-effort: recordRun never throws,
// so a telemetry failure can't break the task.
function recordTask(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  outcome: 'done' | 'blocked' | 'needs-input' | 'retrying',
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
  // Append the pass to the task's durable meter history. meter.json alone holds
  // only the current pass; multi-pass task costs vanished without this.
  void appendPassMeter(task, meterSnapshot(meter), outcome).catch((err) => {
    log.warn(`pass meter append failed for ${task.id}: ${formatErr(err)}`)
  })
  // Attribute terminal outcomes to the lessons that rode along, so guidance
  // accrues a win/loss record and losing lessons retire themselves.
  if ((outcome === 'done' || outcome === 'blocked') && meter.guidanceIds.size > 0) {
    void recordGuidanceOutcome(meter.guidanceIds, outcome).catch((err) => {
      log.warn(`guidance outcome record failed for ${task.id}: ${formatErr(err)}`)
    })
  }
}

// A blocked outcome also drops a raw signal into the lesson candidates, so
// recurring failure modes become visible for the meta loop.
async function blocked(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  stats: RunStats,
  reason: string,
  detail: string | undefined,
  postmortemGuidance: string | null
): Promise<TaskOutcome> {
  logTotal(meter)
  recordTask(ctx, task, meter, 'blocked', stats)
  await postmortem(ctx, task, meter, reason, postmortemGuidance)
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
  reason: string,
  guidance: string | null
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
        prompt: postmortemPrompt(intent, history, diff, reason, guidance),
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
    if (lesson) {
      try {
        const captured = await createGuidanceFromDistillation(ctx, {
          source: { kind: 'postmortem', taskId: task.id, detail: category },
          text: lesson,
          distillation: out,
        })
        if (captured === 'invalid') {
          log.warn(`postmortem guidance metadata invalid for ${task.id}; kept raw candidate only`)
        }
      } catch (err) {
        log.warn(
          `postmortem guidance capture failed for ${task.id}: ${
            err instanceof Error ? err.message : err
          }`
        )
      }
    }
  } catch (err) {
    log.warn(`postmortem failed for ${task.id}: ${err instanceof Error ? err.message : err}`)
    await appendCandidate(ctx, `blocked · ${task.id} · ${reason}`)
  }
}

// Auto-resume policy for TRANSIENT gate failures (verify, ship): rather than
// hard-block, set the task aside with a growing backoff so the run loop retries it
// — up to AUTO_CAP times — letting an env/CI flake recover with no human action.
// Once the cap is spent, the convergence judge decides whether to keep retrying,
// ask for input, or stop as terminal.
export const AUTO_CAP = 5
// Absolute ceiling on judge-approved retries past AUTO_CAP. The judge could
// historically vote RETRY_LATER forever, pinning a task to hourly retries of a
// deterministic failure with no human contact. Past this, the human is asked.
export const AUTO_HARD_CAP = 10
const BACKOFF_MS = [120_000, 300_000, 900_000, 1_800_000, 3_600_000] // 2m, 5m, 15m, 30m, 60m
function backoffMs(n: number): number {
  return BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)] ?? 3_600_000
}

function retryLater(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  stats: RunStats,
  reason: string
): TaskOutcome {
  logTotal(meter)
  recordTask(ctx, task, meter, 'retrying', stats)
  const retryAt = new Date(Date.now() + backoffMs(task.meta.autoRetries)).toISOString()
  return { ok: false, kind: 'retrying', reason, retryAt, autoRetries: task.meta.autoRetries + 1 }
}

// questions.md always holds the CURRENT question round (that's what show/ask and
// the inline prompt read); earlier rounds roll into questions.history.md instead
// of being destroyed.
async function writeQuestions(task: Task, questions: string): Promise<void> {
  await rollArtifactHistory(task, 'questions.md')
  await writeArtifact(task, 'questions.md', questions)
  task.meta.questionRounds += 1
  await saveMeta(task)
}

async function needsInput(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  stats: RunStats,
  questions: string
): Promise<TaskOutcome> {
  await writeQuestions(task, questions)
  await appendCandidate(ctx, `needs-input · ${task.id} · ${firstLine(questions)}`)
  logTotal(meter)
  recordTask(ctx, task, meter, 'needs-input', stats)
  return { ok: false, kind: 'needs-input', questions }
}

type FailureAction =
  | { kind: 'continue' }
  | { kind: 'retry'; reason: string }
  | { kind: 'needs-input'; questions: string }
  | { kind: 'terminal' }

async function judgeFailure(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  intent: string,
  failures: Failure[],
  latestFailure: string,
  safetyFuse: string | null
): Promise<{ action: FailureAction; summary: string }> {
  const priorSummaries = failures.map((f) => `${f.gate}: ${f.summary}`)
  const failureForJudge = safetyFuse
    ? `Safety fuse reached: ${safetyFuse}\n\n${latestFailure}`
    : latestFailure
  const judgment = await agentStep(
    meter,
    'converge',
    agentLabel(ctx.agents.reviewer),
    runAgent(ctx.agents.reviewer, {
      root: ctx.root,
      prompt: convergePrompt(intent, priorSummaries, failureForJudge, await readAnswers(task)),
      access: 'read',
      outFile: `${task.dir}/converge.md`,
    })
  )
  const summary =
    /SUMMARY:\s*(.+)/i.exec(judgment)?.[1]?.trim() || firstLine(latestFailure).slice(0, 200)
  const verdict = parseConvergenceVerdict(judgment)
  switch (verdict) {
    case 'CONTINUE_CODE_FIX':
      return { action: { kind: 'continue' }, summary }
    case 'RETRY_LATER':
      return { action: { kind: 'retry', reason: summary }, summary }
    case 'ASK_HUMAN': {
      // Mechanical backstop for the settled-decisions prompt rule: a judge that
      // re-derives an already-answered question (one real task asked the same
      // security question three times, reworded) does not get to pause the task.
      // The standing answer rides the failure history; the fixer also sees the
      // full answers.md. Fail-safe: at the attempt cap this continue is still
      // overridden into a (differently-worded, non-matching) stuck question.
      const answered = await findAnsweredQuestion(task, summary)
      if (answered) {
        log.warn(
          `${task.id}: converge re-asked a question the human answered at ` +
            `${answered.answeredAt}; continuing with the standing answer instead of pausing`
        )
        return {
          action: { kind: 'continue' },
          summary:
            `re-derived an already-answered question; the standing answer applies: ` +
            `${firstLine(answered.answer).slice(0, 200)}`,
        }
      }
      return {
        action: {
          kind: 'needs-input',
          questions: `${NEEDS_INPUT_PREAMBLE}\n\n${summary}`,
        },
        summary,
      }
    }
    case 'TERMINAL':
      return { action: { kind: 'terminal' }, summary }
    default:
      // Malformed judge output must not silently kill the task (it used to fall
      // through to terminal). Fail toward the human: a question is recoverable,
      // a wrongly-terminal block loses the work.
      log.warn(`${task.id}: convergence judge output had no VERDICT marker; asking the human`)
      return {
        action: {
          kind: 'needs-input',
          questions:
            'Factory could not parse its own convergence judgment and paused instead of ' +
            `guessing. Latest failure:\n\n${summary}\n\n` +
            'Reply with guidance (or just "continue" / "stop") via factory add.',
        },
        summary,
      }
  }
}

async function setAside(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  stats: RunStats,
  reason: string,
  detail: string | undefined,
  intent: string,
  postmortemGuidance: string | null
): Promise<TaskOutcome> {
  if (task.meta.autoRetries >= AUTO_HARD_CAP) {
    // Mechanical ceiling: the judge does not get to keep a task on hourly
    // retries forever. Transient failures that survive this many backoffs are
    // not transient; the human decides.
    log.warn(`${task.id}: auto-retry hard ceiling ${AUTO_HARD_CAP} reached; asking the human`)
    return needsInput(
      ctx,
      task,
      meter,
      stats,
      stuckQuestions(
        'retry',
        `${task.meta.autoRetries} auto-retries were spent on a failure that keeps recurring`,
        detail ?? reason,
        (await readFailures(task)).map((f) => `${f.gate}: ${f.summary}`)
      )
    )
  }
  if (task.meta.autoRetries >= AUTO_CAP) {
    const failures = await readFailures(task)
    const judged = await judgeFailure(
      ctx,
      task,
      meter,
      intent,
      failures,
      detail ?? reason,
      `transient auto-retry limit ${AUTO_CAP} reached`
    )
    switch (judged.action.kind) {
      case 'retry':
      case 'continue':
        return retryLater(
          ctx,
          task,
          meter,
          stats,
          judged.action.kind === 'retry' ? judged.action.reason : reason
        )
      case 'needs-input':
        return needsInput(ctx, task, meter, stats, judged.action.questions)
      case 'terminal':
        return await blocked(
          ctx,
          task,
          meter,
          stats,
          `${reason} (terminal after ${AUTO_CAP} auto-retries)`,
          detail,
          postmortemGuidance
        )
    }
  }
  return retryLater(ctx, task, meter, stats, reason)
}

// Stable fingerprint of a failure for mechanical loop detection: same gate +
// same (whitespace-normalized) failure text. Combined with a worktree-diff hash
// it answers "did the last fix attempt change anything observable?" in code,
// without trusting a model to notice it's going in circles.
// Clip long gate output while keeping BOTH ends: test runners print the actual
// failures (expected/actual diffs) in the middle or head and a low-information
// summary at the tail. A tail-only clip fed fixers 84 rounds of blind guessing
// on one real task because the assertion diffs were sliced away.
const FAILURE_HEAD = 3000
const FAILURE_TAIL = 12000
export function clipFailureOutput(
  text: string,
  head: number = FAILURE_HEAD,
  tail: number = FAILURE_TAIL
): string {
  const trimmed = text.trim()
  if (trimmed.length <= head + tail) {
    return trimmed
  }
  return `${trimmed.slice(0, head)}\n\n[... ${trimmed.length - head - tail} chars clipped ...]\n\n${trimmed.slice(-tail)}`
}

function failureFingerprint(gate: string, detail: string): string {
  return Bun.hash(`${gate}\n${detail.replace(/\s+/g, ' ').trim()}`).toString(16)
}

async function worktreeDiffHash(root: string): Promise<string> {
  return Bun.hash(await worktreeDiff(root)).toString(16)
}

// The trend line matters as much as the latest failure: a human deciding
// hint/continue/stop needs to see whether attempts were converging, plateaued,
// or flip-flopping — without excavating failures.jsonl by hand.
function stuckQuestions(gate: string, reason: string, detail: string, history: string[]): string {
  const trend = history.length
    ? [
        'How the attempts trended (oldest first):',
        '',
        ...history.map((s, i) => `${i + 1}. ${s}`),
        '',
      ]
    : []
  return [
    `Factory mechanically stopped an unproductive ${gate} fix loop: ${reason}.`,
    '',
    ...trend,
    'Latest failure:',
    '',
    detail,
    '',
    'Reply via `factory add`: a concrete hint for the next fix attempt,',
    '"continue" to authorize more attempts, or "stop" to abandon the task.',
  ].join('\n')
}

// After a gate failure, decide what to do next. The convergence judge reads the
// whole failure history and chooses code-fix, retry-later, ask-human, or
// terminal — but two bounds are enforced mechanically, not delegated to the
// judge's judgment:
//   1. STUCK: the failure is byte-identical to the previous one AND the fix
//      attempt didn't change the worktree → re-running is forbidden; ask the
//      human instead of guessing again.
//   2. `hardCap` is a REAL cap on fix attempts: at the cap, continue is not an
//      available action (the judge historically kept voting CONTINUE past every
//      "hard" cap — one real task burned 84 identical attempts / 611M tokens).
// Both bounds fail toward the human (a question is recoverable; silent churn
// and wrongly-terminal blocks are not). The failure is logged either way.
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
): Promise<FailureAction> {
  const fingerprint = failureFingerprint(gate, detail)
  const diffHash = await worktreeDiffHash(ctx.root)
  const record = async (summary: string, remediation: 'code-fix' | 'backoff'): Promise<void> => {
    const entry: Failure = { attempt, gate, summary, detail, remediation, fingerprint, diffHash }
    failures.push(entry)
    await appendFailure(task, entry)
  }

  if (hardCap === 0) {
    await record(firstLine(detail).slice(0, 200), 'code-fix')
    return { kind: 'terminal' }
  }

  const previous = failures.filter((f) => f.gate === gate).at(-1)
  const identicalFailure = previous?.fingerprint != null && previous.fingerprint === fingerprint
  const identicalDiff = previous?.diffHash != null && previous.diffHash === diffHash
  if (identicalFailure && identicalDiff) {
    log.warn(
      `${task.id}: ${gate} failed identically with an unchanged worktree — asking the human ` +
        'instead of re-running'
    )
    await record(`identical ${gate} failure, unchanged worktree — mechanically stuck`, 'code-fix')
    return {
      kind: 'needs-input',
      questions: stuckQuestions(
        gate,
        'the failure is identical to the previous attempt and the fix pass changed nothing',
        detail,
        failures.map((f) => `${f.gate}: ${f.summary}`)
      ),
    }
  }

  const atCap = attempt + 1 >= hardCap
  const judged = await judgeFailure(
    ctx,
    task,
    meter,
    intent,
    failures,
    detail,
    atCap ? `implementation-attempt limit ${hardCap} reached` : null
  )
  await record(judged.summary, judged.action.kind === 'retry' ? 'backoff' : 'code-fix')
  if (atCap && judged.action.kind === 'continue') {
    log.warn(
      `${task.id}: fix-attempt cap ${hardCap} reached; overriding the judge's CONTINUE and ` +
        'asking the human'
    )
    return {
      kind: 'needs-input',
      questions: stuckQuestions(
        gate,
        `the fix-attempt cap (retries: ${hardCap}) is spent`,
        detail,
        failures.map((f) => `${f.gate}: ${f.summary}`)
      ),
    }
  }
  return judged.action
}

// The consolidator's "## Quick fixes" section: cheap/safe advisory items worth
// one bounded pass after PASS. Returns null when absent or "none".
export function extractQuickFixes(consolidated: string): string | null {
  const match = /^## Quick fixes\s*$/im.exec(consolidated)
  if (!match || match.index === undefined) {
    return null
  }
  const after = consolidated.slice(match.index + match[0].length)
  const end = after.search(/^## |^VERDICT:/im)
  const body = (end === -1 ? after : after.slice(0, end)).trim()
  if (!body || /^none\.?$/i.test(body)) {
    return null
  }
  return body
}

async function conductorAskCalibration(ctx: WorkContext): Promise<string | null> {
  return renderAskCalibration(await readAskStats(ctx.repoStateDir))
}

function markerText(text: string, marker: string): string | null {
  return new RegExp(`^${marker}:\\s*(.+)$`, 'im').exec(text)?.[1]?.trim() ?? null
}

async function rescueTerminalFailure(input: {
  ctx: WorkContext
  task: Task
  meter: Meter
  intent: string
  finalPlan: string
  verify: string | null
  failures: Failure[]
  attempt: number
  latestFailure: string
  guidance: string | null
}): Promise<FailureAction | null> {
  if (!input.ctx.config.rescue) {
    return null
  }
  await progress(input.ctx, input.task, 'rescue', 'rescue — checking for a better next move')
  const agent = normAgent(input.ctx.config.agents.rescue)
  const out = await agentStep(
    input.meter,
    'rescue',
    agentLabel(agent),
    runAgent(agent, {
      root: input.ctx.root,
      prompt: rescuePrompt({
        intent: input.intent,
        finalPlan: input.finalPlan,
        verify: input.verify,
        currentDiff: await worktreeDiff(input.ctx.root),
        failures: input.failures.map((f) => `${f.gate}: ${f.summary}`),
        latestFailure: input.latestFailure,
        guidance: input.guidance,
        answers: await readAnswers(input.task),
      }),
      access: 'read',
      outFile: `${input.task.dir}/rescue.md`,
    })
  )
  const summary = markerText(out, 'SUMMARY') ?? firstLine(out).slice(0, 200)
  const next = markerText(out, 'NEXT') ?? summary
  switch (parseConvergenceVerdict(out)) {
    case 'CONTINUE_CODE_FIX': {
      const detail = `Rescue direction:\n${next}\n\nOriginal terminal failure:\n${input.latestFailure}`
      const entry: Failure = {
        attempt: input.attempt,
        gate: 'rescue',
        summary: next.slice(0, 200),
        detail,
        remediation: 'code-fix',
      }
      input.failures.push(entry)
      await appendFailure(input.task, entry)
      return { kind: 'continue' }
    }
    case 'RETRY_LATER':
      return { kind: 'retry', reason: next }
    case 'ASK_HUMAN': {
      // Same backstop as the converge judge: an already-answered question is not
      // a reason to pause — convert it into one more fix pass carrying the answer.
      const answered = await findAnsweredQuestion(input.task, next)
      if (answered) {
        log.warn(
          `${input.task.id}: rescue re-asked a question the human answered at ` +
            `${answered.answeredAt}; continuing with the standing answer instead of pausing`
        )
        const entry: Failure = {
          attempt: input.attempt,
          gate: 'rescue',
          summary: `re-derived an already-answered question; the standing answer applies`,
          detail: `The human already answered this question (${answered.answeredAt}):\n${answered.answer}\n\nOriginal terminal failure:\n${input.latestFailure}`,
          remediation: 'code-fix',
        }
        input.failures.push(entry)
        await appendFailure(input.task, entry)
        return { kind: 'continue' }
      }
      return {
        kind: 'needs-input',
        questions: `${NEEDS_INPUT_PREAMBLE}\n\n${next}`,
      }
    }
    case 'TERMINAL':
      return { kind: 'terminal' }
    default:
      log.warn(`${input.task.id}: rescue output malformed; blocking normally`)
      return null
  }
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
  | { kind: 'pass'; verify: string }
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
  verify: string,
  remediateGuidance: string | null
): Promise<VerifyVerdict> {
  const remedies: string[] = []
  // Defense in depth: the command is sanitized where specs are parsed, but verify
  // strings also arrive from older meta.json and human flags. Backtick-wrapped
  // commands become command substitutions under bash -lc — never run those.
  let command = sanitizeVerifyCommand(verify)
  while (true) {
    await setStatus(task, 'verifying')
    await progress(ctx, task, 'verify', `verify — ${command}`)
    const vstart = Date.now()
    const result = await withHeartbeat(
      'verify',
      vstart,
      run(['bash', '-lc', command], { cwd: ctx.root })
    )
    const vms = Date.now() - vstart
    meter.stages.push({ stage: 'verify', agent: '-', inTok: 0, outTok: 0, ms: vms })
    await persistLiveMeter(meter)
    log.done(`verify ${fmtSecs(vms)}`)
    await rollArtifactHistory(task, 'verify.log')
    await writeArtifact(task, 'verify.log', `$ ${command}\n\n${result.stdout}\n${result.stderr}`)
    if (result.code === 0) {
      return { kind: 'pass', verify: command }
    }
    const detail = `Verify \`${command}\` failed (exit ${result.code}):\n${clipFailureOutput(`${result.stdout}\n${result.stderr}`)}`
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
        prompt: remediatePrompt(
          intent,
          command,
          detail,
          remedies,
          remediateGuidance,
          await readEnvPlaybook(ctx.envPlaybookPath)
        ),
        access: 'full',
        outFile: `${task.dir}/remediate${n > 1 ? `.${n}` : ''}.md`,
      })
    )
    const summary = /SUMMARY:\s*(.+)/i.exec(out)?.[1]?.trim() || firstLine(out).slice(0, 200)
    switch (parseRemedy(out)) {
      case 'ENV-FIXED':
        remedies.push(summary)
        await appendEnvPlaybook(ctx.envPlaybookPath, `env fixed: ${summary}`)
        continue // re-run verify against the repaired environment
      case 'GATE-MISCONFIGURED': {
        // The gate itself is broken (nonexistent script, broken quoting, wrong
        // path). Two real tasks died re-running a corrupted command for hours
        // because there was no bucket for "the check cannot ever pass". The
        // doctor supplies the corrected command; it is persisted so resumes and
        // ship use it too. Without a GATE-FIX the verdict is unusable — back off.
        const fix = parseGateFix(out)
        const fixed = fix ? sanitizeVerifyCommand(fix) : ''
        if (!fixed || fixed === command) {
          return {
            kind: 'aside',
            reason: `verify command is misconfigured and the doctor offered no usable fix: ${summary}`,
            detail,
          }
        }
        log.warn(`${task.id}: verify command repaired by the doctor: ${command} → ${fixed}`)
        remedies.push(`gate repaired: ${summary}`)
        await appendEnvPlaybook(
          ctx.envPlaybookPath,
          `gate repaired: ${summary} (${command} → ${fixed})`
        )
        command = fixed
        task.meta.verify = fixed
        await saveMeta(task)
        continue // re-run with the corrected gate
      }
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
type StageGuidance = (stage: GuidanceStage) => string | null

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
  userFacing: boolean,
  stageGuidance: StageGuidance,
  workforcePlan: WorkforcePlan | null
): Promise<PlanResult> {
  const planners = ctx.agents.planners
  const labels = plannerLabels(planners)
  const lead = ctx.agents.implementer

  // 1. RESEARCH — either the legacy single dossier or a workforce-planned set of
  // independent scouts synthesized back into one canonical research.md.
  await setStatus(task, 'planning')
  let research: string
  if (workforcePlan) {
    await progress(
      ctx,
      task,
      'research',
      `research — ${workforcePlan.research.length}-scout workforce`
    )
    const agents = agentChoiceMap(ctx)
    const scoutResults = await settleStage(
      task.id,
      'research',
      workforcePlan.research.map((entry) => ({
        key: entry.kind,
        promise: (async () => {
          const agent = agents.get(entry.agent) ?? ctx.agents.implementer
          const policies = await renderPolicies(ctx, entry.policies, `research.${entry.kind}`)
          const text = await agentStep(
            meter,
            `research.${entry.kind}`,
            agentLabel(agent),
            runAgent(agent, {
              root: ctx.root,
              prompt: researchScoutPrompt(
                entry.kind,
                intent,
                verify,
                ctx.plansDir,
                userFacing,
                policies
              ),
              access: entry.kind === 'external' ? 'research' : 'read',
              outFile: `${task.dir}/research.${entry.kind}.md`,
            }),
            `${agentLabel(agent)} · research/${entry.kind}`
          )
          return { label: entry.kind, text } satisfies Labeled
        })(),
      }))
    )
    const reports = scoutResults.map((r) => r.value)
    await progress(ctx, task, 'research', 'research — synthesizing scouts')
    research = await agentStep(
      meter,
      'research',
      agentLabel(normAgent(ctx.config.agents.workforce)),
      runAgent(normAgent(ctx.config.agents.workforce), {
        root: ctx.root,
        prompt: researchSynthesisPrompt(intent, reports),
        access: 'read',
        outFile: `${task.dir}/research.md`,
      })
    )
  } else {
    await progress(ctx, task, 'research', 'research — mapping the relevant code & history')
    research = await agentStep(
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
  }

  // 2. PLAN — every planner drafts in parallel (read-only). A crashed planner is
  // dropped from the ensemble (with its critique/revise seats) rather than
  // blocking the task; at least one draft must survive.
  await progress(ctx, task, 'plan', 'plan — drafting')
  const fullEnsemble = planners.map((agent, i) => ({
    agent,
    label: labels[i] ?? `plan-${i + 1}`,
  }))
  const draftResults = await settleStage(
    task.id,
    'plan',
    fullEnsemble.map((member) => ({
      key: member.label,
      promise: agentStep(
        meter,
        'plan',
        member.label,
        runAgent(member.agent, {
          root: ctx.root,
          prompt: planPrompt(
            intent,
            verify,
            answers,
            lessons,
            stageGuidance('plan'),
            research,
            userFacing
          ),
          access: 'read',
          outFile: `${task.dir}/plan.${member.label}.md`,
        })
      ),
    }))
  )
  const ensemble = fullEnsemble.filter((m) => draftResults.some((r) => r.key === m.label))
  const plans = ensemble.map((m) => draftResults.find((r) => r.key === m.label)?.value ?? '')
  const labeled = (texts: string[]): Labeled[] =>
    texts.map((text, i) => ({ label: ensemble[i]?.label ?? `plan-${i + 1}`, text }))

  // 3. CRITIQUE — each planner critiques the others' plans (only with ≥2). A
  // crashed critic degrades to a placeholder; the surviving critiques still flow.
  let critiques: string[] = []
  if (ensemble.length >= 2) {
    await progress(ctx, task, 'crit', 'critique — cross-reviewing the plans')
    const critiqueResults = await settleStage(
      task.id,
      'critique',
      ensemble.map((member, i) => ({
        key: member.label,
        promise: agentStep(
          meter,
          'critique',
          member.label,
          runAgent(member.agent, {
            root: ctx.root,
            prompt: critiquePrompt(
              intent,
              plans.filter((_, j) => j !== i).join('\n\n---\n\n'),
              answers,
              lessons,
              stageGuidance('critique'),
              research
            ),
            access: 'read',
            outFile: `${task.dir}/critique.${member.label}.md`,
          })
        ),
      })),
      0
    )
    critiques = ensemble.map(
      (member) =>
        critiqueResults.find((r) => r.key === member.label)?.value ??
        '(critique unavailable — the critic agent failed; weigh the plan on its own merits)'
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
      prompt: reconcilePrompt(
        intent,
        labeled(plans),
        critiquesForReconcile,
        answers,
        stageGuidance('reconcile'),
        renderAskCalibration(await readAskStats(ctx.repoStateDir))
      ),
      access: 'read',
      outFile: `${task.dir}/reconcile.md`,
    })
  )
  const reconcileDecision = parseReconcileDecision(reconcile)
  if (reconcileDecision === null) {
    // The escalation valve must fail CLOSED. A reconcile output with no parseable
    // DECISION used to fall through to proceed — silently overriding the one
    // checkpoint whose job is to stop factory from building the wrong thing.
    log.warn(`${task.id}: reconcile output had no DECISION marker; treating it as ASK`)
  }
  if (reconcileDecision !== 'PROCEED') {
    const questions = reconcile.replace(/^\s*DECISION:\s*ASK\s*/i, '').trim() || reconcile
    await writeQuestions(task, questions)
    await appendCandidate(ctx, `needs-input · ${task.id} · ${firstLine(questions)}`)
    logTotal(meter)
    return { pause: { ok: false, kind: 'needs-input', questions } }
  }

  // 4. REVISE — each planner improves its own plan using the critiques (≥2 only).
  // A crashed reviser keeps its original draft instead of blocking the task.
  let revised = plans
  if (ensemble.length >= 2) {
    await progress(ctx, task, 'revise', 'revise — improving each plan')
    const allCritiques =
      critiques.map((text, i) => `## Critique (${ensemble[i]?.label})\n${text}`).join('\n\n') +
      (uxCritique ? `\n\n## Critique (ux/ia)\n${uxCritique}` : '')
    const reviseResults = await settleStage(
      task.id,
      'revise',
      ensemble.map((member, i) => ({
        key: member.label,
        promise: agentStep(
          meter,
          'revise',
          member.label,
          runAgent(member.agent, {
            root: ctx.root,
            prompt: revisePrompt(intent, plans[i] ?? '', allCritiques),
            access: 'read',
            outFile: `${task.dir}/plan.${member.label}.v2.md`,
          })
        ),
      })),
      0
    )
    revised = ensemble.map(
      (member, i) => reviseResults.find((r) => r.key === member.label)?.value ?? plans[i] ?? ''
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
      prompt: sharpenPrompt(transcript(turns), true, await conductorAskCalibration(ctx)),
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
    await writeQuestions(task, questions)
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
      prompt: sharpenPrompt(transcript(turns), false, await conductorAskCalibration(ctx)),
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
      await writeQuestions(task, questionText)
      await appendCandidate(ctx, `needs-input · ${task.id} · ${firstLine(questionText)}`)
      return { pause: questionsOutcome(questionText) }
    }
    candidate = await finalizeSharpen(ctx, task, meter, turns, { intent, verify })
  }

  return reviewSharpenSpec(ctx, task, meter, turns, candidate)
}

function deliveryConfirmationSummary(delivery: TaskDelivery): string {
  switch (delivery.mode) {
    case 'skill':
      return deliveryRecommendation(delivery) ?? 'skill'
    case 'policy':
      return 'policy'
    case 'none':
      return 'none'
    case 'pending':
      return 'pending'
  }
}

function deliveryConfirmationPreamble(delivery: TaskDelivery): string {
  const recommendation = deliveryRecommendation(delivery) ?? 'none'
  const reason =
    delivery.mode === 'pending'
      ? 'No selector reason was available.'
      : (delivery.reason ?? 'The selector did not provide a reason.')

  return [
    `Confirm delivery - ${deliveryConfirmationSummary(delivery)} auto-selected.`,
    '',
    'Factory inferred a side-effecting delivery action early in the run.',
    `Proposed delivery: ${recommendation} (${deliveryLabel(delivery)})`,
    `Reason: ${reason}`,
    'Interactive: press Enter to accept, or type an accepted delivery answer.',
    'Non-interactive: to accept, answer with the recommended value shown below.',
    '',
    'Accepted answers: `none`, `$pr`, `/pr`, `$ship`, `/ship`, or a one-off delivery policy.',
  ].join('\n')
}

export function deliveryConfirmationQuestions(delivery: TaskDelivery): string {
  return formatQuestions(deliveryConfirmationPreamble(delivery), [
    {
      q: 'Which delivery should run when the task finishes after review, verify, and commit?',
      rec: deliveryRecommendation(delivery) ?? 'none',
    },
  ])
}

export function resolveDeliveryProposal(input: {
  proposed: TaskDelivery
  proposedAt: string | null
  answers: string | null
  skills: DeliverySkill[]
}): { kind: 'confirmed'; delivery: TaskDelivery } | { kind: 'needs-input'; questions: string } {
  const delivery = applyDeliveryConfirmation({
    proposed: input.proposed,
    answer: input.answers ? latestAnswerValueAfter(input.answers, input.proposedAt) : null,
    skills: input.skills,
  })
  if (delivery) {
    return { kind: 'confirmed', delivery }
  }
  return { kind: 'needs-input', questions: deliveryConfirmationQuestions(input.proposed) }
}

async function selectTaskDelivery(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  stats: RunStats,
  intent: string,
  verify: string | null
): Promise<TaskOutcome | null> {
  await refreshMeta(task)
  const skills = await listDeliverySkills(ctx.root, ctx.repoStateDir)
  const resumeOnPause = task.meta.commit !== null || (await readPlan(task)) !== null
  if (task.meta.deliveryProposal) {
    if (!task.meta.deliveryProposalAt) {
      task.meta.deliveryProposalAt = new Date().toISOString()
      task.meta.resume = resumeOnPause
      task.meta.updatedAt = task.meta.deliveryProposalAt
      await saveMeta(task)
      return needsInput(
        ctx,
        task,
        meter,
        stats,
        deliveryConfirmationQuestions(task.meta.deliveryProposal)
      )
    }
    const resolved = resolveDeliveryProposal({
      proposed: task.meta.deliveryProposal,
      proposedAt: task.meta.deliveryProposalAt,
      answers: await readAnswers(task),
      skills,
    })
    if (resolved.kind === 'needs-input') {
      task.meta.resume = resumeOnPause
      task.meta.updatedAt = new Date().toISOString()
      await saveMeta(task)
      return needsInput(ctx, task, meter, stats, resolved.questions)
    }
    await setTaskDelivery(task, resolved.delivery)
    log.info(`${task.id}: delivery — ${deliveryLabel(resolved.delivery)} confirmed`)
    return null
  }

  if (task.meta.delivery.mode !== 'pending') {
    return null
  }

  await progress(ctx, task, 'delivery-select', 'delivery — choosing completion action')
  const history = formatDeliveryHistory(await readDeliveryHistory(ctx))
  const output = await agentStep(
    meter,
    'delivery-select',
    agentLabel(ctx.agents.reviewer),
    runAgent(ctx.agents.reviewer, {
      root: ctx.root,
      prompt: deliverySelectPrompt({
        intent,
        verify,
        skills,
        history,
      }),
      access: 'read',
      outFile: `${task.dir}/delivery.md`,
    })
  )
  const selection = parseDeliverySelection(
    output,
    skills.map((skill) => skill.name)
  )
  if (!deliveryNeedsConfirmation(selection.delivery)) {
    await setTaskDelivery(task, selection.delivery)
    log.info(`${task.id}: delivery — ${selection.delivery.mode}`)
    return null
  }

  // The earned-autonomy dial: side-effecting deliveries skip the confirmation
  // pause when recent telemetry has earned it (config.autoShip), and fall back
  // to confirming the moment the numbers dip. Explicit directives and manual
  // `factory delivery` choices already skip confirmation; this extends that
  // trust to auto-selected deliveries, mechanically.
  const autoShip = ctx.config.autoShip
  if (autoShip) {
    const readiness = recentFirstPassYield(ctx.metricsPath, autoShip.minTasks)
    if (
      readiness &&
      readiness.tasks >= autoShip.minTasks &&
      readiness.firstPassYield >= autoShip.minFirstPassYield
    ) {
      await setTaskDelivery(task, selection.delivery)
      log.info(
        `${task.id}: delivery — ${deliveryLabel(selection.delivery)} auto-confirmed ` +
          `(earned autonomy: ${(readiness.firstPassYield * 100).toFixed(0)}% first-pass yield ` +
          `over last ${readiness.tasks} tasks)`
      )
      return null
    }
  }

  const now = new Date().toISOString()
  task.meta.deliveryProposal = selection.delivery
  task.meta.deliveryProposalAt = now
  task.meta.resume = resumeOnPause
  task.meta.updatedAt = now
  await saveMeta(task)
  log.info(`${task.id}: delivery — ${deliveryLabel(selection.delivery)} needs confirmation`)
  return needsInput(ctx, task, meter, stats, deliveryConfirmationQuestions(selection.delivery))
}

async function runPrototypeStage(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  intent: string,
  finalPlan: string,
  riskAssessment: string | null,
  guidance: string | null
): Promise<void> {
  try {
    await progress(ctx, task, 'prototype', 'prototype — checking whether an artifact helps')
    const output = await agentStep(
      meter,
      'prototype',
      agentLabel(ctx.agents.implementer),
      runAgent(ctx.agents.implementer, {
        root: ctx.root,
        prompt: prototypePrompt(intent, finalPlan, riskAssessment, guidance),
        access: 'read',
        outFile: `${task.dir}/${PROTOTYPE_RAW}`,
      })
    )
    const result = await writePrototypeOutput(task, output)
    if (result.decision === 'created') {
      log.info(`${task.id}: prototype available — ${result.artifact}`)
      log.info(`${task.id}: prototype URL — ${result.url}`)
    } else if (result.decision === 'fallback') {
      log.warn(`${task.id}: prototype output malformed (${result.reason}); saved prototype.md`)
    } else {
      log.info(`${task.id}: prototype skipped — ${result.reason}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`${task.id}: prototype unavailable — ${message}`)
    try {
      await writePrototypeFallback(
        task,
        `Prototype stage failed before producing a usable artifact.\n\n${message}`,
        message
      )
    } catch (writeErr) {
      log.warn(
        `${task.id}: prototype fallback write failed — ${
          writeErr instanceof Error ? writeErr.message : writeErr
        }`
      )
    }
  }
}

// Run a single task. A trivial task (per triage or declared metadata) takes the fast
// path — straight to implement — while a complex one goes through the full planning ensemble.
// Both are then reviewed, verified, committed, and delivered according to task state.
export async function runTask(ctx: WorkContext, task: Task): Promise<TaskOutcome> {
  let intent = await readIntent(task)
  let verify = task.meta.verify
  await sweepInterruptedMeter(task)
  const meter = newMeter(task)
  await persistLiveMeter(meter)
  const lead = ctx.agents.implementer
  const stats: RunStats = { triage: null, retries: 0, verifyFirstTry: null }
  const stageGuidance = await stageGuidanceForRun(ctx, meter)

  const baselineDiff = await worktreeDiff(ctx.root)
  const baselineHasChanges = await hasChanges(ctx.root)
  await writeArtifact(task, 'baseline.patch', baselineDiff)
  if (baselineHasChanges) {
    log.warn(
      `${task.id}: worktree already has changes; factory will review and commit the whole worktree`
    )
  }
  // Whether this task is user-facing (gates the UI/UX lenses). Set by triage on a
  // fresh run; restored from metadata or derived from the existing diff on resume.
  let userFacing = ctx.config.ux && (task.meta.userFacing ?? false)
  let classifiedUserFacing = task.meta.userFacing
  let triageClassifiedUserFacing = false

  // Standing human answers, read on BOTH paths: a resumed run re-enters at the
  // gates, and the gate stages (consolidate, fix) need the settled decisions too —
  // the one-shot resumeNote alone let the loop re-ask answered questions.
  const answers = await readAnswers(task)

  // RESUME — reuse the saved plan + the existing worktree and pick up where the
  // task left off, skipping the (expensive) planning ensemble. The marker + any
  // human note are consumed here, so a later re-run starts fresh again.
  const resuming = task.meta.resume
  const resumeKind = task.meta.resumeKind
  let resumeNote: string | null = null
  let finalPlan: string
  let riskAssessment: string | null = null
  let shouldPrototype = false
  let workforcePlan: WorkforcePlan | null = null
  if (resuming) {
    finalPlan = (await readPlan(task)) ?? intent
    riskAssessment = await readArtifact(task, 'risk.plan.md')
    workforcePlan = await readWorkforcePlan(task)
    resumeNote = task.meta.resumeNote
    task.meta.resume = false
    task.meta.resumeNote = null
    task.meta.resumeKind = null
    await saveMeta(task)
    log.info(
      `${task.id}: resuming — reusing plan + existing work${resumeNote ? ' (with your note)' : ''}`
    )
  } else {
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
      if (!triage.complexityMarker || !triage.userFacingMarker) {
        // Defaults still apply (complex / not-user-facing) but a missing marker is
        // a prompt-contract violation worth surfacing — a silent USER-FACING miss
        // disables the UX review gate for the whole task.
        log.warn(
          `${task.id}: triage output missing ${[
            !triage.complexityMarker && 'COMPLEXITY',
            !triage.userFacingMarker && 'USER-FACING',
          ]
            .filter(Boolean)
            .join(' and ')} marker(s); using defaults`
        )
      }
      trivial = triage.trivial
      stats.triage = trivial ? 'trivial' : 'complex'
      classifiedUserFacing = triage.userFacing
      userFacing = ctx.config.ux && classifiedUserFacing
      triageClassifiedUserFacing = true
      task.meta.userFacing = classifiedUserFacing
      task.meta.updatedAt = new Date().toISOString()
      await saveMeta(task)
    }

    if (trivial && task.meta.sharpen === 'pending') {
      task.meta.sharpen = 'skipped'
      await saveMeta(task)
    }

    if (trivial) {
      log.info(`${task.id}: trivial — fast path (skipping the plan ensemble)`)
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
    }

    const deliveryPause = await selectTaskDelivery(ctx, task, meter, stats, intent, verify)
    if (deliveryPause) {
      return deliveryPause
    }

    if (trivial) {
      finalPlan = intent
    } else {
      workforcePlan = await runWorkforcePlanner(ctx, task, meter, intent, verify, userFacing)

      const planned = await planEnsemble(
        ctx,
        task,
        meter,
        intent,
        verify,
        answers,
        lessons,
        userFacing,
        stageGuidance,
        workforcePlan
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
      shouldPrototype = true
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

  if (resuming) {
    const deliveryPause = await selectTaskDelivery(ctx, task, meter, stats, intent, verify)
    if (deliveryPause) {
      return deliveryPause
    }
  }

  if (shouldPrototype) {
    await runPrototypeStage(
      ctx,
      task,
      meter,
      intent,
      finalPlan,
      riskAssessment,
      stageGuidance('prototype')
    )
  }

  if (triageClassifiedUserFacing || classifiedUserFacing !== undefined) {
    task.meta.userFacing = classifiedUserFacing
    task.meta.updatedAt = new Date().toISOString()
    await saveMeta(task)
  }

  const feedbackContext = await analyzeFeedbackIfPending(ctx, task, meter, intent, finalPlan)
  const prototype = await prototypeContext(task)

  // Crash-window recovery: the commit ran but the loop died before the SHA was
  // recorded. A clean tree + a set commitStartedAt means HEAD is this task's
  // commit — adopt it rather than re-implementing on a clean tree.
  if (resuming && !task.meta.commit && task.meta.commitStartedAt) {
    if (!(await hasChanges(ctx.root))) {
      task.meta.commit = await headSha(ctx.root)
      log.warn(`${task.id}: recovered commit ${task.meta.commit} from an interrupted commit step`)
    }
    task.meta.commitStartedAt = null
    await saveMeta(task)
  }

  // A resume whose work already committed only has delivery left — skip the build.
  if (resuming && task.meta.commit) {
    return shipAndFinish(ctx, task, intent, meter, stats, stageGuidance)
  }

  // On resume, triage didn't run — derive user-facing from the existing diff so the
  // fix pass still gets the design-context note. (The UX review gate detects it too.)
  if (resuming && ctx.config.ux) {
    const diffUserFacing =
      task.meta.userFacing === undefined ? uiInDiff(await worktreeDiff(ctx.root)) : false
    userFacing = resumeUserFacing(ctx.config.ux, task.meta.userFacing, diffUserFacing)
  }

  // 5–7. IMPLEMENT → REVIEW → VERIFY with auto-fix: on a failed gate, feed the
  // failure back into a fix pass. Termination is by the convergence judge (keep
  // going while failures are genuinely new, stop when stuck — see assessFailure),
  // with config.retries as the hard-cap backstop. Failures accumulate across the
  // whole task (loaded here so the history survives resumes) and feed the fixer.
  let attempt = 0
  const hardCap = ctx.config.retries
  const failures = await readFailures(task)
  let rescueUsed = false
  let quickFixUsed = false
  const rescueOnce = async (latestFailure: string): Promise<FailureAction | null> => {
    if (rescueUsed) {
      return null
    }
    rescueUsed = true
    return rescueTerminalFailure({
      ctx,
      task,
      meter,
      intent,
      finalPlan,
      verify,
      failures,
      attempt,
      latestFailure,
      guidance: stageGuidance('postmortem'),
    })
  }
  // On resume with an existing diff, re-enter at the gates: run them against the
  // work already in the worktree, and only implement (a fix pass) if one fails.
  let skipImplement = resuming && (await hasChanges(ctx.root))
  // A note-less auto-retry is a transient retry: re-run the gates on the existing
  // diff but DON'T re-implement first (a verify env-flake mustn't churn code). If
  // those gates now surface a real code/review failure, let the normal convergence
  // judge decide whether it is fixable instead of treating the backoff as spent
  // implementation budget.
  if (skipImplement && resumeKind === 'auto-retry' && !resumeNote && !feedbackContext) {
    attempt = implementationAttemptCount(failures)
  }
  if (skipImplement && (resumeNote || feedbackContext)) {
    skipImplement = false
    attempt = Math.max(1, implementationAttemptCount(failures))
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
            stageGuidance('fix'),
            feedbackContext?.analysis ?? null,
            prototype,
            answers
          )
        : implementPrompt(
            intent,
            finalPlan,
            verify,
            userFacing,
            riskAssessment,
            stageGuidance('implement'),
            feedbackContext?.analysis ?? null,
            prototype
          )
      await agentStep(
        meter,
        'implement',
        agentLabel(lead),
        runAgent(lead, {
          root: ctx.root,
          prompt: stagePrompt,
          access: ctx.config.implementerAccess === 'full' ? 'full' : 'write',
          outFile: `${task.dir}/implement.log.md`,
        })
      )

      if (!(await hasChanges(ctx.root))) {
        return blocked(
          ctx,
          task,
          meter,
          stats,
          'implementation produced no changes',
          undefined,
          stageGuidance('postmortem')
        )
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
    const legacyReviewEntries: Array<WorkforceEntry<ReviewLens>> = [
      {
        kind: 'correctness',
        agent: defaultReviewAgentId(ctx, 'correctness'),
        policies: [],
        reason: 'Legacy review default.',
      },
    ]
    if (ctx.config.security) {
      legacyReviewEntries.push({
        kind: 'security',
        agent: defaultReviewAgentId(ctx, 'security'),
        policies: [],
        reason: 'Legacy review default.',
      })
    }
    legacyReviewEntries.push(
      {
        kind: 'risk',
        agent: defaultReviewAgentId(ctx, 'risk'),
        policies: [],
        reason: 'Legacy review default.',
      },
      {
        kind: 'deploy',
        agent: defaultReviewAgentId(ctx, 'deploy'),
        policies: [],
        reason: 'Legacy review default.',
      }
    )
    if (ctx.config.ux && (userFacing || uiInDiff(diff))) {
      legacyReviewEntries.push({
        kind: 'ux',
        agent: defaultReviewAgentId(ctx, 'ux'),
        policies: [],
        reason: 'Legacy review default.',
      })
    }
    const legacyReview: WorkforcePlan = {
      research: [],
      review: legacyReviewEntries,
    }
    let reviewEntries = reviewWorkforceForDiff(ctx, workforcePlan ?? legacyReview, userFacing, diff)
    if (attempt > 0) {
      // Fix-pass panels are scoped to the gating lenses (correctness, security,
      // ux-when-relevant). Risk and deploy safety are advisory scorers — they
      // already assessed the change on the first pass, and re-running the full
      // 5-expert panel after every small fix was one of the largest measured
      // waste mechanisms (one task paid 240M review tokens across 84 re-panels).
      const gating = new Set(['correctness', 'security', 'ux'])
      reviewEntries = reviewEntries.filter((entry) => gating.has(entry.kind))
    }
    // On fix passes the gating lenses see the previous consolidated verdict:
    // without it every round re-reviews with fresh eyes, and panels have issued
    // blockers that reversed their own prior-round guidance (the fixer obeyed
    // both directions in turn — churn no fingerprint can catch). The reviewers
    // also see the human answers so settled decisions and explicitly accepted
    // risks stop resurfacing as findings.
    const priorReview = attempt > 0 ? await readArtifact(task, 'consolidated.md') : null
    const agents = agentChoiceMap(ctx)
    const panel: Array<{ key: string; label: string; agent: Agent; prompt: string }> = []
    for (const entry of reviewEntries) {
      const agent = agents.get(entry.agent) ?? reviewer
      const baseline = baselineHasChanges ? baselineDiff : null
      if (entry.kind === 'correctness') {
        panel.push({
          key: 'review',
          label: 'correctness',
          agent,
          prompt: reviewPrompt(
            intent,
            verify,
            finalPlan,
            diff,
            baseline,
            combineGuidance(
              stageGuidance('review'),
              await renderPolicies(ctx, entry.policies, 'review.correctness')
            ),
            answers,
            priorReview
          ),
        })
      } else if (entry.kind === 'security') {
        panel.push({
          key: 'security',
          label: 'security',
          agent,
          prompt: securityPrompt(
            intent,
            finalPlan,
            diff,
            baseline,
            combineGuidance(
              stageGuidance('security'),
              await renderPolicies(ctx, entry.policies, 'review.security')
            ),
            answers,
            priorReview
          ),
        })
      } else if (entry.kind === 'risk') {
        panel.push({
          key: 'risk',
          label: 'risk',
          agent,
          prompt: riskReviewPrompt(
            intent,
            finalPlan,
            diff,
            baseline,
            await renderPolicies(ctx, entry.policies, 'review.risk')
          ),
        })
      } else if (entry.kind === 'deploy') {
        panel.push({
          key: 'deploy',
          label: 'deploy safety',
          agent,
          prompt: deploySafetyPrompt(
            intent,
            finalPlan,
            diff,
            baseline,
            combineGuidance(
              stageGuidance('deploy-safety'),
              await renderPolicies(ctx, entry.policies, 'review.deploy')
            ),
            answers
          ),
        })
      } else if (entry.kind === 'ux') {
        panel.push({
          key: 'ux',
          label: 'ux/design',
          agent,
          prompt: uxReviewPrompt(
            intent,
            finalPlan,
            diff,
            baseline,
            combineGuidance(
              stageGuidance('ux-review'),
              await renderPolicies(ctx, entry.policies, 'review.ux')
            ),
            answers,
            priorReview
          ),
        })
      }
    }
    await progress(ctx, task, 'review', `review — ${panel.length}-expert panel`)
    // A crashed expert must not discard the rest of the panel: surviving reports
    // go to the consolidator with an explicit note about who is missing, so the
    // verdict is made knowing its coverage. At least one expert must survive.
    const panelResults = await settleStage<Labeled>(
      task.id,
      'review',
      panel.map((e) => ({
        key: e.key,
        promise: agentStep(
          meter,
          e.key,
          agentLabel(e.agent),
          runAgent(e.agent, {
            root: ctx.root,
            prompt: e.prompt,
            access: 'read',
            outFile: `${task.dir}/${e.key}.md`,
          }),
          `${agentLabel(e.agent)} · ${e.label}`
        ).then((text): Labeled => ({ label: e.label, text })),
      }))
    )
    const reports = panelResults.map((r) => r.value)
    for (const e of panel) {
      if (!panelResults.some((r) => r.key === e.key)) {
        reports.push({
          label: e.label,
          text: `(no report — the ${e.label} expert crashed; its lens did NOT review this diff)`,
        })
      }
    }
    if (priorReview) {
      reports.push({
        label: 'prior consolidated verdict (before this fix attempt)',
        text: priorReview,
      })
    }

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
          baselineHasChanges ? baselineDiff : null,
          stageGuidance('consolidate'),
          answers
        ),
        access: 'read',
        outFile: `${task.dir}/consolidated.md`,
      })
    )
    const verdict = parseReviewVerdict(consolidated)
    if (verdict === 'PASS' && !quickFixUsed) {
      const quickFixes = extractQuickFixes(consolidated)
      if (quickFixes) {
        // One bounded pass clearing the cheap advisories, then straight to
        // verify — no re-panel. If a quick fix breaks verify, that failure feeds
        // the normal (mechanically bounded) fix machinery like any other.
        quickFixUsed = true
        await setStatus(task, 'implementing')
        await progress(ctx, task, 'quickfix', 'quick fixes — applying cheap advisories')
        await agentStep(
          meter,
          'quickfix',
          agentLabel(lead),
          runAgent(lead, {
            root: ctx.root,
            prompt: quickFixPrompt(intent, quickFixes, diff),
            access: ctx.config.implementerAccess === 'full' ? 'full' : 'write',
            outFile: `${task.dir}/quickfix.log.md`,
          })
        )
        await writeArtifact(task, 'diff.patch', await worktreeDiff(ctx.root))
      }
    }
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
      if (action.kind === 'continue') {
        attempt++
        continue
      }
      if (action.kind === 'retry') {
        return retryLater(ctx, task, meter, stats, action.reason)
      }
      if (action.kind === 'needs-input') {
        return needsInput(ctx, task, meter, stats, action.questions)
      }
      const rescued = await rescueOnce(consolidated)
      if (rescued?.kind === 'continue') {
        attempt++
        continue
      }
      if (rescued?.kind === 'retry') {
        return retryLater(ctx, task, meter, stats, rescued.reason)
      }
      if (rescued?.kind === 'needs-input') {
        return needsInput(ctx, task, meter, stats, rescued.questions)
      }
      return blocked(
        ctx,
        task,
        meter,
        stats,
        `review blocked after ${attempt + 1} implementation attempts`,
        consolidated,
        stageGuidance('postmortem')
      )
    }

    // VERIFY — run the task's verification command, with self-remediation: an
    // environment/setup failure is repaired in place and re-run (no code churn);
    // only a real code defect feeds the code-fix loop, and a flake / unfixable env
    // problem goes straight to the backoff retry instead of burning fix attempts.
    if (verify) {
      const v = await verifyGate(ctx, task, meter, intent, verify, stageGuidance('remediate'))
      if (v.kind === 'pass') {
        verify = v.verify // adopt a doctor-repaired gate for proof/resume/ship
      }
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
        if (action.kind === 'continue') {
          attempt++
          continue
        }
        if (action.kind === 'retry') {
          return retryLater(ctx, task, meter, stats, action.reason)
        }
        if (action.kind === 'needs-input') {
          return needsInput(ctx, task, meter, stats, action.questions)
        }
        const rescued = await rescueOnce(v.detail)
        if (rescued?.kind === 'continue') {
          attempt++
          continue
        }
        if (rescued?.kind === 'retry') {
          return retryLater(ctx, task, meter, stats, rescued.reason)
        }
        if (rescued?.kind === 'needs-input') {
          return needsInput(ctx, task, meter, stats, rescued.questions)
        }
        return blocked(
          ctx,
          task,
          meter,
          stats,
          `verify failed after ${attempt + 1} implementation attempts`,
          v.detail,
          stageGuidance('postmortem')
        )
      }
      if (v.kind === 'aside') {
        // Flake or an environment problem remediation couldn't fix: don't re-implement
        // code over it. Record the failure to history (so it's visible and feeds the
        // next pass) and hand to the backoff auto-retry — env issues like a service
        // that isn't up yet often clear on their own. At the cap, the convergence
        // judge chooses whether to fix code, retry later, ask, or stop.
        const entry: Failure = {
          attempt,
          gate: 'verify',
          summary: firstLine(v.detail).slice(0, 200),
          detail: v.detail,
          remediation: 'backoff',
        }
        failures.push(entry)
        await appendFailure(task, entry)
        if (task.meta.autoRetries >= AUTO_CAP) {
          const judged = await judgeFailure(
            ctx,
            task,
            meter,
            intent,
            failures.slice(0, -1),
            v.detail,
            `transient auto-retry limit ${AUTO_CAP} reached`
          )
          switch (judged.action.kind) {
            case 'continue':
              attempt++
              continue
            case 'retry':
              return retryLater(ctx, task, meter, stats, judged.action.reason)
            case 'needs-input':
              return needsInput(ctx, task, meter, stats, judged.action.questions)
            case 'terminal':
              return blocked(
                ctx,
                task,
                meter,
                stats,
                `${v.reason} (terminal after ${AUTO_CAP} auto-retries)`,
                v.detail,
                stageGuidance('postmortem')
              )
          }
        }
        return retryLater(ctx, task, meter, stats, v.reason)
      }
      // Passed verify — first try iff no prior code-fix attempts (an environment
      // remediation isn't a code fix, so it doesn't disqualify first-try).
      stats.verifyFirstTry = attempt === 0
    } else {
      log.warn(`${task.id}: no verify command — skipping verification gate`)
    }

    break // both gates passed
  }

  // Gate passed: record proof and commit on the branch. Proof is a self-contained
  // record of WHAT passed — verdict summary, real verify output, and the shape of
  // the change — not a stub pointing at files that later get overwritten.
  const consolidatedVerdict = await readArtifact(task, 'consolidated.md')
  const verifyLog = await readArtifact(task, 'verify.log')
  const diffForProof = await worktreeDiff(ctx.root)
  const proof = [
    `# Proof — ${task.id}`,
    '',
    `Recorded: ${new Date().toISOString()}`,
    `Fix attempts: ${attempt}`,
    '',
    '## Review verdict',
    consolidatedVerdict ? consolidatedVerdict.split('\n').slice(0, 40).join('\n') : 'VERDICT: PASS',
    '',
    '## Verify',
    verify ? `\`${verify}\` passed` : 'no verify command',
    ...(verifyLog ? ['', '```', ...verifyLog.split('\n').slice(-30), '```'] : []),
    '',
    '## Change shape',
    '```',
    ...diffForProof.split('\n').slice(0, 60),
    '```',
  ].join('\n')
  await writeArtifact(task, 'proof.md', proof)

  const message = await synthesizeCommitMessage(ctx, task, meter, intent, finalPlan, verify)
  // Mark commit intent BEFORE running git commit: a crash between the commit and
  // the meta save must be recoverable (see meta.commitStartedAt).
  task.meta.commitStartedAt = new Date().toISOString()
  await saveMeta(task)
  await commitAll(ctx.root, message)
  task.meta.commit = await headSha(ctx.root)
  task.meta.commitStartedAt = null
  if (feedbackContext) {
    await refreshFeedbackState(task)
    markFeedbackConsumed(task, feedbackContext.count)
  }
  await saveMeta(task)

  return shipAndFinish(ctx, task, intent, meter, stats, stageGuidance)
}

// 8. Delivery — outward-facing delivery via the delivery agent (run a skill or
// follow a policy). Split out so a resume whose work already committed can re-run
// just this step. A ship failure is transient (CI/network), so it feeds the same
// backoff auto-retry as verify rather than hard-blocking.
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

async function writeCompletionDeck(ctx: WorkContext, task: Task, intent: string, meter: Meter) {
  try {
    await progress(ctx, task, 'deck', 'building brief')
    const diff = task.meta.commit ? await commitDiff(ctx.root, task.meta.commit) : null
    const html = await buildDeckHtml(async () =>
      agentStep(
        meter,
        'deck',
        agentLabel(ctx.agents.delivery),
        runAgent(ctx.agents.delivery, {
          root: ctx.root,
          prompt: deckPrompt({
            taskId: task.id,
            intent: clipFeedbackInput(intent) ?? '',
            finalPlan: clipFeedbackInput(await readPlan(task)),
            verify: task.meta.verify,
            diff: clipFeedbackInput(diff),
            proof: clipFeedbackInput(await readArtifact(task, 'proof.md')),
            verifyLog: clipFeedbackInput(await readArtifact(task, 'verify.log')),
            ship: clipFeedbackInput(await readArtifact(task, 'ship.md')),
            feedback: clipFeedbackInput(await readArtifact(task, 'feedback.md')),
          }),
          access: 'read',
        }),
        'brief'
      )
    )
    if (!html) {
      log.warn(`${task.id}: deck unavailable (task still done) - no valid HTML produced`)
      return
    }
    await writeArtifact(task, 'brief.html', html)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`${task.id}: deck unavailable (task still done) - ${message}`)
  }
}

async function shipAndFinish(
  ctx: WorkContext,
  task: Task,
  intent: string,
  meter: Meter,
  stats: RunStats,
  stageGuidance: StageGuidance
): Promise<TaskOutcome> {
  await refreshMeta(task)
  if (task.meta.deliveryProposal) {
    const deliveryPause = await selectTaskDelivery(
      ctx,
      task,
      meter,
      stats,
      intent,
      task.meta.verify
    )
    if (deliveryPause) {
      return deliveryPause
    }
    await refreshMeta(task)
  }
  if (task.meta.delivery.mode === 'pending') {
    await setTaskDelivery(task, {
      mode: 'none',
      source: 'fallback',
      confidence: 'low',
      reason: 'delivery was still pending after commit; defaulted to none',
    })
  }
  const action = deliveryAction(task.meta.delivery)
  if (action) {
    await setStatus(task, 'shipping')
    await progress(ctx, task, 'ship', 'delivery — delivering')
    const branch = await currentBranch(ctx.root)
    const shipOut = await agentStep(
      meter,
      'ship',
      agentLabel(ctx.agents.delivery),
      runAgent(ctx.agents.delivery, {
        root: ctx.root,
        prompt: shipPrompt(intent, branch, action),
        access: 'full',
        outFile: `${task.dir}/ship.md`,
      })
    )
    const ship = parseShip(shipOut)
    if (!ship.ok) {
      try {
        await appendDeliveryHistory(ctx, task, 'failed')
      } catch (err) {
        log.warn(`delivery history: ${err instanceof Error ? err.message : String(err)}`)
      }
      return setAside(
        ctx,
        task,
        meter,
        stats,
        `ship failed: ${ship.reason}`,
        shipOut,
        intent,
        stageGuidance('postmortem')
      )
    }
    // Delivery may append commits (CI fixes, review responses); keep meta.commit
    // pointing at the true HEAD instead of the pre-ship commit. Record where the
    // work went (branch + MR/PR url) — post-ship harvesting keys on these.
    try {
      const head = await headSha(ctx.root)
      task.meta.commit = head
      task.meta.shipBranch = branch
      task.meta.shipUrl = parseShipUrl(shipOut)
      await saveMeta(task)
    } catch (err) {
      log.warn(`post-ship commit refresh failed for ${task.id}: ${formatErr(err)}`)
    }
  }

  await writeCompletionFeedback(ctx, task, intent, meter)
  await writeCompletionDeck(ctx, task, intent, meter)
  try {
    await appendDeliveryHistory(ctx, task, 'done')
  } catch (err) {
    log.warn(`delivery history: ${err instanceof Error ? err.message : String(err)}`)
  }
  logTotal(meter)
  recordTask(ctx, task, meter, 'done', stats)
  return { ok: true }
}

export async function deliverTask(ctx: WorkContext, task: Task): Promise<TaskOutcome> {
  const intent = await readIntent(task)
  await sweepInterruptedMeter(task)
  const meter = newMeter(task)
  await persistLiveMeter(meter)
  const stats: RunStats = { triage: null, retries: 0, verifyFirstTry: null }
  return shipAndFinish(ctx, task, intent, meter, stats, await stageGuidanceForRun(ctx, meter))
}

async function synthesizeCommitMessage(
  ctx: WorkContext,
  task: Task,
  meter: Meter,
  intent: string,
  finalPlan: string,
  verify: string | null
): Promise<string> {
  const fallback = fallbackCommitMessage(intent)
  try {
    await progress(ctx, task, 'commit-message', 'commit — writing message')
    const diff = await worktreeDiff(ctx.root)
    let subjects: string[] = []
    let authorSubjects: AuthorCommitSubjects | null = null
    try {
      subjects = await recentCommitSubjects(ctx.root)
    } catch (err) {
      log.warn(`commit message: recent history unavailable - ${formatErr(err)}`)
    }
    try {
      authorSubjects = await recentAuthorCommitSubjects(ctx.root)
    } catch (err) {
      log.warn(`commit message: author history unavailable - ${formatErr(err)}`)
    }
    const output = await agentStep(
      meter,
      'commit-message',
      agentLabel(ctx.agents.implementer),
      runAgent(ctx.agents.implementer, {
        root: ctx.root,
        prompt: commitMessagePrompt({
          intent,
          finalPlan,
          diff,
          recentSubjects: subjects,
          authorSubjects,
          verify,
        }),
        access: 'read',
        outFile: `${task.dir}/commit-message.md`,
      })
    )
    const message = cleanCommitMessage(output, fallback)
    await writeArtifact(task, 'commit-message.md', `${message}\n`)
    return message
  } catch (err) {
    log.warn(`commit message: using fallback - ${formatErr(err)}`)
    await writeArtifact(task, 'commit-message.md', `${fallback}\n`)
    return fallback
  }
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
