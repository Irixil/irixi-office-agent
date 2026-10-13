export interface Memory {
    id: string;
    agentId: string;
    type: 'conversation' | 'action' | 'achievement' | 'relationship';
    content: string;
    embedding?: number[];        // For semantic search
    timestamp: Date;
    importance: number;          // 0-1, for retention
    associations: string[];      // Related memory IDs
}

export class MemoryManager {
    private shortTerm: Memory[] = [];

    constructor() { }

    private generateId(): string {
        return Math.random().toString(36).substring(2, 9);
    }

    async add(memory: Omit<Memory, 'id'>): Promise<void> {
        const newMemory: Memory = { ...memory, id: this.generateId() };
        this.shortTerm.push(newMemory);

        if (this.shortTerm.length > 50) {
            this.shortTerm.shift(); // Evict oldest
        }

        // In a full implementation, we would persist this to an SQLite Database
    }

    async recall(query: string, limit: number = 5): Promise<Memory[]> {
        // Naive text match recall for scaffold phase
        // A robust system uses vector embeddings
        return this.shortTerm
            .filter(m => m.content.toLowerCase().includes(query.toLowerCase()))
            .slice(0, limit);
    }

    async recallRecent(limit: number): Promise<Memory[]> {
        return this.shortTerm.slice(Math.max(this.shortTerm.length - limit, 0));
    }

    async consolidate(): Promise<void> {
        // Summarize old memories using LLM and store as condensed memory
    }
}
