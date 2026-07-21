import { describe, expect, test } from 'bun:test'
import {
  decideFeedbackRoute,
  type FeedbackRouteInput,
  followUpIntent,
  isDefaultFeedbackTarget,
  latestFeedbackTarget,
  renderTerminalFeedback,
} from '../src/feedback.ts'
import { deckPrompt, feedbackPrompt } from '../src/prompts.ts'
import type { Task } from '../src/task.ts'
import { SHOW_ARTIFACTS } from '../src/view.ts'

describe('feedbackPrompt', () => {
  test('includes the task id, show pointer, and completed verify command', () => {
    const prompt = feedbackPrompt({
      taskId: 'add-feedback-handoff',
      intent: 'Add completion feedback',
      finalPlan: 'Save feedback.md after delivery.',
      verify: 'bun run test',
      diff: 'diff --git a/src/example.ts b/src/example.ts',
      proof: '`bun run test` passed',
      verifyLog: '$ bun run test\nok',
      ship: 'SHIP: OK',
    })

    expect(prompt).toContain('add-feedback-handoff')
    expect(prompt).toContain('factory show add-feedback-handoff')
    expect(prompt).toContain('The verification command that already passed is: `bun run test`')
  })

  test('states guardrails against invented checks and raw dumps', () => {
    const prompt = feedbackPrompt({
      taskId: 'guardrails',
      intent: 'Summarize safely',
      finalPlan: null,
      verify: null,
      diff: null,
      proof: null,
      verifyLog: null,
      ship: null,
    })

    expect(prompt).toContain('Do not invent URLs, UI paths, commands')
    expect(prompt).toContain('Do not paste raw diffs, raw logs, secrets, or large blobs')
    expect(prompt).toContain('If no UI or manual check is identifiable')
  })

  test('omits optional context blocks when absent', () => {
    const prompt = feedbackPrompt({
      taskId: 'minimal',
      intent: 'Minimal feedback',
      finalPlan: null,
      verify: null,
      diff: null,
      proof: null,
      verifyLog: null,
      ship: null,
    })

    expect(prompt).not.toContain('## Final plan')
    expect(prompt).not.toContain('## Committed diff')
    expect(prompt).not.toContain('## Proof artifact')
    expect(prompt).not.toContain('## Verify log')
    expect(prompt).not.toContain('## Delivery output')
  })
})

describe('deckPrompt', () => {
  test('states the HTML document contract and guardrails', () => {
    const prompt = deckPrompt({
      taskId: 'brief-task',
      intent: 'Build a completion brief',
      finalPlan: 'Generate brief.html beside feedback.md.',
      verify: 'bun run test',
      diff: 'diff --git a/src/deck.ts b/src/deck.ts',
      proof: '`bun run test` passed',
      verifyLog: '$ bun run test\nok',
      ship: 'SHIP: OK',
      feedback: '## Summary\nBuilt the deck command.',
    })

    expect(prompt).toContain('Output one complete HTML document only.')
    expect(prompt).toContain('Start with exactly `<!doctype html>`.')
    expect(prompt).toContain('Do not wrap the document in markdown fences.')
    expect(prompt).toContain('optional Mermaid 11 from jsDelivr')
    expect(prompt).toContain('Do not paste raw diffs, raw logs, secrets, or large blobs.')
    expect(prompt).toContain('stable top header with the task id')
    expect(prompt).toContain(
      'The exact verification command that already passed is: `bun run test`'
    )
    expect(prompt).toContain('## Feedback handoff')
    expect(prompt).toContain('Built the deck command.')
  })

  test('omits the optional feedback block when absent', () => {
    const prompt = deckPrompt({
      taskId: 'no-feedback',
      intent: 'Build a completion brief',
      finalPlan: null,
      verify: null,
      diff: null,
      proof: null,
      verifyLog: null,
      ship: null,
      feedback: null,
    })

    expect(prompt).not.toContain('## Feedback handoff')
  })
})

describe('renderTerminalFeedback', () => {
  test('preserves a normal handoff and appends the show pointer', () => {
    const lines = renderTerminalFeedback(
      [
        '## Summary',
        '',
        'Changed the completion path.',
        '',
        '## What to verify next',
        '',
        '- `bun run test` already passed.',
      ].join('\n'),
      'task-1'
    )

    expect(lines).toEqual([
      '## Summary',
      '',
      'Changed the completion path.',
      '',
      '## What to verify next',
      '',
      '- `bun run test` already passed.',
      '',
      'detail: factory show task-1',
    ])
  })

  test('clips pathological output with a marker', () => {
    const handoff = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join('\n')
    const lines = renderTerminalFeedback(handoff, 'long-task')

    expect(lines).toContain('[handoff clipped; run factory show long-task for the full artifact]')
    expect(lines[lines.length - 1]).toBe('detail: factory show long-task')
    expect(lines.length).toBeLessThanOrEqual(43)
  })
})

