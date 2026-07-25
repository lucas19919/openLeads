import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'

// Where the CLI remembers which OpenLeads instance to talk to and with which
// token. Profiles exist so one machine can drive several instances — a local
// dev box and the production VPS — without re-typing a URL on every call.
//
// Precedence, highest first: explicit flags → environment → profile file. That
// order is what makes the same binary usable interactively *and* from a cron
// job or an MCP host, where only environment variables are available.

export interface Profile {
  url: string
  token?: string
}

export interface ConfigFile {
  current: string
  profiles: Record<string, Profile>
}

export const DEFAULT_URL = 'http://127.0.0.1:8787'

export function configPath(): string {
  return process.env.OPENLEADS_CONFIG ?? join(homedir(), '.openleads', 'config.json')
}

export function readConfig(): ConfigFile {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<ConfigFile>
    return {
      current: raw.current ?? 'default',
      profiles: raw.profiles ?? {},
    }
  } catch {
    return { current: 'default', profiles: {} }
  }
}

/** Persist the config, owner-readable only — it holds a bearer token. */
export function writeConfig(cfg: ConfigFile): void {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(path, 0o600) // no-op on Windows, matters everywhere else
  } catch {
    /* best effort */
  }
}

export interface Resolved {
  url: string
  token?: string
  profile: string
  /** Where the token came from — reported by `openleads whoami`. */
  source: 'flag' | 'env' | 'profile' | 'none'
}

/** Merge flags, environment and the profile file into one connection. */
export function resolveConnection(flags: { url?: string; token?: string; profile?: string }): Resolved {
  const cfg = readConfig()
  const profile = flags.profile ?? process.env.OPENLEADS_PROFILE ?? cfg.current
  const stored = cfg.profiles[profile]

  const url = (flags.url ?? process.env.OPENLEADS_URL ?? stored?.url ?? DEFAULT_URL).replace(/\/+$/, '')

  if (flags.token) return { url, token: flags.token, profile, source: 'flag' }
  if (process.env.OPENLEADS_TOKEN) {
    return { url, token: process.env.OPENLEADS_TOKEN, profile, source: 'env' }
  }
  if (stored?.token) return { url, token: stored.token, profile, source: 'profile' }
  return { url, profile, source: 'none' }
}

export function saveProfile(name: string, profile: Profile, makeCurrent = true): void {
  const cfg = readConfig()
  cfg.profiles[name] = { ...cfg.profiles[name], ...profile }
  if (makeCurrent) cfg.current = name
  writeConfig(cfg)
}

export function removeProfile(name: string): boolean {
  const cfg = readConfig()
  if (!(name in cfg.profiles)) return false
  delete cfg.profiles[name]
  if (cfg.current === name) cfg.current = Object.keys(cfg.profiles)[0] ?? 'default'
  writeConfig(cfg)
  return true
}
