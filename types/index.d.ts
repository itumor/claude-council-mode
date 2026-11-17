export type Config = { target: number; rounds: number; reviewers: number }

export type Finding = {
  severity: 'critical' | 'high' | 'medium' | 'low'
  location: string
  evidence: string
  fix: string
}

export type Review = {
  lens: string
  agentId: string
  score: number
  findings: Finding[]
  verified: string[]
  limitations: string[]
  error?: string
}

export type Round = {
  number: number
  score: number
  passed: boolean
  blockers: number
  reviews: Review[]
  checks: string[]
}

export type RunStatus = 'active' | 'reviewing' | 'passed' | 'needs_human_decision' | 'cancelled'

export type Run = {
  task: string
  config: Config
  lenses: string[]
  status: RunStatus
  rounds: Round[]
  pending: { agentId: string; lens: string }[]
  partial: Review[]
  /** Agents that ended before their spawn was recorded (answer kept for recordSpawn). */
  early: { agentId: string; answer: string; reason: string }[]
  checks: string[]
  stopBlocks: number
  announce: boolean
  /** True while the review tool is still spawning: the round must not close early. */
  spawning?: boolean
  reviewingSince?: number
}

declare module 'claude-code' {
  interface PluginState {
    council: {
      enabled: boolean
      config: Shaped<Config>
      run: Shaped<Run | null>
    }
  }
}
