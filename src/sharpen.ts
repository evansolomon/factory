import { createInterface, type Interface } from 'node:readline'
import { runAgent } from './agents.ts'
import type { Agent } from './config.ts'
import { composeInEditor } from './editor.ts'
import { emit, type Hooks } from './hooks.ts'
import { log } from './log.ts'
import { sharpenPrompt, sharpenReviewPrompt } from './prompts.ts'

// Interactive sharpen step. Seeded with the raw intent, an agent interrogates it
// into a self-contained goal spec, exploring the repo itself. Each agent turn is
// a slow research pass, so it BATCHES its questions; the CLI then walks the human
// through them one at a time (no per-question latency) and sends the answers back
// as one turn. Returns the refined intent + verify, or null if the human cancels.

export type SharpenResult = { intent: string; verify: string | null }
type SharpenOpts = {
  root: string
  agent: Agent
  reviewer?: Agent
  hooks: Hooks
  intent: string
  verify: string | null
}

type Turn = { role: 'human' | 'agent' | 'reviewer'; text: string }

// Bound the conversation so a misbehaving agent can't loop forever.
const MAX_TURNS = 24

function transcript(turns: Turn[]): string {
  return turns.map((t) => `${t.role}: ${t.text}`).join('\n\n')
}

type Parsed = { ready: boolean; verify: string | null; spec: string; message: string }

// The agent signals completion with a `SPEC READY` line; until then everything
// is conversational. Parse out the spec + verify when present.
function parseSharpen(text: string): Parsed {
  const marker = /^SPEC READY\s*$/m.exec(text)
  if (!marker) {
    return { ready: false, verify: null, spec: '', message: text.trim() }
  }
  const message = text.slice(0, marker.index).trim()
  const after = text.slice(marker.index + marker[0].length)
  const vmatch = /^VERIFY:\s*(.*)$/m.exec(after)
  const rawVerify = vmatch?.[1]?.trim() ?? ''
  const verify = rawVerify && !/^none$/i.test(rawVerify) ? rawVerify : null
  const spec = (vmatch ? after.slice(vmatch.index + vmatch[0].length) : after).trim()
  return { ready: true, verify, spec, message }
}

type Question = { q: string; rec: string }
type QuestionReply = { kind: 'cancel' } | { kind: 'finish' } | { kind: 'answers'; text: string }

// When not ready, the agent batches its questions in a `QUESTIONS` block of
// `- <question> ||| <recommended answer>` lines (any grounding context goes
// before the block). Empty questions means it replied in plain prose instead.
function parseQuestions(text: string): { preamble: string; questions: Question[] } {
  const marker = /^QUESTIONS\s*$/m.exec(text)
  if (!marker) {
    return { preamble: '', questions: [] }
  }
  const preamble = text.slice(0, marker.index).trim()
  const questions: Question[] = []
  for (const line of text.slice(marker.index + marker[0].length).split('\n')) {
    const item = /^\s*-\s+(.+)$/.exec(line)
    if (!item?.[1]) {
      continue
    }
    const [q, rec] = item[1].split('|||')
    if (q?.trim()) {
      questions.push({ q: q.trim(), rec: rec?.trim() ?? '' })
    }
  }
  return { preamble, questions }
}

type Review =
  | { kind: 'pass' }
  | { kind: 'revise'; message: string }
  | { kind: 'questions'; preamble: string; questions: Question[] }

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  )
}

function parseReview(text: string): Review {
  const marker = firstLine(text)
  if (marker === 'SHARPEN: PASS') {
    return { kind: 'pass' }
  }
  if (marker === 'SHARPEN: REVISE') {
    const start = text.indexOf(marker) + marker.length
    const message = text.slice(start).trim()
    return {
      kind: 'revise',
      message: message || 'Tighten the spec before showing it to the human.',
    }
  }
  const { preamble, questions } = parseQuestions(text)
  if (questions.length > 0) {
    return { kind: 'questions', preamble, questions }
  }
  return {
    kind: 'revise',
    message: text.trim() || 'Tighten the spec before showing it to the human.',
  }
}

function ask(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve))
}

type Reply = { kind: 'cancel' } | { kind: 'done' } | { kind: 'text'; text: string }

// One conversational reply turn: an empty line (or /done) finishes, a line of text
// keeps refining, /edit composes a multi-line reply in $EDITOR, /cancel aborts.
// An empty /edit re-prompts without re-running the agent.
async function readReply(rl: Interface): Promise<Reply> {
  while (true) {
    const input = (await ask(rl, 'you> ')).trim()
    if (input === '/cancel') {
      return { kind: 'cancel' }
    }
    if (input === '' || input === '/done') {
      return { kind: 'done' }
    }
    if (input === '/edit') {
      const edited = await composeInEditor()
      if (!edited) {
        log.info('  (nothing entered)')
        continue
      }
      log.log(`\n${renderAgent(edited)}\n`)
      return { kind: 'text', text: edited }
    }
    return { kind: 'text', text: input }
  }
}

