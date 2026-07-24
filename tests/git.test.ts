import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { $ } from 'bun'
import { commitAll, diffSince, parentSha, worktreeDiffHasChanges } from '../src/git.ts'

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/factory-git-`)
  await $`git init -q ${root}`.quiet()
  await $`git -C ${root} config user.email factory@example.com`.quiet()
  await $`git -C ${root} config user.name Factory`.quiet()
  return root
}

describe('commitAll', () => {
  test('returns pre-commit output instead of throwing an opaque shell error', async () => {
    const root = await tempRepo()
    try {
      await writeFile(`${root}/change.txt`, 'change\n')
      await mkdir(`${root}/.git/hooks`, { recursive: true })
      const hook = `${root}/.git/hooks/pre-commit`
      await writeFile(hook, '#!/bin/sh\necho "formatter found a fixable problem" >&2\nexit 1\n')
      await chmod(hook, 0o755)

      const result = await commitAll(root, 'Add change')

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.detail).toContain('git commit failed (exit 1)')
        expect(result.detail).toContain('formatter found a fixable problem')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('worktreeDiffHasChanges', () => {
  test('recognizes clean snapshots and treats status or patch content as changes', () => {
    expect(worktreeDiffHasChanges('# git status\n\n# git diff HEAD\n')).toBe(false)
    expect(worktreeDiffHasChanges('# git status\n M src/a.ts\n\n# git diff HEAD\n')).toBe(true)
    expect(worktreeDiffHasChanges('# git status\n\n# git diff HEAD\ndiff --git a/a b/a')).toBe(true)
  })
})

describe('committed implementation diff', () => {
  test('reads the parent and full committed range from a clean worktree', async () => {
    const root = await tempRepo()
    try {
      await writeFile(`${root}/file.txt`, 'base\n')
      expect((await commitAll(root, 'Base')).ok).toBe(true)
      const base = (await $`git -C ${root} rev-parse --short HEAD`.text()).trim()
      await writeFile(`${root}/file.txt`, 'implemented\n')
      expect((await commitAll(root, 'Implement')).ok).toBe(true)

      expect(await parentSha(root)).toBe(base)
      const diff = await diffSince(root, base)
      expect(diff).toContain('-base')
      expect(diff).toContain('+implemented')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
