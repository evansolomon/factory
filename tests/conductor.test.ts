import { describe, expect, test } from 'bun:test'
import {
  decideComplexity,
  deliveryConfirmationQuestions,
  executionShapeConsensus,
  freshRunImplementer,
  gateCodeFixAttemptCount,
  grantsAtomicExecution,
  implementationAttemptCount,
  resolveDeliveryProposal,
  resolveImplementer,
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

describe('resolveImplementer', () => {
  const pool = { quick: 'codex' as const }

  test('missing or blank marker values resolve to the default', () => {
    expect(resolveImplementer(null, pool)).toBeNull()
    expect(resolveImplementer('   ', pool)).toBeNull()
  })

  test('the DEFAULT sentinel resolves to the default in any case', () => {
    expect(resolveImplementer('DEFAULT', pool)).toBeNull()
    expect(resolveImplementer('default', pool)).toBeNull()
    expect(resolveImplementer(' Default ', pool)).toBeNull()
  })

  test('the reserved default pool entry can never route as a named entry', () => {
    // The lead lives in the pool under `default`; the sentinel check intercepts
    // the name before pool lookup, so it always means "use the lead".
    expect(resolveImplementer('default', { default: 'codex', quick: 'claude' })).toBeNull()
  })

  test('an exact pool name resolves, tolerating surrounding whitespace', () => {
    expect(resolveImplementer('quick', pool)).toBe('quick')
    expect(resolveImplementer('  quick ', pool)).toBe('quick')
  })

  test('unknown and case-mismatched names fail safe to the default', () => {
    // Exact matching is the contract: AgentMapSchema allows case-variant
    // sibling keys, so a forgiving match could pick the wrong agent.
    expect(resolveImplementer('Quick', pool)).toBeNull()
    expect(resolveImplementer('no-such-agent', pool)).toBeNull()
    // Prototype-chain properties are not pool entries.
    expect(resolveImplementer('constructor', pool)).toBeNull()
  })

  test('an empty pool always resolves to the default', () => {
    expect(resolveImplementer('quick', {})).toBeNull()
  })
})

// The meta transition every fresh run applies after the complexity phase —
// the ONLY writer of task.meta.implementer.
describe('freshRunImplementer', () => {
  const pool = { quick: 'codex' as const }

  test('a triaged run with a pool persists the resolved routing decision', () => {
    expect(freshRunImplementer({ source: 'triage' }, 'quick', pool)).toBe('quick')
    expect(freshRunImplementer({ source: 'triage' }, 'DEFAULT', pool)).toBeNull()
    expect(freshRunImplementer({ source: 'triage' }, null, pool)).toBeNull()
  })

  test('a triaged run with an empty pool clears a stale routing decision', () => {
    // Regression: the pool was removed after an earlier run routed this task.
    // Triage no longer asks for the marker, and whatever meta held must not
    // survive this run to route a later resume once the pool is restored.
    expect(freshRunImplementer({ source: 'triage' }, null, {})).toBeNull()
    expect(freshRunImplementer({ source: 'triage' }, 'quick', {})).toBeNull()
  })

  test('triage-skipped runs never route, whatever the marker or pool', () => {
    expect(
      freshRunImplementer(
        { source: 'declared', trivial: true, complexity: 'trivial' },
        'quick',
        pool
      )
    ).toBeNull()
    expect(freshRunImplementer({ source: 'none' }, 'quick', pool)).toBeNull()
  })
})

describe('implementationAttemptCount', () => {
  test('ignores transient backoff failures', () => {
    const failures: Failure[] = [
      {
        attempt: 0,
        strategyEpoch: 0,
        gate: 'review',
        summary: 'missing resume parameter',
        detail: 'review failed',
        remediation: 'code-fix',
      },
      {
        attempt: 1,
        strategyEpoch: 0,
        gate: 'verify',
        summary: 'test database restarting',
        detail: 'verify failed',
        remediation: 'backoff',
      },
      {
        attempt: 1,
        strategyEpoch: 0,
        gate: 'verify',
        summary: 'test database oom',
        detail: 'verify failed again',
        remediation: 'backoff',
      },
    ]

    expect(implementationAttemptCount(failures)).toBe(1)
  })

  test('counts only the current strategy epoch', () => {
    const failures: Failure[] = [
      {
        attempt: 0,
        strategyEpoch: 0,
        gate: 'review',
        summary: 'old strategy',
        detail: 'failed',
        remediation: 'code-fix',
      },
      {
        attempt: 0,
        strategyEpoch: 1,
        gate: 'review',
        summary: 'new strategy',
        detail: 'failed differently',
        remediation: 'code-fix',
      },
    ]

    expect(implementationAttemptCount(failures, 0)).toBe(1)
    expect(implementationAttemptCount(failures, 1)).toBe(1)
  })
})

describe('gateCodeFixAttemptCount', () => {
  test('gives a newly discovered gate an independent repair budget', () => {
    const failures: Failure[] = [
      {
        attempt: 0,
        strategyEpoch: 0,
        gate: 'review',
        summary: 'first review defect',
        detail: 'review failed',
        remediation: 'code-fix',
      },
      {
        attempt: 1,
        strategyEpoch: 0,
        gate: 'review',
        summary: 'second review defect',
        detail: 'review failed again',
        remediation: 'code-fix',
      },
      {
        attempt: 2,
        strategyEpoch: 0,
        gate: 'commit',
        summary: 'lint hook failed',
        detail: 'git commit failed',
        remediation: 'code-fix',
      },
      {
        attempt: 3,
        strategyEpoch: 0,
        gate: 'commit',
        summary: 'temporary hook environment failure',
        detail: 'git commit failed again',
        remediation: 'backoff',
      },
    ]

    expect(gateCodeFixAttemptCount(failures, 'commit')).toBe(1)
    expect(gateCodeFixAttemptCount(failures, 'review')).toBe(2)
  })
})

describe('execution shape guard', () => {
  test('requires an exact explicit atomic override', () => {
    expect(grantsAtomicExecution('atomic')).toBe(true)
    expect(grantsAtomicExecution(' ATOMIC ')).toBe(true)
    expect(grantsAtomicExecution('continue')).toBe(false)
    expect(grantsAtomicExecution(null)).toBe(false)
  })

  test('requires independent confirmation before parking staged or unclear plans', () => {
    expect(executionShapeConsensus('ATOMIC', null)).toBe('ATOMIC')
    expect(executionShapeConsensus('STAGED', 'ATOMIC')).toBe('ATOMIC')
    expect(executionShapeConsensus('STAGED', 'STAGED')).toBe('STAGED')
    expect(executionShapeConsensus(null, 'ATOMIC')).toBe('ATOMIC')
    expect(executionShapeConsensus(null, null)).toBeNull()
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
