import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

// Open a file in $EDITOR and wait for it to close. `sh -c` so a multi-word
// $EDITOR (e.g. "code --wait") works; "$1" handles spaces in the path. $EDITOR
// must block until close (nano/vim do; GUI editors need a wait flag).
export async function openEditor(path: string): Promise<void> {
  const editor =
    process.env['AGENT_WORK_EDITOR'] || process.env['EDITOR'] || process.env['VISUAL'] || 'vi'
  const proc = Bun.spawn(['sh', '-c', `${editor} "$1"`, 'sh', path], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`editor exited ${code}: ${editor}`)
  }
}

// Compose text in $EDITOR via a temp file, pre-filled with `seed`. Returns the
// trimmed contents ('' if left empty). Used for composing a task intent and for
// multi-line sharpen replies.
export async function composeInEditor(seed = ''): Promise<string> {
  const tmp = `${tmpdir()}/factory-edit-${Date.now()}.md`
  await Bun.write(tmp, seed ? `${seed}\n` : '')
  await openEditor(tmp)
  const text = (await Bun.file(tmp).text()).trim()
  await rm(tmp, { force: true })
  return text
}
