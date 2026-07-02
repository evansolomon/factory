import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { AUTO_UPGRADE_COMMAND_NAMES } from './commands.ts'
import { autoUpgradeStateFile } from './config.ts'
import { log } from './log.ts'
import {
  type FetchImpl,
  fetchLatestRelease,
  resolveCurrentFactoryInstallDir,
  shouldInstallLatest,
  upgradeFactory,
} from './upgrade.ts'
import { FACTORY_VERSION } from './version.ts'

export const AUTO_UPGRADE_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
export const AUTO_UPGRADE_CHECK_TIMEOUT_MS = 2000

const AutoUpgradeStateSchema = z.object({
  lastCheckedAt: z.string().min(1),
})

export type AutoUpgradeState = z.infer<typeof AutoUpgradeStateSchema>

export type AutoUpgradeResult = { kind: 'continue' } | { kind: 'exit'; code: number }

const AUTO_UPGRADE_COMMANDS: ReadonlySet<string> = new Set(AUTO_UPGRADE_COMMAND_NAMES)

export function isAutoUpgradeCommand(command: string): boolean {
  return AUTO_UPGRADE_COMMANDS.has(command)
}

export function isDevFactoryVersion(version: string): boolean {
  return version.includes('-dev.')
}

export function isAffirmativeAutoUpgradeAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase()
  return normalized === 'y' || normalized === 'yes'
}

export function shouldRunAutoUpgradeCheck(input: {
  state: AutoUpgradeState | null
  now: Date
}): boolean {
  if (!input.state) {
    return true
  }
  const lastCheckedAt = Date.parse(input.state.lastCheckedAt)
  if (!Number.isFinite(lastCheckedAt)) {
    return true
  }
  return input.now.getTime() - lastCheckedAt >= AUTO_UPGRADE_CHECK_INTERVAL_MS
}

export async function readAutoUpgradeState(file: string): Promise<AutoUpgradeState | null> {
  let raw: unknown
  try {
    raw = await Bun.file(file).json()
  } catch {
    return null
  }
  const parsed = AutoUpgradeStateSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export async function writeAutoUpgradeState(file: string, now: Date): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await Bun.write(file, `${JSON.stringify({ lastCheckedAt: now.toISOString() }, null, 2)}\n`)
}

export async function maybeAutoUpgrade(opts: {
  command: string
  env?: Record<string, string | undefined>
  execPath?: string
  currentVersion?: string
  stdinIsTTY?: boolean
  stdoutIsTTY?: boolean
  now?: Date
  stateFile?: string
  fetchImpl?: FetchImpl
  readAnswer?: (question: string) => Promise<string>
  upgrade?: () => Promise<number>
  checkTimeoutMs?: number
}): Promise<AutoUpgradeResult> {
  const accepted = await shouldUpgradeNow(opts)
  if (!accepted) {
    return { kind: 'continue' }
  }

  const code = await (opts.upgrade ?? upgradeFactory)()
  if (code === 0) {
    log.log(`re-run \`factory ${opts.command}\` to continue on the new version`)
  }
  return { kind: 'exit', code }
}

async function shouldUpgradeNow(opts: {
  command: string
  env?: Record<string, string | undefined>
  execPath?: string
  currentVersion?: string
  stdinIsTTY?: boolean
  stdoutIsTTY?: boolean
  now?: Date
  stateFile?: string
  fetchImpl?: FetchImpl
  readAnswer?: (question: string) => Promise<string>
  checkTimeoutMs?: number
}): Promise<boolean> {
  try {
    const env = opts.env ?? process.env
    if (env['FACTORY_DISABLE_AUTO_UPGRADE']) {
      return false
    }
    if (!isAutoUpgradeCommand(opts.command)) {
      return false
    }
    if (!(opts.stdinIsTTY ?? Boolean(process.stdin.isTTY))) {
      return false
    }
    if (!(opts.stdoutIsTTY ?? Boolean(process.stdout.isTTY))) {
      return false
    }
    if (!resolveCurrentFactoryInstallDir(opts.execPath ?? process.execPath)) {
      return false
    }

    const currentVersion = opts.currentVersion ?? FACTORY_VERSION
    if (isDevFactoryVersion(currentVersion)) {
      return false
    }

    const now = opts.now ?? new Date()
    const stateFile = opts.stateFile ?? autoUpgradeStateFile()
    const state = await readAutoUpgradeState(stateFile)
    if (!shouldRunAutoUpgradeCheck({ state, now })) {
      return false
    }

    await writeAutoUpgradeState(stateFile, now)

    const latest = await fetchLatestReleaseWithTimeout(
      opts.fetchImpl ?? fetch,
      opts.checkTimeoutMs ?? AUTO_UPGRADE_CHECK_TIMEOUT_MS
    )
    if (!shouldInstallLatest(currentVersion, latest.version)) {
      return false
    }

    const currentVersionForPrompt = stripControlChars(currentVersion)
    const latestVersionForPrompt = stripControlChars(latest.version)
    const question = [
      `a newer factory is available: ${currentVersionForPrompt} -> ${latestVersionForPrompt}`,
      'upgrade now? [y/N] ',
    ].join('\n')
    const answer = await (opts.readAnswer ?? readAutoUpgradeAnswer)(question)
    return isAffirmativeAutoUpgradeAnswer(answer)
  } catch {
    return false
  }
}

async function fetchLatestReleaseWithTimeout(fetchImpl: FetchImpl, timeoutMs: number) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchLatestRelease(fetchImpl, { signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

function readAutoUpgradeAnswer(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

function stripControlChars(value: string): string {
  let stripped = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    if ((code >= 0 && code <= 31) || (code >= 127 && code <= 159)) {
      continue
    }
    stripped += char
  }
  return stripped
}
