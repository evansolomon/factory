import { basename, dirname } from 'node:path'
import { z } from 'zod'
import { type RunResult, run } from './exec.ts'
import { log } from './log.ts'
import { FACTORY_VERSION } from './version.ts'

const LATEST_RELEASE_URL = 'https://api.github.com/repos/evansolomon/factory/releases/latest'
const INSTALLER_URL = 'https://raw.githubusercontent.com/evansolomon/factory/master/install.sh'

const LatestReleaseSchema = z.object({
  tag_name: z.string().min(1),
})

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

type RunCommand = (
  cmd: string[],
  opts: {
    cwd: string
    stdin?: string
    streamTo?: string
    env?: Record<string, string>
    timeout?: number
  }
) => Promise<RunResult>

export class UpgradeError extends Error {
  override name = 'UpgradeError'
}

export function normalizeGitHubReleaseVersion(tagName: string): string {
  return tagName.startsWith('v') ? tagName.slice(1) : tagName
}

export function shouldInstallLatest(localVersion: string, latestVersion: string): boolean {
  return (
    normalizeGitHubReleaseVersion(localVersion) !== normalizeGitHubReleaseVersion(latestVersion)
  )
}

export async function fetchLatestRelease(
  fetchImpl: FetchImpl = fetch,
  opts?: { signal?: AbortSignal }
): Promise<{ tagName: string; version: string }> {
  let response: Response
  try {
    response = await fetchImpl(LATEST_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'factory',
      },
      signal: opts?.signal,
    })
  } catch (err) {
    throw new UpgradeError(`failed to fetch latest GitHub release: ${errorMessage(err)}`)
  }

  if (!response.ok) {
    throw new UpgradeError(
      `failed to fetch latest GitHub release: HTTP ${response.status} ${response.statusText}`.trim()
    )
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new UpgradeError('malformed GitHub release response: invalid JSON')
  }

  const parsed = LatestReleaseSchema.safeParse(body)
  if (!parsed.success) {
    throw new UpgradeError('malformed GitHub release response: invalid or missing tag_name')
  }

  return {
    tagName: parsed.data.tag_name,
    version: normalizeGitHubReleaseVersion(parsed.data.tag_name),
  }
}

export function resolveCurrentFactoryInstallDir(execPath = process.execPath): string | null {
  return basename(execPath) === 'factory' ? dirname(execPath) : null
}

export function buildInstallerEnv(
  parentEnv: NodeJS.ProcessEnv,
  installDir: string | null
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value !== undefined) {
      env[key] = value
    }
  }

  if (installDir) {
    env['FACTORY_INSTALL_DIR'] = installDir
  } else {
    delete env['FACTORY_INSTALL_DIR']
  }

  return env
}

export async function runLatestInstaller(
  opts: {
    fetchImpl?: FetchImpl
    runCommand?: RunCommand
    parentEnv?: NodeJS.ProcessEnv
    installDir?: string | null
    cwd?: string
  } = {}
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const runCommand = opts.runCommand ?? run
  const installDir = opts.installDir ?? null

  let response: Response
  try {
    response = await fetchImpl(INSTALLER_URL, {
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'factory',
      },
    })
  } catch (err) {
    throw new UpgradeError(`failed to fetch installer: ${errorMessage(err)}`)
  }

  if (!response.ok) {
    throw new UpgradeError(
      `failed to fetch installer: HTTP ${response.status} ${response.statusText}`.trim()
    )
  }

  let installer: string
  try {
    installer = await response.text()
  } catch (err) {
    throw new UpgradeError(`failed to fetch installer: ${errorMessage(err)}`)
  }
  let result: RunResult
  try {
    result = await runCommand(['bash', '-s'], {
      cwd: opts.cwd ?? process.cwd(),
      stdin: installer,
      env: buildInstallerEnv(opts.parentEnv ?? process.env, installDir),
    })
  } catch (err) {
    throw new UpgradeError(`failed to run installer: ${errorMessage(err)}`)
  }

  const output = combinedOutput(result)
  if (result.code !== 0) {
    throw new UpgradeError(
      output
        ? `installer failed with exit code ${result.code}: ${output}`
        : `installer failed with exit code ${result.code}`
    )
  }

  return output
}

export async function upgradeFactory(): Promise<number> {
  try {
    const latest = await fetchLatestRelease()
    if (!shouldInstallLatest(FACTORY_VERSION, latest.version)) {
      log.log(`already on the latest version (${FACTORY_VERSION})`)
      return 0
    }

    log.log(`updating ${FACTORY_VERSION} -> ${latest.version}`)
    const installDir = resolveCurrentFactoryInstallDir()
    if (installDir) {
      log.log(`installing to ${installDir}`)
    } else {
      log.warn(
        'could not detect an existing factory install; using the installer default. Set FACTORY_INSTALL_DIR for a custom install directory.'
      )
    }

    await runLatestInstaller({ installDir })
    log.ok(`factory upgraded to ${latest.version}`)
    return 0
  } catch (err) {
    if (err instanceof UpgradeError) {
      log.fail(err.message)
      return 1
    }
    throw err
  }
}

function combinedOutput(result: RunResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
