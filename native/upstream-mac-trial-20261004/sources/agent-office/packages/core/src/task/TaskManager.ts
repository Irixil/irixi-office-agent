export interface Deliverable {
    type: string;
    url?: string;
    content?: string;
}

export interface Task {
    id: string;
    title: string;
    description: string;
    type: 'coding' | 'writing' | 'research' | 'meeting' | 'review' | 'custom';
    priority: 'low' | 'medium' | 'high' | 'urgent';
    estimatedDuration: number;   // minutes
    requiredSkills: string[];
    dependencies: string[];      // Task IDs
    creator?: string;            // Agent ID
    assignee?: string;           // Agent ID
    status: 'pending' | 'in_progress' | 'blocked' | 'completed';
    deliverable?: Deliverable;
}

export class TaskManager {
    private tasks: Map<string, Task> = new Map();

    private generateId(): string {
        return Math.random().toString(36).substring(2, 9);
    }

    public createTask(task: Omit<Task, 'id' | 'status'>): Task {
        const newTask: Task = {
            ...task,
            id: this.generateId(),
            status: 'pending',
        };
        this.tasks.set(newTask.id, newTask);
        return newTask;
    }

    public assignTask(taskId: string, agentId: string): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.assignee = agentId;
            if (task.status === 'pending') {
                task.status = 'in_progress';
            }
        }
    }

    public getAgentQueue(agentId: string): Task[] {
        return Array.from(this.tasks.values())
            .filter(t => t.assignee === agentId)
            .sort((a, b) => {
                const priorityOrder = { urgent: 3, high: 2, medium: 1, low: 0 };
                return priorityOrder[b.priority] - priorityOrder[a.priority];
            });
    }

    public updateTaskStatus(taskId: string, status: Task['status']): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = status;
        }
    }

    public getTask(taskId: string): Task | undefined {
        return this.tasks.get(taskId);
    }

    public async evaluateCompletion(taskId: string): Promise<boolean> {
        const task = this.tasks.get(taskId);
        if (!task) return false;

        // Abstract hook for future LLM-based evaluation
        return task.status === 'completed';
    }
}
