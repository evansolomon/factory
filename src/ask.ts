import { createInterface, type Interface } from 'node:readline'
import { type AgentResult, type AgentRun, agentLabel, runAgent } from './agents.ts'
import type { Agent, WorkContext } from './config.ts'
import { composeInEditor } from './editor.ts'
import { log } from './log.ts'
import { renderAgentMarkdown } from './sharpen-render.ts'
import { loadTasks, type Task } from './task.ts'

const ARTIFACT_LIMIT = 8000
const LOG_TAIL_LIMIT = 8000
const FAILURE_TAIL_LINES = 8
const DETAILED_TASK_LIMIT = 4

export type AskMode = 'session' | 'print'

export type AskRequest = {
  mode: AskMode
  taskId: string | null
  question: string
}

export type AskTranscriptTurn = {
  question: string
  answer: string
}

export type AskAnswer = {
  answer: string
  selectedTaskIds: string[]
}

type AgentRunner = (agent: Agent, opts: AgentRun) => Promise<AgentResult>

type AskTurnOutcome =
  | { kind: 'answer'; answer: string; selectedTaskIds: string[] }
  | { kind: 'fatal'; message: string }

export const NON_TTY_ASK_MESSAGE =
  'factory ask is interactive and needs a terminal. For a scriptable one-shot answer use: factory ask --print [task-id] <question...>'

class ScopedAskTaskMissing extends Error {
  override readonly name = 'ScopedAskTaskMissing'
}

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

function formatTranscript(transcript: AskTranscriptTurn[]): string {
  return transcript.map((turn) => `Human: ${turn.question}\nAssistant: ${turn.answer}`).join('\n\n')
}

