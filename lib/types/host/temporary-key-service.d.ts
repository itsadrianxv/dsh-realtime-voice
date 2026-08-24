export interface TemporaryKey {
    token: string;
    /** Unix timestamp in seconds, matching the DashScope API. */
    expiresAt: number;
}
export type TemporaryKeyFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
/** Safe provider error that never contains either permanent or temporary credentials. */
export declare class TemporaryKeyIssueError extends Error {
    readonly status?: number | undefined;
    readonly providerCode?: string | undefined;
    readonly requestId?: string | undefined;
    constructor(message: string, status?: number | undefined, providerCode?: string | undefined, requestId?: string | undefined);
}
/** Server-side JIT issuer. The permanent API key never leaves this call. */
export declare class TemporaryKeyService {
    private readonly fetchImpl;
    private readonly now;
    constructor(fetchImpl?: TemporaryKeyFetch, now?: () => number);
    issue(endpoint: string, permanentApiKey: string, ttlSeconds: number, timeoutMs: number): Promise<TemporaryKey>;
}
