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
  /** Set by the mod (never by the reviewer) when the review came from an earlier message. */
  recovered?: true
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
  /** When the last verdict was posted: no nudge for a turn that saw one. */
  lastVerdictAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    council: {
      enabled: boolean
      /** The user turned Council off: the mode tool may not turn it back on. */
      lockedOff: boolean
      config: Shaped<Config>
      run: Shaped<Run | null>
    }
  }
}
