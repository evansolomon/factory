import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  AUTO_UPGRADE_CHECK_INTERVAL_MS,
  type AutoUpgradeResult,
  type AutoUpgradeState,
  isAffirmativeAutoUpgradeAnswer,
  isAutoUpgradeCommand,
  isDevFactoryVersion,
  maybeAutoUpgrade,
  readAutoUpgradeState,
  shouldRunAutoUpgradeCheck,
  writeAutoUpgradeState,
} from '../src/auto-upgrade.ts'
import { main } from '../src/cli.ts'
import { autoUpgradeStateFile } from '../src/config.ts'
import { log } from '../src/log.ts'
import type { FetchImpl } from '../src/upgrade.ts'

type MaybeAutoUpgradeOpts = Parameters<typeof maybeAutoUpgrade>[0]

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(`${tmpdir()}/factory-${prefix}-`)
}

function responseFetch(version: string): FetchImpl {
  return async () => Response.json({ tag_name: `v${version}` })
}

function baseOpts(stateFile: string): MaybeAutoUpgradeOpts {
  return {
    command: 'status',
    env: {},
    execPath: '/usr/local/bin/factory',
    currentVersion: '0.1.0',
    stdinIsTTY: true,
    stdoutIsTTY: true,
    now: new Date('2026-06-22T12:00:00.000Z'),
    stateFile,
    fetchImpl: responseFetch('0.1.1'),
    readAnswer: async () => 'n',
    upgrade: async () => 0,
  }
}

async function runAuto(
  stateFile: string,
  opts: Partial<MaybeAutoUpgradeOpts> = {}
): Promise<AutoUpgradeResult> {
  return await maybeAutoUpgrade({ ...baseOpts(stateFile), ...opts })
}

async function statePath(prefix: string): Promise<string> {
  const dir = await tempDir(prefix)
  return `${dir}/auto-upgrade.json`
}

async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists()
}

describe('auto-upgrade eligibility', () => {
  test('uses an explicit normal-command allow-list', () => {
    for (const command of [
      'add',
      'backlog',
      'run',
      'answer',
      'feedback',
      'resume',
      'correct',
      'status',
      'ask',
      'session',
      'codex',
      'claude',
      'config',
      'show',
      'lessons',
      'report',
    ]) {
      expect(isAutoUpgradeCommand(command)).toBe(true)
    }

    for (const command of ['', 'help', '-h', '--help', 'version', '--version', 'upgrade', 'wat']) {
      expect(isAutoUpgradeCommand(command)).toBe(false)
    }
  })

  test('disable env prevents fetch, prompt, and state write', async () => {
    const file = await statePath('auto-disabled')
    let fetched = false
    let prompted = false

    const result = await runAuto(file, {
      env: { FACTORY_DISABLE_AUTO_UPGRADE: '1' },
      fetchImpl: async () => {
        fetched = true
        return Response.json({ tag_name: 'v0.1.1' })
      },
      readAnswer: async () => {
        prompted = true
        return 'y'
      },
    })

    expect(result).toEqual({ kind: 'continue' })
    expect(fetched).toBe(false)
    expect(prompted).toBe(false)
    expect(await fileExists(file)).toBe(false)
  })

  test('known normal commands require stdin and stdout TTYs', async () => {
    const stdinFile = await statePath('auto-stdin')
    const stdoutFile = await statePath('auto-stdout')

    await runAuto(stdinFile, { stdinIsTTY: false })
    await runAuto(stdoutFile, { stdoutIsTTY: false })

    expect(await fileExists(stdinFile)).toBe(false)
    expect(await fileExists(stdoutFile)).toBe(false)
  })

  test('source runs and dev-stamped builds skip', async () => {
    const sourceFile = await statePath('auto-source')
    const devFile = await statePath('auto-dev')

    await runAuto(sourceFile, { execPath: '/opt/homebrew/bin/bun' })
    await runAuto(devFile, { currentVersion: '0.1.0-dev.20260622010101' })

    expect(isDevFactoryVersion('0.1.0-dev.20260622010101')).toBe(true)
    expect(await fileExists(sourceFile)).toBe(false)
    expect(await fileExists(devFile)).toBe(false)
  })
})

