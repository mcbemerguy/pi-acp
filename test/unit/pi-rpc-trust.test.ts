import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPiRpcSpawnArgs, buildPiRpcSpawnEnv } from '../../src/pi-rpc/process.js'
import {
  allowsAdapterProjectLocalReads,
  resolveProjectTrustPolicy,
  piArgsForProjectTrustPolicy
} from '../../src/pi-rpc/trust.js'

test('Pi RPC trust policy maps to safe spawn args', () => {
  assert.deepEqual(buildPiRpcSpawnArgs(), ['--mode', 'rpc', '--no-themes'])
  assert.deepEqual(buildPiRpcSpawnArgs({ projectTrustPolicy: 'trusted' }), [
    '--mode',
    'rpc',
    '--no-themes',
    '--approve'
  ])
  assert.deepEqual(buildPiRpcSpawnArgs({ projectTrustPolicy: 'untrusted', sessionPath: '/tmp/session.jsonl' }), [
    '--mode',
    'rpc',
    '--no-themes',
    '--no-approve',
    '--session',
    '/tmp/session.jsonl'
  ])
})

test('Pi RPC trust policy resolves from request meta, config, then env', () => {
  assert.equal(resolveProjectTrustPolicy({ env: {} }), 'auto')
  assert.equal(resolveProjectTrustPolicy({ env: { PI_ACP_PROJECT_TRUST: 'approve' } }), 'trusted')
  assert.equal(
    resolveProjectTrustPolicy({ config: { projectTrust: 'no-approve' }, env: { PI_ACP_PROJECT_TRUST: 'approve' } }),
    'untrusted'
  )
  assert.equal(
    resolveProjectTrustPolicy({
      requestMeta: { piAcp: { projectTrust: 'trusted' } },
      config: { projectTrust: 'untrusted' },
      env: {}
    }),
    'trusted'
  )
})

test('Pi RPC trust policy gates adapter-side project-local reads', () => {
  assert.equal(allowsAdapterProjectLocalReads('auto'), false)
  assert.equal(allowsAdapterProjectLocalReads('untrusted'), false)
  assert.equal(allowsAdapterProjectLocalReads('trusted'), true)
  assert.deepEqual(piArgsForProjectTrustPolicy('auto'), [])
})

test('Pi RPC env marks ACP children and strips parent-only delegated question tool', () => {
  const env = buildPiRpcSpawnEnv({
    PATH: '/bin',
    PI_DELEGATED_TOOL_CAP: 'read, ask_user_questions,write'
  })

  assert.equal(env.PI_ACP, '1')
  assert.equal(env.PI_ACP_RPC, '1')
  assert.equal(env.PI_DELEGATED_TOOL_CAP, 'read,write')
})
