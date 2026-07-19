import { describe, expect, test } from 'bun:test'
import {
  agentEffortArgs,
  parseClaudeStream,
  resolveAgentEffort,
  unattendedAgentEnv,
} from '../src/agents.ts'

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

  test('can remove a CLI setting that would override factory policy', () => {
    expect(
      unattendedAgentEnv({ PATH: '/usr/bin', CLAUDE_CODE_EFFORT_LEVEL: 'max' }, [
        'CLAUDE_CODE_EFFORT_LEVEL',
      ])
    ).toEqual({ PATH: '/usr/bin' })
  })
})

describe('agent effort', () => {
  test('maps the shared effort policy to each CLI', () => {
    expect(agentEffortArgs({ cli: 'codex' }, 'high')).toEqual([
      '-c',
      'model_reasoning_effort="high"',
    ])
    expect(agentEffortArgs({ cli: 'claude' }, 'high')).toEqual(['--effort', 'high'])
  })

  test('lets agent overrides win over the stage policy', () => {
    expect(resolveAgentEffort({ cli: 'claude', effort: 'low' }, 'high')).toEqual({
      effort: 'low',
      source: 'agent',
    })
    expect(resolveAgentEffort({ cli: 'codex', reasoningEffort: 'minimal' }, 'high')).toEqual({
      effort: 'minimal',
      source: 'legacy',
    })
  })

  test('does not guess automatic effort support for custom providers', () => {
    const agent = { cli: 'codex', model: 'grok-4', provider: 'xai' } as const
    expect(resolveAgentEffort(agent, 'high')).toEqual({ effort: null, source: 'provider-default' })
    expect(agentEffortArgs(agent, 'high')).toEqual([])
    expect(resolveAgentEffort({ ...agent, effort: 'high' }, 'low')).toEqual({
      effort: 'high',
      source: 'agent',
    })
  })

  test('uses a stable medium default outside the task pipeline', () => {
    expect(resolveAgentEffort({ cli: 'claude' })).toEqual({ effort: 'medium', source: 'default' })
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
