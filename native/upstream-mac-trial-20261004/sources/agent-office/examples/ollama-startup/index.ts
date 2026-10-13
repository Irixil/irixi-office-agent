/**
 * 🏢 AgentOffice — Ollama Startup Example
 *
 * A minimal virtual office with 2 AI agents powered by a local Ollama model.
 * This example shows how to configure agents, set up the office, and
 * connect everything to the Colyseus server.
 *
 * Usage:
 *   1. Make sure Ollama is running: ollama serve
 *   2. Pull a model: ollama pull llama3.2
 *   3. From the repo root: npm run build
 *   4. Run: npx ts-node examples/ollama-startup/index.ts
 */

import { Agent, Office, OfficeConfig } from '@agent-office/core';
import { OllamaAdapter } from '@agent-office/adapters';

// ─── Office Configuration ───
const officeConfig: OfficeConfig = {
    name: 'Local Startup HQ',
    grid: { width: 40, height: 40, tileSize: 16 },
    rooms: [
        { id: 'engineering', name: 'Engineering Bay', bounds: { x: 0, y: 0, width: 20, height: 20 }, type: 'workspace', capacity: 4, ambientNoise: 0.3, lighting: 0.8 },
        { id: 'social', name: 'Coffee & Social', bounds: { x: 20, y: 20, width: 20, height: 20 }, type: 'social', capacity: 6, ambientNoise: 0.6, lighting: 0.9 },
    ],
    furniture: [
        { id: 'desk-alice', type: 'desk', x: 5, y: 18, interactionPoint: { x: 4, y: 18 } },
        { id: 'desk-bob', type: 'desk', x: 5, y: 23, interactionPoint: { x: 4, y: 23 } },
        { id: 'coffee', type: 'appliance', x: 25, y: 25, interactionPoint: { x: 24, y: 25 } },
        { id: 'whiteboard', type: 'board', x: 17, y: 3, interactionPoint: { x: 16, y: 3 } },
    ],
    spawnPoints: [{ x: 20, y: 2 }],  // Office door
    zones: []
};

const office = new Office(officeConfig);

// ─── LLM Adapter ───
const ollama = new OllamaAdapter('http://localhost:11434');

// ─── Agent: Alice (Engineer) ───
const alice = new Agent({
    id: 'alice',
    name: 'Alice',
    role: 'Senior Engineer',
    avatar: 'char_0.png',
    inference: {
        provider: 'ollama',
        model: 'llama3.2:latest',
        systemPrompt: `You are Alice, a senior engineer at a small startup. You love clean code, write TypeScript, and mentor junior developers. You're direct but kind. Keep thoughts SHORT.`,
    },
    personality: {
        traits: {
            openness: 0.7,
            conscientiousness: 0.95,
            extraversion: 0.5,
            agreeableness: 0.7,
            neuroticism: 0.1
        },
        communicationStyle: 'technical',
        workHours: { start: '09:00', end: '17:00' },
        breakFrequency: 120
    },
    capabilities: [
        { name: 'code_execute', description: 'Execute JavaScript/TypeScript code' },
        { name: 'web_search', description: 'Search the web for documentation' },
        { name: 'write_note', description: 'Write technical notes' },
        { name: 'create_task', description: 'Create and assign engineering tasks' },
        { name: 'hire_agent', description: 'Hire a new team member' }
    ],
    memory: { shortTermLimit: 50 }
});

// ─── Agent: Bob (Product Manager) ───
const bob = new Agent({
    id: 'bob',
    name: 'Bob',
    role: 'Product Manager',
    avatar: 'char_1.png',
    inference: {
        provider: 'ollama',
        model: 'llama3.2:latest',
        systemPrompt: `You are Bob, a product manager at a small startup. You focus on user needs, prioritize features, and keep the team aligned. You're enthusiastic and organized. Keep thoughts SHORT.`,
    },
    personality: {
        traits: {
            openness: 0.8,
            conscientiousness: 0.85,
            extraversion: 0.9,
            agreeableness: 0.85,
            neuroticism: 0.2
        },
        communicationStyle: 'casual',
        workHours: { start: '09:00', end: '17:00' },
        breakFrequency: 90
    },
    capabilities: [
        { name: 'web_search', description: 'Research competitors and user feedback' },
        { name: 'write_note', description: 'Write product specs and PRDs' },
        { name: 'create_task', description: 'Create and prioritize product tasks' },
        { name: 'hire_agent', description: 'Hire a new team member' }
    ],
    memory: { shortTermLimit: 50 }
});

// ─── Connect & Run ───
alice.setInferenceAdapter(ollama);
bob.setInferenceAdapter(ollama);

async function main() {
    await alice.initialize();
    await bob.initialize();

    console.log(`\n🏢 ${office.config.name}`);
    console.log(`   Agents: ${alice.config.name} (${alice.config.role}), ${bob.config.name} (${bob.config.role})`);
    console.log(`   Model: llama3.2:latest via Ollama`);
    console.log(`   Grid: ${officeConfig.grid.width}x${officeConfig.grid.height} tiles\n`);
    console.log(`To run the full visual simulation, start the server and UI:`);
    console.log(`   npm run start --workspace=@agent-office/server`);
    console.log(`   npm run dev --workspace=@agent-office/ui\n`);

    // Demo: run a single think cycle for each agent
    console.log('─── Demo: Single Think Cycle ───\n');

    const aliceDecision = await alice.think({
        time: new Date().toISOString(),
        location: '5,18',
        nearbyAgents: [{ name: 'Bob', role: 'Product Manager', distance: 5 }],
        currentTask: 'Build the authentication module',
        recentMessages: [],
        memories: ['Started working on the auth module yesterday']
    });
    console.log(`Alice thinks: "${aliceDecision.thought}"`);
    console.log(`Alice action: ${aliceDecision.action}\n`);

    const bobDecision = await bob.think({
        time: new Date().toISOString(),
        location: '20,15',
        nearbyAgents: [{ name: 'Alice', role: 'Engineer', distance: 5 }],
        currentTask: 'Write product requirements for v2',
        recentMessages: [],
        memories: ['Need to align with Alice on auth module timeline']
    });
    console.log(`Bob thinks: "${bobDecision.thought}"`);
    console.log(`Bob action: ${bobDecision.action}\n`);
}

main().catch(console.error);
