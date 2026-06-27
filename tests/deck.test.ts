import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Config, RoleAgents, WorkContext } from '../src/config.ts'
import {
  browserOpenCommand,
  buildDeckHtml,
  type DeckOpener,
  deckUrl,
  normalizeDeckHtml,
  openDeck,
  parseDeckArgs,
} from '../src/deck.ts'
import { log } from '../src/log.ts'
import { addTask, saveMeta, setStatus, writeArtifact } from '../src/task.ts'
import { printShow } from '../src/view.ts'

const config: Config = {
  retries: 10,
  triage: true,
  security: true,
  ux: true,
  plansDir: null,
  captureEvals: false,
  postmortem: false,
  remediate: true,
  hooks: {},
  agents: {
    planners: ['codex', 'claude'],
    implementer: 'codex',
    reviewer: 'claude',
    delivery: 'claude',
    namer: { cli: 'codex', model: 'gpt-5-nano' },
  },
  ask: { agent: 'claude' },
}

const agents: RoleAgents = {
  planners: [{ cli: 'codex' }, { cli: 'claude' }],
  implementer: { cli: 'codex' },
  reviewer: { cli: 'claude' },
  delivery: { cli: 'claude' },
  namer: { cli: 'codex', model: 'gpt-5-nano' },
}

async function workContext(): Promise<WorkContext> {
  const root = await mkdtemp(`${tmpdir()}/factory-deck-`)
  const stateDir = `${root}/state`
  return {
    root,
    config,
    stateDir,
    tasksDir: `${stateDir}/tasks`,
    plansDir: null,
    agents,
    askAgent: { cli: 'claude' },
    repoStateDir: stateDir,
    metricsPath: `${stateDir}/metrics.db`,
  }
}

async function captureLogs(run: () => Promise<number>): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = []
  const originalLog = log.log
  const originalFail = log.fail
  const originalWarn = log.warn
  log.log = (message: string) => {
    lines.push(message)
  }
  log.fail = (message: string) => {
    lines.push(message)
  }
  log.warn = (message: string) => {
    lines.push(message)
  }
  try {
    return { code: await run(), lines }
  } finally {
    log.log = originalLog
    log.fail = originalFail
    log.warn = originalWarn
  }
}

describe('normalizeDeckHtml', () => {
  test('trims and preserves valid HTML', () => {
    expect(normalizeDeckHtml('\n<!doctype html>\n<html></html>\n')).toBe(
      '<!doctype html>\n<html></html>'
    )
  })

  test('unwraps one surrounding HTML fence', () => {
    expect(normalizeDeckHtml('```html\n<!doctype html>\n<html></html>\n```')).toBe(
      '<!doctype html>\n<html></html>'
    )
  })

  test('rejects prose', () => {
    expect(normalizeDeckHtml('Here is the deck:\n<!doctype html>')).toBeNull()
  })
})

describe('buildDeckHtml', () => {
  test('returns null on runner throw and invalid output', async () => {
    expect(
      await buildDeckHtml(async () => {
        throw new Error('agent failed')
      })
    ).toBeNull()
    expect(await buildDeckHtml(async () => 'not html')).toBeNull()
  })
})

describe('parseDeckArgs', () => {
  test('accepts supported forms', () => {
    expect(parseDeckArgs([])).toEqual({ ok: true, request: { taskQuery: null, urlOnly: false } })
    expect(parseDeckArgs(['fix-ui'])).toEqual({
      ok: true,
      request: { taskQuery: 'fix-ui', urlOnly: false },
    })
    expect(parseDeckArgs(['--url'])).toEqual({
      ok: true,
      request: { taskQuery: null, urlOnly: true },
    })
    expect(parseDeckArgs(['--url', 'fix-ui'])).toEqual({
      ok: true,
      request: { taskQuery: 'fix-ui', urlOnly: true },
    })
    expect(parseDeckArgs(['fix-ui', '--url'])).toEqual({
      ok: true,
      request: { taskQuery: 'fix-ui', urlOnly: true },
    })
  })

  test('rejects unknown options and extra positionals', () => {
    expect(parseDeckArgs(['--open'])).toEqual({
      ok: false,
      message: 'unknown option --open\nusage: factory deck [task-id] [--url]',
    })
    expect(parseDeckArgs(['one', 'two'])).toEqual({
      ok: false,
      message: 'usage: factory deck [task-id] [--url]',
    })
  })
})

