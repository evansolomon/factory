import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { $ } from 'bun'
import { z } from 'zod'
import { run } from './exec.ts'
import { log } from './log.ts'

// The eval replay runner — the missing consumer of the harvested eval corpus.
// Every terminal task was captured as {spec, verify, baseCommit, reference diff}
// but nothing ever replayed one, so the "regression set accruing from use" was
// write-only. This runs a case end-to-end: fresh worktree at baseCommit, fresh
// isolated FACTORY_HOME, the current factory binary on the captured spec, then
// scores the replay against the captured reference. This is what makes prompt,
// policy, and config changes measurable instead of guessed — including
// factory's own changes to itself.

export const EvalCaseSchema = z.object({
  id: z.string(),
  ts: z.string(),
  outcome: z.enum(['done', 'blocked', 'corrected']),
  reason: z.string().nullable().default(null),
  worktree: z.string(),
  baseCommit: z.string(),
  verify: z.string().nullable().default(null),
  spec: z.string(),
  diff: z.string().optional(),
  agentAttempt: z.string().optional(),
  humanFix: z.string().optional(),
})
export type EvalCase = z.infer<typeof EvalCaseSchema>

export type LoadedEvalCase = { file: string; case: EvalCase }

export async function listEvalCases(repoStateDir: string): Promise<LoadedEvalCase[]> {
  const dir = `${repoStateDir}/eval-candidates`
  let entries: string[] = []
  try {
    entries = (await readdir(dir)).filter((e) => e.endsWith('.json')).sort()
  } catch {
    return []
  }
  const out: LoadedEvalCase[] = []
  for (const entry of entries) {
    try {
      const parsed = EvalCaseSchema.safeParse(await Bun.file(`${dir}/${entry}`).json())
      if (parsed.success) {
        out.push({ file: entry, case: parsed.data })
      } else {
        log.warn(`eval case skipped (${entry}): ${parsed.error.issues[0]?.message}`)
      }
    } catch (err) {
      log.warn(`eval case skipped (${entry}): ${err instanceof Error ? err.message : err}`)
    }
  }
  return out
}

// The set of files a diff touches — the cheap, deterministic backbone of the
// similarity score. Prose-level diff comparison is a judgment call; file-set
// overlap is not, and reference diffs captured with a status header + no-index
// blocks parse the same way.
export function diffFileSet(diff: string): Set<string> {
  const files = new Set<string>()
  for (const match of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    if (match[1]) {
      files.add(match[1].trim())
    }
  }
  for (const match of diff.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
    if (match[2]) {
      files.add(match[2].trim())
    }
  }
  return files
}

export function fileJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1
  }
  if (a.size === 0 || b.size === 0) {
    return 0
  }
  let shared = 0
  for (const f of a) {
    if (b.has(f)) {
      shared++
    }
  }
  return shared / (a.size + b.size - shared)
}

export type EvalResult = {
  file: string
  id: string
  expectedOutcome: string
  replayStatus: string
  outcomeMatch: boolean
  fileJaccard: number
  replayFiles: string[]
  referenceFiles: string[]
  durationMs: number
  error: string | null
}

// How factory re-invokes itself: the compiled binary IS the entrypoint; a
// source run needs `bun <cli.ts>`.
export function factoryInvocation(): string[] {
  const script = process.argv[1]
  return script && /\.(ts|js|mjs)$/.test(script) ? [process.execPath, script] : [process.execPath]
}

const ReplayMetaSchema = z.object({
  status: z.string(),
  commit: z.string().nullable().default(null),
})

async function replayTaskState(
  home: string
): Promise<{ status: string; commit: string | null } | null> {
  const sessions = `${home}/sessions`
  try {
    for (const session of await readdir(sessions)) {
      const tasksDir = `${sessions}/${session}/tasks`
      for (const taskDir of await readdir(tasksDir).catch(() => [] as string[])) {
        const parsed = ReplayMetaSchema.safeParse(
          await Bun.file(`${tasksDir}/${taskDir}/meta.json`)
            .json()
            .catch(() => null)
        )
        if (parsed.success) {
          return { status: parsed.data.status, commit: parsed.data.commit }
        }
      }
    }
  } catch {}
  return null
}

