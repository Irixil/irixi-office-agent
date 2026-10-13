import { PromptBuilder } from '../PromptBuilder';
import { AgentConfig } from '@agent-office/core';

describe('PromptBuilder', () => {
    it('should build a valid prompt string', () => {
        const config: AgentConfig = {
            id: '1',
            name: 'Alice',
            role: 'Engineer',
            avatar: 'alice.png',
            inference: {
                provider: 'ollama',
                model: 'llama3.2:latest',
                systemPrompt: '',
                tools: []
            },
            personality: {
                traits: { openness: 0.8, conscientiousness: 0.8, extraversion: 0.5, agreeableness: 0.7, neuroticism: 0.2 },
                communicationStyle: 'technical',
                workHours: { start: '09:00', end: '17:00' },
                breakFrequency: 60
            },
            capabilities: [{ name: 'Coding', description: 'Writes JS' }],
            memory: {}
        };

        const prompt = PromptBuilder.buildSystemPrompt(
            config,
            { name: 'Headquarters', time: '10:00 AM' },
            []
        );

        expect(prompt).toContain('Alice');
        expect(prompt).toContain('Engineer');
        expect(prompt).toContain('Headquarters');
        expect(prompt).toContain('Coding: Writes JS');
    });
});
