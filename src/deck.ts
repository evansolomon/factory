import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WorkContext } from './config.ts'
import { run } from './exec.ts'
import { log } from './log.ts'
import { findTask, latestTask, type Task } from './task.ts'

export type DeckRequest = {
  taskQuery: string | null
  urlOnly: boolean
}

export type DeckOpenResult = { ok: true } | { ok: false; message: string }

export type DeckOpener = (url: string) => Promise<DeckOpenResult>

const USAGE = 'usage: factory deck [task-id] [--url]'

export function normalizeDeckHtml(text: string): string | null {
  const trimmed = text.trim()
  const fence = trimmed.match(/^```(?:html)?\s*\n([\s\S]*?)\n```$/i)
  const html = (fence?.[1] ?? trimmed).trim()
  return /^<!doctype html>/i.test(html) ? html : null
}

export async function buildDeckHtml(runDeck: () => Promise<string>): Promise<string | null> {
  try {
    return normalizeDeckHtml(await runDeck())
  } catch {
    return null
  }
}

export function parseDeckArgs(
  args: string[]
): { ok: true; request: DeckRequest } | { ok: false; message: string } {
  let urlOnly = false
  const positional: string[] = []

  for (const arg of args) {
    if (arg === '--url') {
      urlOnly = true
      continue
    }
    if (arg.startsWith('-')) {
      return { ok: false, message: `unknown option ${arg}\n${USAGE}` }
    }
    positional.push(arg)
  }

  if (positional.length > 1) {
    return { ok: false, message: USAGE }
  }

  return { ok: true, request: { taskQuery: positional[0] ?? null, urlOnly } }
}

export function deckPath(task: Task): string {
  return resolve(task.dir, 'brief.html')
}

export function deckUrl(path: string): string {
  return pathToFileURL(path).href
}

export function browserOpenCommand(platform: NodeJS.Platform, url: string): string[] | null {
  if (platform === 'darwin') {
    return ['open', url]
  }
  if (platform === 'linux') {
    return ['xdg-open', url]
  }
  if (platform === 'win32') {
    return ['cmd', '/c', 'start', '', url]
  }
  return null
}

export async function defaultDeckOpener(url: string): Promise<DeckOpenResult> {
  const cmd = browserOpenCommand(process.platform, url)
  if (!cmd) {
    return { ok: false, message: `no browser opener for platform ${process.platform}` }
  }
  const result = await run(cmd, { cwd: process.cwd() })
  if (result.code === 0) {
    return { ok: true }
  }
  const detail = (result.stderr || result.stdout).trim()
  return {
    ok: false,
    message: detail ? `browser opener failed: ${detail}` : `browser opener exited ${result.code}`,
  }
}

export async function openDeck(
  ctx: WorkContext,
  args: string[],
  opts: { opener?: DeckOpener } = {}
): Promise<number> {
  const parsed = parseDeckArgs(args)
  if (!parsed.ok) {
    log.fail(parsed.message)
    return 1
  }

  const task = parsed.request.taskQuery
    ? await findTask(ctx, parsed.request.taskQuery)
    : await latestTask(ctx, ['done'])
  if (!task) {
    log.fail(
      parsed.request.taskQuery
        ? `no task matching ${parsed.request.taskQuery}`
        : 'no done task in this worktree'
    )
    return 1
  }
  if (task.meta.status !== 'done') {
    log.fail(`${task.id} is ${task.meta.status}; deck is only available for done tasks`)
    return 1
  }

  const path = deckPath(task)
  if (!(await Bun.file(path).exists())) {
    log.fail(
      `no brief for ${task.id} - deck generation is best-effort and may have been skipped; try: factory show ${task.id}`
    )
    return 1
  }

  const url = deckUrl(path)
  if (parsed.request.urlOnly) {
    log.log(url)
    return 0
  }

  const result = await (opts.opener ?? defaultDeckOpener)(url)
  if (!result.ok) {
    log.warn(`could not open deck: ${result.message}`)
    log.log(url)
  }
  return 0
}
