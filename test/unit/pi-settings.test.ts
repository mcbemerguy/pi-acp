import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEnableSkillCommands } from '../../src/acp/pi-settings.js'

test('getEnableSkillCommands invalidates global and project settings by metadata', () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-settings-cache-'))
  try {
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'repo')
    mkdirSync(join(cwd, '.pi'), { recursive: true })
    mkdirSync(agentDir, { recursive: true })

    const globalSettings = join(agentDir, 'settings.json')
    const projectSettings = join(cwd, '.pi', 'settings.json')
    process.env.PI_CODING_AGENT_DIR = agentDir

    writeFileSync(globalSettings, JSON.stringify({ enableSkillCommands: false }))
    assert.equal(getEnableSkillCommands(cwd), false)

    writeFileSync(projectSettings, JSON.stringify({ enableSkillCommands: true }))
    const projectFuture = new Date(Date.now() + 5000)
    utimesSync(projectSettings, projectFuture, projectFuture)
    assert.equal(getEnableSkillCommands(cwd), true)

    writeFileSync(projectSettings, JSON.stringify({ enableSkillCommands: false }))
    const laterProjectFuture = new Date(Date.now() + 10000)
    utimesSync(projectSettings, laterProjectFuture, laterProjectFuture)
    assert.equal(getEnableSkillCommands(cwd), false)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('getEnableSkillCommands invalidates same-size project setting edits with preserved mtime', () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-settings-cache-same-size-'))
  try {
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'repo')
    mkdirSync(join(cwd, '.pi'), { recursive: true })
    mkdirSync(agentDir, { recursive: true })

    const projectSettings = join(cwd, '.pi', 'settings.json')
    process.env.PI_CODING_AGENT_DIR = agentDir

    writeFileSync(projectSettings, JSON.stringify({ enableSkillCommands: true, pad: 'xx' }))
    const originalTimes = statSync(projectSettings)
    assert.equal(getEnableSkillCommands(cwd), true)

    writeFileSync(projectSettings, JSON.stringify({ enableSkillCommands: false, pad: 'x' }))
    utimesSync(projectSettings, originalTimes.atime, originalTimes.mtime)
    assert.equal(getEnableSkillCommands(cwd), false)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(root, { recursive: true, force: true })
  }
})
