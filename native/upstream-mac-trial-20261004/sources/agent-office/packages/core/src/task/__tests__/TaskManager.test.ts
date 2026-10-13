import { TaskManager } from '../TaskManager';

describe('TaskManager', () => {
    it('should create and assign tasks', () => {
        const manager = new TaskManager();
        const task = manager.createTask({
            title: 'Fix issue',
            description: 'Test task',
            type: 'coding',
            priority: 'high',
            estimatedDuration: 30,
            requiredSkills: [],
            dependencies: []
        });

        expect(task.id).toBeDefined();
        expect(task.status).toBe('pending');

        manager.assignTask(task.id, 'agent-1');
        const queue = manager.getAgentQueue('agent-1');
        expect(queue.length).toBe(1);
        expect(queue[0].status).toBe('in_progress');
    });
});
