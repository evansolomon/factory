import { type TaskComplexity, TaskComplexitySchema } from './task.ts'

const ADD_USAGE =
  'usage: factory add [--raw] [--trivial | --complexity trivial|complex] [--force-new] ' +
  '[--name <slug>] [intent...] [--verify <cmd...>] [--edit]'

export type ParsedAddOptions = {
  args: string[]
  raw: boolean
  complexity: TaskComplexity | null
  // Allow queueing a second fresh task in a worktree that already has one. The
  // workstream model is one active task per worktree; a second fresh task is an
  // error unless the batching is deliberate.
  forceNew: boolean
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
  const verifyIndex = args.indexOf('--verify')
  const head = verifyIndex === -1 ? args : args.slice(0, verifyIndex)
  const tail = verifyIndex === -1 ? [] : args.slice(verifyIndex + 1)
  if (tail.includes('--trivial') || tail.includes('--complexity')) {
    return fail('complexity flags must appear before --verify')
  }

  const cleaned: string[] = []
  let raw = false
  let forceNew = false
  let name: string | null = null
  let complexity: TaskComplexity | null = null
  for (let i = 0; i < head.length; i++) {
    const arg = head[i]
    if (arg === undefined) {
      continue
    }
    if (arg === '--raw') {
      raw = true
      continue
    }
    if (arg === '--force-new') {
      forceNew = true
      continue
    }
    if (arg === '--name') {
      const value = head[i + 1]
      if (!value || value.startsWith('--')) {
        return fail('--name needs a value')
      }
      name = value
      i++
      continue
    }
    if (arg === '--trivial') {
      const next = setComplexity(complexity, 'trivial')
      if (typeof next !== 'string') {
        return next
      }
      complexity = next
      continue
    }
    if (arg === '--complexity') {
      const value = head[i + 1]
      if (!value || value.startsWith('--')) {
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
      i++
      continue
    }
    cleaned.push(arg)
  }

  return {
    ok: true,
    options: {
      args: verifyIndex === -1 ? cleaned : [...cleaned, '--verify', ...tail],
      raw,
      complexity,
      forceNew,
      name,
    },
  }
}
