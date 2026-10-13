# How to Create a New Scene

The office view uses a pluggable `SceneAdapter` interface. You can swap the pixel-art canvas for any rendering approach (3D, isometric, list view, etc.) by implementing 2 things:

1. A **SceneAdapter** class (6 methods)
2. A **React component** that creates the adapter

---

## Step 1: Implement SceneAdapter

```typescript
// scene/MySceneAdapter.ts
import type { SceneAdapter, AgentInfo, BubbleType } from "./SceneAdapter";
import type { AgentStatus } from "@office/shared";

export class MySceneAdapter implements SceneAdapter {
  addAgent(agentId: string, info: AgentInfo) {
    // Agent joined — render them using info.name, info.label, info.labelColor
    // info.palette is optional (pixel-specific), ignore if not needed
  }

  removeAgent(agentId: string) {
    // Agent left — remove from scene
  }

  updateAgent(agentId: string, status: AgentStatus, bubble: BubbleType | null) {
    // status: "idle" | "working" | "waiting_approval" | "done" | "error"
    // bubble: "permission" | "working" | "waiting" | null
  }

  showSpeechBubble(agentId: string, text: string) {
    // Show a temporary speech bubble with the agent's latest message
  }

  selectAgent(agentId: string | null) {
    // Highlight the selected agent (null = deselect)
  }

  dispose() {
    // Cleanup: stop loops, remove listeners, free resources
  }
}
```

## Step 2: Create the Scene Component

```tsx
// scene/MyScene.tsx
import type { SceneComponentProps } from "./SceneAdapter";
import { MySceneAdapter } from "./MySceneAdapter";

export default function MyScene({ onAdapterReady, onAgentClick }: SceneComponentProps) {
  useEffect(() => {
    const adapter = new MySceneAdapter(/* ... */);
    onAdapterReady(adapter);
    return () => adapter.dispose();
  }, []);

  return <div onClick={(e) => {
    const agentId = /* hit-test logic */;
    if (agentId) onAgentClick(agentId);
  }}>
    {/* your scene rendering */}
  </div>;
}
```

## Step 3: Swap in page.tsx

```tsx
// In apps/web/src/app/office/page.tsx, change the dynamic import:
const MyScene = dynamic(() => import("@/components/office/scene/MyScene"), { ssr: false });

// Then in the JSX:
<MyScene
  onAdapterReady={handleAdapterReady}
  onAgentClick={handleAgentClick}
/>
```

That's it. The `useSceneBridge` hook in page.tsx automatically syncs store state to your adapter.

---

## What Happens Automatically

You do NOT need to handle any of this — `useSceneBridge` does it for you:

- Seeding existing agents on mount
- Subscribing to Zustand store changes
- Calling `addAgent` / `removeAgent` when agents join/leave
- Calling `updateAgent` with the correct status and bubble type
- Calling `showSpeechBubble` for new messages, log output, and team chat
- Calling `selectAgent` when the user selects an agent in the sidebar

## Editor Mode

The tile editor (furniture placement, floor painting) is pixel-specific and lives in `PixelOfficeScene`. Non-pixel scenes don't need an editor — it's automatically hidden when `officeStateRef.current` is null.

## File Structure

```
scene/
  SceneAdapter.ts         ← Interface (AgentInfo, BubbleType, SceneAdapter, SceneComponentProps)
  useSceneBridge.ts       ← Store→adapter sync hook (used by page.tsx, not by scenes)
  PixelSceneAdapter.ts    ← Reference implementation wrapping OfficeState
  PixelOfficeScene.tsx    ← Reference implementation (pixel-art canvas)
  README.md               ← This file
```
