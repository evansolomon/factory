import { describe, expect, test } from 'bun:test'
import {
  decideComplexity,
  deliveryConfirmationQuestions,
  implementationAttemptCount,
  resolveDeliveryProposal,
  resumeUserFacing,
} from '../src/conductor.ts'
import type { TaskDelivery } from '../src/delivery.ts'
import { parseFormattedQuestions } from '../src/sharpen.ts'
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

describe('resumeUserFacing', () => {
  test('prefers persisted user-facing metadata before falling back to diff', () => {
    expect(resumeUserFacing(true, true, false)).toBe(true)
    expect(resumeUserFacing(true, false, true)).toBe(false)
    expect(resumeUserFacing(true, undefined, true)).toBe(true)
    expect(resumeUserFacing(false, true, true)).toBe(false)
  })
})

describe('delivery confirmation', () => {
  const proposed: TaskDelivery = {
    mode: 'skill',
    skill: 'ship',
    source: 'selected',
    confidence: 'high',
    reason: 'Similar factory tasks used ship.',
  }
  const skills = [
    { name: 'pr', description: null },
    { name: 'ship', description: null },
  ]

  test('formats a recommended-answer confirmation question', () => {
    const questions = deliveryConfirmationQuestions(proposed)
    const parsed = parseFormattedQuestions(questions)

    expect(parsed.preamble).toContain('Confirm delivery - $ship auto-selected.')
    expect(parsed.preamble).toContain('Proposed delivery: $ship (skill:ship)')
    expect(parsed.preamble).toContain('Reason: Similar factory tasks used ship.')
    expect(parsed.questions).toEqual([
      {
        q: 'Which delivery should run when the task finishes after review, verify, and commit?',
        rec: '$ship',
      },
    ])
  })

  test('round-trips a policy recommendation through formatted questions', () => {
    const policy: TaskDelivery = {
      mode: 'policy',
      policy: 'Open a PR with title `delivery: confirm $ship` and wait for CI.',
      source: 'selected',
      confidence: 'medium',
      reason: 'The task asks for a one-off release policy.',
    }
    const parsed = parseFormattedQuestions(deliveryConfirmationQuestions(policy))

    expect(parsed.preamble).toContain('Confirm delivery - policy auto-selected.')
    expect(parsed.preamble).toContain(
      'Proposed delivery: Open a PR with title `delivery: confirm $ship` and wait for CI.'
    )
    expect(parsed.questions).toEqual([
      {
        q: 'Which delivery should run when the task finishes after review, verify, and commit?',
        rec: 'Open a PR with title `delivery: confirm $ship` and wait for CI.',
      },
    ])
  })

  test('keeps a delivery proposal needs-input without a usable answer', () => {
    expect(
      resolveDeliveryProposal({
        proposed,
        proposedAt: '2026-01-01T00:00:00.000Z',
        answers: null,
        skills,
      })
    ).toEqual({
      kind: 'needs-input',
      questions: deliveryConfirmationQuestions(proposed),
    })
    expect(
      resolveDeliveryProposal({
        proposed,
        proposedAt: '2026-01-01T00:00:00.000Z',
        answers: '## Answer (2026-01-01T00:00:01.000Z)\nQ: Run delivery?\nA: (skipped)',
        skills,
      })
    ).toEqual({
      kind: 'needs-input',
      questions: deliveryConfirmationQuestions(proposed),
    })
  })

  test('ignores stale answers written before the delivery proposal', () => {
    expect(
      resolveDeliveryProposal({
        proposed,
        proposedAt: '2026-01-01T00:00:00.000Z',
        answers: [
          '## Answer (2025-12-31T00:00:00.000Z)',
          'Q: Earlier clarification?',
          'A: $ship',
          '',
          '## Answer (2025-12-31T00:00:01.000Z)',
          'Use the original plan.',
        ].join('\n'),
        skills,
      })
    ).toEqual({
      kind: 'needs-input',
      questions: deliveryConfirmationQuestions(proposed),
    })
  })

  test('confirms selected ship with the recommended answer', () => {
    expect(
      resolveDeliveryProposal({
        proposed,
        proposedAt: '2026-01-01T00:00:00.000Z',
        answers:
          '## Answer (2026-01-01T00:00:01.000Z)\nQ: Run delivery?\nRecommended: $ship\nA: $ship',
        skills,
      })
    ).toEqual({ kind: 'confirmed', delivery: proposed })
  })

  test('overrides selected ship with manual none', () => {
    expect(
      resolveDeliveryProposal({
        proposed,
        proposedAt: '2026-01-01T00:00:00.000Z',
        answers: '## Answer (2026-01-01T00:00:01.000Z)\nnone',
        skills,
      })
    ).toEqual({
      kind: 'confirmed',
      delivery: {
        mode: 'none',
        source: 'manual',
        confidence: 'high',
        reason: 'User manually disabled delivery.',
      },
    })
  })
})
