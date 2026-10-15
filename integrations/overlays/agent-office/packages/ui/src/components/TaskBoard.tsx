import React, { useState, useEffect } from 'react';
import { getColyseusRoom } from '../game/Game';

interface TaskItem {
    id: number;
    title: string;
    assigned_to: string;
    status: string;
}

interface IrixiTaskItem {
    taskId: string;
    title: string;
    goalStatement: string;
    goalVersionId: string;
    executionId: string | null;
    artifactId: string | null;
    artifactVersion: number | null;
    candidateSha256: string | null;
    diffSha256: string | null;
    status: string;
    statusLabel: string;
    nextStep: string;
    actor: string | null;
    scopeOutcome: string | null;
    confirmed: boolean;
    current: boolean;
    nativeTaskUrl?: string | null;
    nativeStateCurrent?: boolean;
    productRegistrySha256?: string | null;
}

export function TaskBoard({ embedded = false }: { embedded?: boolean }) {
    const [tasks, setTasks] = useState<TaskItem[]>([]);
    const [newTask, setNewTask] = useState('');
    const [targetAgent, setTargetAgent] = useState('auto');
    const [irixiTasks, setIrixiTasks] = useState<IrixiTaskItem[] | null>(null);

    useEffect(() => {
        const checkRoom = setInterval(() => {
            const room = getColyseusRoom();
            if (room) {
                room.onMessage('task-update', (data: any) => {
                    setTasks(prev => {
                        const existing = prev.find(t => t.title === data.task);
                        if (existing) {
                            return prev.map(t => t.title === data.task ? { ...t, status: data.status, assigned_to: data.agentId } : t);
                        }
                        return [...prev, { id: Date.now(), title: data.task, assigned_to: data.agentId, status: data.status }];
                    });
                });
                room.onMessage('tasks-sync', (serverTasks: any[]) => {
                    setTasks(serverTasks.map(t => ({
                        id: t.id,
                        title: t.title,
                        assigned_to: t.assigned_to || '',
                        status: t.status
                    })));
                });
                room.onMessage('irixi-task-sync', (payload: { tasks?: IrixiTaskItem[] }) => {
                    setIrixiTasks(Array.isArray(payload?.tasks) ? payload.tasks : []);
                });
                room.send('request-tasks-sync');
                room.send('request-irixi-sync');
                clearInterval(checkRoom);
            }
        }, 500);
        return () => clearInterval(checkRoom);
    }, []);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!newTask.trim()) return;
        const room = getColyseusRoom();
        if (room) {
            room.send('assign-task', { title: newTask, agentId: targetAgent === 'auto' ? undefined : targetAgent });
            setNewTask('');
        }
    };

    const statusColor = (s: string) => {
        if (s === 'completed') return '#00b894';
        if (s === 'in_progress') return '#fdcb6e';
        return '#dfe6e9';
    };

    const statusIcon = (s: string) => {
        if (s === 'completed') return '✅';
        if (s === 'in_progress') return '🔄';
        return '⏳';
    };

    return (
        <div style={{
            position: 'absolute', left: embedded ? 8 : 20, top: embedded ? 8 : 20,
            width: embedded ? 'min(320px, calc(100vw - 16px))' : 280,
            backgroundColor: 'rgba(10,10,30,0.92)', color: 'white',
            padding: embedded ? 12 : 16, borderRadius: 12,
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(108,92,231,0.3)',
            maxHeight: embedded ? 'calc(100vh - 16px)' : '50vh', display: 'flex', flexDirection: 'column',
            boxSizing: 'border-box'
        }}>
            <h3 style={{ margin: '0 0 10px 0', fontSize: '14px', display: 'flex', alignItems: 'center', gap: 6 }}>
                📋 Task Board
            </h3>

            {/* The Irixi slice is read-only here; ordinary Agent Office keeps its existing form. */}
            {!embedded && irixiTasks === null && <form onSubmit={handleSubmit} style={{ marginBottom: 10 }}>
                <input
                    type="text"
                    value={newTask}
                    onChange={(e) => setNewTask(e.target.value)}
                    placeholder="Assign a task..."
                    style={{
                        width: '100%', padding: '8px 10px', borderRadius: 6,
                        border: '1px solid #444', backgroundColor: '#1a1a3e',
                        color: 'white', fontSize: '12px', outline: 'none',
                        boxSizing: 'border-box', marginBottom: 6
                    }}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                    <select
                        value={targetAgent}
                        onChange={(e) => setTargetAgent(e.target.value)}
                        style={{
                            flex: 1, padding: '6px', borderRadius: 6,
                            border: '1px solid #444', backgroundColor: '#1a1a3e',
                            color: '#aaa', fontSize: '11px'
                        }}
                    >
                        <option value="auto">🤖 Auto-assign</option>
                        <option value="alice">Alice (Engineer)</option>
                        <option value="bob">Bob (PM)</option>
                    </select>
                    <button type="submit" style={{
                        padding: '6px 14px', borderRadius: 6, border: 'none',
                        backgroundColor: '#6c5ce7', color: 'white', fontSize: '11px',
                        cursor: 'pointer', fontWeight: 'bold'
                    }}>
                        Assign
                    </button>
                </div>
            </form>}

            {/* Task List */}
            <div style={{ flex: 1, overflowY: 'auto', fontSize: '12px' }}>
                {irixiTasks !== null && irixiTasks.map(task => (
                    <div key={`${task.taskId}:${task.goalVersionId}`} data-irixi-task={task.taskId} style={{
                        padding: '8px', marginBottom: 6, borderRadius: 6,
                        backgroundColor: 'rgba(108,92,231,0.10)',
                        borderLeft: `3px solid ${statusColor(task.status)}`
                    }}>
                        <div style={{ fontWeight: 'bold', fontSize: '11px' }}>
                            {statusIcon(task.status)} {task.title}
                        </div>
                        <div style={{ fontSize: '11px', color: '#ddd', marginTop: 4 }}>{task.goalStatement}</div>
                        <div style={{ fontSize: '11px', color: '#bbb', marginTop: 4 }}>{task.statusLabel}</div>
                        <div style={{ fontSize: '10px', color: '#999', marginTop: 2 }}>下一步：{task.nextStep}</div>
                        <div style={{ fontSize: '10px', color: '#aaa', marginTop: 3 }}>
                            goal {task.goalVersionId.slice(0, 12)} · execution {task.executionId?.slice(0, 12) || 'not started'}
                        </div>
                        <div style={{ fontSize: '10px', color: '#888', marginTop: 2 }}>
                            actor {task.actor || 'idle'} · version {task.artifactVersion ?? '—'} · {task.confirmed ? 'confirmed for delivery' : 'not confirmed'}
                        </div>
                        {task.scopeOutcome && <div style={{ fontSize: '10px', color: '#888', marginTop: 2 }}>
                            scope outcome: {task.scopeOutcome}
                        </div>}
                        {task.nativeTaskUrl && task.nativeStateCurrent && <a
                            href={task.nativeTaskUrl}
                            target="_blank"
                            rel="noreferrer"
                            data-native-task-link={task.taskId}
                            style={{ display: 'inline-block', marginTop: 7, color: '#74b9ff', fontSize: '11px', fontWeight: 700 }}
                        >
                            打开原生任务{task.artifactId ? '与成果' : ''} ↗
                        </a>}
                    </div>
                ))}
                {irixiTasks === null && tasks.length === 0 && (
                    <p style={{ color: '#666', fontStyle: 'italic', margin: 0, fontSize: '11px' }}>
                        {embedded ? '正在读取当前 Irixi 项目状态…' : 'No tasks yet. Entries are saved as pending; AI execution is disabled.'}
                    </p>
                )}
                {!embedded && irixiTasks === null && tasks.map(task => (
                    <div key={task.id} style={{
                        padding: '6px 8px', marginBottom: 4, borderRadius: 6,
                        backgroundColor: 'rgba(255,255,255,0.05)',
                        borderLeft: `3px solid ${statusColor(task.status)}`
                    }}>
                        <div style={{ fontWeight: 'bold', fontSize: '11px' }}>
                            {statusIcon(task.status)} {task.title}
                        </div>
                        <div style={{ fontSize: '10px', color: '#888', marginTop: 2 }}>
                            → {task.assigned_to || 'Unassigned'}
                        </div>
                    </div>
                ))}
            </div>

            <div style={{ marginTop: 8, fontSize: '10px', color: '#555', borderTop: '1px solid #333', paddingTop: 6 }}>
                {irixiTasks === null && !embedded
                    ? '⏸ AI disabled • 💾 SQLite persistence • Tasks stay pending'
                    : '👁 Read-only Irixi projection • no Ollama inference • authority remains in Irixi'}
            </div>
        </div>
    );
}
