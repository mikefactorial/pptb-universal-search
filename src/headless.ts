import { UniversalSearchService } from './services/UniversalSearchService';
import {
    AgentInvocationInput,
    AgentInvocationResult,
    AgentInvocationScope,
    HeadlessInvocationContext,
    NormalizedAgentInvocationInput
} from './types/agent';
import { SearchCallbacks, SearchCancellation, SearchOptions, SearchResult } from './types/search';

const DEFAULT_MAX_RESULTS = 50;

const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
    matchCase: false,
    searchPicklists: false,
    searchLookups: false,
    searchAttributes: true,
    searchEntities: true,
    searchRelationships: true,
    searchFormsViews: true,
    alwaysGetLatestSolution: false
};

export async function invokeHeadless(
    input: AgentInvocationInput = {},
    context: HeadlessInvocationContext = {}
): Promise<AgentInvocationResult> {
    try {
        const normalizedInput = normalizeInput(input);
        const resolvedEntities = await resolveEntities(normalizedInput.entities, context);
        const service = new UniversalSearchService();
        const callbacks = createCallbacks(context);
        const cancellation = createCancellation();
        const aggregatedResults: SearchResult[] = [];

        context.logger?.info?.(`Headless invocation input: ${JSON.stringify(normalizedInput)}`);
        context.logger?.info?.(
            `Starting headless invocation for ${context.toolName ?? 'Universal Search'} with scope ${normalizedInput.scope.join(', ')}`
        );
        context.logger?.debug?.(`Headless invocation search term: ${normalizedInput.searchTerm}`);

        if (normalizedInput.scope.includes('records')) {
            context.updateProgress?.(15, 'Searching records');
            context.logger?.debug?.(`Searching records across ${resolvedEntities.length} entities.`);
            const recordResults = normalizedInput.lookupFilter
                ? await service.searchRecordsByLookupText(
                    normalizedInput.searchTerm,
                    normalizedInput.lookupFilter,
                    callbacks,
                    cancellation,
                    normalizedInput.maxResults
                )
                : await service.searchProgressive(
                    normalizedInput.searchTerm,
                    'records',
                    resolvedEntities,
                    null,
                    {
                        ...DEFAULT_SEARCH_OPTIONS,
                        matchCase: normalizedInput.matchCase
                    },
                    callbacks,
                    cancellation,
                    normalizedInput.maxResults
                );

            aggregatedResults.push(...recordResults);
            context.logger?.debug?.(`Record search produced ${countMatches(aggregatedResults)} candidate matches.`);
        }

        const remainingResults = normalizedInput.maxResults - countMatches(aggregatedResults);
        if (remainingResults > 0 && (normalizedInput.scope.includes('metadata') || normalizedInput.scope.includes('solutionComponents'))) {
            context.updateProgress?.(65, 'Searching solution components');
            const metadataResults = await service.searchProgressive(
                normalizedInput.searchTerm,
                'metadata',
                resolvedEntities,
                null,
                {
                    ...DEFAULT_SEARCH_OPTIONS,
                    matchCase: normalizedInput.matchCase
                },
                callbacks,
                cancellation,
                remainingResults
            );

            aggregatedResults.push(...metadataResults);
            context.logger?.debug?.(`Combined matches after metadata search: ${countMatches(aggregatedResults)}.`);
        }

        const deduplicatedResults = deduplicateResults(aggregatedResults);
        const totalMatches = countMatches(deduplicatedResults);
        context.updateProgress?.(100, 'Search complete');
        context.logger?.info?.(`Headless invocation complete with ${totalMatches} matches.`);

        return {
            totalMatches,
            results: deduplicatedResults
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        context.logger?.error?.(`Headless invocation failed: ${errorMessage}`);
        throw error;
    }
}

export function normalizeInput(input: AgentInvocationInput): NormalizedAgentInvocationInput {
    const searchTerm = typeof input.searchTerm === 'string' ? input.searchTerm.trim() : '';

    if (!searchTerm) {
        throw new Error('A non-empty searchTerm is required for headless invocation.');
    }

    const scope = normalizeScope(input.scope);
    const entities = normalizeEntities(input.entities);
    const maxResults = normalizeMaxResults(input.maxResults);
    const matchCase = input.matchCase === true || input.matchCase === 'true';
    const lookupFilter = buildLookupFilter(input, entities);

    return {
        searchTerm,
        scope,
        entities,
        maxResults,
        matchCase,
        lookupFilter
    };
}

function normalizeScope(scope: string[] | string | undefined): AgentInvocationScope[] {
    const validScope = new Set<AgentInvocationScope>(['records', 'metadata', 'solutionComponents']);
    const scopeValues = parseStringArrayInput(scope);
    const normalizedScope = scopeValues
        .filter((value): value is AgentInvocationScope => validScope.has(value as AgentInvocationScope));

    if (normalizedScope.length > 0) {
        return normalizedScope;
    }

    return ['records'];
}

function normalizeEntities(
    entities: string[] | string | undefined
): string[] {
    const normalizedEntities = parseStringArrayInput(entities)
        .map(entity => entity.trim())
        .filter(Boolean);

    return normalizedEntities;
}

function normalizeMaxResults(maxResults: number | string | undefined): number {
    const numericValue = typeof maxResults === 'string'
        ? Number(maxResults)
        : maxResults;

    if (typeof numericValue !== 'number' || Number.isNaN(numericValue)) {
        return DEFAULT_MAX_RESULTS;
    }

    return Math.max(1, Math.min(Math.floor(numericValue), 200));
}

function parseStringArrayInput(value: string[] | string | undefined): string[] {
    if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === 'string');
    }

    if (typeof value !== 'string') {
        return [];
    }

    const parsed = parsePossiblySerializedValue(value);
    if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
    }

    if (typeof parsed === 'string') {
        const normalized = parsed.trim();
        if (!normalized) {
            return [];
        }

        if (normalized.includes(',')) {
            return normalized
                .split(',')
                .map((part) => stripSurroundingQuotes(part.trim()))
                .filter(Boolean);
        }

        return [stripSurroundingQuotes(normalized)].filter(Boolean);
    }

    const extractedTokens = extractWordTokens(typeof value === 'string' ? value : '');
    if (extractedTokens.length > 0) {
        return extractedTokens;
    }

    return [];
}