async function readQuestionAnswers(
  opts: SharpenOpts,
  rl: Interface,
  questions: Question[]
): Promise<QuestionReply> {
  const answered: string[] = []
  for (let qi = 0; qi < questions.length; qi++) {
    const { q, rec } = questions[qi] ?? { q: '', rec: '' }
    log.log(`\n${BOLD}(${qi + 1}/${questions.length})${RESET} ${styleLine(q)}`)
    if (rec) {
      log.info(`  recommend: ${rec}`)
    }
    const input = (await waitingForInput(opts, () => ask(rl, 'you> '))).trim()
    if (input === '/cancel') {
      return { kind: 'cancel' }
    }
    if (input === '/done') {
      return { kind: 'finish' }
    }
    if (input === '/skip') {
      answered.push(`Q: ${q}\nA: (skipped)`)
      continue
    }
    answered.push(`Q: ${q}\nA: ${input || rec || '(no preference)'}`)
  }
  return { kind: 'answers', text: answered.join('\n\n') }
}

// Drive lifecycle hooks for the interactive sharpen step: active stage while the agent
// computes, and attention while factory is actually waiting at a human prompt.
async function thinking<T>(opts: SharpenOpts, work: () => Promise<T>): Promise<T> {
  await emit(opts.root, opts.hooks, 'attention', { state: 'none' })
  await emit(opts.root, opts.hooks, 'stage.change', { stage: 'sharpen', active: true })
  try {
    return await work()
  } finally {
    await emit(opts.root, opts.hooks, 'stage.change', { stage: 'sharpen', active: false })
  }
}

async function waitingForInput<T>(opts: SharpenOpts, wait: () => Promise<T>): Promise<T> {
  await emit(opts.root, opts.hooks, 'attention', { state: 'needs-input' })
  try {
    return await wait()
  } finally {
    await emit(opts.root, opts.hooks, 'attention', { state: 'none' })
  }
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const RESET = '\x1b[0m'

// Inline styling for one line of the agent's markdown: bold a leading "Label:"
// (Recommendation:/Why:/headings), colorize `code` spans (dropping the noisy
// backticks), and render **bold**.
function styleLine(line: string): string {
  return line
    .replace(/^(\s*)([A-Z][A-Za-z ]{1,38}):/, (_m, sp, label) => `${sp}${BOLD}${label}:${RESET}`)
    .replace(/`([^`]+)`/g, `${CYAN}$1${RESET}`)
    .replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`)
}

// Frame an agent turn with a dim left gutter so a multi-paragraph message reads
// as one block, visually distinct from your left-aligned `you>` input.
function renderAgent(text: string): string {
  return text
    .split('\n')
    .map((line) => `${DIM}│${RESET} ${styleLine(line)}`)
    .join('\n')
}

function showSpec(spec: string, verify: string | null): void {
  log.log(`\n${GREEN}${BOLD}┌─ proposed spec ────────────────────────────${RESET}`)
  log.log(renderAgent(spec))
  if (verify) {
    log.log(`${DIM}│${RESET} ${BOLD}verify:${RESET} ${CYAN}${verify}${RESET}`)
  }
  log.log(`${GREEN}${BOLD}└────────────────────────────────────────────${RESET}`)
  log.info('Enter to queue this · or type a reply to keep refining')
}

async function reviewSpec(
  opts: SharpenOpts,
  turns: Turn[],
  spec: SharpenResult,
  tally: { inTok: number; outTok: number }
): Promise<Review> {
  log.info('  …checking spec')
  const { text, usage } = await thinking(opts, () =>
    runAgent(opts.reviewer ?? opts.agent, {
      root: opts.root,
      prompt: sharpenReviewPrompt(transcript(turns), spec.intent, spec.verify),
      access: 'read',
    })
  )
  tally.inTok += usage.inputTokens
  tally.outTok += usage.outputTokens
  return parseReview(text)
}

