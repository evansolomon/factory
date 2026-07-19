import { describe, expect, test } from 'bun:test'
import {
  defaultTaskProfile,
  profileIsTrivial,
  resolveStageEffort,
  type TaskProfile,
} from '../src/effort.ts'

const low: TaskProfile = { ambiguity: 'low', coupling: 'low', consequence: 'low' }

describe('task profile routing', () => {
  test('keeps large mechanical work eligible for the trivial route', () => {
    expect(profileIsTrivial(low)).toBe(true)
    expect(profileIsTrivial({ ...low, coupling: 'medium' })).toBe(true)
  })

  test('routes ambiguity, high coupling, or high consequence through planning', () => {
    expect(profileIsTrivial({ ...low, ambiguity: 'medium' })).toBe(false)
    expect(profileIsTrivial({ ...low, coupling: 'high' })).toBe(false)
    expect(profileIsTrivial({ ...low, consequence: 'high' })).toBe(false)
  })

  test('uses conservative profiles when triage is skipped', () => {
    expect(defaultTaskProfile('trivial')).toEqual(low)
    expect(defaultTaskProfile('complex')).toEqual({
      ambiguity: 'medium',
      coupling: 'medium',
      consequence: 'medium',
    })
    expect(defaultTaskProfile(null)).toEqual(defaultTaskProfile('complex'))
  })
})

describe('stage effort policy', () => {
  test('uses medium planning for a low-demand task', () => {
    expect(resolveStageEffort({ stage: 'plan', profile: low, planRisk: null, attempt: 0 })).toEqual(
      {
        effort: 'medium',
        reason: 'low ambiguity/coupling',
      }
    )
  })

  test('uses the facet relevant to each stage', () => {
    const ambiguous: TaskProfile = { ...low, ambiguity: 'high' }
    expect(
      resolveStageEffort({ stage: 'plan', profile: ambiguous, planRisk: null, attempt: 0 }).effort
    ).toBe('high')
    expect(
      resolveStageEffort({ stage: 'implement', profile: ambiguous, planRisk: null, attempt: 0 })
        .effort
    ).toBe('medium')

    const consequential: TaskProfile = { ...low, consequence: 'high' }
    expect(
      resolveStageEffort({ stage: 'plan', profile: consequential, planRisk: null, attempt: 0 })
        .effort
    ).toBe('medium')
    expect(
      resolveStageEffort({ stage: 'security', profile: consequential, planRisk: null, attempt: 0 })
        .effort
    ).toBe('high')
  })

  test('raises post-plan effort when concrete risk increases', () => {
    expect(
      resolveStageEffort({ stage: 'implement', profile: low, planRisk: 6, attempt: 0 }).effort
    ).toBe('high')
    expect(
      resolveStageEffort({ stage: 'implement', profile: low, planRisk: 9, attempt: 0 }).effort
    ).toBe('xhigh')
    expect(
      resolveStageEffort({ stage: 'plan', profile: low, planRisk: 9, attempt: 0 }).effort
    ).toBe('medium')
    expect(
      resolveStageEffort({ stage: 'consolidate', profile: low, planRisk: 6, attempt: 0 }).effort
    ).toBe('high')
  })

  test('escalates distinct fix attempts and reserves xhigh for recovery', () => {
    expect(
      resolveStageEffort({ stage: 'implement', profile: low, planRisk: null, attempt: 1 }).effort
    ).toBe('high')
    expect(
      resolveStageEffort({ stage: 'implement', profile: low, planRisk: null, attempt: 2 }).effort
    ).toBe('xhigh')
    expect(
      resolveStageEffort({ stage: 'rescue', profile: low, planRisk: null, attempt: 0 }).effort
    ).toBe('xhigh')
  })

  test('keeps clerical stages cheap', () => {
    expect(
      resolveStageEffort({
        stage: 'name',
        profile: { ...low, ambiguity: 'high' },
        planRisk: 9,
        attempt: 2,
      }).effort
    ).toBe('low')
  })
})
