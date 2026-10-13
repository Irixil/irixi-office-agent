export interface ToolDefinition {
    name: string;
    description: string;
    parameters: any; // Can be detailed JSONSchema later
}

export interface InferenceConfig {
    provider: 'ollama' | 'openai' | 'gaia' | 'anthropic' | 'custom';
    model: string;
    baseUrl?: string;
    apiKey?: string;
    temperature?: number;
    maxTokens?: number;
    systemPrompt: string;
    tools?: ToolDefinition[];
}

export interface PersonalityConfig {
    traits: {
        openness: number;          // 0-1
        conscientiousness: number;
        extraversion: number;
        agreeableness: number;
        neuroticism: number;
    };
    communicationStyle: 'formal' | 'casual' | 'technical' | 'creative';
    workHours: { start: string; end: string };
    breakFrequency: number;      // minutes
}

export interface Capability {
    name: string;
    description: string;
}

export interface MemoryConfig {
    shortTermLimit?: number;
}

export interface AgentConfig {
    id: string;
    name: string;
    role: string;
    avatar: string;              // Sprite sheet reference
    inference: InferenceConfig;
    personality: PersonalityConfig;
    capabilities: Capability[];
    memory: MemoryConfig;
}
