import { describe, expect, test } from 'bun:test'
import { scanArgs, scanFlags } from '../src/args.ts'
import type { OptionSpec } from '../src/commands.ts'

const OPTIONS = [
  { name: '--flag', description: 'a boolean' },
  { name: '--value', alias: '-v', description: 'a valued option', value: { kind: 'none' } },
  {
    name: '--equals',
    description: 'valued, accepts --equals=x',
    value: { kind: 'none' },
    equals: true,
  },
  { name: '--tail', description: 'consumes the rest', value: { kind: 'none' }, tail: true },
] as const satisfies readonly OptionSpec[]

describe('scanArgs', () => {
  test('separates flags, values, and positionals', () => {
    const scan = scanArgs(OPTIONS, ['a', '--flag', '--value', 'x', 'b'], { unknown: 'error' })
    if (!scan.ok) {
      throw new Error('expected ok')
    }
    expect(scan.flags['--flag']).toBe(true)
    expect(scan.flags['--value']).toEqual(['x'])
    expect(scan.positionals).toEqual(['a', 'b'])
  })

  test('aliases collect under the canonical name, repeats in argv order', () => {
    const scan = scanArgs(OPTIONS, ['-v', 'one', '--value', 'two'], { unknown: 'error' })
    if (!scan.ok) {
      throw new Error('expected ok')
    }
    expect(scan.flags['--value']).toEqual(['one', 'two'])
  })

  test('equals form is recognized only when declared', () => {
    const declared = scanArgs(OPTIONS, ['--equals=x=y'], { unknown: 'error' })
    if (!declared.ok) {
      throw new Error('expected ok')
    }
    expect(declared.flags['--equals']).toEqual(['x=y'])

    const undeclared = scanArgs(OPTIONS, ['--value=x'], { unknown: 'error' })
    expect(undeclared).toEqual({
      ok: false,
      error: { kind: 'unknown-option', option: '--value=x' },
    })
  })

  test('a valued option consumes the next token verbatim, even a flag', () => {
    const scan = scanArgs(OPTIONS, ['--value', '--flag'], { unknown: 'error' })
    if (!scan.ok) {
      throw new Error('expected ok')
    }
    expect(scan.flags['--value']).toEqual(['--flag'])
    expect(scan.flags['--flag']).toBe(false)
  })

  test('missing value errors with the token as written', () => {
    expect(scanArgs(OPTIONS, ['-v'], { unknown: 'error' })).toEqual({
      ok: false,
      error: { kind: 'missing-value', option: '-v' },
    })
  })

  test('tail consumes everything after it, unparsed', () => {
    const scan = scanArgs(OPTIONS, ['a', '--tail', '--flag', 'b', '-v'], { unknown: 'error' })
    if (!scan.ok) {
      throw new Error('expected ok')
    }
    expect(scan.flags['--tail']).toEqual(['--flag', 'b', '-v'])
    expect(scan.flags['--flag']).toBe(false)
    expect(scan.positionals).toEqual(['a'])
  })

  test('absent tail is undefined, present-but-empty tail is []', () => {
    const absent = scanFlags(OPTIONS, [], { unknown: 'error' })
    expect(absent.flags['--tail']).toBeUndefined()
    const empty = scanFlags(OPTIONS, ['--tail'], { unknown: 'error' })
    expect(empty.flags['--tail']).toEqual([])
  })

  test('unknown policy: error, ignore, collect', () => {
    expect(scanArgs(OPTIONS, ['--wat'], { unknown: 'error' })).toEqual({
      ok: false,
      error: { kind: 'unknown-option', option: '--wat' },
    })

    const ignored = scanFlags(OPTIONS, ['--wat', 'a'], { unknown: 'ignore' })
    expect(ignored.positionals).toEqual(['a'])

    const collected = scanFlags(OPTIONS, ['--wat', 'a'], { unknown: 'collect' })
    expect(collected.positionals).toEqual(['--wat', 'a'])
  })

  test('flagish policy: double-dash treats single-dash tokens as positionals', () => {
    const dash = scanArgs(OPTIONS, ['-x'], { unknown: 'error' })
    expect(dash).toEqual({ ok: false, error: { kind: 'unknown-option', option: '-x' } })

    const doubleDash = scanFlags(OPTIONS, ['-x'], { unknown: 'error', flagish: 'double-dash' })
    expect(doubleDash.positionals).toEqual(['-x'])
  })

  test('lone dash is positional by default, flag-ish on request', () => {
    const positional = scanFlags(OPTIONS, ['-'], { unknown: 'error' })
    expect(positional.positionals).toEqual(['-'])

    expect(scanArgs(OPTIONS, ['-'], { unknown: 'error', loneDash: 'flagish' })).toEqual({
      ok: false,
      error: { kind: 'unknown-option', option: '-' },
    })

    const ignored = scanFlags(OPTIONS, ['-'], { unknown: 'ignore', loneDash: 'flagish' })
    expect(ignored.positionals).toEqual([])
  })

  test('scanFlags throws on the impossible error branch', () => {
    expect(() => scanFlags(OPTIONS, ['--value'], { unknown: 'error' })).toThrow(
      'option scan failed'
    )
  })

  test('an undeclared flag has no typed field to read', () => {
    const scan = scanFlags(OPTIONS, [], { unknown: 'ignore' })
    // The compile-time drift guard: the result type is mapped from the declared
    // option tuple, so this line only typechecks while '--undeclared' is absent
    // from OPTIONS — tsc fails on the unused directive if it ever compiles.
    // @ts-expect-error '--undeclared' is not a declared option
    void scan.flags['--undeclared']
    expect(scan.flags['--flag']).toBe(false)
  })
})
