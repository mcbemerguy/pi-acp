import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverAvailableCommands } from '../../src/acp/agent.js'

test('discoverAvailableCommands includes Pi extension commands and trusts Pi command filtering', async () => {
  const commands = await discoverAvailableCommands(
    {
      async getCommands() {
        return {
          commands: [
            { name: 'workflow:review-fix', description: 'Review and fix', source: 'extension' },
            { name: 'skill:docs', description: 'Docs skill', source: 'skill' },
            { name: 'prompt', description: 'Prompt command', source: 'prompt' }
          ]
        }
      }
    },
    [],
    false
  )

  assert.equal(
    commands.some(command => command.name === 'workflow:review-fix'),
    true
  )
  assert.equal(
    commands.some(command => command.name === 'skill:docs'),
    true
  )
  assert.equal(
    commands.some(command => command.name === 'prompt'),
    true
  )
  assert.equal(
    commands.some(command => command.name === 'compact'),
    true
  )
})

test('discoverAvailableCommands falls back to file commands when Pi command discovery fails', async () => {
  const commands = await discoverAvailableCommands(
    {
      async getCommands() {
        throw new Error('get_commands failed')
      }
    },
    [
      {
        name: 'from-file',
        description: 'File command',
        content: 'Prompt content',
        source: '(project)'
      }
    ],
    true
  )

  assert.equal(
    commands.some(command => command.name === 'from-file'),
    true
  )
  assert.equal(
    commands.some(command => command.name === 'compact'),
    true
  )
})
