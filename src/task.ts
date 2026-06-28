import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { z } from 'zod'
import type { WorkContext } from './config.ts'
import { type TaskDelivery, TaskDeliverySchema } from './delivery.ts'

// A task is a directory under <dir>/tasks/<id>/ containing:
//   task.md   — human-owned intent (free-form markdown; what sharpening enriches)
//   meta.json — machine-owned status/verify/sharpen/timestamps
//   meter.json — machine-owned live token/stage counts for the current pass
//   plan.*.md, review.md, proof.md, feedback.md — conductor artifacts
// Splitting human prose from machine state means factory flips status without
// ever rewriting what you wrote.

export const StatusSchema = z.enum([
  'ready',
  'needs-input',
  // Live run-loop stage: refining a queued rough intent into a durable spec.
  'sharpening',
  // Legacy name for tasks created before the step was renamed.
  'grilling',
  'planning',
  'implementing',
  'reviewing',
  'verifying',
  'shipping',
  // Set aside after a transient gate failure (verify/ship), waiting on a backoff
  // before the loop auto-resumes it. Soft — no attention alert, unlike blocked.
  'retrying',
  'done',
  'blocked',
])
export type Status = z.infer<typeof StatusSchema>

const SharpenStateSchema = z.enum(['pending', 'done', 'skipped'])
export type SharpenState = z.infer<typeof SharpenStateSchema>

export const TaskComplexitySchema = z.enum(['trivial', 'complex'])
export type TaskComplexity = z.infer<typeof TaskComplexitySchema>

// Statuses where a task is at rest — no run-loop is actively working it: queued
// (ready), waiting on a human (needs-input/blocked), on a backoff (retrying), legacy
// interactive grilling, or finished (done). Every OTHER
// status is a live stage the conductor sets while working a task. Deriving the
// complement (rather than listing the stages) means a newly-added stage is covered
// automatically — the same heuristic factory_prompt uses for "in-progress".
const SETTLED: readonly Status[] = [
  'ready',
  'needs-input',
  'grilling',
  'retrying',
  'done',
  'blocked',
]

// A task left in a live stage with no loop on it: its run-loop was killed mid-stage
// (Ctrl-C / crash) and never transitioned the status. Safe to reclaim because the
// loop is sequential and one-per-worktree, so it only looks for work *between* tasks
// — nothing is working this one now.
export function isStranded(status: Status): boolean {
  return !SETTLED.includes(status)
}

// Statuses a `factory retry` with no id will adopt: a blocked/retrying task, or one
// stranded mid-stage. (An explicit id resumes a task regardless of status.)
export const RESUMABLE_STATUSES: Status[] = StatusSchema.options.filter(
  (s) => s === 'blocked' || s === 'retrying' || isStranded(s)
)

const MetaSchema = z.object({
  id: z.string(),
  slug: z.string(),
  status: StatusSchema.default('ready'),
  verify: z.string().nullable().default(null),
  createdAt: z.string(),
  // Bumped on every status change, so "how long in this stage" (and staleness)
  // is computable without a separate event log.
  updatedAt: z.string().nullable().default(null),
  // Short SHA recorded when the task's work is committed.
  commit: z.string().nullable().default(null),
  // Short human-facing note on the current status: a block reason, or a pointer
  // to questions.md when awaiting input.
  note: z.string().nullable().default(null),
  // Whether the raw intent still needs the run loop's sharpen pre-stage. Legacy
  // tasks default to done so upgrading does not unexpectedly rewrite old intents.
  sharpen: SharpenStateSchema.default('done'),
  // Resume bookkeeping. `resume` tells the next run to pick up where the task left
  // off — reuse the saved plan + existing diff, skip the planning ensemble — set by
  // `factory retry` and by the loop's auto-resume; consumed (cleared) on the run.
  // `resumeNote` carries optional human fix-context, consumed with it.
  resume: z.boolean().default(false),
  resumeNote: z.string().nullable().default(null),
  resumeKind: z.enum(['manual', 'auto-retry', 'stranded']).nullable().default(null),
  // Auto-resume of transient gate failures: when the backoff next elapses, and how
  // many loop-level retries have been spent against the cap.
  retryAt: z.string().nullable().default(null),
  autoRetries: z.number().int().default(0),
  // Explicit complexity declared by `factory add`; null means runtime triage decides.
  complexity: TaskComplexitySchema.nullable().default(null),
  // Task-local delivery decision. Pending tasks choose delivery before implementation
  // using repo context, available skills, history, and the task spec.
  delivery: TaskDeliverySchema.default({ mode: 'pending' }),
  deliveryProposal: TaskDeliverySchema.optional(),
  deliveryProposalAt: z.string().nullable().default(null),
  userFacing: z.boolean().optional(),
  // Human feedback recorded after progress exists. Counted separately from answers
  // so the conductor can consume feedback only after a verified commit.
  feedbackCount: z.number().int().nonnegative().default(0),
  feedbackConsumed: z.number().int().nonnegative().default(0),
  feedbackSourceTaskId: z.string().nullable().default(null),
})
export type Meta = z.infer<typeof MetaSchema>