describe('auto-upgrade state', () => {
  test('missing, recent, old, and malformed state decisions', async () => {
    const now = new Date('2026-06-22T12:00:00.000Z')
    const recent: AutoUpgradeState = { lastCheckedAt: new Date(now.getTime() - 1000).toISOString() }
    const old: AutoUpgradeState = {
      lastCheckedAt: new Date(now.getTime() - AUTO_UPGRADE_CHECK_INTERVAL_MS - 1).toISOString(),
    }
    const malformedDate: AutoUpgradeState = { lastCheckedAt: 'not-a-date' }

    expect(shouldRunAutoUpgradeCheck({ state: null, now })).toBe(true)
    expect(shouldRunAutoUpgradeCheck({ state: recent, now })).toBe(false)
    expect(shouldRunAutoUpgradeCheck({ state: old, now })).toBe(true)
    expect(shouldRunAutoUpgradeCheck({ state: malformedDate, now })).toBe(true)
  })

  test('malformed state is treated as missing', async () => {
    const file = await statePath('auto-malformed')
    await Bun.write(file, '{')

    expect(await readAutoUpgradeState(file)).toBeNull()
  })

  test('state writer creates the parent directory', async () => {
    const dir = await tempDir('auto-writer')
    const file = `${dir}/nested/auto-upgrade.json`
    const now = new Date('2026-06-22T12:00:00.000Z')

    await writeAutoUpgradeState(file, now)

    expect(await readAutoUpgradeState(file)).toEqual({ lastCheckedAt: now.toISOString() })
  })

  test('default state path is under FACTORY_HOME when set', async () => {
    const previous = process.env['FACTORY_HOME']
    const home = await tempDir('auto-home')
    process.env['FACTORY_HOME'] = home
    try {
      expect(autoUpgradeStateFile()).toBe(`${home}/auto-upgrade.json`)
    } finally {
      if (previous === undefined) {
        delete process.env['FACTORY_HOME']
      } else {
        process.env['FACTORY_HOME'] = previous
      }
    }
  })
})

