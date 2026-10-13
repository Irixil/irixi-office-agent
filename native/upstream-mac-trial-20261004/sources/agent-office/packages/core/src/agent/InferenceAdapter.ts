import { ToolDefinition } from './AgentConfig';

export interface LLMMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface ToolCall {
    name: string;
    params: any;
}

export interface CompletionRequest {
    model: string;
    messages: LLMMessage[];
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
}

export interface CompletionResponse {
    content: string;
    toolCalls?: ToolCall[];
    usage: { prompt: number; completion: number };
    latency: number;
}

export interface InferenceAdapter {
    readonly provider: string;
    readonly isLocal: boolean;

    complete(request: CompletionRequest): Promise<CompletionResponse>;
    stream?(request: CompletionRequest): AsyncIterable<string>;
    embed?(text: string): Promise<number[]>;
    listModels?(): Promise<string[]>;
}
