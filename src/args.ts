import type { OptionSpec, ValueSource } from './commands.ts'

// Declaration-driven flag scanner: every flag a command reads must be declared
// in its registry spec, and the result type is mapped from that declaration —
// an undeclared flag has no typed field to read. Token classification is a
// per-command policy so each command reproduces its historical parser exactly.
export type ScanPolicy = {
  // 'error':   undeclared flag-ish tokens fail (message commands, lessons, session, deck)
  // 'ignore':  undeclared flag-ish tokens are dropped (run, dispatch, harvest, gc,
  //            report, evals run, skills edit, config edit — today's tolerance)
  // 'collect': flag-ish tokens that are not declared options are positionals
  //            (add intent, delivery policy text)
  unknown: 'error' | 'ignore' | 'collect'
  // 'dash': -x and --x are flag-ish (default). 'double-dash': only --x
  // (e.g. `factory session -x` treats -x as a positional task query today).
  flagish?: 'dash' | 'double-dash'
  // deck treats a lone '-' as an unknown option; report ignores it; default: positional.
  loneDash?: 'positional' | 'flagish'
}

export type ScanError =
  | { kind: 'unknown-option'; option: string }
  | { kind: 'missing-value'; option: string }

export type FlagValues<Spec extends readonly OptionSpec[]> = {
  [O in Spec[number] as O['name']]: O extends { tail: true }
    ? string[] | undefined // the raw tail tokens, if the tail option appeared
    : O extends { value: ValueSource }
      ? string[] // every occurrence's value, in argv order
      : boolean
}

export type Scanned<Spec extends readonly OptionSpec[]> = {
  flags: FlagValues<Spec>
  positionals: string[]
}

export type ScanResult<Spec extends readonly OptionSpec[]> =
  | ({ ok: true } & Scanned<Spec>)
  | { ok: false; error: ScanError }

export function scanArgs<const Spec extends readonly OptionSpec[]>(
  options: Spec,
  args: string[],
  policy: ScanPolicy
): ScanResult<Spec> {
  const byToken = new Map<string, OptionSpec>()
  for (const option of options) {
    byToken.set(option.name, option)
    if (option.alias) {
      byToken.set(option.alias, option)
    }
  }

  const booleans = new Set<string>()
  const values = new Map<string, string[]>()
  let tail: { name: string; tokens: string[] } | null = null
  const positionals: string[] = []

  const isFlagish = (token: string): boolean => {
    if (token === '-') {
      return policy.loneDash === 'flagish'
    }
    if (token.startsWith('--')) {
      return true
    }
    return (policy.flagish ?? 'dash') === 'dash' && token.startsWith('-')
  }

  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === undefined) {
      continue
    }
    const option = byToken.get(token)
    if (option) {
      if (option.tail) {
        tail = { name: option.name, tokens: args.slice(i + 1) }
        break
      }
      if (option.value) {
        const next = args[i + 1]
        if (next === undefined) {
          return { ok: false, error: { kind: 'missing-value', option: token } }
        }
        const collected = values.get(option.name) ?? []
        collected.push(next)
        values.set(option.name, collected)
        i++
      } else {
        booleans.add(option.name)
      }
      continue
    }
    if (token.startsWith('--') && token.includes('=')) {
      const separator = token.indexOf('=')
      const candidate = byToken.get(token.slice(0, separator))
      if (candidate?.equals && candidate.value) {
        const collected = values.get(candidate.name) ?? []
        collected.push(token.slice(separator + 1))
        values.set(candidate.name, collected)
        continue
      }
    }
    if (isFlagish(token)) {
      if (policy.unknown === 'error') {
        return { ok: false, error: { kind: 'unknown-option', option: token } }
      }
      if (policy.unknown === 'collect') {
        positionals.push(token)
      }
      continue
    }
    positionals.push(token)
  }

  const flags: Record<string, boolean | string[] | undefined> = {}
  for (const option of options) {
    if (option.tail) {
      flags[option.name] = tail?.name === option.name ? tail.tokens : undefined
    } else if (option.value) {
      flags[option.name] = values.get(option.name) ?? []
    } else {
      flags[option.name] = booleans.has(option.name)
    }
  }
  // The record is built key-for-key from the same declarations the mapped type
  // is derived from; this is the one boundary where that has to be asserted.
  return { ok: true, flags: flags as FlagValues<Spec>, positionals }
}

// For specs whose scan cannot fail under the given policy (no valued options,
// unknowns tolerated). Throws on the impossible branch instead of inventing an
// error path.
export function scanFlags<const Spec extends readonly OptionSpec[]>(
  options: Spec,
  args: string[],
  policy: ScanPolicy
): Scanned<Spec> {
  const scan = scanArgs(options, args, policy)
  if (!scan.ok) {
    throw new Error(`option scan failed: ${scan.error.kind} ${scan.error.option}`)
  }
  return scan
}