export async function runEvalCase(
  mainRoot: string,
  loaded: LoadedEvalCase,
  opts: { keep?: boolean } = {}
): Promise<EvalResult> {
  const c = loaded.case
  const started = Date.now()
  const fail = (error: string): EvalResult => ({
    file: loaded.file,
    id: c.id,
    expectedOutcome: c.outcome,
    replayStatus: 'error',
    outcomeMatch: false,
    fileJaccard: 0,
    replayFiles: [],
    referenceFiles: [...diffFileSet(c.diff ?? '')],
    durationMs: Date.now() - started,
    error,
  })
  if (c.outcome === 'corrected' || !c.diff) {
    return fail('corrected/paired cases are not replayable yet — skipped')
  }

  const worktree = await mkdtemp(`${tmpdir()}/factory-eval-wt-`)
  const home = await mkdtemp(`${tmpdir()}/factory-eval-home-`)
  const cleanup = async () => {
    if (opts.keep) {
      log.info(`kept replay state: worktree ${worktree} · home ${home}`)
      return
    }
    await $`git -C ${mainRoot} worktree remove --force ${worktree}`.nothrow().quiet()
    await rm(worktree, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }

  try {
    const add = await $`git -C ${mainRoot} worktree add --detach ${worktree} ${c.baseCommit}`
      .nothrow()
      .quiet()
    if (add.exitCode !== 0) {
      await cleanup()
      return fail(`could not create worktree at ${c.baseCommit}: ${add.stderr.toString().trim()}`)
    }

    // An isolated home keeps the replay from polluting real session state and
    // makes runs reproducible (no accumulated guidance/config on the machine).
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value
      }
    }
    env['FACTORY_HOME'] = home
    const invoke = factoryInvocation()
    const addArgs = c.verify
      ? ['add', '--raw', c.spec, '--verify', c.verify]
      : ['add', '--raw', c.spec]
    const addRes = await run([...invoke, ...addArgs], { cwd: worktree, stdin: '', env })
    if (addRes.code !== 0) {
      await cleanup()
      return fail(`factory add failed: ${(addRes.stderr || addRes.stdout).slice(0, 400)}`)
    }
    const runRes = await run([...invoke, 'run', '--once', '--no-prompt'], {
      cwd: worktree,
      stdin: '',
      env,
    })
    const state = await replayTaskState(home)
    const replayDiff = await $`git -C ${worktree} diff HEAD~1 HEAD`.nothrow().quiet()
    const uncommitted = await $`git -C ${worktree} diff HEAD`.nothrow().quiet()
    const replayFiles =
      state?.commit && replayDiff.exitCode === 0
        ? diffFileSet(replayDiff.text())
        : diffFileSet(uncommitted.text())
    const referenceFiles = diffFileSet(c.diff)
    const status = state?.status ?? (runRes.code === 0 ? 'unknown' : 'error')
    const result: EvalResult = {
      file: loaded.file,
      id: c.id,
      expectedOutcome: c.outcome,
      replayStatus: status,
      outcomeMatch: c.outcome === 'done' ? status === 'done' : status !== 'done',
      fileJaccard: fileJaccard(replayFiles, referenceFiles),
      replayFiles: [...replayFiles].sort(),
      referenceFiles: [...referenceFiles].sort(),
      durationMs: Date.now() - started,
      error: null,
    }
    await cleanup()
    return result
  } catch (err) {
    await cleanup()
    return fail(err instanceof Error ? err.message : String(err))
  }
}

export async function appendEvalResult(repoStateDir: string, result: EvalResult): Promise<void> {
  const path = `${repoStateDir}/eval-results.jsonl`
  const file = Bun.file(path)
  const existing = (await file.exists()) ? await file.text() : ''
  await Bun.write(
    path,
    `${existing}${JSON.stringify({ ts: new Date().toISOString(), ...result })}\n`
  )
}
