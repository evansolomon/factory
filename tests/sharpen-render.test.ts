import { describe, expect, test } from 'bun:test'
import { styleSharpenMarkdownLine } from '../src/sharpen-render.ts'

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '')
}

describe('sharpen markdown rendering', () => {
  test('renders spec headings without visible markdown markers', () => {
    const heading = styleSharpenMarkdownLine('## Problem')

    expect(heading).toContain('\x1b[32m\x1b[1m')
    expect(stripAnsi(heading)).toBe('Problem')
    expect(stripAnsi(styleSharpenMarkdownLine('### Rejected Alternatives'))).toBe(
      'Rejected Alternatives'
    )
  })

  test('renders inline emphasis and code as display text', () => {
    const line = styleSharpenMarkdownLine('Use **small** `terminal` markdown.')

    expect(line).toContain('\x1b[1msmall\x1b[0m')
    expect(line).toContain('\x1b[36mterminal\x1b[0m')
    expect(stripAnsi(line)).toBe('Use small terminal markdown.')
  })

  test('keeps list structure and unsupported markdown readable', () => {
    const bullet = styleSharpenMarkdownLine('- Use `bun test`')

    expect(bullet).toContain('\x1b[2m-\x1b[0m')
    expect(stripAnsi(bullet)).toBe('- Use bun test')
    expect(stripAnsi(styleSharpenMarkdownLine('1. Read [README](./README.md)'))).toBe(
      '1. Read [README](./README.md)'
    )
  })
})
