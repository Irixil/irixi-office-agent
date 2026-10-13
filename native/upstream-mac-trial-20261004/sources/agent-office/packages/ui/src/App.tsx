import React from 'react';
import { ChatPanel } from './components/ChatPanel';
import { TaskBoard } from './components/TaskBoard';
import { AgentInspector } from './components/AgentInspector';
import { LayoutEditor } from './components/LayoutEditor';
import { SystemLog } from './components/SystemLog';
import { ViralControlPanel } from './components/ViralControlPanel';
import { HighlightsFeed } from './components/HighlightsFeed';
import { AgentPulseBoard } from './components/AgentPulseBoard';
import { RelationshipGraph } from './components/RelationshipGraph';
import { EpisodeRecapPanel } from './components/EpisodeRecapPanel';

export function App() {
    const irixiEmbed = new URLSearchParams(window.location.search).get('irixiEmbed') === '1';
    if (irixiEmbed) {
        return <TaskBoard embedded />;
    }
    return (
        <>
            <div style={{ position: 'absolute', bottom: 20, left: 20, color: 'white', backgroundColor: 'rgba(10,10,30,0.85)', padding: '12px 16px', borderRadius: '10px', zIndex: 10, border: '1px solid rgba(108,92,231,0.3)' }}>
                <h1 style={{ margin: 0, fontSize: '18px', display: 'flex', alignItems: 'center', gap: 8 }}>🏢 AgentOffice</h1>
                <p data-adapted-mac-trial style={{ margin: '4px 0 0', color: '#fdcb6e', fontSize: '11px', fontWeight: 700 }}>ADAPTED MAC TEST · AI DISABLED</p>
                <p style={{ margin: '4px 0 0', opacity: 0.7, fontSize: '11px' }}>UI, layout, and task persistence only</p>
            </div>
            <ChatPanel />
            <TaskBoard />
            <AgentInspector agent={{ name: 'Alice', role: 'Engineer', status: 'Idle', currentTask: 'Write Scaffold' }} />
            <LayoutEditor />
            <SystemLog />
            <ViralControlPanel />
            <RelationshipGraph />
            <HighlightsFeed />
            <AgentPulseBoard />
            <EpisodeRecapPanel />
        </>
    );
}
