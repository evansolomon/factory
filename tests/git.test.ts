import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { $ } from 'bun'
import { commitAll } from '../src/git.ts'

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
