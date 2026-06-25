import { describe, expect, test } from 'bun:test'
import { formatQuestionAnswer, formatQuestions, parseFormattedQuestions } from '../src/sharpen.ts'

describe('formatted sharpen questions', () => {
  test('round-trips persisted questions with recommendations', () => {
    const text = formatQuestions('Grounding context.', [
      { q: 'Should auto-upgrade skip source runs?', rec: 'Yes, only installed binaries.' },
      { q: 'Which commands are eligible?', rec: 'Interactive normal commands only.' },
    ])

    expect(parseFormattedQuestions(text)).toEqual({
      preamble: 'Grounding context.',
      questions: [
        { q: 'Should auto-upgrade skip source runs?', rec: 'Yes, only installed binaries.' },
        { q: 'Which commands are eligible?', rec: 'Interactive normal commands only.' },
      ],
    })
  })

  test('does not treat unrelated preamble bullets as questions', () => {
    const text = [
      '- Existing fact without a recommendation.',
      '',
      '- Which scope should apply?',
      '  Recommended: Keep it narrow.',
    ].join('\n')

    expect(parseFormattedQuestions(text)).toEqual({
      preamble: '- Existing fact without a recommendation.',
      questions: [{ q: 'Which scope should apply?', rec: 'Keep it narrow.' }],
    })
  })

  test('keeps recommendation context when formatting a custom answer', () => {
    expect(
      formatQuestionAnswer(
        { q: 'Which scope should apply?', rec: 'Keep the first version narrow.' },
        'Use the narrow version, but include follow-up notes.'
      )
    ).toBe(
      [
        'Q: Which scope should apply?',
        'Recommended: Keep the first version narrow.',
        'A: Use the narrow version, but include follow-up notes.',
      ].join('\n')
    )
  })

  test('omits empty recommendation when formatting an answer', () => {
    expect(
      formatQuestionAnswer({ q: 'Which scope should apply?', rec: '' }, 'No preference.')
    ).toBe(['Q: Which scope should apply?', 'A: No preference.'].join('\n'))
  })
})
