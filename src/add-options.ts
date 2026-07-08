import { scanArgs } from './args.ts'
import { ADD_PARSE_OPTIONS } from './commands.ts'
import { type TaskComplexity, TaskComplexitySchema } from './task.ts'

const ADD_USAGE =
  'usage: factory add [--raw] [--trivial | --complexity trivial|complex] [--allow-dirty] ' +
  '[--name <slug>] [intent...] [--verify <cmd...>] [--edit]'

export type ParsedAddOptions = {
  args: string[]
  raw: boolean
  complexity: TaskComplexity | null
  // Start a new task on a worktree that already has uncommitted changes. The
  // task's commit stages the whole tree (git add -A), so preexisting edits
  // would be swept into it under a message that describes only the new task —
  // starting dirty is an error unless it is deliberate.
  allowDirty: boolean
  // Explicit task id/slug from the caller (spawner tools already named the
  // worktree) — skips the namer model call entirely.
  name: string | null
}

export type ParseAddOptionsResult =
  | { ok: true; options: ParsedAddOptions }
  | { ok: false; message: string }

function fail(message: string): ParseAddOptionsResult {
  return { ok: false, message: `${ADD_USAGE}\n${message}` }
}

function setComplexity(
  current: TaskComplexity | null,
  next: TaskComplexity
): ParseAddOptionsResult | TaskComplexity {
  if (current !== null && current !== next) {
    return fail(`conflicting complexity flags: ${current} and ${next}`)
  }
  return next
}

export function parseAddOptions(args: string[]): ParseAddOptionsResult {
  // Unknown flag-ish tokens are intent words ('collect'); --verify consumes the
  // rest of the line as its tail. --edit is intentionally undeclared here so it
  // stays in the intent tokens for resolveIntent (which strips it anywhere,
  // including inside the verify tail).
  const scan = scanArgs(ADD_PARSE_OPTIONS, args, { unknown: 'collect' })
  if (!scan.ok) {
    if (scan.error.option === '--name') {
      return fail('--name needs a value')
    }
    return fail('--complexity needs a value: trivial or complex')
  }

  const tail = scan.flags['--verify']
  if (tail?.includes('--trivial') || tail?.includes('--complexity')) {
    return fail('complexity flags must appear before --verify')
  }

  let name: string | null = null
  for (const value of scan.flags['--name']) {
    if (value.startsWith('--')) {
      return fail('--name needs a value')
    }
    name = value
  }

  let complexity: TaskComplexity | null = null
  if (scan.flags['--trivial']) {
    complexity = 'trivial'
  }
  for (const value of scan.flags['--complexity']) {
    if (value.startsWith('--')) {
      return fail('--complexity needs a value: trivial or complex')
    }
    const parsed = TaskComplexitySchema.safeParse(value)
    if (!parsed.success) {
      return fail(`invalid complexity "${value}" (expected trivial or complex)`)
    }
    const next = setComplexity(complexity, parsed.data)
    if (typeof next !== 'string') {
      return next
    }
    complexity = next
  }

  return {
    ok: true,
    options: {
      args: tail === undefined ? scan.positionals : [...scan.positionals, '--verify', ...tail],
      raw: scan.flags['--raw'],
      complexity,
      allowDirty: scan.flags['--allow-dirty'],
      name,
    },
  }
}
