export type AgentInvocationScope = 'records' | 'metadata' | 'solutionComponents';
import type { SearchResult } from './search';

export interface AgentInvocationInput {
    searchTerm?: string;
    scope?: string[] | string;
    entities?: string[] | string;
    maxResults?: number | string;
    matchCase?: boolean | string;
    lookupField?: string;
    lookupTargetEntity?: string;
    lookupTargetPrimaryNameField?: string;
}

export interface AgentLookupFilter {
    entityName: string;
    lookupAttribute: string;
    targetEntityName: string;
    targetPrimaryNameAttribute: string;
}

export interface NormalizedAgentInvocationInput {
    searchTerm: string;
    scope: AgentInvocationScope[];
    entities: string[];
    maxResults: number;
    matchCase: boolean;
    lookupFilter?: AgentLookupFilter;
}

export interface AgentInvocationResult {
    totalMatches: number;
    results: SearchResult[];
}

export interface HeadlessInvocationContext {
    toolId?: string;
    toolName?: string;
    invocationMode?: 'one-way' | 'two-way';
    authToken?: string;
    updateProgress?: (percent: number, message: string) => void;
    logger?: {
        debug?: (message: string) => void;
        info?: (message: string) => void;
        warn?: (message: string) => void;
        error?: (message: string) => void;
    };
}