export function buildAskPrompt(
  question: string,
  ctx: WorkContext,
  tasks: Task[],
  detailed: string[],
  transcript: AskTranscriptTurn[] = []
): string {
  const taskIndex = tasks.length > 0 ? tasks.map(taskLine).join('\n') : '(no tasks)'
  const artifacts = detailed.length > 0 ? detailed.join('\n\n') : '(no artifacts selected)'
  const conversation =
    transcript.length > 0
      ? `\nConversation history (live session memory, not saved evidence):\n${formatTranscript(
          transcript
        )}\n`
      : ''
  const transcriptRules =
    transcript.length > 0
      ? `\n- Use the conversation history only to resolve references like "why?", "that one", or "the second issue".
- Answer factual questions only from the current task index and selected artifact excerpts.
- If the conversation history conflicts with current saved state, current saved state wins.`
      : ''

  return `You are answering a question about factory's saved task state.
${conversation}
User question:
${question}

Rules:
- Answer only from the provided context.
- Do not run commands, inspect extra files, edit files, use git, run tests, or access the network.
- If the context does not prove the answer, say what is missing.${transcriptRules}
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

export function parseAskRequest(args: string[], tasks: Task[]): AskRequest {
  const mode: AskMode = args[0] === '--print' ? 'print' : 'session'
  const restArgs = mode === 'print' ? args.slice(1) : args
  const [first, ...rest] = restArgs
  if (!first) {
    return { mode, question: '', taskId: null }
  }
  const task =
    tasks.find((candidate) => candidate.id === first || candidate.id.includes(first)) ?? null
  if (task) {
    return { mode, question: rest.join(' ').trim(), taskId: task.id }
  }
  return { mode, question: restArgs.join(' ').trim(), taskId: null }
}

function addTaskOnce(tasks: Task[], task: Task): void {
  if (!tasks.some((existing) => existing.id === task.id)) {
    tasks.push(task)
  }
}

async function selectDetailedTasks(
  question: string,
  tasks: Task[],
  explicit: Task | null,
  carriedTaskIds: string[] = []
): Promise<Task[]> {
  if (explicit) {
    return [explicit]
  }

  const selected: Task[] = []
  for (const id of carriedTaskIds) {
    const task = tasks.find((candidate) => candidate.id === id)
    if (task) {
      addTaskOnce(selected, task)
    }
  }

  for (const task of tasks.slice(0, DETAILED_TASK_LIMIT)) {
    addTaskOnce(selected, task)
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
        addTaskOnce(selected, task)
      }
      if (selected.length >= DETAILED_TASK_LIMIT) {
        break
      }
    }
  }

  return selected.slice(0, DETAILED_TASK_LIMIT)
}

function priorQuestions(transcript: AskTranscriptTurn[]): string {
  return transcript.map((turn) => turn.question).join('\n')
}

export async function answerAskQuestion(opts: {
  ctx: WorkContext
  question: string
  taskId: string | null
  transcript?: AskTranscriptTurn[]
  carriedTaskIds?: string[]
  runner?: AgentRunner
}): Promise<AskAnswer> {
  const transcript = opts.transcript ?? []
  const tasks = sortForAsk(await loadTasks(opts.ctx))
  if (tasks.length === 0) {
    throw new Error('no tasks in this worktree')
  }

  const scopedTask = opts.taskId
    ? (tasks.find((candidate) => candidate.id === opts.taskId) ?? null)
    : null
  if (opts.taskId && !scopedTask) {
    throw new ScopedAskTaskMissing(`task ${opts.taskId} is no longer in this worktree`)
  }

  const selectionQuestion = [opts.question, priorQuestions(transcript)].filter(Boolean).join('\n')
  const selected = await selectDetailedTasks(
    selectionQuestion,
    tasks,
    scopedTask,
    opts.carriedTaskIds ?? []
  )
  const detailed: string[] = []
  for (const task of selected) {
    detailed.push(...(await taskArtifacts(task)))
  }

  const runner = opts.runner ?? runAgent
  const result = await runner(opts.ctx.askAgent, {
    root: opts.ctx.root,
    prompt: buildAskPrompt(opts.question, opts.ctx, tasks, detailed, transcript),
    access: 'read',
  })
  return {
    answer: result.text.trim() || '(no answer)',
    selectedTaskIds: selected.map((task) => task.id),
  }
}

function ask(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function mergeIds(existing: string[], incoming: string[]): string[] {
  const ids = [...existing]
  for (const id of incoming) {
    if (!ids.includes(id)) {
      ids.push(id)
    }
  }
  return ids
}

export async function runAskSession(opts: {
  agent: string
  taskId: string | null
  initialQuestion: string
  readLine: () => Promise<string>
  write: (text: string) => void
  writeError: (text: string) => void
  turn: (
    question: string,
    transcript: AskTranscriptTurn[],
    carriedTaskIds: string[]
  ) => Promise<AskTurnOutcome>
  edit?: () => Promise<string>
  renderAnswer?: (text: string) => string
}): Promise<number> {
  const transcript: AskTranscriptTurn[] = []
  let carriedTaskIds: string[] = []
  const renderAnswer = opts.renderAnswer ?? ((text: string) => text)

  opts.write(`ask — ${opts.agent}${opts.taskId ? ` · task ${opts.taskId}` : ''}`)
  opts.write('ask a question · Enter or /done to exit · /edit long reply · /cancel abort')

  const submit = async (question: string): Promise<number | null> => {
    opts.write('  …thinking')
    try {
      const outcome = await opts.turn(question, transcript, carriedTaskIds)
      if (outcome.kind === 'fatal') {
        opts.writeError(outcome.message)
        return 1
      }
      opts.write(renderAnswer(outcome.answer))
      transcript.push({ question, answer: outcome.answer })
      carriedTaskIds = mergeIds(carriedTaskIds, outcome.selectedTaskIds)
      return null
    } catch (err) {
      opts.writeError(`ask failed: ${errorMessage(err)}`)
      return null
    }
  }

  const initial = opts.initialQuestion.trim()
  if (initial) {
    const code = await submit(initial)
    if (code !== null) {
      return code
    }
  }

  while (true) {
    const input = (await opts.readLine()).trim()
    if (input === '' || input === '/done') {
      return 0
    }
    if (input === '/cancel') {
      return 1
    }
    if (input === '/edit') {
      const edited = opts.edit ? await opts.edit() : ''
      if (!edited) {
        opts.write('  (nothing entered)')
        continue
      }
      const code = await submit(edited)
      if (code !== null) {
        return code
      }
      continue
    }

    const code = await submit(input)
    if (code !== null) {
      return code
    }
  }
}

export function askSessionTtyError(
  inputIsTty: boolean | undefined,
  outputIsTty: boolean | undefined
): string | null {
  return inputIsTty && outputIsTty ? null : NON_TTY_ASK_MESSAGE
}

export async function askFactory(ctx: WorkContext, args: string[]): Promise<number> {
  const mode: AskMode = args[0] === '--print' ? 'print' : 'session'
  if (mode === 'session') {
    const ttyError = askSessionTtyError(process.stdin.isTTY, process.stdout.isTTY)
    if (ttyError) {
      log.fail(ttyError)
      return 1
    }
  }

  const tasks = sortForAsk(await loadTasks(ctx))
  const request = parseAskRequest(args, tasks)
  if (tasks.length === 0) {
    log.fail('no tasks in this worktree')
    return 1
  }

  if (request.mode === 'print') {
    if (!request.question) {
      log.fail('usage: factory ask --print [task-id] <question...>')
      return 1
    }
    const result = await answerAskQuestion({
      ctx,
      question: request.question,
      taskId: request.taskId,
      transcript: [],
      carriedTaskIds: [],
    })
    log.log(result.answer)
    return 0
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await runAskSession({
      agent: agentLabel(ctx.askAgent),
      taskId: request.taskId,
      initialQuestion: request.question,
      readLine: () => ask(rl, 'you> '),
      write: (text) => log.log(text),
      writeError: (text) => log.fail(text),
      edit: composeInEditor,
      renderAnswer: renderAgentMarkdown,
      turn: async (question, transcript, carriedTaskIds) => {
        try {
          const result = await answerAskQuestion({
            ctx,
            question,
            taskId: request.taskId,
            transcript,
            carriedTaskIds,
          })
          return { kind: 'answer', answer: result.answer, selectedTaskIds: result.selectedTaskIds }
        } catch (err) {
          if (err instanceof ScopedAskTaskMissing) {
            return { kind: 'fatal', message: err.message }
          }
          throw err
        }
      },
    })
  } finally {
    rl.close()
  }
}
