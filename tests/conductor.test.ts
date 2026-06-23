import { describe, expect, test } from 'bun:test'
import { decideComplexity } from '../src/conductor.ts'

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
