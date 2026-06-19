import { chatComplete } from './provider'
import { TOOL_SCHEMAS, runTool, type ToolContext } from './tools'
import { COPILOT_SYSTEM } from './prompts'
import type { ChatMessage } from './types'

export interface AgentStep {
  tool: string
  args: Record<string, unknown>
  result: unknown
}

export interface AgentRun {
  reply: string
  steps: AgentStep[]
  messages: ChatMessage[]
}

/**
 * The copilot loop: feed history + system prompt, let the model call tools, run
 * them, feed results back, repeat until it answers in prose (or we hit the step
 * budget). The whole exchange is returned so the caller can persist the thread.
 */
export async function runAgent(
  history: ChatMessage[],
  ctx: ToolContext,
  opts: { maxSteps?: number } = {},
): Promise<AgentRun> {
  const maxSteps = opts.maxSteps ?? 6
  const messages: ChatMessage[] = [{ role: 'system', content: COPILOT_SYSTEM }, ...history]
  const steps: AgentStep[] = []

  for (let i = 0; i < maxSteps; i++) {
    const { message } = await chatComplete({ messages, tools: TOOL_SCHEMAS, temperature: 0.3, maxTokens: 1200 })
    messages.push(message)

    const calls = message.tool_calls ?? []
    if (calls.length === 0) {
      return { reply: message.content ?? '', steps, messages: messages.slice(1) }
    }

    for (const call of calls) {
      let args: Record<string, unknown> = {}
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
      } catch {
        args = {}
      }
      const result = await runTool(call.function.name, args, ctx)
      steps.push({ tool: call.function.name, args, result })
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(result),
      })
    }
  }

  // Budget exhausted — ask for a final summary without more tools.
  const { message } = await chatComplete({
    messages: [...messages, { role: 'user', content: 'Fasse das Ergebnis jetzt kurz auf Deutsch zusammen, ohne weitere Werkzeuge.' }],
    temperature: 0.3,
    maxTokens: 600,
  })
  return { reply: message.content ?? '', steps, messages: messages.slice(1) }
}
