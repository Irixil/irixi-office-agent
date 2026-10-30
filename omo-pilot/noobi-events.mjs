// Keep durable facts, not internal token streams or echoed user instructions.
// Completed role replies are independently emitted by GameHarness events.
export function noobiNotificationFacts(notification) {
  const method = notification.method || '', item = notification.params?.item;
  const internal = ['agentMessage', 'userMessage', 'reasoning'].includes(item?.type)
    || /^item\/(?:agentMessage|userMessage|reasoning)\//u.test(method)
    || /(?:\/delta|Delta)$/u.test(method)
    || method === 'item/fileChange/patchUpdated';
  const generatedImage = method === 'item/completed' && item?.type === 'imageGeneration'
    && item.status === 'completed' && item.savedPath ? item : null;
  return { persistProgress: !internal, generatedImage };
}
