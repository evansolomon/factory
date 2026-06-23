import { describe, expect, test } from 'bun:test'
import { parseInputArgs } from '../src/input.ts'

const usage = 'usage: factory feedback [task-id] [-m <feedback> | --edit]'

describe('parseInputArgs', () => {
  test('no args: no task, no message', () => {
    expect(parseInputArgs([], usage)).toEqual({
      ok: true,
      taskQuery: null,
      message: null,
      edit: false,
    })
  })

  test('lone positional is the task id, not a message', () => {
    expect(parseInputArgs(['fix-login'], usage)).toEqual({
      ok: true,
      taskQuery: 'fix-login',
      message: null,
      edit: false,
    })
  })

  test('-m carries the message', () => {
    expect(parseInputArgs(['-m', 'the button wraps'], usage)).toEqual({
      ok: true,
      taskQuery: null,
      message: 'the button wraps',
      edit: false,
    })
  })

  test('task id plus -m', () => {
    expect(parseInputArgs(['fix-login', '-m', 'the button wraps'], usage)).toEqual({
      ok: true,
      taskQuery: 'fix-login',
      message: 'the button wraps',
      edit: false,
    })
  })

  test('--message= form and --edit', () => {
    expect(parseInputArgs(['--message=hi'], usage)).toMatchObject({ message: 'hi' })
    expect(parseInputArgs(['--edit'], usage)).toMatchObject({ edit: true, message: null })
  })

  test('-m without a value is an error', () => {
    expect(parseInputArgs(['fix-login', '-m'], usage)).toEqual({ ok: false, error: usage })
  })

  // The old gotcha: a free-text message whose words are not a task id used to bind
  // silently. Now bare words are positionals, so >1 positional is a clear error that
  // points at -m instead of mis-parsing.
  test('multiple bare words error instead of binding to a task', () => {
    const result = parseInputArgs(['login', 'is', 'broken'], usage)
    expect(result.ok).toBe(false)
  })

  test('unknown option is rejected', () => {
    const result = parseInputArgs(['--nope'], usage)
    expect(result.ok).toBe(false)
  })
})
