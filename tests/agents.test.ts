import { describe, expect, test } from 'bun:test'
import { parseClaudeStream, unattendedAgentEnv } from '../src/agents.ts'

function stream(...events: unknown[]): string {
  return events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n')
}

describe('unattendedAgentEnv', () => {
  test('removes only TMUX_PANE from the inherited environment', () => {
    expect(
      unattendedAgentEnv({
        PATH: '/usr/bin',
        TMUX: '/tmp/tmux/default,1,0',
        TMUX_PANE: '%7',
        UNSET: undefined,
      })
    ).toEqual({
      PATH: '/usr/bin',
      TMUX: '/tmp/tmux/default,1,0',
    })
  })
})

describe('parseClaudeStream', () => {
  test('sums modelUsage across models so native subagent spend is counted', () => {
    const out = parseClaudeStream(
      'claude',
      stream('junk not json', {
        type: 'result',
        result: 'done',
        usage: { input_tokens: 9, output_tokens: 5 },
        modelUsage: {
          'claude-fable-5': {
            inputTokens: 100,
            outputTokens: 40,
            cacheReadInputTokens: 1000,
            cacheCreationInputTokens: 200,
          },
          'claude-haiku-4-5-20251001': {
            inputTokens: 50,
            outputTokens: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      })
    )

    expect(out.text).toBe('done')
    expect(out.usage).toEqual({ inputTokens: 1350, outputTokens: 50 })
  })

  test('falls back to main-loop usage when modelUsage is absent', () => {
    const out = parseClaudeStream(
      'claude',
      stream({
        type: 'result',
        result: 'done',
        usage: {
          input_tokens: 9,
          output_tokens: 162,
          cache_read_input_tokens: 17733,
          cache_creation_input_tokens: 9516,
        },
      })
    )

    expect(out.usage).toEqual({ inputTokens: 27258, outputTokens: 162 })
  })

  test('a stream without a result event degrades to raw text and zero usage', () => {
    const out = parseClaudeStream('claude', 'plain text output')

    expect(out.text).toBe('plain text output')
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })
})
