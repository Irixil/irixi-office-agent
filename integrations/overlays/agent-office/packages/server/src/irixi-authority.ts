export type IrixiTaskBoardItem = {
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
    authoritySha256: string;
    pipelineBindingSha256: string;
    nativeTaskUrl?: string | null;
    nativeStateCurrent?: boolean;
    productRegistrySha256?: string | null;
    nativeCapabilities?: Record<string, unknown> | null;
    team?: { agents: Array<{ id: string; name: string; role?: string; actor?: string; stationRole?: string; status: string }> };
    workItems?: Array<{ id: string; agentId: string; title: string; status: string }>;
};

export function irixiProjectionRefreshKey(task: IrixiTaskBoardItem): string {
    return JSON.stringify([
        task.taskId,
        task.goalVersionId,
        task.executionId,
        task.artifactId,
        task.artifactVersion,
        task.candidateSha256,
        task.diffSha256,
        task.status,
        task.actor,
        task.scopeOutcome,
        task.confirmed,
        task.current,
        task.authoritySha256,
        task.pipelineBindingSha256,
        task.nativeTaskUrl,
        task.nativeStateCurrent,
        task.productRegistrySha256,
        task.team,
        task.workItems,
    ]);
}

export function createIrixiAuthorityProjection() {
    const rawUrl = process.env.AGENT_OFFICE_IRIXI_AUTHORITY_URL?.trim();
    const taskId = process.env.AGENT_OFFICE_IRIXI_TASK_ID?.trim();
    if (!rawUrl && !taskId) return null;
    if (!rawUrl || !taskId || process.env.AGENT_OFFICE_ZERO_MODEL !== '1') {
        throw new Error('Agent Office Irixi projection requires zero-model mode, URL, and task ID');
    }
    let endpoint: URL;
    try { endpoint = new URL(rawUrl); }
    catch { throw new Error('Agent Office authority must use an explicit HTTP loopback origin on a non-privileged port'); }
    const port = Number(endpoint.port);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
        || !Number.isInteger(port) || port < 1024 || port > 65535
        || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
        || endpoint.href !== rawUrl) {
        throw new Error('Agent Office authority must use an explicit HTTP loopback origin on a non-privileged port');
    }
    const rawOpenOfficeUrl = process.env.AGENT_OFFICE_OPENOFFICE_URL?.trim();
    const openOfficeEndpoint = rawOpenOfficeUrl ? new URL(rawOpenOfficeUrl) : null;
    if (openOfficeEndpoint && (openOfficeEndpoint.protocol !== 'http:' || openOfficeEndpoint.hostname !== '127.0.0.1' || openOfficeEndpoint.pathname !== '/')) {
        throw new Error('Agent Office native state must use a loopback OpenOffice root URL');
    }
    return {
        taskId,
        async read(): Promise<IrixiTaskBoardItem> {
            const response = await fetch(new URL(`/v1/task-board?taskId=${encodeURIComponent(taskId)}`, endpoint), {
                signal: AbortSignal.timeout(3_000), headers: { accept: 'application/json' }
            });
            if (!response.ok) throw new Error(`Irixi task projection unavailable (${response.status})`);
            const value = await response.json() as IrixiTaskBoardItem;
            if (value.taskId !== taskId || typeof value.current !== 'boolean'
                || !/^[a-f0-9]{64}$/.test(value.authoritySha256)
                || !/^[a-f0-9]{64}$/.test(value.pipelineBindingSha256)) {
                throw new Error('Irixi task projection is stale or malformed');
            }
            if (!openOfficeEndpoint) return value;
            const nativeResponse = await fetch(new URL('/api/product-state', openOfficeEndpoint), {
                signal: AbortSignal.timeout(3_000), headers: { accept: 'application/json' }
            });
            if (!nativeResponse.ok) throw new Error(`OpenOffice native state unavailable (${nativeResponse.status})`);
            const native = await nativeResponse.json() as any;
            if (native.taskId !== value.taskId || native.goalVersionId !== value.goalVersionId
                || !native.product || !/^[a-f0-9]{64}$/.test(native.product.registrySha256)) {
                throw new Error('OpenOffice native state is not bound to the current Irixi task');
            }
            return {
                ...value,
                nativeTaskUrl: new URL(String(native.links?.nativeTask || '/'), openOfficeEndpoint).href,
                nativeStateCurrent: Boolean(native.current && native.product.bindingCurrent),
                productRegistrySha256: native.product.registrySha256,
                nativeCapabilities: native.product.capabilities || null,
            };
        }
    };
}
