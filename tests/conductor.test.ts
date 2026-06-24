import { describe, expect, test } from 'bun:test'
import { decideComplexity, implementationAttemptCount } from '../src/conductor.ts'
import type { Failure } from '../src/task.ts'

describe('decideComplexity', () => {
  test('declared trivial wins regardless of triage config', () => {
    expect(decideComplexity('trivial', true)).toEqual({
      source: 'declared',
      trivial: true,
      complexity: 'trivial',
    })
    expect(decideComplexity('trivial', false)).toEqual({
      source: 'declared',
      trivial: true,
      complexity: 'trivial',
    })
  })

  test('declared complex wins regardless of triage config', () => {
    expect(decideComplexity('complex', true)).toEqual({
      source: 'declared',
      trivial: false,
      complexity: 'complex',
    })
    expect(decideComplexity('complex', false)).toEqual({
      source: 'declared',
      trivial: false,
      complexity: 'complex',
    })
  })

  test('no declaration uses triage when enabled', () => {
    expect(decideComplexity(null, true)).toEqual({ source: 'triage' })
  })

  test('no declaration uses no shortcut when triage is disabled', () => {
    expect(decideComplexity(null, false)).toEqual({ source: 'none' })
  })
})

describe('implementationAttemptCount', () => {
  test('ignores transient backoff failures', () => {
    const failures: Failure[] = [
      {
        attempt: 0,
        gate: 'review',
        summary: 'missing resume parameter',
        detail: 'review failed',
        remediation: 'code-fix',
      },
      {
        attempt: 1,
        gate: 'verify',
        summary: 'test database restarting',
        detail: 'verify failed',
        remediation: 'backoff',
      },
      {
        attempt: 1,
        gate: 'verify',
        summary: 'test database oom',
        detail: 'verify failed again',
        remediation: 'backoff',
      },
    ]

    expect(implementationAttemptCount(failures)).toBe(1)
  })
})
