import { $ } from 'bun'
import type { WorkContext } from './config.ts'
import { appendCandidate } from './lessons.ts'
import { log } from './log.ts'
import { readArtifact, saveMeta, type Task, writeArtifact } from './task.ts'

// Post-ship feedback harvesting: after factory ships an MR, human rework on that
// work is the highest-signal feedback there is — and it used to vanish (real
// usage showed 8 human follow-up commits on one shipped task with feedbackCount
// still 0). Attribution is sound with plain git: `meta.commit` is refreshed to
// the true HEAD when ship finishes, so anything after it on `meta.shipBranch`
// is not factory's. MR discussion is fetched best-effort via gh/glab when the
// platform CLI is available. Harvest records what it finds (harvest.md + lesson
// candidates); it never creates tasks — manufacturing work from noise is worse
// than surfacing signal.

export type HarvestResult = {
  taskId: string
  reworkCommits: string[]
  discussion: string | null
  skipped: string | null
}

async function fetchDiscussion(url: string): Promise<string | null> {
  try {
    if (url.includes('github.com')) {
      const res = await $`gh pr view ${url} --json comments,reviews`.nothrow().quiet()
      return res.exitCode === 0 ? res.text().trim() : null
    }
    const res = await $`glab mr view ${url} --comments`.nothrow().quiet()
    return res.exitCode === 0 ? res.text().trim() : null
  } catch {
    return null
  }
}

export async function harvestTask(ctx: WorkContext, task: Task): Promise<HarvestResult> {
  const skip = (reason: string): HarvestResult => ({
    taskId: task.id,
    reworkCommits: [],
    discussion: null,
    skipped: reason,
  })
  if (task.meta.status !== 'done' || !task.meta.commit) {
    return skip('not a completed task with a commit')
  }
  const branch = task.meta.shipBranch
  if (!branch && !task.meta.shipUrl) {
    return skip('no recorded ship branch or MR url (shipped before harvesting existed?)')
  }

  const reworkCommits: string[] = []
  if (branch) {
    await $`git -C ${ctx.root} fetch origin ${branch}`.nothrow().quiet()
    const range =
      await $`git -C ${ctx.root} log ${task.meta.commit}..origin/${branch} --no-merges --format=${'%h %s'}`
        .nothrow()
        .quiet()
    if (range.exitCode === 0) {
      reworkCommits.push(
        ...range
          .text()
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
      )
    }
  }
  const discussion = task.meta.shipUrl ? await fetchDiscussion(task.meta.shipUrl) : null

  if (reworkCommits.length > 0 || discussion) {
    const prior = await readArtifact(task, 'harvest.md')
    const report = [
      `# Post-ship harvest — ${task.id}`,
      '',
      `Harvested: ${new Date().toISOString()}`,
      `Ship commit: ${task.meta.commit} · branch: ${branch ?? '(unknown)'} · MR: ${task.meta.shipUrl ?? '(none)'}`,
      '',
      '## Human rework commits after factory finished',
      reworkCommits.length > 0 ? reworkCommits.map((c) => `- ${c}`).join('\n') : '(none)',
      '',
      '## MR discussion',
      discussion ?? '(unavailable)',
    ].join('\n')
    if (report !== prior) {
      await writeArtifact(task, 'harvest.md', report)
      for (const commit of reworkCommits) {
        await appendCandidate(ctx, `post-ship rework · ${task.id} · ${commit}`)
      }
    }
  }

  task.meta.harvestedAt = new Date().toISOString()
  await saveMeta(task)
  return { taskId: task.id, reworkCommits, discussion, skipped: null }
}

export function summarizeHarvest(result: HarvestResult): string {
  if (result.skipped) {
    return `${result.taskId}: skipped — ${result.skipped}`
  }
  const rework = result.reworkCommits.length
  const parts = [
    rework > 0 ? `${rework} human rework commit${rework === 1 ? '' : 's'}` : 'no rework commits',
    result.discussion ? 'MR discussion captured' : 'no MR discussion available',
  ]
  const detail = rework > 0 ? ` — review with: factory show ${result.taskId}` : ''
  return `${result.taskId}: ${parts.join(' · ')}${detail}`
}

export function logHarvest(result: HarvestResult): void {
  const line = summarizeHarvest(result)
  if (result.reworkCommits.length > 0) {
    log.warn(line)
  } else {
    log.info(line)
  }
}
