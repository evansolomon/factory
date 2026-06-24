import { describe, expect, test } from 'bun:test'
import { onCompleteLabel, resolveOnComplete, taskOnCompleteLabel } from '../src/on-complete.ts'

describe('resolveOnComplete', () => {
  test('inherits configured delivery by default', () => {
    expect(resolveOnComplete({ mode: 'inherit' }, { skill: 'ship' })).toEqual({ skill: 'ship' })
  })

  test('disabled task override suppresses configured delivery', () => {
    expect(resolveOnComplete({ mode: 'disabled' }, { skill: 'ship' })).toBeNull()
  })

  test('task policy overrides configured delivery', () => {
    expect(
      resolveOnComplete({ mode: 'policy', policy: 'Make a PR and do not merge' }, { skill: 'ship' })
    ).toEqual({ policy: 'Make a PR and do not merge' })
  })

  test('labels configured and task-local values', () => {
    expect(onCompleteLabel(null)).toBe('disabled')
    expect(onCompleteLabel({ skill: 'ship' })).toBe('skill:ship')
    expect(onCompleteLabel({ policy: 'Make a PR' })).toBe('policy:Make a PR')
    expect(taskOnCompleteLabel({ mode: 'inherit' })).toBe('inherit')
    expect(taskOnCompleteLabel({ mode: 'disabled' })).toBe('disabled')
    expect(taskOnCompleteLabel({ mode: 'policy', policy: 'Make a PR' })).toBe('policy:Make a PR')
  })
})
