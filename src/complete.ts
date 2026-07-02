import { readdir } from 'node:fs/promises'
import { z } from 'zod'
import { loadBacklog } from './backlog.ts'
import {
  activeCommandChoices,
  type OptionSpec,
  resolveCommand,
  SHOW_STEP_DESCRIPTIONS,
  type SubcommandSpec,
  type ValueSource,
} from './commands.ts'
import type { CompletionIo } from './completion.ts'
import { loadContext, loadRepoContext, type RepoContext, type WorkContext } from './config.ts'
import { listDeliverySkills } from './delivery.ts'
import { listEvalCases } from './eval-run.ts'
import { listGuidance } from './guidance.ts'
import { log } from './log.ts'
import { findTask, latestTask } from './task.ts'
import { activitySteps } from './view.ts'

// The hidden `factory __complete` helper: invoked by the zsh completion shim at
// TAB time with `<cword> <word>...` (cword is a 0-based index into the words
// after `factory`; an index past the end means an empty partial). It prints one
// `name\tdescription` line per candidate and ALWAYS exits 0 silently — a broken
// repo, corrupt state, or internal bug must never break the user's TAB key.

export type Candidate = {
  name: string
  description: string
}

export type SourceContext = {
  // The words after `factory` (words[0] is the command) — some sources are
  // context-dependent (show's second positional completes the chosen task's steps).
  words: string[]
}

export type SourceResolver = (source: ValueSource, ctx: SourceContext) => Promise<Candidate[]>

const TOP_OPTIONS: readonly Candidate[] = [
  { name: '--version', description: 'Print the current CLI version' },
  { name: '--help', description: 'Show help' },
  { name: '-h', description: 'Show help' },
]

function findOption(
  options: readonly OptionSpec[] | undefined,
  token: string
): OptionSpec | undefined {
  return options?.find((option) => option.name === token || option.alias === token)
}

function optionCandidates(options: readonly OptionSpec[] | undefined): Candidate[] {
  const out: Candidate[] = []
  for (const option of options ?? []) {
    out.push({ name: option.name, description: option.description })
    if (option.alias) {
      out.push({ name: option.alias, description: option.description })
    }
  }
  return out
}

// Pure registry walk from the typed command specs to the candidate list; all
// filesystem access is behind `resolve`, so this is unit-testable without zsh.
// No prefix filtering happens here — zsh matches candidates against the partial.
export async function completeCandidates(
  words: string[],
  cword: number,
  resolve: SourceResolver
): Promise<Candidate[]> {
  const partial = words[cword] ?? ''
  if (cword <= 0) {
    return partial.startsWith('-') ? [...TOP_OPTIONS] : [...activeCommandChoices()]
  }

  const command = resolveCommand(words[0] ?? '')
  if (!command) {
    return []
  }

  // Walk the words before the cursor through the spec tree: descend into
  // subcommands, skip flags and their values, count consumed positionals.
  let level: SubcommandSpec = command
  let positionalCount = 0
  let pendingValue: OptionSpec | null = null
  for (let i = 1; i < cword; i++) {
    const token = words[i] ?? ''
    if (pendingValue) {
      pendingValue = null
      continue
    }
    const option = findOption(level.options, token)
    if (option) {
      if (option.tail) {
        return [] // nothing completes inside a tail (e.g. after --verify)
      }
      if (option.value) {
        pendingValue = option
      }
      continue
    }
    if (token.startsWith('-') && token !== '') {
      continue // unknown or inline (--x=y) flag; never a positional
    }
    const sub = level.subcommands?.find((candidate) => candidate.name === token)
    if (sub && positionalCount === 0) {
      level = sub
      continue
    }
    positionalCount++
  }

  if (pendingValue?.value) {
    return await resolve(pendingValue.value, { words })
  }

  if (partial.startsWith('--') && partial.includes('=')) {
    const separator = partial.indexOf('=')
    const option = findOption(level.options, partial.slice(0, separator))
    if (option?.equals && option.value) {
      const values = await resolve(option.value, { words })
      return values.map((value) => ({
        name: `${partial.slice(0, separator + 1)}${value.name}`,
        description: value.description,
      }))
    }
    return []
  }

  if (partial.startsWith('-') && partial !== '') {
    return optionCandidates(level.options)
  }

  const out: Candidate[] = []
  if (level.subcommands && positionalCount === 0) {
    out.push(...level.subcommands.map(({ name, description }) => ({ name, description })))
  }
  const positionals = level.positionals ?? []
  const last = positionals[positionals.length - 1]
  const positional = positionals[positionalCount] ?? (last?.variadic ? last : undefined)
  for (const source of positional?.sources ?? []) {
    out.push(...(await resolve(source, { words })))
  }
  out.push(...optionCandidates(level.options))
  return out
}

