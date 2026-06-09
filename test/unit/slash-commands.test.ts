import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expandSlashCommand,
  parseCommandArgs,
  substituteArgs,
  loadSlashCommands,
  toAvailableCommands
} from '../../src/acp/slash-commands.js'

test('parseCommandArgs: handles quotes', () => {
  assert.deepEqual(parseCommandArgs('a b'), ['a', 'b'])
  assert.deepEqual(parseCommandArgs("'a b' c"), ['a b', 'c'])
  assert.deepEqual(parseCommandArgs('"a b" c'), ['a b', 'c'])
})

test('substituteArgs: replaces $1.. and $@', () => {
  assert.equal(substituteArgs('x=$1 y=$2 all=$@', ['one', 'two']).trim(), 'x=one y=two all=one two')
  assert.equal(substituteArgs('$3', ['one']).trim(), '')
})

test('expandSlashCommand: expands known command', () => {
  const cmds = [{ name: 'hello', description: '(user)', content: 'Say hi to $1', source: '(user)' }]

  assert.equal(expandSlashCommand('/hello world', cmds as any), 'Say hi to world')
  assert.equal(expandSlashCommand('/unknown world', cmds as any), '/unknown world')
  assert.equal(expandSlashCommand('not a command', cmds as any), 'not a command')
})

test('loadSlashCommands: invalidates cached prompt files by metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-slash-cache-'))
  try {
    const cwd = join(root, 'repo')
    const prompts = join(cwd, '.pi', 'prompts')
    const prompt = join(prompts, 'hello.md')
    mkdirSync(prompts, { recursive: true })
    writeFileSync(prompt, 'first $1')

    assert.equal(expandSlashCommand('/hello world', loadSlashCommands(cwd, { includeProject: true })), 'first world')

    writeFileSync(prompt, 'second $1')
    const future = new Date(Date.now() + 5000)
    utimesSync(prompt, future, future)

    assert.equal(expandSlashCommand('/hello world', loadSlashCommands(cwd, { includeProject: true })), 'second world')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadSlashCommands: invalidates same-size prompt edits with preserved mtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-slash-cache-same-size-'))
  try {
    const cwd = join(root, 'repo')
    const prompts = join(cwd, '.pi', 'prompts')
    const prompt = join(prompts, 'hello.md')
    mkdirSync(prompts, { recursive: true })
    writeFileSync(prompt, 'first $1')
    const originalTimes = statSync(prompt)

    assert.equal(expandSlashCommand('/hello world', loadSlashCommands(cwd, { includeProject: true })), 'first world')

    writeFileSync(prompt, 'other $1')
    utimesSync(prompt, originalTimes.atime, originalTimes.mtime)

    assert.equal(expandSlashCommand('/hello world', loadSlashCommands(cwd, { includeProject: true })), 'other world')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadSlashCommands: does not read project prompts unless explicitly allowed', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-slash-untrusted-'))
  try {
    const cwd = join(root, 'repo')
    const prompts = join(cwd, '.pi', 'prompts')
    mkdirSync(prompts, { recursive: true })
    writeFileSync(join(prompts, 'project-only.md'), 'project prompt')

    assert.equal(expandSlashCommand('/project-only', loadSlashCommands(cwd)), '/project-only')
    assert.equal(
      expandSlashCommand('/project-only', loadSlashCommands(cwd, { includeProject: true })),
      'project prompt'
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('toAvailableCommands: de-dupes by name (first wins)', () => {
  const cmds = [
    { name: 'x', description: 'first', content: '1', source: '(user)' },
    { name: 'x', description: 'second', content: '2', source: '(project)' }
  ]

  assert.deepEqual(toAvailableCommands(cmds as any), [{ name: 'x', description: 'first' }])
})
