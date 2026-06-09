import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { readTextFileCached, statFile, type FileMetadata } from './file-cache.js'

export type FileSlashCommand = {
  name: string
  description: string
  content: string
  source: string
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>
  content: string
} {
  const frontmatter: Record<string, string> = {}

  if (!content.startsWith('---')) return { frontmatter, content }

  const endIndex = content.indexOf('\n---', 3)
  if (endIndex === -1) return { frontmatter, content }

  const frontmatterBlock = content.slice(4, endIndex)
  const remaining = content.slice(endIndex + 4).trim()

  for (const line of frontmatterBlock.split('\n')) {
    const match = line.match(/^(\w+):\s*(.*)$/)
    if (match) frontmatter[match[1]] = match[2].trim()
  }

  return { frontmatter, content: remaining }
}

type CommandFile = FileMetadata & {
  path: string
  name: string
  source: 'user' | 'project'
  subdir: string
}

type SlashCommandCacheEntry = {
  signature: string
  commands: FileSlashCommand[]
}

const slashCommandCache = new Map<string, SlashCommandCacheEntry>()

function collectCommandFiles(
  dir: string,
  source: 'user' | 'project',
  subdir = '',
  out: CommandFile[] = []
): CommandFile[] {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        const newSubdir = subdir ? `${subdir}:${entry.name}` : entry.name
        collectCommandFiles(fullPath, source, newSubdir, out)
        continue
      }

      if (!entry.isFile() || !entry.name.endsWith('.md')) continue

      const metadata = statFile(fullPath)
      if (!metadata) continue
      out.push({ path: fullPath, name: entry.name.slice(0, -3), source, subdir, ...metadata })
    }
  } catch {
    return out
  }

  return out
}

function commandFilesSignature(files: CommandFile[]): string {
  return files.map(f => `${f.path}\0${f.mtimeNs}\0${f.ctimeNs}\0${f.size}`).join('\n')
}

function commandSource(source: 'user' | 'project', subdir: string): string {
  return source === 'user' ? (subdir ? `(user:${subdir})` : '(user)') : subdir ? `(project:${subdir})` : '(project)'
}

function parseCommandFile(file: CommandFile): FileSlashCommand | null {
  const rawContent = readTextFileCached(file.path)
  if (rawContent === null) return null

  const { frontmatter, content } = parseFrontmatter(rawContent)
  const sourceStr = commandSource(file.source, file.subdir)

  let description = frontmatter.description || ''
  if (!description) {
    const firstLine = content.split('\n').find(l => l.trim())
    if (firstLine) {
      description = firstLine.slice(0, 60)
      if (firstLine.length > 60) description += '...'
    }
  }

  description = description ? `${description} ${sourceStr}` : sourceStr

  return {
    name: file.name,
    description,
    content,
    source: sourceStr
  }
}

export function loadSlashCommands(cwd: string, opts: { includeProject?: boolean } = {}): FileSlashCommand[] {
  const userDir = join(homedir(), '.pi', 'agent', 'prompts')
  const projectDir = resolve(cwd, '.pi', 'prompts')
  const includeProject = opts.includeProject === true
  const cacheKey = `${resolve(cwd)}\0${userDir}\0${projectDir}\0${includeProject ? 'project' : 'user-only'}`

  const files = [
    ...collectCommandFiles(userDir, 'user'),
    ...(includeProject ? collectCommandFiles(projectDir, 'project') : [])
  ]
  const signature = commandFilesSignature(files)
  const cached = slashCommandCache.get(cacheKey)
  if (cached?.signature === signature) return cached.commands.slice()

  const commands = files.flatMap(file => {
    const command = parseCommandFile(file)
    return command ? [command] : []
  })

  slashCommandCache.set(cacheKey, { signature, commands })
  return commands.slice()
}

export function toAvailableCommands(fileCommands: FileSlashCommand[]): AvailableCommand[] {
  const seen = new Set<string>()
  const out: AvailableCommand[] = []

  for (const c of fileCommands) {
    if (seen.has(c.name)) continue
    seen.add(c.name)

    out.push({
      name: c.name,
      description: c.description
      // input: omitted for now (pi commands don't specify this)
    })
  }

  return out
}

export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = []
  let current = ''
  let inQuote: string | null = null

  for (let i = 0; i < argsString.length; i++) {
    const ch = argsString[i]

    if (inQuote) {
      if (ch === inQuote) inQuote = null
      else current += ch
      continue
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        args.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }

  if (current) args.push(current)
  return args
}

export function substituteArgs(content: string, args: string[]): string {
  let result = content

  result = result.replace(/\$@/g, args.join(' '))
  result = result.replace(/\$(\d+)/g, (_m, num) => {
    const idx = Number.parseInt(String(num), 10) - 1
    return args[idx] ?? ''
  })

  return result
}

export function expandSlashCommand(text: string, fileCommands: FileSlashCommand[]): string {
  if (!text.startsWith('/')) return text

  const spaceIndex = text.indexOf(' ')
  const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex)
  const argsString = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1)

  const cmd = fileCommands.find(c => c.name === commandName)
  if (!cmd) return text

  const args = parseCommandArgs(argsString)
  return substituteArgs(cmd.content, args)
}