function parsePossiblySerializedValue(value: string): unknown {
    let current: unknown = value.trim();

    for (let attempt = 0; attempt < 30; attempt += 1) {
        if (typeof current !== 'string') {
            return current;
        }

        const candidate = current.trim();
        if (!candidate) {
            return '';
        }

        try {
            current = JSON.parse(candidate);
            continue;
        } catch {
            if (candidate.includes('\\"')) {
                const unescaped = candidate.replace(/\\"/g, '"');
                if (unescaped !== candidate) {
                    current = unescaped;
                    continue;
                }
            }

            return candidate;
        }
    }

    return current;
}

function stripSurroundingQuotes(value: string): string {
    return value.replace(/^['"]|['"]$/g, '');
}

function extractWordTokens(value: string): string[] {
    const matches = value.match(/[a-z][a-z0-9_]*/gi);
    return matches ? Array.from(new Set(matches.map((token) => token.toLowerCase()))) : [];
}

function buildLookupFilter(input: AgentInvocationInput, entities: string[]) {
    if (input.lookupField && input.lookupTargetEntity) {
        if (!entities[0]) {
            throw new Error('An entity must be provided when using explicit lookupField input.');
        }

        return {
            entityName: entities[0],
            lookupAttribute: input.lookupField,
            targetEntityName: input.lookupTargetEntity,
            targetPrimaryNameAttribute: input.lookupTargetPrimaryNameField || 'fullname'
        };
    }

    return undefined;
}

async function resolveEntities(entities: string[], context: HeadlessInvocationContext): Promise<string[]> {
    const allEntities = (await window.dataverseAPI.getAllEntitiesMetadata())?.value || [];
    const allLogicalNames = allEntities
        .map((entity: any) => entity?.LogicalName)
        .filter((entityName: unknown): entityName is string => typeof entityName === 'string' && entityName.length > 0);

    if (entities.length === 0) {
        context.logger?.warn?.('No entity list provided. Falling back to all available entities.');
        return allLogicalNames;
    }

    const resolvedEntities: string[] = [];
    const unresolvedEntities: string[] = [];

    for (const requestedEntity of entities) {
        const matchedLogicalName = findEntityLogicalName(requestedEntity, allEntities);
        if (matchedLogicalName) {
            resolvedEntities.push(matchedLogicalName);
            continue;
        }

        unresolvedEntities.push(requestedEntity);
    }

    if (unresolvedEntities.length > 0) {
        context.logger?.warn?.(`Could not resolve some entities by logical/display name: ${unresolvedEntities.join(', ')}`);
    }

    return Array.from(new Set([...resolvedEntities, ...unresolvedEntities]));
}

function findEntityLogicalName(requestedEntity: string, entitiesMetadata: any[]): string | undefined {
    const requestedAlias = normalizeEntityAlias(requestedEntity);
    if (!requestedAlias) {
        return undefined;
    }

    const entityAliases = entitiesMetadata
        .map((entity) => ({
            logicalName: typeof entity?.LogicalName === 'string' ? entity.LogicalName : undefined,
            aliases: getEntityAliases(entity)
        }))
        .filter((candidate): candidate is { logicalName: string; aliases: string[] } => Boolean(candidate.logicalName));

    const exactAliasMatch = entityAliases.find((candidate) => candidate.aliases.includes(requestedAlias));
    if (exactAliasMatch) {
        return exactAliasMatch.logicalName;
    }

    const containsAliasMatch = entityAliases.find((candidate) =>
        candidate.aliases.some((alias) => alias.includes(requestedAlias) || requestedAlias.includes(alias))
    );
    if (containsAliasMatch) {
        return containsAliasMatch.logicalName;
    }

    return undefined;
}

function getEntityAliases(entity: any): string[] {
    const aliases = new Set<string>();

    const logicalName = typeof entity?.LogicalName === 'string' ? entity.LogicalName : '';
    if (logicalName) {
        const normalizedLogical = normalizeEntityAlias(logicalName);
        if (normalizedLogical) {
            aliases.add(normalizedLogical);
        }

        const logicalWithoutPublisherPrefix = logicalName.includes('_')
            ? logicalName.split('_').slice(1).join('_')
            : logicalName;
        const normalizedWithoutPrefix = normalizeEntityAlias(logicalWithoutPublisherPrefix);
        if (normalizedWithoutPrefix) {
            aliases.add(normalizedWithoutPrefix);
        }
    }

    for (const displayName of getEntityDisplayNames(entity)) {
        const normalizedDisplayName = normalizeEntityAlias(displayName);
        if (normalizedDisplayName) {
            aliases.add(normalizedDisplayName);
        }
    }

    return Array.from(aliases);
}

function normalizeEntityAlias(value: string): string {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[_\-\s]+/g, '')
        .replace(/[^a-z0-9]/g, '');

    if (!normalized) {
        return '';
    }

    if (normalized.endsWith('ies')) {
        return normalized.slice(0, -3) + 'y';
    }

    if (normalized.endsWith('es') && normalized.length > 3) {
        return normalized.slice(0, -2);
    }

    if (normalized.endsWith('s') && !normalized.endsWith('ss')) {
        return normalized.slice(0, -1);
    }

    return normalized;
}

function getEntityDisplayNames(entity: any): string[] {
    const names = new Set<string>();

    const userLocalized = entity?.DisplayName?.UserLocalizedLabel?.Label;
    if (typeof userLocalized === 'string' && userLocalized.trim()) {
        names.add(userLocalized.trim());
    }

    const localizedLabels = entity?.DisplayName?.LocalizedLabels;
    if (Array.isArray(localizedLabels)) {
        for (const label of localizedLabels) {
            if (typeof label?.Label === 'string' && label.Label.trim()) {
                names.add(label.Label.trim());
            }
        }
    }

    return Array.from(names);
}

function createCallbacks(context: HeadlessInvocationContext): SearchCallbacks {
    return {
        onError: (error) => context.logger?.error?.(error.message)
    };
}

function createCancellation(): SearchCancellation {
    return {
        isCancelled: false,
        cancel() {
            this.isCancelled = true;
        }
    };
}

function deduplicateResults(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>();
    return results.filter((result) => {
        const key = `${result.type}::${result.entityName}::${result.id}`;
        if (seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

function countMatches(results: SearchResult[]): number {
    return results.reduce((total, result) => total + (typeof result.totalCount === 'number' ? result.totalCount : result.records.length), 0);
}
