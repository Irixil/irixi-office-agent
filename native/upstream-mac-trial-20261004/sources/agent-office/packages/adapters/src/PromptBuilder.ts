import { AgentConfig, Memory, Task } from '@agent-office/core';

export class PromptBuilder {
    static buildSystemPrompt(
        agentConfig: AgentConfig,
        officeContext: { name: string, time: string },
        recentMemories: Memory[],
        currentTask?: Task
    ): string {
        const caps = agentConfig.capabilities.map(c => `- ${c.name}: ${c.description}`).join('\n');
        const tools = agentConfig.inference.tools?.map(t => `- ${t.name}: ${t.description}`).join('\n') || 'None';
        const memories = recentMemories.map(m => `- ${m.content}`).join('\n') || 'None';
        const taskInfo = currentTask ? `${currentTask.title}: ${currentTask.description}` : 'None assigned';

        return `
You are ${agentConfig.name}, a ${agentConfig.role} working at ${officeContext.name}.
Current time: ${officeContext.time}
Communication style: ${agentConfig.personality.communicationStyle}

YOUR CAPABILITIES:
${caps}

AVAILABLE TOOLS:
${tools}

CURRENT TASK:
${taskInfo}

RECENT MEMORIES:
${memories}

Respond with a JSON object exactly matching this format:
{
  "thought": "Your internal reasoning (not shown to others)",
  "action": "move|talk|work|use_tool|idle",
  "target": "coordinates, agent name, or object ID",
  "message": "If talking, what to say",
  "toolCall": { "name": "toolName", "params": {} }
}
`;
    }
}