describe('deckUrl and browserOpenCommand', () => {
  test('uses encoded file URLs', () => {
    expect(deckUrl('/tmp/factory deck/brief.html')).toBe('file:///tmp/factory%20deck/brief.html')
  })

  test('maps supported platforms', () => {
    expect(browserOpenCommand('darwin', 'file:///deck.html')).toEqual(['open', 'file:///deck.html'])
    expect(browserOpenCommand('linux', 'file:///deck.html')).toEqual([
      'xdg-open',
      'file:///deck.html',
    ])
    expect(browserOpenCommand('win32', 'file:///deck.html')).toEqual([
      'cmd',
      '/c',
      'start',
      '',
      'file:///deck.html',
    ])
    expect(browserOpenCommand('freebsd', 'file:///deck.html')).toBeNull()
  })
})

describe('openDeck', () => {
  test('--url selects the latest done task and does not call opener', async () => {
    const ctx = await workContext()
    const oldTask = await addTask(ctx, 'Old done task', null)
    await setStatus(oldTask, 'done')
    oldTask.meta.updatedAt = '2026-01-01T00:00:00.000Z'
    await saveMeta(oldTask)
    await writeArtifact(oldTask, 'brief.html', '<!doctype html>\n<html></html>')
    const latest = await addTask(ctx, 'Latest done task', null)
    await setStatus(latest, 'done')
    latest.meta.updatedAt = '2026-01-02T00:00:00.000Z'
    await saveMeta(latest)
    await writeArtifact(latest, 'brief.html', '<!doctype html>\n<html></html>')
    const opener: DeckOpener = async () => {
      throw new Error('opener should not run')
    }

    const result = await captureLogs(() => openDeck(ctx, ['--url'], { opener }))

    expect(result.code).toBe(0)
    expect(result.lines).toEqual([deckUrl(`${latest.dir}/brief.html`)])
  })

  test('explicit done task opens through injected opener', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Open this deck', null)
    await setStatus(task, 'done')
    await writeArtifact(task, 'brief.html', '<!doctype html>\n<html></html>')
    const opened: string[] = []

    const result = await captureLogs(() =>
      openDeck(ctx, [task.id], {
        opener: async (url) => {
          opened.push(url)
          return { ok: true }
        },
      })
    )

    expect(result.code).toBe(0)
    expect(result.lines).toEqual([])
    expect(opened).toEqual([deckUrl(`${task.dir}/brief.html`)])
  })

  test('non-done task returns 1', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Still running', null)
    await writeArtifact(task, 'brief.html', '<!doctype html>\n<html></html>')

    const result = await captureLogs(() => openDeck(ctx, [task.id]))

    expect(result.code).toBe(1)
    expect(result.lines).toEqual([`${task.id} is ready; deck is only available for done tasks`])
  })

  test('missing brief returns 1', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'No deck', null)
    await setStatus(task, 'done')

    const result = await captureLogs(() => openDeck(ctx, [task.id]))

    expect(result.code).toBe(1)
    expect(result.lines).toEqual([
      `no brief for ${task.id} - deck generation is best-effort and may have been skipped; try: factory show ${task.id}`,
    ])
  })

  test('no latest done task returns 1', async () => {
    const ctx = await workContext()
    await addTask(ctx, 'Not done', null)

    const result = await captureLogs(() => openDeck(ctx, []))

    expect(result.code).toBe(1)
    expect(result.lines).toEqual(['no done task in this worktree'])
  })

  test('missing explicit task returns 1', async () => {
    const ctx = await workContext()

    const result = await captureLogs(() => openDeck(ctx, ['missing']))

    expect(result.code).toBe(1)
    expect(result.lines).toEqual(['no task matching missing'])
  })

  test('opener failure returns 0 and prints the URL', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Headless deck', null)
    await setStatus(task, 'done')
    await writeArtifact(task, 'brief.html', '<!doctype html>\n<html></html>')

    const result = await captureLogs(() =>
      openDeck(ctx, [task.id], {
        opener: async () => ({ ok: false, message: 'no display' }),
      })
    )

    expect(result.code).toBe(0)
    expect(result.lines).toEqual([
      'could not open deck: no display',
      deckUrl(`${task.dir}/brief.html`),
    ])
  })
})

describe('printShow deck pointer', () => {
  test('prints the deck command without rendering HTML inline', async () => {
    const ctx = await workContext()
    const task = await addTask(ctx, 'Show a deck pointer', 'bun test')
    await setStatus(task, 'done')
    await writeArtifact(task, 'feedback.md', '## Summary\nDone.')
    await writeArtifact(task, 'brief.html', '<!doctype html>\n<html><body>deck</body></html>')

    const result = await captureLogs(() => printShow(ctx, task.id))

    expect(result.code).toBe(0)
    expect(result.lines).toContain(`brief available: factory deck ${task.id}`)
    expect(result.lines.join('\n')).not.toContain('<!doctype html>')
  })
})