export type Task = {
  id: string
  dir: string
  meta: Meta
}

const LiveMeterSchema = z.object({
  startedAt: z.string(),
  updatedAt: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  stages: z.array(
    z.object({
      stage: z.string(),
      agent: z.string(),
      inTok: z.number().int().nonnegative(),
      outTok: z.number().int().nonnegative(),
      ms: z.number().int().nonnegative(),
    })
  ),
})
export type LiveMeter = z.infer<typeof LiveMeterSchema>

function sanitizedSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

function slugify(text: string): string {
  const slug = sanitizedSlug(text)
  return slug.length > 0 ? slug : 'task'
}

function firstLine(text: string): string {
  return text.trim().split('\n', 1)[0] ?? ''
}

function alreadyExists(err: unknown): boolean {
  const parsed = z.object({ code: z.string() }).safeParse(err)
  return parsed.success && parsed.data.code === 'EEXIST'
}

export type AddTaskOptions = {
  status?: Status
  sharpen?: SharpenState
  complexity?: TaskComplexity | null
  delivery?: TaskDelivery
  feedbackSourceTaskId?: string | null
  suggestedSlug?: string | null
}

async function listTaskDirs(tasksDir: string): Promise<string[]> {
  try {
    const entries = await readdir(tasksDir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

export async function addTask(
  ctx: WorkContext,
  intent: string,
  verify: string | null,
  options: AddTaskOptions = {}
): Promise<Task> {
  await mkdir(ctx.tasksDir, { recursive: true })
  // Descriptive, number-free id; disambiguate same-named tasks with a -N suffix.
  // Claim the directory atomically so parallel `factory add`s cannot choose the
  // same id after racing through a list-then-create window.
  const suggestedSlug = sanitizedSlug(firstLine(options.suggestedSlug ?? ''))
  const slug = suggestedSlug || slugify(firstLine(intent))
  let id = slug
  let dir = `${ctx.tasksDir}/${id}`
  for (let n = 2; ; n++) {
    try {
      await mkdir(dir)
      break
    } catch (err) {
      if (!alreadyExists(err)) {
        throw err
      }
      id = `${slug}-${n}`
      dir = `${ctx.tasksDir}/${id}`
    }
  }

  const now = new Date().toISOString()
  const meta: Meta = {
    id,
    slug,
    status: options.status ?? 'ready',
    verify,
    createdAt: now,
    updatedAt: now,
    commit: null,
    note: null,
    sharpen: options.sharpen ?? 'done',
    resume: false,
    resumeNote: null,
    resumeKind: null,
    retryAt: null,
    autoRetries: 0,
    complexity: options.complexity ?? null,
    delivery: options.delivery ?? { mode: 'pending' },
    deliveryProposal: undefined,
    deliveryProposalAt: null,
    userFacing: undefined,
    feedbackCount: 0,
    feedbackConsumed: 0,
    feedbackSourceTaskId: options.feedbackSourceTaskId ?? null,
  }

  await Bun.write(`${dir}/task.md`, `${intent.trim()}\n`)
  await writeMeta(dir, meta)
  return { id, dir, meta }
}

// Finish a sharpened task: replace its intent with the refined spec, set the verify
// command, and mark it ready for the normal plan/implement pipeline.
export async function readySharpenedTask(
  task: Task,
  intent: string,
  verify: string | null
): Promise<void> {
  await Bun.write(`${task.dir}/task.md`, `${intent.trim()}\n`)
  task.meta.verify = verify
  task.meta.sharpen = 'done'
  task.meta.status = 'ready'
  task.meta.updatedAt = new Date().toISOString()
  await writeMeta(task.dir, task.meta)
}

export const readyGrilledTask = readySharpenedTask

// Remove a task entirely (its whole dir). Kept for legacy callers that cancel a
// task before it enters the run loop.
export async function deleteTask(task: Task): Promise<void> {
  await rm(task.dir, { recursive: true, force: true })
}

// Ordered oldest-first by createdAt (ids no longer carry a sortable number).
export async function loadTasks(ctx: WorkContext): Promise<Task[]> {
  const tasks: Task[] = []
  for (const name of await listTaskDirs(ctx.tasksDir)) {
    const dir = `${ctx.tasksDir}/${name}`
    const metaFile = Bun.file(`${dir}/meta.json`)
    if (!(await metaFile.exists())) {
      continue
    }
    tasks.push({ id: name, dir, meta: MetaSchema.parse(await metaFile.json()) })
  }
  return tasks.sort((a, b) => a.meta.createdAt.localeCompare(b.meta.createdAt))
}

// The next task for the run loop to execute, in priority order: a ready task; else a
// task stranded mid-stage by a killed loop (Ctrl-C/crash), reclaimed where it left
// off; else a due auto-retry — a 'retrying' task whose backoff has elapsed. The last
// two are promoted to a resume (reuse the saved plan + diff). Ready work takes
// priority so reclaims/retries fill idle time rather than starving fresh tasks.
// Returns null when nothing is runnable yet.
export async function nextRunnable(
  ctx: WorkContext,
  now: number = Date.now()
): Promise<Task | null> {
  const tasks = await loadTasks(ctx)
  const ready = tasks.find((t) => t.meta.status === 'ready')
  if (ready) {
    return ready
  }
  const stranded = tasks.find((t) => isStranded(t.meta.status))
  if (stranded) {
    return recoverStranded(stranded)
  }
  const due = tasks
    .filter(
      (t) =>
        t.meta.status === 'retrying' && t.meta.retryAt !== null && Date.parse(t.meta.retryAt) <= now
    )
    .sort((a, b) => (a.meta.retryAt ?? '').localeCompare(b.meta.retryAt ?? ''))
  const first = due[0]
  if (!first) {
    return null
  }
  return resumeRun(first, 'auto-retry')
}

// Flip a not-ready task into a resumed ready run: the conductor consumes meta.resume
// to reuse the saved plan + existing diff and pick up where it left off. Shared by the
// stranded-task reclaim and the due-auto-retry path.
async function resumeRun(task: Task, kind: 'manual' | 'auto-retry' | 'stranded'): Promise<Task> {
  task.meta.resume = true
  task.meta.resumeKind = kind
  task.meta.retryAt = null
  await setStatus(task, 'ready')
  return task
}

// Early planning has no durable selected plan yet, so restart it from the original
// intent. Once plan.md exists, the selected design is a resumable boundary.
async function recoverStranded(task: Task): Promise<Task> {
  if (task.meta.status === 'sharpening') {
    task.meta.resume = false
    task.meta.resumeKind = null
    task.meta.retryAt = null
    await setStatus(task, 'ready', `recovered after interrupted ${task.meta.status} stage`)
    return task
  }
  if (task.meta.status === 'planning' && !(await readPlan(task))) {
    task.meta.resume = false
    task.meta.resumeKind = null
    task.meta.retryAt = null
    await setStatus(task, 'ready', `recovered after interrupted ${task.meta.status} stage`)
    return task
  }
  task.meta.resumeNote =
    `Recovered after interrupted ${task.meta.status} stage. ` +
    'Inspect existing work and continue from the saved artifacts.'
  return resumeRun(task, 'stranded')
}

// Most recently-updated task in this worktree, optionally restricted to certain
// statuses. The sensible default target for show/add/retry when no id is given.
export async function latestTask(ctx: WorkContext, statuses?: Status[]): Promise<Task | null> {
  const tasks = (await loadTasks(ctx)).filter((t) => !statuses || statuses.includes(t.meta.status))
  if (tasks.length === 0) {
    return null
  }
  const stamp = (t: Task) => t.meta.updatedAt ?? t.meta.createdAt
  return tasks.reduce((a, b) => (stamp(b) > stamp(a) ? b : a))
}

export async function setStatus(
  task: Task,
  status: Status,
  note: string | null = null
): Promise<void> {
  task.meta.status = status
  task.meta.note = note
  task.meta.updatedAt = new Date().toISOString()
  await writeMeta(task.dir, task.meta)
}

// Persist meta after mutating a field directly (e.g. recording the commit SHA).
export async function saveMeta(task: Task): Promise<void> {
  await writeMeta(task.dir, task.meta)
}

export async function refreshMeta(task: Task): Promise<void> {
  task.meta = await readMeta(task.dir)
}

export async function setTaskDelivery(task: Task, delivery: TaskDelivery): Promise<void> {
  const latest = await readMeta(task.dir)
  latest.delivery = delivery
  latest.deliveryProposal = undefined
  latest.deliveryProposalAt = null
  latest.updatedAt = new Date().toISOString()
  task.meta = latest
  await writeMeta(task.dir, latest, { preserveDelivery: false })
}

export async function findTask(ctx: WorkContext, query: string): Promise<Task | null> {
  const tasks = await loadTasks(ctx)
  return tasks.find((t) => t.id === query) ?? tasks.find((t) => t.id.includes(query)) ?? null
}

export async function readIntent(task: Task): Promise<string> {
  return (await Bun.file(`${task.dir}/task.md`).text()).trim()
}

export async function readArtifact(task: Task, name: string): Promise<string | null> {
  const file = Bun.file(`${task.dir}/${name}`)
  return (await file.exists()) ? (await file.text()).trim() : null
}

// The selected final plan, saved as an artifact after SELECT so a resume can reuse
// it and skip the planning ensemble. null if absent (e.g. a task from before this).
export async function readPlan(task: Task): Promise<string | null> {
  return readArtifact(task, 'plan.md')
}

// One failed gate: which gate rejected it, a one-line root-cause summary (for loop
// detection), and the full text (for the next fixer). Persisted to failures.jsonl
// so the history spans the whole task — including resumes — and the convergence
// judge can tell genuine progress from going in circles.
const FailureRemediationSchema = z.enum(['code-fix', 'backoff'])
const FailureSchema = z.object({
  attempt: z.number().int(),
  gate: z.string(),
  summary: z.string(),
  detail: z.string(),
  // Backoff failures are transient verify/env/ship records. They are useful
  // history, but they must not consume the implementation fix budget.
  remediation: FailureRemediationSchema.default('code-fix'),
})
export type FailureRemediation = z.infer<typeof FailureRemediationSchema>
export type Failure = z.infer<typeof FailureSchema>

export async function readFailures(task: Task): Promise<Failure[]> {
  const file = Bun.file(`${task.dir}/failures.jsonl`)
  if (!(await file.exists())) {
    return []
  }
  const out: Failure[] = []
  for (const line of (await file.text()).split('\n')) {
    if (!line.trim()) {
      continue
    }
    try {
      out.push(FailureSchema.parse(JSON.parse(line)))
    } catch {}
  }
  return out
}

export async function appendFailure(task: Task, failure: Failure): Promise<void> {
  const file = Bun.file(`${task.dir}/failures.jsonl`)
  const existing = (await file.exists()) ? await file.text() : ''
  await Bun.write(file, `${existing}${JSON.stringify(failure)}\n`)
}

// Accumulated human answers for this task. Threaded into the pre-implementation
// stages so a resumed run incorporates them instead of re-asking.
export async function readAnswers(task: Task): Promise<string | null> {
  const file = Bun.file(`${task.dir}/answers.md`)
  return (await file.exists()) ? (await file.text()).trim() : null
}

export async function appendAnswer(task: Task, text: string): Promise<void> {
  const existing = (await readAnswers(task)) ?? ''
  const entry = `## Answer (${new Date().toISOString()})\n${text.trim()}\n`
  await Bun.write(`${task.dir}/answers.md`, existing ? `${existing}\n\n${entry}` : entry)
}

type AnswerEntry = {
  timestamp: string
  text: string
}

function answerEntries(text: string): AnswerEntry[] {
  const starts = [...text.matchAll(/^## Answer \(([^)]+)\)\n/gm)].map((match) => ({
    index: match.index,
    timestamp: match[1] ?? '',
  }))
  return starts
    .map((start, i) => ({
      timestamp: start.timestamp,
      text: text.slice(start.index, starts[i + 1]?.index ?? text.length).trim(),
    }))
    .filter((entry) => entry.text)
}

function answerValue(entry: AnswerEntry): string | null {
  const body = entry.text.replace(/^## Answer \([^)]+\)(?:\n|$)/, '').trim()
  if (!body) {
    return null
  }

  const matches = [...body.matchAll(/^A:\s*(.*)$/gm)]
  const answerLine = matches.at(-1)
  if (!answerLine || answerLine.index === undefined) {
    return body
  }

  const lineEnd = body.indexOf('\n', answerLine.index)
  const inline = answerLine[1] ?? ''
  const rest = lineEnd === -1 ? '' : body.slice(lineEnd + 1)
  return `${inline}${rest ? `\n${rest}` : ''}`.trim() || null
}

export function latestAnswerValue(answers: string): string | null {
  const latest = answerEntries(answers).at(-1)
  if (!latest) {
    return null
  }
  return answerValue(latest)
}

export function latestAnswerValueAfter(answers: string, after: string | null): string | null {
  if (!after) {
    return null
  }
  const afterMs = Date.parse(after)
  if (!Number.isFinite(afterMs)) {
    return null
  }
  const latest = answerEntries(answers)
    .filter((entry) => {
      const entryMs = Date.parse(entry.timestamp)
      return Number.isFinite(entryMs) && entryMs > afterMs
    })
    .at(-1)
  return latest ? answerValue(latest) : null
}

export function pendingFeedbackCount(task: Task): number {
  return Math.max(0, task.meta.feedbackCount - task.meta.feedbackConsumed)
}

// Human feedback lives in human-feedback.md, kept separate from the success-path
// completion handoff in feedback.md so the handoff write can't clobber pending,
// not-yet-consumed feedback.
export async function readFeedback(task: Task): Promise<string | null> {
  const file = Bun.file(`${task.dir}/human-feedback.md`)
  return (await file.exists()) ? (await file.text()).trim() : null
}

function feedbackEntries(text: string): string[] {
  const starts = [...text.matchAll(/^## Feedback \([^)]+\)\n/gm)].map((match) => match.index)
  return starts
    .map((start, i) => text.slice(start, starts[i + 1] ?? text.length).trim())
    .filter(Boolean)
}

export async function readPendingFeedback(task: Task): Promise<string | null> {
  const text = await readFeedback(task)
  if (!text) {
    return null
  }
  const entries = feedbackEntries(text).slice(task.meta.feedbackConsumed)
  return entries.length > 0 ? entries.join('\n\n') : null
}

export async function appendFeedback(task: Task, text: string): Promise<void> {
  const existing = (await readFeedback(task)) ?? ''
  const entry = `## Feedback (${new Date().toISOString()})\n\n${text.trim()}\n`
  await Bun.write(`${task.dir}/human-feedback.md`, existing ? `${existing}\n\n${entry}` : entry)
  task.meta.feedbackCount += 1
  task.meta.updatedAt = new Date().toISOString()
  await writeMeta(task.dir, task.meta)
}

export function markFeedbackConsumed(task: Task, count: number): void {
  task.meta.feedbackConsumed = Math.max(task.meta.feedbackConsumed, count)
}

export async function refreshFeedbackState(task: Task): Promise<void> {
  const file = Bun.file(`${task.dir}/meta.json`)
  if (!(await file.exists())) {
    return
  }
  const latest = MetaSchema.parse(await file.json())
  task.meta.feedbackCount = Math.max(task.meta.feedbackCount, latest.feedbackCount)
  task.meta.feedbackConsumed = Math.max(task.meta.feedbackConsumed, latest.feedbackConsumed)
}

export async function readLiveMeter(task: Task): Promise<LiveMeter | null> {
  const file = Bun.file(`${task.dir}/meter.json`)
  if (!(await file.exists())) {
    return null
  }
  try {
    const parsed = LiveMeterSchema.safeParse(await file.json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export async function writeLiveMeter(task: Task, meter: LiveMeter): Promise<void> {
  const finalPath = `${task.dir}/meter.json`
  const tmpPath = `${task.dir}/.meter.${process.pid}.${randomUUID()}.tmp`
  await Bun.write(tmpPath, `${JSON.stringify(meter, null, 2)}\n`)
  await rename(tmpPath, finalPath)
}

export async function writeArtifact(task: Task, name: string, content: string): Promise<void> {
  await Bun.write(`${task.dir}/${name}`, content)
}

async function readMeta(dir: string): Promise<Meta> {
  return MetaSchema.parse(await Bun.file(`${dir}/meta.json`).json())
}

async function writeMeta(
  dir: string,
  meta: Meta,
  opts: { preserveDelivery?: boolean } = {}
): Promise<void> {
  const nextMeta =
    opts.preserveDelivery !== false && (await Bun.file(`${dir}/meta.json`).exists())
      ? { ...meta, delivery: (await readMeta(dir)).delivery }
      : meta
  const finalPath = `${dir}/meta.json`
  const tmpPath = `${dir}/.meta.${process.pid}.${Date.now()}.tmp`
  await Bun.write(tmpPath, `${JSON.stringify(nextMeta, null, 2)}\n`)
  await rename(tmpPath, finalPath)
}
