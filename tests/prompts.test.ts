import { describe, expect, test } from 'bun:test'
import { feedbackAnalysisPrompt, fixPrompt, implementPrompt } from '../src/prompts.ts'

describe('feedback prompts', () => {
  test('feedbackAnalysisPrompt requires abstraction and root-cause inference', () => {
    const prompt = feedbackAnalysisPrompt('Fix layout', 'Button wraps.', 'diff --git', 'Plan')

    expect(prompt).toContain('Inferred abstract problem or root cause')
    expect(prompt).toContain('First infer the abstraction/root cause')
  })

  test('feedbackAnalysisPrompt requires inspecting other applicable instances', () => {
    const prompt = feedbackAnalysisPrompt('Fix layout', 'Button wraps.', 'diff --git', 'Plan')

    expect(prompt).toContain('Other applicable concrete instances')
    expect(prompt).toContain('then search downward for concrete affected cases')
  })

  test('feedbackAnalysisPrompt requires non-applicable cases', () => {
    const prompt = feedbackAnalysisPrompt('Fix layout', 'Button wraps.', 'diff --git', 'Plan')

    expect(prompt).toContain('Non-applicable look-alikes')
  })

  test('feedbackAnalysisPrompt requires changing only justified cases', () => {
    const prompt = feedbackAnalysisPrompt('Fix layout', 'Button wraps.', 'diff --git', 'Plan')

    expect(prompt).toContain('Change only cases justified by that abstraction')
  })

  test('fixPrompt includes a distinct human feedback analysis section', () => {
    const prompt = fixPrompt(
      'Fix layout',
      'Plan',
      'Human feedback requires a follow-up fix pass.',
      [],
      'diff --git',
      true,
      null,
      'The root cause is narrow buttons.'
    )

    expect(prompt).toContain('## Human feedback analysis')
    expect(prompt).toContain('The root cause is narrow buttons.')
  })

  test('implementPrompt includes a distinct human feedback analysis section', () => {
    const prompt = implementPrompt(
      'Fix layout',
      'Plan',
      'bun test',
      false,
      null,
      'The root cause is narrow buttons.'
    )

    expect(prompt).toContain('## Human feedback analysis')
    expect(prompt).toContain('The root cause is narrow buttons.')
  })
})
