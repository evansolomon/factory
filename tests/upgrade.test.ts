import { describe, expect, test } from 'bun:test'
import {
  buildInstallerEnv,
  type FetchImpl,
  fetchLatestRelease,
  normalizeGitHubReleaseVersion,
  resolveCurrentFactoryInstallDir,
  runLatestInstaller,
  shouldInstallLatest,
  UpgradeError,
} from '../src/upgrade.ts'

function responseFetch(response: Response): FetchImpl {
  return async (_input: string, _init?: RequestInit) => response
}

describe('upgrade version comparison', () => {
  test('normalizes one leading lowercase v', () => {
    expect(normalizeGitHubReleaseVersion('v0.1.0')).toBe('0.1.0')
    expect(normalizeGitHubReleaseVersion('0.1.0')).toBe('0.1.0')
  })

  test('installs only when normalized versions differ', () => {
    expect(shouldInstallLatest('0.1.0', 'v0.1.0')).toBe(false)
    expect(shouldInstallLatest('v0.1.0', '0.1.0')).toBe(false)
    expect(shouldInstallLatest('0.2.0', '0.1.0')).toBe(true)
  })
})

describe('latest release lookup', () => {
  test('parses the latest GitHub release tag', async () => {
    const release = await fetchLatestRelease(responseFetch(Response.json({ tag_name: 'v0.1.0' })))

    expect(release).toEqual({ tagName: 'v0.1.0', version: '0.1.0' })
  })

  test('rejects network failures', async () => {
    const failingFetch: FetchImpl = async () => {
      throw new Error('network down')
    }

    await expect(fetchLatestRelease(failingFetch)).rejects.toThrow(
      'failed to fetch latest GitHub release: network down'
    )
  })

  test('rejects missing or non-string tag_name', async () => {
    await expect(fetchLatestRelease(responseFetch(Response.json({})))).rejects.toThrow(UpgradeError)
    await expect(
      fetchLatestRelease(responseFetch(Response.json({ tag_name: 123 })))
    ).rejects.toThrow(UpgradeError)
  })

  test('rejects invalid JSON as a malformed response', async () => {
    await expect(fetchLatestRelease(responseFetch(new Response('{')))).rejects.toThrow(
      'malformed GitHub release response: invalid JSON'
    )
  })

  test('rejects non-2xx responses', async () => {
    await expect(
      fetchLatestRelease(responseFetch(new Response('nope', { status: 500, statusText: 'bad' })))
    ).rejects.toThrow(UpgradeError)
  })
})

describe('installer execution', () => {
  test('resolves the install directory only for an installed factory binary', () => {
    expect(resolveCurrentFactoryInstallDir('/Users/evan/.local/bin/factory')).toBe(
      '/Users/evan/.local/bin'
    )
    expect(resolveCurrentFactoryInstallDir('/opt/homebrew/bin/bun')).toBeNull()
  })

  test('builds installer env from the parent env', () => {
    const resolved = buildInstallerEnv({ PATH: '/bin', HOME: '/home/evan' }, '/factory/bin')
    expect(resolved['PATH']).toBe('/bin')
    expect(resolved['HOME']).toBe('/home/evan')
    expect(resolved['FACTORY_INSTALL_DIR']).toBe('/factory/bin')

    const unresolved = buildInstallerEnv(
      { PATH: '/bin', FACTORY_INSTALL_DIR: '/old/factory/bin' },
      null
    )
    expect(unresolved['PATH']).toBe('/bin')
    expect(unresolved['FACTORY_INSTALL_DIR']).toBeUndefined()
  })

  test('installer fetch failure throws UpgradeError', async () => {
    const failingFetch: FetchImpl = async () => {
      throw new Error('installer network down')
    }

    await expect(runLatestInstaller({ fetchImpl: failingFetch })).rejects.toThrow(UpgradeError)
  })

  test('installer failure includes captured output', async () => {
    let thrown: unknown
    try {
      await runLatestInstaller({
        fetchImpl: responseFetch(new Response('echo install')),
        runCommand: async () => ({
          stdout: 'installer stdout',
          stderr: 'installer stderr',
          code: 12,
        }),
        parentEnv: { PATH: '/bin' },
        installDir: null,
        cwd: '/tmp',
      })
    } catch (err) {
      thrown = err
    }

    if (!(thrown instanceof UpgradeError)) {
      throw new Error('expected UpgradeError')
    }
    expect(thrown.message).toContain('installer stdout')
    expect(thrown.message).toContain('installer stderr')
  })
})