describe('auto-upgrade release check and prompt', () => {
  test('missing and old state check now; recent state suppresses', async () => {
    const missing = await statePath('auto-missing')
    const old = await statePath('auto-old')
    const recent = await statePath('auto-recent')
    const now = new Date('2026-06-22T12:00:00.000Z')
    let missingFetches = 0
    let oldFetches = 0
    let recentFetches = 0

    await writeAutoUpgradeState(old, new Date(now.getTime() - AUTO_UPGRADE_CHECK_INTERVAL_MS - 1))
    await writeAutoUpgradeState(recent, new Date(now.getTime() - 1000))

    await runAuto(missing, {
      now,
      fetchImpl: async () => {
        missingFetches += 1
        return Response.json({ tag_name: 'v0.1.0' })
      },
    })
    await runAuto(old, {
      now,
      fetchImpl: async () => {
        oldFetches += 1
        return Response.json({ tag_name: 'v0.1.0' })
      },
    })
    await runAuto(recent, {
      now,
      fetchImpl: async () => {
        recentFetches += 1
        return Response.json({ tag_name: 'v0.1.0' })
      },
    })

    expect(missingFetches).toBe(1)
    expect(oldFetches).toBe(1)
    expect(recentFetches).toBe(0)
  })

  test('no update writes state and does not prompt', async () => {
    const file = await statePath('auto-current')
    let prompted = false

    const result = await runAuto(file, {
      fetchImpl: responseFetch('0.1.0'),
      readAnswer: async () => {
        prompted = true
        return 'y'
      },
    })

    expect(result).toEqual({ kind: 'continue' })
    expect(prompted).toBe(false)
    expect(await readAutoUpgradeState(file)).toEqual({
      lastCheckedAt: '2026-06-22T12:00:00.000Z',
    })
  })

  test('release lookup failure writes state and continues', async () => {
    const file = await statePath('auto-failure')

    const result = await runAuto(file, {
      fetchImpl: async () => {
        throw new Error('network down')
      },
    })

    expect(result).toEqual({ kind: 'continue' })
    expect(await readAutoUpgradeState(file)).toEqual({
      lastCheckedAt: '2026-06-22T12:00:00.000Z',
    })
  })

  test('timeout writes state and continues', async () => {
    const file = await statePath('auto-timeout')
    const abortingFetch: FetchImpl = async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }

    const result = await runAuto(file, {
      fetchImpl: abortingFetch,
      checkTimeoutMs: 1,
    })

    expect(result).toEqual({ kind: 'continue' })
    expect(await readAutoUpgradeState(file)).toEqual({
      lastCheckedAt: '2026-06-22T12:00:00.000Z',
    })
  })

  test('state is written before the prompt is shown', async () => {
    const file = await statePath('auto-before-prompt')

    await runAuto(file, {
      readAnswer: async () => {
        expect(await readAutoUpgradeState(file)).toEqual({
          lastCheckedAt: '2026-06-22T12:00:00.000Z',
        })
        return 'n'
      },
    })
  })

  test('prompt strips control characters from displayed versions', async () => {
    const file = await statePath('auto-prompt-control-chars')
    let prompt = ''

    await runAuto(file, {
      currentVersion: '0.1.0\rbad',
      fetchImpl: responseFetch('0.1.1\u001B[2K'),
      readAnswer: async (question) => {
        prompt = question
        return 'n'
      },
    })

    expect(prompt).not.toContain('\r')
    expect(prompt).not.toContain('\u001B')
    expect(prompt).toContain('0.1.0bad -> 0.1.1[2K')
  })

  test('only y and yes accept', () => {
    for (const answer of ['y', 'Y', ' yes ', 'YES']) {
      expect(isAffirmativeAutoUpgradeAnswer(answer)).toBe(true)
    }
    for (const answer of ['', 'n', 'no', 'yeah', 'sure']) {
      expect(isAffirmativeAutoUpgradeAnswer(answer)).toBe(false)
    }
  })

  test('decline, empty, and arbitrary answers continue without upgrade', async () => {
    for (const answer of ['n', '', 'sure']) {
      const file = await statePath(`auto-decline-${answer || 'empty'}`)
      let upgraded = false

      const result = await runAuto(file, {
        readAnswer: async () => answer,
        upgrade: async () => {
          upgraded = true
          return 0
        },
      })

      expect(result).toEqual({ kind: 'continue' })
      expect(upgraded).toBe(false)
    }
  })

  test('accept runs upgrade, emits rerun hint on success, and exits with its code', async () => {
    const file = await statePath('auto-accept')
    const lines: string[] = []
    const original = log.log
    let upgraded = false
    log.log = (message: string) => {
      lines.push(message)
    }
    try {
      const result = await runAuto(file, {
        command: 'run',
        readAnswer: async (question) => {
          expect(question).toContain('0.1.0 -> 0.1.1')
          return 'yes'
        },
        upgrade: async () => {
          upgraded = true
          return 0
        },
      })

      expect(result).toEqual({ kind: 'exit', code: 0 })
      expect(upgraded).toBe(true)
      expect(lines).toContain('re-run `factory run` to continue on the new version')
    } finally {
      log.log = original
    }
  })

  test('accepted failed upgrade exits with the failure code and no rerun hint', async () => {
    const file = await statePath('auto-accept-fail')
    const lines: string[] = []
    const original = log.log
    log.log = (message: string) => {
      lines.push(message)
    }
    try {
      const result = await runAuto(file, {
        readAnswer: async () => 'y',
        upgrade: async () => 1,
      })

      expect(result).toEqual({ kind: 'exit', code: 1 })
      expect(lines).toEqual([])
    } finally {
      log.log = original
    }
  })

  test('unexpected prompt errors continue silently', async () => {
    const file = await statePath('auto-prompt-error')
    let upgraded = false

    const result = await runAuto(file, {
      readAnswer: async () => {
        throw new Error('tty closed')
      },
      upgrade: async () => {
        upgraded = true
        return 0
      },
    })

    expect(result).toEqual({ kind: 'continue' })
    expect(upgraded).toBe(false)
  })
})

describe('cli auto-upgrade placement', () => {
  test('help, no command, version, and explicit upgrade return before auto-upgrade', async () => {
    let autoCalls = 0
    const autoUpgrade = async (): Promise<AutoUpgradeResult> => {
      autoCalls += 1
      return { kind: 'exit', code: 9 }
    }

    expect(await main({ argv: [], autoUpgrade })).toBe(0)
    expect(await main({ argv: ['help'], autoUpgrade })).toBe(0)
    expect(await main({ argv: ['--help'], autoUpgrade })).toBe(0)
    expect(await main({ argv: ['version'], autoUpgrade })).toBe(0)
    expect(await main({ argv: ['--version'], autoUpgrade })).toBe(0)
    expect(await main({ argv: ['upgrade'], autoUpgrade, upgrade: async () => 7 })).toBe(7)
    expect(autoCalls).toBe(0)
  })

  test('accepted auto-upgrade exits before normal command dispatch', async () => {
    const result = await main({
      argv: ['status'],
      autoUpgrade: async () => ({ kind: 'exit', code: 42 }),
    })

    expect(result).toBe(42)
  })
})
