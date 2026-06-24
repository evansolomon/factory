import { composeInEditor } from './editor.ts'

// Shared argument handling for the human-input commands (answer/retry/feedback).
// The message is NEVER positional: the single optional positional is always the
// task id. That removes the old id-vs-text ambiguity, where a feedback/answer/note
// whose first word happened to match (or be a substring of) a task id silently
// bound to that task instead of being read as the message.

export type ParsedInput =
  | { ok: true; taskQuery: string | null; message: string | null; edit: boolean }
  | { ok: false; error: string }

// Parse `[task-id] [-m|--message <text>] [--edit]`. `message` here is only the
// inline value from -m/--message; an absent flag (null) is resolved later from
// $EDITOR or stdin by resolveMessage. Repeated -m: last value wins.
export function parseInputArgs(args: string[], usage: string): ParsedInput {
  let message: string | null = null
  let edit = false
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '-m' || arg === '--message') {
      const next = args[i + 1]
      if (next === undefined) {
        return { ok: false, error: usage }
      }
      message = next
      i++
    } else if (arg.startsWith('--message=')) {
      message = arg.slice('--message='.length)
    } else if (arg === '--edit') {
      edit = true
    } else if (arg.startsWith('--') || (arg.startsWith('-') && arg !== '-')) {
      return { ok: false, error: `unknown option ${arg}\n${usage}` }
    } else {
      positionals.push(arg)
    }
  }
  if (positionals.length > 1) {
    return {
      ok: false,
      error: `${usage}\nthe message is set with -m/--message or composed in $EDITOR`,
    }
  }
  return { ok: true, taskQuery: positionals[0] ?? null, message, edit }
}

// Resolve the free-text message from the parsed flags. 'required' commands
// (answer/feedback) fall back to $EDITOR in a TTY or stdin when piped; 'optional'
// commands (retry) only produce a note from an explicit -m or --edit, so a bare
// `factory retry` still just retries with no note. Returns null when empty.
export async function resolveMessage(
  parsed: { message: string | null; edit: boolean },
  mode: 'required' | 'optional'
): Promise<string | null> {
  if (parsed.message !== null) {
    return parsed.message.trim() || null
  }
  if (parsed.edit) {
    return (await composeInEditor()).trim() || null
  }
  if (mode === 'required') {
    const text = process.stdin.isTTY ? await composeInEditor() : (await Bun.stdin.text()).trim()
    return text.trim() || null
  }
  return null
}
