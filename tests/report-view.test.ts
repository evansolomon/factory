import { describe, expect, test } from 'bun:test'
import type { Report } from '../src/metrics.ts'
import { formatReport } from '../src/view.ts'

describe('report rendering', () => {
  test('renders cost totals and a combined stage table', () => {
    const report: Report = {
      tasks: 2,
      runs: 3,
      outcomes: [
        { outcome: 'done', count: 2 },
        { outcome: 'blocked', count: 1 },
      ],
      implementRuns: 3,
      firstPassYield: 2 / 3,
      escalations: 1,
      escalationRate: 1 / 2,
      blockedRate: 1 / 3,
      retryRuns: 1,
      retrySuccess: 1,
      inputTokensTotal: 12_300,
      outputTokensTotal: 4_500,
      tokensMedianPerTask: 8_400,
      stages: [
        {
          stage: 'implement',
          inputTokens: 8_000,
          outputTokens: 2_000,
          totalTokens: 10_000,
          ms: 40_000,
        },
        {
          stage: 'review',
          inputTokens: 4_000,
          outputTokens: 2_000,
          totalTokens: 6_000,
          ms: 35_000,
        },
        { stage: 'verify', inputTokens: 0, outputTokens: 0, totalTokens: 0, ms: 5_000 },
      ],
      cycleMedianMs: 120_000,
    }

    const lines = formatReport(report)
    const text = lines.join('\n')

    expect(text).toContain(
      [
        '  cost             input 12.3k tok · output 4.5k tok ·',
        ' total 16.8k tok · median 8.4k tok/task',
      ].join('')
    )
    expect(lines.filter((line) => line === '  stage cost and time:')).toHaveLength(1)
    expect(text).not.toContain('tokens by stage:')
    expect(text).not.toContain('time by stage:')
    expect(text).toContain('stage')
    expect(text).toContain('input')
    expect(text).toContain('output')
    expect(text).toContain('total')
    expect(text).toContain('token %')
    expect(text).toContain('time')
    expect(text).toContain('time %')
    expect(lines).toContain('    implement         8.0k    2.0k   10.0k     63%     40s     50%')

    const verify = lines.find((line) => line.includes('verify'))

    expect(verify).toBeDefined()
    expect(verify).toContain('0       0       0')
    expect(verify).toContain('0%')
    expect(verify).toContain('5s')
  })
})
