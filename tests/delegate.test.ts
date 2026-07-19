import { describe, expect, test } from 'bun:test'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { collectDelegatedUsage, delegateCommand, delegateUsageFile } from '../src/delegate.ts'

describe('delegateCommand', () => {
  test('renders a bare claude agent with only cli and usage file', () => {
    expect(delegateCommand({ cli: 'claude' }, '/tmp/ledger.jsonl')).toBe(
      'factory delegate --cli claude --usage-file /tmp/ledger.jsonl'
    )
  })

  test('renders every configured codex field in flag order', () => {
    const agent = {
      cli: 'codex',
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
      provider: 'xai',
    } as const
    expect(delegateCommand(agent, '/tmp/ledger.jsonl')).toBe(
      'factory delegate --cli codex --model gpt-5.4-mini --reasoning-effort low --provider xai --usage-file /tmp/ledger.jsonl'
    )
  })

  test('renders the shared effort override for claude', () => {
    expect(
      delegateCommand({ cli: 'claude', model: 'sonnet', effort: 'high' }, '/tmp/ledger.jsonl')
    ).toBe(
      'factory delegate --cli claude --model sonnet --effort high --usage-file /tmp/ledger.jsonl'
    )
  })

  test('description never leaks into the command', () => {
    const agent = { cli: 'claude', model: 'haiku', description: 'trivial edits only' } as const
    expect(delegateCommand(agent, '/tmp/ledger.jsonl')).not.toContain('trivial edits')
  })
})

describe('delegateUsageFile', () => {
  test('is task-scoped and lives in tmp', () => {
    const file = delegateUsageFile('fix-typo-a1b2')
    expect(file.startsWith(tmpdir())).toBe(true)
    expect(file).toContain('fix-typo-a1b2')
    expect(delegateUsageFile('other-task')).not.toBe(file)
  })
})

describe('collectDelegatedUsage', () => {
  test('a missing ledger yields no records', async () => {
    const dir = await mkdtemp(`${tmpdir()}/factory-delegate-test-`)
    expect(await collectDelegatedUsage(`${dir}/absent.jsonl`)).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })

  test('parses valid lines, skips garbage, and deletes the ledger', async () => {
    const dir = await mkdtemp(`${tmpdir()}/factory-delegate-test-`)
    const file = `${dir}/ledger.jsonl`
    await appendFile(
      file,
      [
        JSON.stringify({ label: 'claude:haiku', inputTokens: 1200, outputTokens: 300, ms: 4000 }),
        'not json at all',
        JSON.stringify({ unrelated: true }),
        JSON.stringify({ label: 'codex:gpt-5.4-mini' }),
        '',
      ].join('\n')
    )

    const records = await collectDelegatedUsage(file)
    expect(records).toEqual([
      { label: 'claude:haiku', inputTokens: 1200, outputTokens: 300, ms: 4000 },
      { label: 'codex:gpt-5.4-mini', inputTokens: 0, outputTokens: 0, ms: 0 },
    ])
    expect(await Bun.file(file).exists()).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })
})
