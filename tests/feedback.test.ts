import { describe, expect, test } from 'bun:test'
import { renderTerminalFeedback } from '../src/feedback.ts'
import { feedbackPrompt } from '../src/prompts.ts'
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
  })
})
