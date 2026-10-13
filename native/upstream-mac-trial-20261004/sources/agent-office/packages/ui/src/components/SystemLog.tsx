import React, { useState, useEffect, useRef } from 'react';
import { eventBus } from '../events';

interface LogEntry {
    id: number;
    agent: string;
    action: string;
    thought: string;
    time: string;
}

const actionIcons: Record<string, string> = {
    'work': '💻', 'talk': '💬', 'idle': '😌',
    'use_tool': '🔧', 'move': '🚶', 'think': '💡'
};

export function SystemLog() {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [isOpen, setIsOpen] = useState(true);
    const scrollRef = useRef<HTMLDivElement>(null);
    const idRef = useRef(0);

    const lastEntryPerAgent = useRef<Record<string, string>>({});

    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;

            // Deduplicate: skip if same agent + action + thought as last time
            const key = `${detail.agent}:${detail.action}:${detail.thought}`;
            if (lastEntryPerAgent.current[detail.agent] === key) return;
            lastEntryPerAgent.current[detail.agent] = key;

            setLogs(prev => {
                const newLog: LogEntry = { id: idRef.current++, ...detail };
                const updated = [...prev, newLog];
                return updated.slice(-30); // Keep last 30 entries
            });
        };
        eventBus.addEventListener('activity-log', handler);
        return () => eventBus.removeEventListener('activity-log', handler);
    }, []);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logs]);

    if (!isOpen) {
        return (
            <button
                onClick={() => setIsOpen(true)}
                style={{
                    position: 'absolute', right: 20, top: 20,
                    padding: '6px 12px', borderRadius: 8, border: 'none',
                    backgroundColor: '#2d3436', color: '#aaa',
                    cursor: 'pointer', fontSize: '11px', zIndex: 10
                }}
            >
                📊 Activity Log
            </button>
        );
    }

    return (
        <div style={{
            position: 'absolute', right: 20, top: 20, width: 260,
            backgroundColor: 'rgba(10,10,30,0.92)', color: 'white',
            padding: 12, borderRadius: 12,
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            border: '1px solid rgba(108,92,231,0.3)',
            maxHeight: '35vh', display: 'flex', flexDirection: 'column',
            zIndex: 10
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <h3 style={{ margin: 0, fontSize: '13px' }}>📊 System Activity Log</h3>
                <button onClick={() => setIsOpen(false)} style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: '14px' }}>✕</button>
            </div>

            <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', fontSize: '10px', lineHeight: 1.5 }}>
                {logs.length === 0 && (
                    <p style={{ color: '#555', fontStyle: 'italic', margin: 0 }}>Waiting for agent events...</p>
                )}
                {logs.map(log => (
                    <div key={log.id} style={{
                        padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.04)',
                        display: 'flex', gap: 4, alignItems: 'flex-start'
                    }}>
                        <span style={{ opacity: 0.4, minWidth: 48 }}>{log.time}</span>
                        <span>{actionIcons[log.action] || '•'}</span>
                        <span>
                            <strong style={{ color: log.agent === 'Alice' ? '#aaffaa' : '#3a86ff' }}>{log.agent}</strong>
                            {' '}
                            <span style={{ color: '#888' }}>{log.action}</span>
                            {log.thought && <span style={{ color: '#666', fontStyle: 'italic' }}> — "{log.thought.slice(0, 60)}"</span>}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
