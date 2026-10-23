export function createFakeOmoRoleRunner() {
  let sequence = 0;
  return async ({ role, prompt, runModelDecision }) => {
    const names = role === 'Developer' ? ['read', 'write', 'edit', 'grep', 'find', 'ls']
      : role === 'Reviewer' ? ['read', 'grep', 'find', 'ls'] : [];
    const response = await runModelDecision({
      provider: 'irixi-codex-bridge', modelId: 'gpt-6-luna', systemPrompt: 'isolated fake OmO',
      messages: [{ role: 'user', content: prompt }], tools: names.map((name) => ({ name, parameters: { type: 'object' } })),
    }, 1, new AbortController().signal);
    let text = response;
    try {
      const decision = JSON.parse(response);
      if (Array.isArray(decision.content)) text = decision.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    } catch {}
    if (!text.trim()) throw new Error('Fake OmO received no assistant text.');
    sequence += 1;
    return {
      status: 'model_returned', output: { text }, provider: 'irixi-codex-bridge', model: 'gpt-6-luna',
      providerCalls: 1, sessionId: `fake-omo-session-${sequence}`,
      runtime: { installedVersion: '5.1.40', engineVersion: 'synthetic-test-runtime' },
    };
  };
}
