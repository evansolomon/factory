// Inline answer prompt for `factory run` on a TTY. The run loop never blocks on
// human input — needs-input tasks are set aside so it stays busy — so this worker
// runs CONCURRENTLY with the loop (it is started, never awaited). It watches for
// needs-input tasks and prompts for an answer right in the run terminal, then
// folds the reply back via the same primitive as state-aware `factory add`
// (appendAnswer + set ready) so the loop picks the task up on its next poll. The
// loop keeps pulling and running other queued tasks while a prompt is open.
//
// Non-TTY runs (detached/CI/piped) skip this entirely and fall back to the hook +
// state-aware `factory add` path.

import { createInterface, type Interface } from 'node:readline'
import type { WorkContext } from './config.ts'
import { composeInEditor } from './editor.ts'
import { log, setActivePrompt } from './log.ts'
import { formatQuestionAnswer, parseFormattedQuestions, type Question } from './sharpen.ts'
import { BOLD, RESET, renderAgentMarkdown, styleSharpenMarkdownLine } from './sharpen-render.ts'
import { appendAnswer, loadTasks, setStatus, type Task } from './task.ts'

const POLL_MS = 500

export type PromptWorker = { stop: () => Promise<void> }

// Start the worker. Returns a handle whose stop() ends the loop and waits for any
// in-flight prompt to settle — used by bounded runs; the long-lived watch mode
// just lets it die with the process.
export function startPromptWorker(ctx: WorkContext): PromptWorker {
  const state = { stopped: false }
  // Tasks the user chose to defer with /skip: leave them needs-input for
  // state-aware `factory add` instead of re-prompting in a tight loop this session.
  const deferred = new Set<string>()
  const done = run(ctx, state, deferred)
  return {
    stop: async () => {
      state.stopped = true
      await done
    },
  }
}

async function run(
  ctx: WorkContext,
  state: { stopped: boolean },
  deferred: Set<string>
): Promise<void> {
  while (!state.stopped) {
    const task = await nextNeedsInput(ctx, deferred)
    if (!task) {
      await Bun.sleep(POLL_MS)
      continue
    }
    await promptTask(task, deferred)
  }
}

async function nextNeedsInput(ctx: WorkContext, deferred: Set<string>): Promise<Task | null> {
  const tasks = await loadTasks(ctx)
  return tasks.find((t) => t.meta.status === 'needs-input' && !deferred.has(t.id)) ?? null
}

async function promptTask(task: Task, deferred: Set<string>): Promise<void> {
  const questionsFile = Bun.file(`${task.dir}/questions.md`)
  const questionsText = (await questionsFile.exists()) ? (await questionsFile.text()).trim() : ''
  const parsed = questionsText ? parseFormattedQuestions(questionsText) : null
  log.log('')
  log.warn(`${task.id} needs input:`)
  if (parsed?.questions.length) {
    if (parsed.preamble) {
      log.log(renderAgentMarkdown(parsed.preamble))
    }
    log.info('  Enter accepts a recommendation · /skip a question · /edit for a long reply')
    log.info('  /defer to answer later with `factory add`')
  } else if (questionsText) {
    log.log(questionsText)
    log.info('  type your answer · /edit for a long reply · /skip to defer to `factory add`')
  } else {
    log.info('  type your answer · /edit for a long reply · /skip to defer to `factory add`')
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let label = `answer ${task.id}> `
  const pinPrompt = () => setActivePrompt({ text: () => label + rl.line })
  pinPrompt()
  try {
    let reply: Answer
    if (parsed && parsed.questions.length > 0) {
      reply = await readQuestionAnswers(rl, task.id, parsed.questions, {
        pinPrompt,
        setLabel: (next) => {
          label = next
        },
      })
    } else {
      reply = await readAnswer(rl, label, pinPrompt)
    }
    if (reply.kind === 'defer') {
      deferred.add(task.id)
      log.info(`  deferred — answer later with: factory add "…"`)
      return
    }
    await appendAnswer(task, reply.text)
    await setStatus(task, 'ready')
    log.ok(`${task.id}: answered, back in queue`)
  } finally {
    setActivePrompt(null)
    rl.close()
  }
}

type Answer = { kind: 'defer' } | { kind: 'answer'; text: string }

// One answer: a line of text answers, /edit composes a long reply in $EDITOR,
// /skip defers. An empty line re-prompts rather than recording a blank answer.
async function readAnswer(rl: Interface, label: string, pinPrompt: () => void): Promise<Answer> {
  while (true) {
    const input = (await ask(rl, label)).trim()
    if (input === '/skip') {
      return { kind: 'defer' }
    }
    if (input === '/edit') {
      // The editor takes over the terminal — release the bottom line so concurrent
      // loop output doesn't repaint a stale prompt over it, then re-pin after.
      setActivePrompt(null)
      const edited = await composeInEditor()
      pinPrompt()
      if (!edited) {
        log.info('  (nothing entered)')
        continue
      }
      return { kind: 'answer', text: edited }
    }
    if (input === '') {
      continue
    }
    return { kind: 'answer', text: input }
  }
}

async function readQuestionAnswers(
  rl: Interface,
  taskId: string,
  questions: Question[],
  prompt: { pinPrompt: () => void; setLabel: (label: string) => void }
): Promise<Answer> {
  const answered: string[] = []
  for (let qi = 0; qi < questions.length; qi++) {
    const { q, rec } = questions[qi] ?? { q: '', rec: '' }
    log.log(`\n${BOLD}(${qi + 1}/${questions.length})${RESET} ${styleSharpenMarkdownLine(q)}`)
    if (rec) {
      log.info(`  recommend: ${rec}`)
    }
    const label = `answer ${taskId} (${qi + 1}/${questions.length})> `
    prompt.setLabel(label)
    prompt.pinPrompt()
    const reply = await readQuestionAnswer(rl, label, rec, prompt.pinPrompt)
    if (reply.kind === 'defer') {
      return reply
    }
    answered.push(formatQuestionAnswer({ q, rec }, reply.text))
  }
  return { kind: 'answer', text: answered.join('\n\n') }
}

async function readQuestionAnswer(
  rl: Interface,
  label: string,
  recommendation: string,
  pinPrompt: () => void
): Promise<Answer> {
  while (true) {
    const input = (await ask(rl, label)).trim()
    if (input === '/defer') {
      return { kind: 'defer' }
    }
    if (input === '/skip') {
      return { kind: 'answer', text: '(skipped)' }
    }
    if (input === '/edit') {
      setActivePrompt(null)
      const edited = await composeInEditor()
      pinPrompt()
      if (!edited) {
        log.info('  (nothing entered)')
        continue
      }
      return { kind: 'answer', text: edited }
    }
    return { kind: 'answer', text: input || recommendation || '(no preference)' }
  }
}

function ask(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve))
}
