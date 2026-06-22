import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { z } from 'zod'
import type { WorkContext } from './config.ts'

// A task is a directory under <dir>/tasks/<id>/ containing:
//   task.md   — human-owned intent (free-form markdown; what grilling enriches)
//   meta.json — machine-owned status/verify/timestamps (never touches task.md)
//   plan.*.md, review.md, proof.md, diff.patch — conductor artifacts
// Splitting human prose from machine state means factory flips status without
// ever rewriting what you wrote.

export const StatusSchema = z.enum([
  'ready',
  'needs-input',
  // Created up-front by `factory add` while you interactively grill the intent, so
  // it's visible in `factory status`; flipped to 'ready' (or deleted) when you finish.
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

// Statuses where a task is at rest — no run-loop is actively working it: queued
// (ready), waiting on a human (needs-input/blocked), on a backoff (retrying), being
// grilled interactively (grilling), or finished (done). Every OTHER status is a live
// stage the conductor sets while working a task. Deriving the complement (rather than
// listing the stages) means a newly-added stage is covered automatically — the same
// heuristic factory_prompt uses for "in-progress".
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

// Statuses a `factory resume` with no id will adopt: a blocked/retrying task, or one
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
  // Resume bookkeeping. `resume` tells the next run to pick up where the task left
  // off — reuse the saved plan + existing diff, skip the planning ensemble — set by
  // `factory resume` and by the loop's auto-resume; consumed (cleared) on the run.
  // `resumeNote` carries optional human fix-context, consumed with it.
  resume: z.boolean().default(false),
  resumeNote: z.string().nullable().default(null),
  resumeKind: z.enum(['manual', 'auto-retry', 'stranded']).nullable().default(null),
  // Auto-resume of transient gate failures: when the backoff next elapses, and how
  // many loop-level retries have been spent against the cap.
  retryAt: z.string().nullable().default(null),
  autoRetries: z.number().int().default(0),
})
export type Meta = z.infer<typeof MetaSchema>

export type Task = {
  id: string
  dir: string
  meta: Meta
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : 'task'
}

function firstLine(text: string): string {
  return text.trim().split('\n', 1)[0] ?? ''
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
  status: Status = 'ready'
): Promise<Task> {
  await mkdir(ctx.tasksDir, { recursive: true })
  // Descriptive, number-free id; disambiguate same-named tasks with a -N suffix.
  const slug = slugify(firstLine(intent))
  const existing = await listTaskDirs(ctx.tasksDir)
  let id = slug
  for (let n = 2; existing.includes(id); n++) {
    id = `${slug}-${n}`
  }
  const dir = `${ctx.tasksDir}/${id}`
  await mkdir(dir, { recursive: true })

  const now = new Date().toISOString()
  const meta: Meta = {
    id,
    slug,
    status,
    verify,
    createdAt: now,
    updatedAt: now,
    commit: null,
    note: null,
    resume: false,
    resumeNote: null,
    resumeKind: null,
    retryAt: null,
    autoRetries: 0,
  }

  await Bun.write(`${dir}/task.md`, `${intent.trim()}\n`)
  await writeMeta(dir, meta)
  return { id, dir, meta }
}

// Finish a grilled task: replace its intent with the refined spec, set the verify
// command, and flip it from 'grilling' to 'ready' so the loop will pick it up.
export async function readyGrilledTask(
  task: Task,
  intent: string,
  verify: string | null
): Promise<void> {
  await Bun.write(`${task.dir}/task.md`, `${intent.trim()}\n`)
  task.meta.verify = verify
  task.meta.status = 'ready'
  task.meta.updatedAt = new Date().toISOString()
  await writeMeta(task.dir, task.meta)
}

// Remove a task entirely (its whole dir). Used when a grill is cancelled.
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

// Planning has no durable selected plan yet, so restart it from the original intent.
// Later stages can reuse the saved plan and whatever worktree diff survived.
async function recoverStranded(task: Task): Promise<Task> {
  if (task.meta.status === 'planning') {
    task.meta.resume = false
    task.meta.resumeKind = null
    task.meta.retryAt = null
    await setStatus(task, 'ready', `recovered after interrupted ${task.meta.status} stage`)
    return task
  }
  task.meta.resumeNote = `Recovered after interrupted ${task.meta.status} stage. Inspect existing work and continue from the saved artifacts.`
  return resumeRun(task, 'stranded')
}

// Most recently-updated task in this worktree, optionally restricted to certain
// statuses. The sensible default target for show/answer/resume when no id is given.
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

export async function findTask(ctx: WorkContext, query: string): Promise<Task | null> {
  const tasks = await loadTasks(ctx)
  return tasks.find((t) => t.id === query) ?? tasks.find((t) => t.id.includes(query)) ?? null
}

export async function readIntent(task: Task): Promise<string> {
  return (await Bun.file(`${task.dir}/task.md`).text()).trim()
}

// The selected final plan, saved as an artifact after SELECT so a resume can reuse
// it and skip the planning ensemble. null if absent (e.g. a task from before this).
export async function readPlan(task: Task): Promise<string | null> {
  const file = Bun.file(`${task.dir}/plan.md`)
  return (await file.exists()) ? (await file.text()).trim() : null
}

// One failed fix-loop attempt: which gate rejected it, a one-line root-cause
// summary (for loop detection), and the full text (for the next fixer). Persisted
// to failures.jsonl so the history spans the whole task — including resumes — and
// the convergence judge can tell genuine progress from going in circles.
const FailureSchema = z.object({
  attempt: z.number().int(),
  gate: z.string(),
  summary: z.string(),
  detail: z.string(),
})
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

export async function writeArtifact(task: Task, name: string, content: string): Promise<void> {
  await Bun.write(`${task.dir}/${name}`, content)
}

async function writeMeta(dir: string, meta: Meta): Promise<void> {
  const finalPath = `${dir}/meta.json`
  const tmpPath = `${dir}/.meta.${process.pid}.${Date.now()}.tmp`
  await Bun.write(tmpPath, `${JSON.stringify(meta, null, 2)}\n`)
  await rename(tmpPath, finalPath)
}
