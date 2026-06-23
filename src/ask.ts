import { runAgent } from './agents.ts'
import type { WorkContext } from './config.ts'
import { log } from './log.ts'
import { loadTasks, type Task } from './task.ts'

const ARTIFACT_LIMIT = 8000
const LOG_TAIL_LIMIT = 8000
const FAILURE_TAIL_LINES = 8
const DETAILED_TASK_LIMIT = 4

function stamp(task: Task): string {
  return task.meta.updatedAt ?? task.meta.createdAt
}

function rank(task: Task): number {
  switch (task.meta.status) {
    case 'blocked':
      return 0
    case 'needs-input':
      return 1
    case 'planning':
    case 'implementing':
    case 'reviewing':
    case 'verifying':
    case 'shipping':
      return 2
    case 'retrying':
      return 3
    case 'ready':
      return 4
    case 'done':
      return 5
    case 'sharpening':
    case 'grilling':
      return 6
  }
  return 7
}

function sortForAsk(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const ranked = rank(a) - rank(b)
    return ranked === 0 ? stamp(b).localeCompare(stamp(a)) : ranked
  })
}

async function fileText(task: Task, name: string): Promise<string | null> {
  const file = Bun.file(`${task.dir}/${name}`)
  return (await file.exists()) ? (await file.text()).trim() : null
}

async function hasArtifact(task: Task, name: string): Promise<boolean> {
  return await Bun.file(`${task.dir}/${name}`).exists()
}

function head(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }
  return `${text.slice(0, limit)}\n[truncated after ${limit} chars]`
}

function tail(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }
  return `[truncated to last ${limit} chars]\n${text.slice(-limit)}`
}

async function artifact(task: Task, name: string): Promise<string | null> {
  const text = await fileText(task, name)
  if (!text) {
    return null
  }
  const clipped =
    name.endsWith('.log') || name.endsWith('.jsonl')
      ? tail(text, LOG_TAIL_LIMIT)
      : head(text, ARTIFACT_LIMIT)
  return `### ${task.id}/${name}\n${clipped}`
}

async function failures(task: Task): Promise<string | null> {
  const text = await fileText(task, 'failures.jsonl')
  if (!text) {
    return null
  }
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-FAILURE_TAIL_LINES)
  if (lines.length === 0) {
    return null
  }
  return `### ${task.id}/failures.jsonl (last ${lines.length})\n${lines.join('\n')}`
}

async function taskArtifacts(task: Task): Promise<string[]> {
  const names = [
    'task.md',
    'questions.md',
    'answers.md',
    'plan.final.md',
    'consolidated.md',
    'postmortem.md',
    'feedback.md',
    'proof.md',
    'ship.md',
    'verify.log',
  ]
  const out: string[] = [`### ${task.id}/meta.json\n${JSON.stringify(task.meta, null, 2)}`]
  for (const name of names) {
    const text = await artifact(task, name)
    if (text) {
      out.push(text)
    }
  }
  const failureText = await failures(task)
  if (failureText) {
    out.push(failureText)
  }
  return out
}

function onCompleteLabel(ctx: WorkContext): string {
  const onComplete = ctx.config.onComplete
  if (!onComplete) {
    return 'disabled'
  }
  return 'skill' in onComplete ? `skill:${onComplete.skill}` : `policy:${onComplete.policy}`
}

function taskLine(task: Task): string {
  const meta = task.meta
  const parts = [
    `id=${meta.id}`,
    `status=${meta.status}`,
    `updatedAt=${meta.updatedAt ?? '(unset)'}`,
    `verify=${meta.verify ?? '(none)'}`,
  ]
  if (meta.note) {
    parts.push(`note=${meta.note}`)
  }
  if (meta.commit) {
    parts.push(`commit=${meta.commit}`)
  }
  if (meta.retryAt) {
    parts.push(`retryAt=${meta.retryAt}`)
  }
  if (meta.autoRetries > 0) {
    parts.push(`autoRetries=${meta.autoRetries}`)
  }
  return `- ${parts.join(' · ')}`
}

function prompt(question: string, ctx: WorkContext, tasks: Task[], detailed: string[]): string {
  const taskIndex = tasks.length > 0 ? tasks.map(taskLine).join('\n') : '(no tasks)'
  const artifacts = detailed.length > 0 ? detailed.join('\n\n') : '(no artifacts selected)'
  return `You are answering a question about factory's saved task state.

User question:
${question}

Rules:
- Answer only from the provided context.
- Do not run commands, inspect extra files, edit files, use git, run tests, or access the network.
- If the context does not prove the answer, say what is missing.
- Prefer direct facts over speculation.
- Include task ids and artifact names when relevant.
- Keep the answer concise.
- End with the next useful factory command if one exists.

Factory context:
- worktree: ${ctx.root}
- stateDir: ${ctx.stateDir}
- tasksDir: ${ctx.tasksDir}
- onComplete: ${onCompleteLabel(ctx)}

Task index, ordered by likely relevance:
${taskIndex}

Selected artifact excerpts:
${artifacts}
`
}

function parseAskArgs(args: string[], tasks: Task[]): { question: string; task: Task | null } {
  const [first, ...rest] = args
  if (!first) {
    return { question: '', task: null }
  }
  const task =
    tasks.find((candidate) => candidate.id === first || candidate.id.includes(first)) ?? null
  if (task) {
    return { question: rest.join(' ').trim(), task }
  }
  return { question: args.join(' ').trim(), task: null }
}

async function selectDetailedTasks(
  question: string,
  tasks: Task[],
  explicit: Task | null
): Promise<Task[]> {
  if (explicit) {
    return [explicit]
  }

  const selected: Task[] = []
  const add = (task: Task) => {
    if (!selected.some((existing) => existing.id === task.id)) {
      selected.push(task)
    }
  }

  for (const task of tasks.slice(0, DETAILED_TASK_LIMIT)) {
    add(task)
  }

  const deliveryQuestion = /\b(ship|shipped|shipping|deliver|delivered|push|pushed|pr|mr)\b/i.test(
    question
  )
  if (deliveryQuestion) {
    for (const task of tasks) {
      if (
        task.meta.status === 'shipping' ||
        task.meta.status === 'retrying' ||
        task.meta.status === 'done' ||
        (await hasArtifact(task, 'ship.md')) ||
        (await hasArtifact(task, 'proof.md'))
      ) {
        add(task)
      }
      if (selected.length >= DETAILED_TASK_LIMIT) {
        break
      }
    }
  }

  return selected.slice(0, DETAILED_TASK_LIMIT)
}

export async function askFactory(ctx: WorkContext, args: string[]): Promise<number> {
  const tasks = sortForAsk(await loadTasks(ctx))
  const parsed = parseAskArgs(args, tasks)
  if (!parsed.question) {
    log.fail('usage: factory ask [task-id] <question...>')
    return 1
  }
  if (tasks.length === 0) {
    log.fail('no tasks in this worktree')
    return 1
  }

  const selected = await selectDetailedTasks(parsed.question, tasks, parsed.task)
  const detailed: string[] = []
  for (const task of selected) {
    detailed.push(...(await taskArtifacts(task)))
  }

  const agent = ctx.askAgent.model ? `${ctx.askAgent.cli}:${ctx.askAgent.model}` : ctx.askAgent.cli
  log.info(`asking ${agent}`)
  const result = await runAgent(ctx.askAgent, {
    root: ctx.root,
    prompt: prompt(parsed.question, ctx, tasks, detailed),
    access: 'read',
  })
  log.log(result.text.trim() || '(no answer)')
  return 0
}
