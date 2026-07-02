import { describe, expect, test } from 'bun:test'
import { classifyAnswer, renderAskCalibration } from '../src/question-stats.ts'

const QUESTIONS = [
  '- Should auto-upgrade skip source runs?',
  '  Recommended: Yes, only run when an installed binary is detectable.',
  '',
  '- Which commands are eligible?',
  '  Recommended: All normal commands except help, version, and upgrade.',
].join('\n')

describe('question-bar measurement', () => {
  test('classifies rubber-stamp acceptances', () => {
    expect(
      classifyAnswer(QUESTIONS, 'Go with the recommended answer for all seven questions.')
    ).toBe('accept')
    expect(classifyAnswer(QUESTIONS, 'yes')).toBe('accept')
    expect(classifyAnswer(QUESTIONS, 'Use your recommendations')).toBe('accept')
    expect(classifyAnswer(QUESTIONS, 'Yes, only run when an installed binary is detectable.')).toBe(
      'accept'
    )
  })

  test('classifies substantive answers as overrides', () => {
    expect(
      classifyAnswer(QUESTIONS, 'Actually skip the weekly prompt entirely on CI machines.')
    ).toBe('override')
    expect(classifyAnswer(QUESTIONS, 'It will be simpler to have only one place for labels')).toBe(
      'override'
    )
    expect(classifyAnswer(QUESTIONS, '')).toBe('unclear')
  })

  test('calibration renders only with enough signal and steers by rate', () => {
    expect(renderAskCalibration({ rounds: 3, accepts: 3, overrides: 0 })).toBeNull()
    expect(renderAskCalibration({ rounds: 10, accepts: 9, overrides: 1 })).toContain(
      'raise your asking bar'
    )
    expect(renderAskCalibration({ rounds: 10, accepts: 2, overrides: 7 })).toContain(
      'missing real context'
    )
  })
})
