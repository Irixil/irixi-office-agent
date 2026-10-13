/**
 * 🏢 AgentOffice — OpenAI Agency Example
 *
 * A premium AI agency office using OpenAI's GPT-4o-mini for inference.
 * Demonstrates how to use the OpenAICompatibleAdapter with API keys.
 *
 * This same adapter works with any OpenAI-compatible endpoint:
 * - OpenAI (api.openai.com)
 * - OpenRouter (openrouter.ai)
 * - Gaia (gaia.domains)
 * - Together AI (api.together.xyz)
 * - Any local server with /v1/chat/completions
 *
 * Usage:
 *   1. Set your API key: export OPENAI_API_KEY=sk-...
 *   2. From the repo root: npm run build
 *   3. Run: npx ts-node examples/openai-agency/index.ts
 */

import { Agent, Office, OfficeConfig } from '@agent-office/core';
import { OpenAICompatibleAdapter } from '@agent-office/adapters';

// ─── OpenAI Adapter ───
const openai = new OpenAICompatibleAdapter(
    'https://api.openai.com/v1',
    process.env.OPENAI_API_KEY || 'sk-your-key-here',
    'openai'
);

// ─── Office Configuration ───
const officeConfig: OfficeConfig = {
    name: 'Premium AI Agency',
    grid: { width: 50, height: 50, tileSize: 16 },
    rooms: [
        { id: 'strategy', name: 'Strategy Room', bounds: { x: 0, y: 0, width: 25, height: 25 }, type: 'meeting', capacity: 6, ambientNoise: 0.2, lighting: 0.9 },
        { id: 'creative', name: 'Creative Studio', bounds: { x: 25, y: 0, width: 25, height: 25 }, type: 'workspace', capacity: 4, ambientNoise: 0.4, lighting: 0.8 },
        { id: 'lounge', name: 'Executive Lounge', bounds: { x: 0, y: 25, width: 50, height: 25 }, type: 'social', capacity: 10, ambientNoise: 0.5, lighting: 0.7 },
    ],
    furniture: [],
    spawnPoints: [{ x: 25, y: 2 }],
    zones: []
};

const office = new Office(officeConfig);

// ─── Agent: Sarah (Creative Director) ───
const sarah = new Agent({
    id: 'sarah',
    name: 'Sarah',
    role: 'Creative Director',
    avatar: 'sarah.png',
    inference: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        systemPrompt: `You are Sarah, a Creative Director at a premium AI agency. You lead the creative vision, design campaigns, and inspire the team. You think in visual metaphors and love bold ideas. Keep thoughts SHORT.`,
    },
    personality: {
        traits: { openness: 1.0, conscientiousness: 0.7, extraversion: 0.8, agreeableness: 0.8, neuroticism: 0.2 },
        communicationStyle: 'creative',
        workHours: { start: '10:00', end: '19:00' },
        breakFrequency: 60
    },
    capabilities: [
        { name: 'web_search', description: 'Research design trends and inspiration' },
        { name: 'write_note', description: 'Write creative briefs' },
        { name: 'create_task', description: 'Assign creative tasks to the team' },
        { name: 'hire_agent', description: 'Hire designers, copywriters, and strategists' }
    ],
    memory: { shortTermLimit: 50 }
});

// ─── Agent: Marcus (Account Executive) ───
const marcus = new Agent({
    id: 'marcus',
    name: 'Marcus',
    role: 'Account Executive',
    avatar: 'marcus.png',
    inference: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        systemPrompt: `You are Marcus, an Account Executive at a premium AI agency. You manage client relationships, pitch new business, and ensure deliverables meet expectations. You're persuasive and detail-oriented. Keep thoughts SHORT.`,
    },
    personality: {
        traits: { openness: 0.6, conscientiousness: 0.95, extraversion: 0.95, agreeableness: 0.7, neuroticism: 0.15 },
        communicationStyle: 'formal',
        workHours: { start: '08:00', end: '18:00' },
        breakFrequency: 150
    },
    capabilities: [
        { name: 'web_search', description: 'Research potential clients and industries' },
        { name: 'write_note', description: 'Write proposals and client reports' },
        { name: 'create_task', description: 'Create client deliverable tasks' },
        { name: 'hire_agent', description: 'Hire account managers and strategists' }
    ],
    memory: { shortTermLimit: 50 }
});

// ─── Agent: Priya (Data Analyst) ───
const priya = new Agent({
    id: 'priya',
    name: 'Priya',
    role: 'Data Analyst',
    avatar: 'priya.png',
    inference: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        systemPrompt: `You are Priya, a Data Analyst at a premium AI agency. You analyze campaign performance, build dashboards, and provide insights that drive strategy. You love numbers and data-driven decisions. Keep thoughts SHORT.`,
    },
    personality: {
        traits: { openness: 0.7, conscientiousness: 1.0, extraversion: 0.4, agreeableness: 0.8, neuroticism: 0.1 },
        communicationStyle: 'technical',
        workHours: { start: '09:00', end: '17:00' },
        breakFrequency: 120
    },
    capabilities: [
        { name: 'code_execute', description: 'Run data analysis scripts' },
        { name: 'web_search', description: 'Research industry benchmarks' },
        { name: 'write_note', description: 'Write analysis reports' },
        { name: 'create_task', description: 'Create data-related tasks' }
    ],
    memory: { shortTermLimit: 50 }
});

// ─── Connect & Run ───
sarah.setInferenceAdapter(openai);
marcus.setInferenceAdapter(openai);
priya.setInferenceAdapter(openai);

async function main() {
    await sarah.initialize();
    await marcus.initialize();
    await priya.initialize();

    console.log(`\n🏢 ${office.config.name}`);
    console.log(`   Agents: Sarah (Creative), Marcus (Accounts), Priya (Data)`);
    console.log(`   Model: gpt-4o-mini via OpenAI API`);
    console.log(`   Grid: ${officeConfig.grid.width}x${officeConfig.grid.height} tiles\n`);

    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'sk-your-key-here') {
        console.log('⚠️  Set OPENAI_API_KEY to run the think cycle demo.');
        console.log('   export OPENAI_API_KEY=sk-...\n');
        return;
    }

    console.log('─── Demo: Single Think Cycle ───\n');

    const sarahDecision = await sarah.think({
        time: new Date().toISOString(),
        location: '10,10',
        nearbyAgents: [
            { name: 'Marcus', role: 'Account Executive', distance: 5 },
            { name: 'Priya', role: 'Data Analyst', distance: 8 }
        ],
        currentTask: 'Design the Q2 brand campaign',
        recentMessages: [],
        memories: ['Client wants a bold, modern direction for Q2']
    });
    console.log(`Sarah thinks: "${sarahDecision.thought}"`);
    console.log(`Sarah action: ${sarahDecision.action}\n`);
}

main().catch(console.error);