// Tolerant per-task read: one corrupt meta.json must not disable task-id
// completion for the rest, so this does NOT go through loadTasks (whose schema
// parse throws on the first bad task).
const TaskStatusSchema = z.object({ status: z.string() })

async function taskIdCandidates(ctx: WorkContext): Promise<Candidate[]> {
  let names: string[] = []
  try {
    names = (await readdir(ctx.tasksDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
  const out: Candidate[] = []
  for (const name of names) {
    try {
      const parsed = TaskStatusSchema.safeParse(
        await Bun.file(`${ctx.tasksDir}/${name}/meta.json`).json()
      )
      if (parsed.success) {
        out.push({ name, description: parsed.data.status })
      }
    } catch {
      // unreadable meta.json — skip this task, keep the rest
    }
  }
  return out
}

async function showStepCandidates(
  ctx: WorkContext,
  target: 'latest' | 'arg1',
  words: string[]
): Promise<Candidate[]> {
  const query = words[1]
  const task =
    target === 'latest' ? await latestTask(ctx) : query ? await findTask(ctx, query) : null
  if (!task) {
    return []
  }
  return (await activitySteps(task)).map((step) => ({
    name: step,
    description: SHOW_STEP_DESCRIPTIONS[step] ?? 'agent activity step',
  }))
}

// Resolver over injected contexts (unit-testable); defaultResolver lazily loads
// the real ones. Every source is individually fenced: any failure (no repo, no
// state, corrupt files) yields no candidates for that source, never an error.
export function contextResolver(
  work: () => Promise<WorkContext>,
  repo: () => Promise<RepoContext>
): SourceResolver {
  return async (source, ctx) => {
    try {
      switch (source.kind) {
        case 'static':
          return source.choices.map(({ name, description }) => ({ name, description }))
        case 'none':
          return []
        case 'task-id':
          return await taskIdCandidates(await work())
        case 'show-step':
          return await showStepCandidates(await work(), source.task, ctx.words)
        case 'lesson-id':
          return (await listGuidance(await work())).map((record) => ({
            name: record.id,
            description: record.text,
          }))
        case 'backlog-id':
          return (await loadBacklog(await repo())).map((entry) => ({
            name: entry.id,
            description: entry.intent,
          }))
        case 'eval-case':
          return (await listEvalCases((await work()).repoStateDir, { onSkip: () => {} })).map(
            (entry) => ({
              name: entry.file,
              description: `${entry.case.outcome} eval case`,
            })
          )
        case 'skill-name': {
          const workCtx = await work()
          return (await listDeliverySkills(workCtx.root, workCtx.repoStateDir)).map((skill) => ({
            name: source.insert === 'directive' ? `$${skill.name}` : skill.name,
            description: skill.description ?? '',
          }))
        }
      }
    } catch {
      return []
    }
  }
}

export function defaultResolver(cwd: string): SourceResolver {
  let work: Promise<WorkContext> | null = null
  let repo: Promise<RepoContext> | null = null
  return contextResolver(
    () => {
      work ??= loadContext(cwd)
      return work
    },
    () => {
      repo ??= loadRepoContext(cwd)
      return repo
    }
  )
}

// Candidates travel one per line as `name\tdescription` and zsh renders them
// in the completion UI; user-authored text (lesson bodies, backlog intents,
// skill frontmatter) must neither corrupt that framing nor inject terminal
// control sequences. ANSI/OSC escape sequences are removed whole; any other
// C0/C1 control character (tab/newline/CR included) becomes a space.
// Implemented as a character scan, not regex literals with control characters.
function sanitizeField(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 0x1b || code === 0x9b || code === 0x9d) {
      i = escapeSequenceEnd(value, i)
      continue
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += ' '
      continue
    }
    out += value.charAt(i)
  }
  return out
}

// Index of the escape sequence's final character, so the caller's i++ resumes
// just past it. Handles CSI (ESC[ or 0x9b: parameter/intermediate bytes then a
// final byte), OSC (ESC] or 0x9d: terminated by BEL or ST), and two-character
// ESC sequences. An unterminated sequence swallows the rest of the string —
// the safe direction for hostile input.
function escapeSequenceEnd(value: string, start: number): number {
  const introducer = value.charCodeAt(start)
  const kind =
    introducer === 0x9b
      ? 'csi'
      : introducer === 0x9d
        ? 'osc'
        : value.charAt(start + 1) === '['
          ? 'csi'
          : value.charAt(start + 1) === ']'
            ? 'osc'
            : 'esc'
  if (kind === 'csi') {
    // Parameter/intermediate bytes (0x20–0x3f), then one final byte.
    let i = start + (introducer === 0x1b ? 2 : 1)
    while (i < value.length && value.charCodeAt(i) >= 0x20 && value.charCodeAt(i) <= 0x3f) {
      i++
    }
    return i
  }
  if (kind === 'osc') {
    let i = start + (introducer === 0x1b ? 2 : 1)
    while (i < value.length) {
      const code = value.charCodeAt(i)
      if (code === 0x07 || code === 0x9c) {
        return i
      }
      if (code === 0x1b && value.charAt(i + 1) === '\\') {
        return i + 1
      }
      i++
    }
    return value.length
  }
  // Plain ESC sequence: intermediate bytes (0x20–0x2f), then one final byte —
  // covers charset designations like ESC ( B as well as two-byte forms.
  let i = start + 1
  while (i < value.length && value.charCodeAt(i) >= 0x20 && value.charCodeAt(i) <= 0x2f) {
    i++
  }
  return i
}

function sanitizeDescription(value: string): string {
  const flat = sanitizeField(value)
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

const defaultIo: CompletionIo = {
  stdout: process.stdout,
  stderr: process.stderr,
}

// Loaders (config, guidance) log warnings straight to stdout; at TAB time any
// such line would be read back as a completion candidate. Silence the logger
// for the duration — the helper's only legitimate output is candidate lines.
function silenceLog(): () => void {
  const original = { ...log }
  const noop = () => {}
  log.step = noop
  log.ok = noop
  log.fail = noop
  log.warn = noop
  log.info = noop
  log.done = noop
  log.log = noop
  log.status = noop
  log.clearStatus = noop
  return () => {
    Object.assign(log, original)
  }
}

export async function runComplete(args: string[], io: CompletionIo = defaultIo): Promise<number> {
  const restoreLog = silenceLog()
  try {
    const [rawCword, ...words] = args
    const cword = Number.parseInt(rawCword ?? '', 10)
    if (!Number.isInteger(cword) || cword < 0) {
      return 0
    }
    const candidates = await completeCandidates(words, cword, defaultResolver(process.cwd()))
    for (const candidate of candidates) {
      io.stdout.write(
        `${sanitizeField(candidate.name)}\t${sanitizeDescription(candidate.description)}\n`
      )
    }
  } catch {
    // Completion must never surface errors — no output, exit 0.
  } finally {
    restoreLog()
  }
  return 0
}