describe('SHOW_ARTIFACTS', () => {
  test('shows completion feedback before plan artifacts', () => {
    expect(SHOW_ARTIFACTS[0]).toEqual(['feedback.md', '## Completion feedback'])
    const names = SHOW_ARTIFACTS.map(([name]) => name)

    expect(names.indexOf('feedback.md')).toBeLessThan(names.indexOf('plan.final.md'))
    expect(names).toContain('commit.log')
    expect(names).toContain('risk.shape.md')
    expect(names).not.toContain('brief.html')
  })
})

function task(id: string, updatedAt: string, overrides: Partial<Task['meta']> = {}): Task {
  return {
    id,
    dir: `/tmp/factory/tasks/${id}`,
    meta: {
      id,
      slug: id,
      status: 'ready',
      verify: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt,
      commit: null,
      commitStartedAt: null,
      note: null,
      sharpen: 'done',
      resume: false,
      resumeNote: null,
      resumeKind: null,
      retryAt: null,
      autoRetries: 0,
      strategyEpoch: 0,
      strategyBudget: null,
      executionOverride: null,
      dispatchChainId: null,
      complexity: null,
      taskProfile: null,
      implementer: null,
      delivery: { mode: 'pending' },
      deliveryProposalAt: null,
      shipBranch: null,
      shipUrl: null,
      harvestedAt: null,
      questionRounds: 0,
      autoAcceptedRounds: 0,
      feedbackCount: 0,
      feedbackConsumed: 0,
      feedbackSourceTaskId: null,
      ...overrides,
    },
  }
}

function route(overrides: Partial<FeedbackRouteInput>) {
  return decideFeedbackRoute({
    status: 'ready',
    hasPlan: false,
    hasWorktreeDiff: false,
    hasCommit: false,
    pendingFeedback: false,
    loopActive: false,
    ...overrides,
  })
}

describe('feedback routing', () => {
  test('done routes to follow-up', () => {
    expect(route({ status: 'done' })).toEqual({ kind: 'follow-up' })
  })

  test('any committed task routes to follow-up', () => {
    expect(route({ status: 'retrying', hasCommit: true, hasWorktreeDiff: true })).toEqual({
      kind: 'follow-up',
    })
  })

  test('needs-input rejects with answer guidance', () => {
    expect(route({ status: 'needs-input' })).toEqual({
      kind: 'reject',
      message: 'task is waiting for answers; use factory add',
    })
  })

  test('fresh ready rejects with add guidance', () => {
    expect(route({ status: 'ready' })).toEqual({
      kind: 'reject',
      message: 'task has no progress to give feedback on; use factory add for new work',
    })
  })

  test('ready with diff routes to resume', () => {
    expect(route({ status: 'ready', hasWorktreeDiff: true })).toEqual({ kind: 'resume' })
  })

  test('blocked with plan routes to resume', () => {
    expect(route({ status: 'blocked', hasPlan: true })).toEqual({ kind: 'resume' })
  })

  test('retrying with diff routes to resume', () => {
    expect(route({ status: 'retrying', hasWorktreeDiff: true })).toEqual({ kind: 'resume' })
  })

  test('default-target predicate excludes fresh, needs-input, and live pre-plan tasks', () => {
    expect(isDefaultFeedbackTarget({ ...baseInput(), status: 'ready' })).toBe(false)
    expect(isDefaultFeedbackTarget({ ...baseInput(), status: 'needs-input' })).toBe(false)
    expect(isDefaultFeedbackTarget({ ...baseInput(), status: 'planning' })).toBe(false)
    expect(isDefaultFeedbackTarget({ ...baseInput(), status: 'ready', hasPlan: true })).toBe(true)
  })

  test('latest feedback target uses the filtered eligible set', () => {
    const fresh = task('fresh', '2026-01-03T00:00:00.000Z')
    const eligible = task('eligible', '2026-01-02T00:00:00.000Z')
    const needsInput = task('needs-input', '2026-01-04T00:00:00.000Z', {
      status: 'needs-input',
    })

    const target = latestFeedbackTarget([eligible, fresh, needsInput], (candidate) =>
      baseInput({
        status: candidate.meta.status,
        hasPlan: candidate.id === eligible.id,
      })
    )

    expect(target?.id).toBe('eligible')
  })
})

describe('feedback follow-up intent', () => {
  test('includes source task details and raw feedback', () => {
    const source = task('fix-layout', '2026-01-01T00:00:00.000Z', {
      commit: 'abc1234',
      verify: 'bun test',
    })

    const intent = followUpIntent(source, 'The mobile button wraps badly.')

    expect(intent).toContain('Address feedback on fix-layout')
    expect(intent).toContain('- id: fix-layout')
    expect(intent).toContain('- commit: abc1234')
    expect(intent).toContain('- task dir: /tmp/factory/tasks/fix-layout')
    expect(intent).toContain('- inspect: factory show fix-layout')
    expect(intent).toContain('- verify: bun test')
    expect(intent).toContain('The mobile button wraps badly.')
  })
})

function baseInput(overrides: Partial<FeedbackRouteInput> = {}): FeedbackRouteInput {
  return {
    status: 'ready',
    hasPlan: false,
    hasWorktreeDiff: false,
    hasCommit: false,
    pendingFeedback: false,
    loopActive: false,
    ...overrides,
  }
}