export async function sharpen(opts: SharpenOpts): Promise<SharpenResult | null> {
  log.step('sharpen — clarifying intent into a spec')
  log.info(
    '  Enter accepts a recommendation / finishes · /skip a question · /edit for a long reply · /cancel abort'
  )
  await emit(opts.root, opts.hooks, 'stage.change', { stage: 'sharpen', active: false })
  const turns: Turn[] = [{ role: 'human', text: opts.intent }]
  let proposed: SharpenResult | null = null
  const tally = { inTok: 0, outTok: 0 }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (let i = 0; i < MAX_TURNS; i++) {
      log.info('  …thinking')
      const { text, usage } = await thinking(opts, () =>
        runAgent(opts.agent, {
          root: opts.root,
          prompt: sharpenPrompt(transcript(turns), false),
          access: 'read',
        })
      )
      tally.inTok += usage.inputTokens
      tally.outTok += usage.outputTokens
      turns.push({ role: 'agent', text })
      const parsed = parseSharpen(text)

      // A batch of questions → walk them one at a time (no per-question latency),
      // then send all the answers back to the agent as a single turn.
      if (!parsed.ready) {
        const { preamble, questions } = parseQuestions(text)
        if (questions.length > 0) {
          if (preamble) {
            log.log(`\n${renderAgent(preamble)}`)
          }
          const reply = await readQuestionAnswers(opts, rl, questions)
          if (reply.kind === 'cancel') {
            return null
          }
          if (reply.kind === 'finish') {
            return proposed ?? (await finalizeReviewed(opts, turns, tally))
          }
          turns.push({ role: 'human', text: reply.text })
          continue
        }
      }

      // Otherwise: show the spec (if ready) or a plain prose reply, then take one
      // conversational reply (line, /edit, /done, /cancel).
      if (parsed.ready) {
        if (parsed.message) {
          log.log(`\n${renderAgent(parsed.message)}\n`)
        }
        const candidate = { intent: parsed.spec, verify: parsed.verify ?? opts.verify }
        const review = await reviewSpec(opts, turns, candidate, tally)
        if (review.kind === 'revise') {
          turns.push({
            role: 'reviewer',
            text:
              'Internal spec review asked for a revision before showing this to the human:' +
              `\n\n${review.message}`,
          })
          continue
        }
        if (review.kind === 'questions') {
          if (review.preamble) {
            log.log(`\n${renderAgent(review.preamble)}`)
          }
          const reply = await readQuestionAnswers(opts, rl, review.questions)
          if (reply.kind === 'cancel') {
            return null
          }
          if (reply.kind === 'finish') {
            turns.push({
              role: 'human',
              text: 'Use the spec reviewer recommended answers for those unresolved decisions.',
            })
            continue
          }
          turns.push({
            role: 'human',
            text: `Spec review identified unresolved human decisions:\n\n${reply.text}`,
          })
          continue
        }
        proposed = candidate
        showSpec(parsed.spec, proposed.verify)
      } else if (parsed.message) {
        log.log(`\n${renderAgent(parsed.message)}\n`)
      } else {
        log.info('(no response — type a reply to retry, or Enter to finish)')
      }
      const r = await waitingForInput(opts, () => readReply(rl))
      if (r.kind === 'cancel') {
        return null
      }
      if (r.kind === 'done') {
        return proposed ?? (await finalizeReviewed(opts, turns, tally))
      }
      turns.push({ role: 'human', text: r.text })
    }
    log.warn('sharpen: reached the turn limit — finalizing')
    return proposed ?? (await finalizeReviewed(opts, turns, tally))
  } finally {
    rl.close()
    await emit(opts.root, opts.hooks, 'attention', { state: 'none' })
    await emit(opts.root, opts.hooks, 'stage.change', { stage: '', active: false })
    if (tally.inTok || tally.outTok) {
      log.info(`  tokens: ${fmtTok(tally.inTok)} in → ${fmtTok(tally.outTok)} out`)
    }
  }
}

async function finalizeReviewed(
  opts: SharpenOpts,
  turns: Turn[],
  tally: { inTok: number; outTok: number }
): Promise<SharpenResult> {
  const candidate = await finalize(opts, turns, tally)
  const review = await reviewSpec(opts, turns, candidate, tally)
  if (review.kind === 'pass') {
    return candidate
  }
  if (review.kind === 'questions') {
    turns.push({
      role: 'human',
      text:
        'Use the spec reviewer recommended answers for these unresolved decisions:\n\n' +
        review.questions.map((q) => `Q: ${q.q}\nA: ${q.rec || '(no preference)'}`).join('\n\n'),
    })
    return await finalize(opts, turns, tally)
  }
  turns.push({
    role: 'reviewer',
    text: `Internal spec review asked for a final revision before queueing:\n\n${review.message}`,
  })
  return await finalize(opts, turns, tally)
}

// Force the agent to synthesize the spec from the conversation so far. Falls back
// to the raw intent if it can't — finishing should never lose the human's input.
async function finalize(
  opts: SharpenOpts,
  turns: Turn[],
  tally: { inTok: number; outTok: number }
): Promise<SharpenResult> {
  log.info('  …finalizing the spec')
  const { text, usage } = await thinking(opts, () =>
    runAgent(opts.agent, {
      root: opts.root,
      prompt: sharpenPrompt(transcript(turns), true),
      access: 'read',
    })
  )
  tally.inTok += usage.inputTokens
  tally.outTok += usage.outputTokens
  const parsed = parseSharpen(text)
  if (!parsed.ready || !parsed.spec) {
    log.warn('sharpen: could not synthesize a spec — keeping your original intent')
    return { intent: opts.intent, verify: opts.verify }
  }
  return { intent: parsed.spec, verify: parsed.verify ?? opts.verify }
}

export type GrillResult = SharpenResult
export const grill = sharpen
