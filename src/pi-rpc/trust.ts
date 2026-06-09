export type PiProjectTrustPolicy = 'auto' | 'trusted' | 'untrusted'

export const DEFAULT_PROJECT_TRUST_POLICY: PiProjectTrustPolicy = 'auto'

export type PiProjectTrustConfig = {
  projectTrust?: unknown
  trustPolicy?: unknown
}

export function normalizeProjectTrustPolicy(value: unknown): PiProjectTrustPolicy | null {
  if (typeof value === 'boolean') return value ? 'trusted' : 'untrusted'
  if (typeof value !== 'string') return null

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
  switch (normalized) {
    case 'auto':
    case 'default':
    case 'saved':
    case 'trust-store':
    case 'truststore':
      return 'auto'
    case 'trusted':
    case 'trust':
    case 'approve':
    case 'approved':
    case 'yes':
    case 'true':
      return 'trusted'
    case 'untrusted':
    case 'no-trust':
    case 'no-approve':
    case 'noapprove':
    case 'deny':
    case 'denied':
    case 'no':
    case 'false':
      return 'untrusted'
    default:
      return null
  }
}

export function projectTrustPolicyFromMeta(value: unknown): PiProjectTrustPolicy | null {
  const root = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const piAcp = root?.piAcp && typeof root.piAcp === 'object' ? (root.piAcp as Record<string, unknown>) : null
  return normalizeProjectTrustPolicy(piAcp?.projectTrust ?? root?.projectTrust)
}

export function resolveProjectTrustPolicy(
  options: {
    requestMeta?: unknown
    config?: PiProjectTrustConfig | null
    env?: NodeJS.ProcessEnv
  } = {}
): PiProjectTrustPolicy {
  return (
    projectTrustPolicyFromMeta(options.requestMeta) ??
    normalizeProjectTrustPolicy(options.config?.projectTrust) ??
    normalizeProjectTrustPolicy(options.config?.trustPolicy) ??
    normalizeProjectTrustPolicy((options.env ?? process.env).PI_ACP_PROJECT_TRUST) ??
    DEFAULT_PROJECT_TRUST_POLICY
  )
}

export function piArgsForProjectTrustPolicy(policy: PiProjectTrustPolicy): string[] {
  switch (policy) {
    case 'trusted':
      return ['--approve']
    case 'untrusted':
      return ['--no-approve']
    case 'auto':
      return []
  }
}

export function allowsAdapterProjectLocalReads(policy: PiProjectTrustPolicy): boolean {
  return policy === 'trusted'
}
