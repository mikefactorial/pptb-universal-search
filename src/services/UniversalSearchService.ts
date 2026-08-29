import DataverseAPI from '@pptb/types/dataverseAPI';
import { AgentLookupFilter } from '../types/agent';
import { SearchOptions, SearchResult, SearchMode, AttributeMetadata, MetadataSearchResult, SearchCallbacks, SearchProgress, SearchCancellation } from '../types/search';
import { metadataCache } from './MetadataCache';

export class UniversalSearchService {
    private searchStartTime: number = 0;
    
    /**
     * Main progressive search function with callbacks
     */
    async searchProgressive(
        searchText: string,
        searchMode: SearchMode,
        selectedEntities: string[],
        selectedSolution: string | null,
        searchOptions: SearchOptions,
        callbacks: SearchCallbacks,
        cancellation: SearchCancellation,
        maxResults: number = Number.POSITIVE_INFINITY
    ): Promise<SearchResult[]> {
        this.searchStartTime = Date.now();
        
        const trimmedText = searchText.trim();
        if (!trimmedText) {
            const error = new Error('Search text cannot be empty');
            callbacks.onError?.(error);
            throw error;
        }

        try {
            switch (searchMode) {
                case 'records':
                    return await this.searchRecordsProgressive(trimmedText, selectedEntities, searchOptions, callbacks, cancellation, maxResults);
                case 'metadata':
                    return await this.searchMetadataProgressive(trimmedText, selectedEntities, searchOptions, callbacks, cancellation, maxResults);
                case 'solution':
                    return await this.searchSolutionProgressive(selectedSolution, callbacks, cancellation);
                default:
                    throw new Error(`Unsupported search mode: ${searchMode}`);
            }
        } catch (error) {
            callbacks.onError?.(error as Error);
            throw error;
        }
    }

    /**
     * Search through records in selected entities with progress callbacks
     */
    private async searchRecordsProgressive(
        searchText: string,
        selectedEntities: string[],
        searchOptions: SearchOptions,
        callbacks: SearchCallbacks,
        cancellation: SearchCancellation,
        maxResults: number = Number.POSITIVE_INFINITY
    ): Promise<SearchResult[]> {
        if (!selectedEntities || selectedEntities.length === 0) {
            throw new Error('Please select at least one entity to search');
        }

        const results: SearchResult[] = [];
        const sortedEntities = selectedEntities.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        const totalEntities = sortedEntities.length;

        let totalMatches = 0;

        for (let i = 0; i < sortedEntities.length; i++) {
            if (cancellation.isCancelled) {
                break;
            }

            if (totalMatches >= maxResults) {
                break;
            }

            const entityName = sortedEntities[i];
            const progress: SearchProgress = {
                currentEntity: entityName,
                entitiesCompleted: i,
                totalEntities,
                isSearching: true,
                estimatedTimeRemaining: this.calculateEstimatedTimeRemaining(i, totalEntities)
            };

            callbacks.onProgress?.(progress);

            try {
                // Get entity metadata from cache first, fallback to API if not cached
                let entityMetadata = metadataCache.getEntityMetadata(entityName);
                if (!entityMetadata) {
                    // Fallback to API call if not in cache (shouldn't happen in normal flow)
                    console.warn(`Entity metadata not in cache for ${entityName}, making API call`);
                    const apiMetadata = await window.dataverseAPI.getEntityMetadata(entityName, true, ['LogicalName', 'DisplayName']);
                    if (!apiMetadata) {
                        throw new Error(`Could not retrieve metadata for entity ${entityName}`);
                    }
                    entityMetadata = apiMetadata as any; // Type assertion since we know the structure
                }
                
                // At this point entityMetadata is guaranteed to exist
                if (!entityMetadata) {
                    throw new Error(`Could not get entity metadata for ${entityName}`);
                }
                
                // Get entity attributes using getEntityRelatedMetadata
                const attributesResponse = await window.dataverseAPI.getEntityRelatedMetadata(entityName, 'Attributes');
                if (!attributesResponse || !attributesResponse.value) {
                    console.warn(`No attributes found for entity ${entityName}`);
                    continue;
                }
                
                const attributes = attributesResponse.value;
                if (!Array.isArray(attributes)) {
                    console.warn(`Invalid attributes format for entity ${entityName}`);
                    continue;
                }
                
                // Filter to searchable attributes
                const searchableAttributes = (attributes as AttributeMetadata[]).filter(attr => 
                    attr && 
                    typeof attr === 'object' &&
                    'LogicalName' in attr &&
                    'IsValidForRead' in attr &&
                    'AttributeType' in attr &&
                    attr.LogicalName &&
                    attr.IsValidForRead && 
                    (attr.AttributeType === 'String' || 
                     attr.AttributeType === 'Memo' ||
                     attr.AttributeType === 'Lookup' ||
                     attr.AttributeType === 'Customer' ||
                     attr.AttributeType === 'Owner' ||
                     attr.AttributeType === 'Picklist' ||
                     attr.AttributeType === 'State' ||
                     attr.AttributeType === 'Status' ||
                     attr.AttributeType === 'Integer' ||
                     attr.AttributeType === 'BigInt' ||
                     attr.AttributeType === 'Decimal' ||
                     attr.AttributeType === 'Double' ||
                     attr.AttributeType === 'Money' ||
                     attr.AttributeType === 'DateTime' ||
                     attr.AttributeType === 'Boolean' ||
                     attr.AttributeType === 'Uniqueidentifier')
                );

                if (searchableAttributes.length === 0) {
                    console.warn(`No searchable attributes found for entity ${entityName}`);
                    // Just continue to next entity - don't create error result for UI
                    continue;
                }

                // Build FetchXML query
                let fetchXml: string;
                try {
                    fetchXml = await this.buildRecordSearchFetchXml(
                        entityName,
                        searchText,
                        searchableAttributes,
                        searchOptions,
                        Math.max(1, maxResults - totalMatches)
                    );
                } catch (fetchError) {
                    console.warn(`Could not build search query for entity ${entityName}:`, fetchError);
                    // Just continue to next entity - don't create error result for UI
                    continue;
                }

                // Execute query
                let response: any;
                try {
                    response = await window.dataverseAPI.fetchXmlQuery(fetchXml);
                } catch (queryError) {
                    console.warn(`Query failed for entity ${entityName}:`, queryError);
                    // Track error for final summary but don't create UI result
                    const errorResult: SearchResult = {
                        id: `records_${entityName}_fetch_error`,
                        entityName,
                        tabTitle: `${entityName} (Fetch Error)`,
                        type: 'records',
                        records: [],
                        totalCount: 0,
                        error: `Failed to execute query for ${entityName}: ${(queryError as Error).message}`
                    };
                    
                    results.push(errorResult);
                    // Don't call onResultUpdate for errors - just track in results for final summary
                    continue;
                }
                
                let records = response?.value || [];

                if (!Array.isArray(records)) {
                    console.warn(`Invalid response format for entity ${entityName}:`, response);
                    records = [];
                }

                if (Number.isFinite(maxResults)) {
                    records = records.slice(0, Math.max(0, maxResults - totalMatches));
                }

                // Post-process results
                records = await this.postProcessRecords(records);
                totalMatches += records.length;

                // Only create result if we have records or want to show empty results
                if (records.length > 0) {
                    const recordsWithId = records.map((record: any, index: number) => ({
                        ...record,
                        id: record.id || record[`${entityName}id`] || `record_${index}`
                    }));
                    
                    const result: SearchResult = {
                        id: `records_${entityName}`,
                        entityName,
                        tabTitle: `${entityMetadata.DisplayName?.LocalizedLabels?.[0]?.Label || entityName} (${records.length})`,
                        type: 'records',
                        records: recordsWithId,
                        totalCount: records.length
                    };
                    results.push(result);
                    callbacks.onResultUpdate?.(result);
                }

            } catch (error) {
                console.error(`Error searching entity ${entityName}:`, error);
                // Track error for final summary but don't create UI result
                const errorResult: SearchResult = {
                    id: `records_${entityName}_error`,
                    entityName,
                    tabTitle: `${entityName} (Error)`,
                    type: 'records',
                    records: [],
                    totalCount: 0,
                    error: `Failed to search ${entityName}: ${(error as Error).message}`
                };
                
                results.push(errorResult);
                // Don't call onResultUpdate for errors - just track in results for final summary
            }
        }

        const finalProgress: SearchProgress = {
            currentEntity: '',
            entitiesCompleted: totalEntities,
            totalEntities,
            isSearching: false
        };
        
        callbacks.onProgress?.(finalProgress);
        callbacks.onComplete?.(results);

        return results;
    }

    /**
     * Search through metadata with progress callbacks
     */
    private async searchMetadataProgressive(
        searchText: string,
        selectedEntities: string[],
        searchOptions: SearchOptions,
        callbacks: SearchCallbacks,
        cancellation: SearchCancellation,
        maxResults: number = Number.POSITIVE_INFINITY
    ): Promise<SearchResult[]> {
        const results: SearchResult[] = [];
        const searchRegex = this.wildcardToRegex(searchText, searchOptions.matchCase);
        
        // Extract environment ID for maker portal links
        console.log('Extracting environment ID for metadata search...');
        const environmentId = await this.getEnvironmentIdFromOrganization();
        if (environmentId) {
            console.log('Environment ID extracted successfully:', environmentId);
        } else {
            console.log('Could not extract environment ID, metadata links will not work');
        }
        
        // Get entities to search
        let entitiesToSearch = selectedEntities;
        if (!selectedEntities || selectedEntities.length === 0) {
            const allEntities = await window.dataverseAPI.getAllEntitiesMetadata();
            entitiesToSearch = (allEntities?.value || []).map((e: any) => e.LogicalName).filter(Boolean);
        }

        const metadataResults: MetadataSearchResult[] = [];
        const totalEntities = entitiesToSearch.length;

        for (let i = 0; i < entitiesToSearch.length; i++) {
            if (cancellation.isCancelled) {
                break;
            }

            if (metadataResults.length >= maxResults) {
                break;
            }

            const entityName = entitiesToSearch[i];
            const progress: SearchProgress = {
                currentEntity: entityName,
                entitiesCompleted: i,
                totalEntities,
                isSearching: true,
                estimatedTimeRemaining: this.calculateEstimatedTimeRemaining(i, totalEntities)
            };

            callbacks.onProgress?.(progress);

            try {
                // For metadata search, we need complete metadata from API
                // since cache may not have all the detailed properties needed
                const entityMetadata = await window.dataverseAPI.getEntityMetadata(entityName, true);
                if (!entityMetadata) {
                    continue;
                }
                

                // Use the extracted environment ID for building maker portal links
                console.log('Using environment ID for link building:', environmentId);

                // Track results for this specific entity
                const entityMetadataResults: MetadataSearchResult[] = [];
                
                // Search entity names and descriptions
                if (searchOptions.searchEntities) {
                    await this.searchEntityMetadata(entityMetadata, searchRegex, entityMetadataResults, environmentId);
                }

                // Search attributes
                if (searchOptions.searchAttributes) {
                    try {
                        const attributesResponse = await window.dataverseAPI.getEntityRelatedMetadata(entityName, 'Attributes');
                        if (attributesResponse?.value && Array.isArray(attributesResponse.value)) {
                            this.searchAttributeMetadata(entityName, attributesResponse.value, searchRegex, entityMetadataResults, entityMetadata, environmentId);
                        }
                    } catch (attrError) {
                        console.warn(`Could not get attributes for ${entityName}:`, attrError);
                    }
                }

                // Search relationships
                if (searchOptions.searchRelationships) {
                    try {
                        const relationshipsResponse = await window.dataverseAPI.getEntityRelatedMetadata(entityName, 'OneToManyRelationships');
                        if (relationshipsResponse?.value && Array.isArray(relationshipsResponse.value)) {
                            this.searchRelationshipMetadata(entityName, relationshipsResponse.value, 'OneToMany', searchRegex, entityMetadataResults, entityMetadata, environmentId);
                        }

                        const manyToOneResponse = await window.dataverseAPI.getEntityRelatedMetadata(entityName, 'ManyToOneRelationships');
                        if (manyToOneResponse?.value && Array.isArray(manyToOneResponse.value)) {
                            this.searchRelationshipMetadata(entityName, manyToOneResponse.value, 'ManyToOne', searchRegex, entityMetadataResults, entityMetadata, environmentId);
                        }

                        const manyToManyResponse = await window.dataverseAPI.getEntityRelatedMetadata(entityName, 'ManyToManyRelationships');
                        if (manyToManyResponse?.value && Array.isArray(manyToManyResponse.value)) {
                            this.searchRelationshipMetadata(entityName, manyToManyResponse.value, 'ManyToMany', searchRegex, entityMetadataResults, entityMetadata, environmentId);
                        }
                    } catch (relError) {
                        console.warn(`Could not get relationships for ${entityName}:`, relError);
                    }
                }

                // Search forms and views
                if (searchOptions.searchFormsViews) {
                    try {
                        // Search forms using FetchXML
                        try {
                            const formsFetch = `
                                <fetch>
                                    <entity name="systemform">
                                        <attribute name="name" />
                                        <attribute name="formxml" />
                                        <filter>
                                            <condition attribute="objecttypecode" operator="eq" value="${entityMetadata.ObjectTypeCode}" />
                                        </filter>
                                    </entity>
                                </fetch>`;
                            
                            const formsResponse = await window.dataverseAPI.fetchXmlQuery(formsFetch);
                            
                            if (formsResponse?.value) {
                                this.searchFormsMetadata(entityName, formsResponse.value, searchRegex, entityMetadataResults, entityMetadata, environmentId);
                            }
                        } catch (formsError) {
                            console.warn(`Could not get forms for ${entityName}:`, formsError);
                        }

                        // Search saved queries (views) using FetchXML
                        try {
                            const viewsFetch = `
                                <fetch>
                                    <entity name="savedquery">
                                        <attribute name="name" />
                                        <attribute name="fetchxml" />
                                        <attribute name="layoutxml" />
                                        <filter>
                                            <condition attribute="returnedtypecode" operator="eq" value="${entityMetadata.ObjectTypeCode}" />
                                        </filter>
                                    </entity>
                                </fetch>`;
                            
                            const viewsResponse = await window.dataverseAPI.fetchXmlQuery(viewsFetch);
                            
                            if (viewsResponse?.value) {
                                this.searchViewsMetadata(entityName, viewsResponse.value, searchRegex, entityMetadataResults, entityMetadata, environmentId);
                            }
                        } catch (viewsError) {
                            console.warn(`Could not get views for ${entityName}:`, viewsError);
                        }
                    } catch (formsViewsError) {
                        console.warn(`Could not get forms/views for ${entityName}:`, formsViewsError);
                    }
                }

                // If we found results for this entity, immediately send them to UI
                if (entityMetadataResults.length > 0) {
                    const remainingResults = Math.max(0, maxResults - metadataResults.length);
                    const limitedEntityResults = entityMetadataResults.slice(0, remainingResults);
                    if (limitedEntityResults.length === 0) {
                        continue;
                    }

                    // Add to global results
                    metadataResults.push(...limitedEntityResults);
                    
                    // Create and send result immediately for progressive display
                    const result: SearchResult = {
                        id: `metadata_${entityName}`,
                        entityName,
                        tabTitle: `${entityName} Metadata (${limitedEntityResults.length})`,
                        type: 'metadata',
                        records: limitedEntityResults.map(r => ({
                            id: `${r.type}_${r.name}`,
                            Type: r.type,
                            Name: r.name,
                            'Display Name': r.displayName || '',
                            'Match Location': r.matchLocation,
                            'Match Value': r.matchValue,
                            Description: r.description || '',
                            Link: r.link || ''
                        })),
                        totalCount: limitedEntityResults.length
                    };
                    
                    results.push(result);
                    callbacks.onResultUpdate?.(result);
                }

            } catch (error) {
                console.error(`Error searching metadata for ${entityName}:`, error);
            }
        }

        // Final progress update

        const finalProgress: SearchProgress = {
            currentEntity: '',
            entitiesCompleted: totalEntities,
            totalEntities,
            isSearching: false
        };
        
        callbacks.onProgress?.(finalProgress);
        callbacks.onComplete?.(results);

        return results;
    }

    /**
     * Search through solution with progress callbacks
     */
    private async searchSolutionProgressive(
        selectedSolution: string | null,
        callbacks: SearchCallbacks,
        cancellation: SearchCancellation
    ): Promise<SearchResult[]> {
        if (!selectedSolution) {
            throw new Error('Please select a solution to search');
        }

        if (cancellation.isCancelled) {
            return [];
        }

        const progress: SearchProgress = {
            currentEntity: selectedSolution,
            entitiesCompleted: 0,
            totalEntities: 1,
            isSearching: true
        };

        callbacks.onProgress?.(progress);

        const result: SearchResult = {
            id: `solution_${selectedSolution}`,
            entityName: selectedSolution,
            tabTitle: `${selectedSolution} (Not Implemented)`,
            type: 'solution',
            records: [],
            totalCount: 0,
            error: 'Solution file search is not yet implemented in this version. This feature requires server-side solution export and file parsing capabilities.'
        };

        callbacks.onResultUpdate?.(result);

        const finalProgress: SearchProgress = {
            currentEntity: '',
            entitiesCompleted: 1,
            totalEntities: 1,
            isSearching: false
        };

        callbacks.onProgress?.(finalProgress);
        callbacks.onComplete?.([result]);

        return [result];
    }

    async searchRecordsByLookupText(
        searchText: string,
        lookupFilter: AgentLookupFilter,
        callbacks: SearchCallbacks,
        cancellation: SearchCancellation,
        maxResults: number = 50
    ): Promise<SearchResult[]> {
        if (cancellation.isCancelled) {
            return [];
        }

        const progress: SearchProgress = {
            currentEntity: lookupFilter.entityName,
            entitiesCompleted: 0,
            totalEntities: 1,
            isSearching: true
        };
        callbacks.onProgress?.(progress);

        try {
            let entityMetadata = metadataCache.getEntityMetadata(lookupFilter.entityName);
            if (!entityMetadata) {
                const apiMetadata = await window.dataverseAPI.getEntityMetadata(lookupFilter.entityName, true, ['LogicalName', 'DisplayName']);
                if (!apiMetadata) {
                    throw new Error(`Could not retrieve metadata for entity ${lookupFilter.entityName}`);
                }
                entityMetadata = apiMetadata as any;
            }

            const attributesResponse = await window.dataverseAPI.getEntityRelatedMetadata(lookupFilter.entityName, 'Attributes');
            const lookupAttributes = Array.isArray(attributesResponse?.value) ? attributesResponse.value : [];
            const lookupAttribute = lookupAttributes.find((attribute: any) => attribute?.LogicalName === lookupFilter.lookupAttribute);
            if (!lookupAttribute) {
                throw new Error(`Lookup attribute ${lookupFilter.lookupAttribute} was not found on ${lookupFilter.entityName}`);
            }

            const fetchXml = await this.buildLookupTextSearchFetchXml(
                lookupFilter.entityName,
                lookupAttribute,
                searchText,
                lookupFilter.targetEntityName,
                lookupFilter.targetPrimaryNameAttribute,
                maxResults
            );

            const response = await window.dataverseAPI.fetchXmlQuery(fetchXml);
            const records = await this.postProcessRecords(Array.isArray(response?.value) ? response.value.slice(0, maxResults) : []);

            if (records.length === 0) {
                callbacks.onComplete?.([]);
                callbacks.onProgress?.({
                    currentEntity: '',
                    entitiesCompleted: 1,
                    totalEntities: 1,
                    isSearching: false
                });
                return [];
            }

            const result: SearchResult = {
                id: `records_${lookupFilter.entityName}_${lookupFilter.lookupAttribute}`,
                entityName: lookupFilter.entityName,
                tabTitle: `${entityMetadata?.DisplayName?.LocalizedLabels?.[0]?.Label || lookupFilter.entityName} (${records.length})`,
                type: 'records',
                records: records.map((record: any, index: number) => ({
                    ...record,
                    id: record.id || record[`${lookupFilter.entityName}id`] || `record_${index}`
                })),
                totalCount: records.length
            };

            callbacks.onResultUpdate?.(result);
            callbacks.onComplete?.([result]);
            callbacks.onProgress?.({
                currentEntity: '',
                entitiesCompleted: 1,
                totalEntities: 1,
                isSearching: false
            });

            return [result];
        } catch (error) {
            callbacks.onError?.(error as Error);
            throw error;
        }
    }

    /**
     * Calculate estimated time remaining based on current progress
     */
    private calculateEstimatedTimeRemaining(completed: number, total: number): number | undefined {
        if (completed === 0 || this.searchStartTime === 0) {
            return undefined;
        }

        const elapsedTime = (Date.now() - this.searchStartTime) / 1000; // in seconds
        const averageTimePerEntity = elapsedTime / completed;
        const remainingEntities = total - completed;
        
        return Math.round(averageTimePerEntity * remainingEntities);
    }

    /**
     * Build FetchXML query for record search
     */
    private async buildRecordSearchFetchXml(
        entityName: string,
        searchText: string,
        attributes: AttributeMetadata[],
        searchOptions: SearchOptions = { 
            matchCase: false, 
            searchPicklists: false, 
            searchLookups: false,
            searchAttributes: true,
            searchEntities: true,
            searchRelationships: false,
            searchFormsViews: false,
            alwaysGetLatestSolution: false
        },
        top: number = 100
    ): Promise<string> {
        if (!attributes || attributes.length === 0) {
            throw new Error(`No searchable attributes provided for entity ${entityName}`);
        }
        
        const conditions: string[] = [];
        
        // Try to parse as different data types
        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const isGuid = guidRegex.test(searchText);
        const isNumber = !isNaN(Number(searchText));
        const isDate = !isNaN(Date.parse(searchText));
        
        // Build the FetchXML - use all-attributes to avoid request length issues
        
        for (const attr of attributes) { // Include ALL attributes, not just first 20
            if (!attr || !attr.LogicalName) {
                continue;
            }
            
            const attrName = attr.LogicalName;
            
            // Skip system fields that are typically not searchable
            if (attrName.startsWith('createdon') || 
                attrName.startsWith('modifiedon') || 
                attrName.startsWith('versionnumber')) {
                continue;
            }
            
            switch (attr.AttributeType) {
                case 'String':
                case 'Memo':
                    if (searchText.includes('*') || searchText.includes('?')) {
                        // Use like with wildcards
                        const likePattern = this.buildLikePattern(searchText, true);
                        conditions.push(`<condition attribute="${attrName}" operator="like" value="${this.escapeXml(likePattern)}" />`);
                    } else {
                        // Use contains for regular text
                        conditions.push(`<condition attribute="${attrName}" operator="like" value="${this.escapeXml(this.buildLikePattern(searchText))}" />`);
                    }
                    break;
                    
                case 'Lookup':
                case 'Customer':
                case 'Owner':
                    if (isGuid) {
                        conditions.push(`<condition attribute="${attrName}" operator="eq" value="${searchText}" />`);
                    } else if (searchOptions.searchLookups && !isGuid) {
                        // TODO: Implement lookup text search
                        // This would require getting the related entity and searching its primary name field
                        // For now, skip lookup text search to avoid complexity
                    }
                    break;
                    
                case 'Integer':
                case 'BigInt':
                case 'Decimal':
                case 'Double':
                case 'Money':
                    if (isNumber) {
                        conditions.push(`<condition attribute="${attrName}" operator="eq" value="${searchText}" />`);
                    }
                    break;
                    
                case 'DateTime':
                    if (isDate) {
                        const date = new Date(searchText);
                        const dateStr = date.toISOString().split('T')[0];
                        conditions.push(`<condition attribute="${attrName}" operator="on" value="${dateStr}" />`);
                    }
                    break;
                    
                case 'Boolean':
                    if (searchText.toLowerCase() === 'true' || searchText === '1') {
                        conditions.push(`<condition attribute="${attrName}" operator="eq" value="1" />`);
                    } else if (searchText.toLowerCase() === 'false' || searchText === '0') {
                        conditions.push(`<condition attribute="${attrName}" operator="eq" value="0" />`);
                    }
                    break;
                    
                case 'Picklist':
                case 'State':
                case 'Status':
                    if (isNumber) {
                        conditions.push(`<condition attribute="${attrName}" operator="eq" value="${searchText}" />`);
                    } else if (searchOptions.searchPicklists && !isNumber) {
                        // Search through picklist option labels to find matches
                        try {
                            const optionValues = await this.searchPicklistOptions(entityName, attrName, searchText, searchOptions.matchCase);
                            for (const optionValue of optionValues) {
                                conditions.push(`<condition attribute="${attrName}" operator="eq" value="${optionValue}" />`);
                            }
                        } catch (error) {
                            console.warn(`Error searching picklist options for ${attrName}:`, error);
                        }
                    }
                    break;
            }
        }
        
        if (conditions.length === 0) {
            throw new Error(`No searchable conditions could be built for entity ${entityName} with search text "${searchText}"`);
        }
        
        return `
            <fetch top="${Math.max(1, Math.min(top, 5000))}">
                <entity name="${entityName}">
                    <all-attributes />
                    <filter type="or">
                        ${conditions.join('')}
                    </filter>
                </entity>
            </fetch>
        `.trim();
    }

    private async buildLookupTextSearchFetchXml(
        entityName: string,
        lookupAttribute: AttributeMetadata & { Targets?: string[] },
        searchText: string,
        targetEntityName: string,
        targetPrimaryNameAttribute: string,
        top: number
    ): Promise<string> {
        const targets = Array.isArray(lookupAttribute.Targets) ? lookupAttribute.Targets : [];
        if (targets.length > 0 && !targets.includes(targetEntityName)) {
            throw new Error(`Lookup attribute ${lookupAttribute.LogicalName} does not target ${targetEntityName}`);
        }

        const targetMetadata = await window.dataverseAPI.getEntityMetadata(
            targetEntityName,
            true,
            ['LogicalName', 'PrimaryIdAttribute', 'PrimaryNameAttribute']
        ) as any;

        const targetPrimaryIdAttribute = targetMetadata?.PrimaryIdAttribute || `${targetEntityName}id`;
        const primaryNameAttribute = targetMetadata?.PrimaryNameAttribute || targetPrimaryNameAttribute;
        const likePattern = this.buildLikePattern(searchText, searchText.includes('*') || searchText.includes('?'));

        return `
            <fetch top="${Math.max(1, Math.min(top, 5000))}">
                <entity name="${entityName}">
                    <all-attributes />
                    <link-entity
                        name="${targetEntityName}"
                        from="${targetPrimaryIdAttribute}"
                        to="${lookupAttribute.LogicalName}"
                        alias="${lookupAttribute.LogicalName}_lookup">
                        <filter type="and">
                            <condition attribute="${primaryNameAttribute}" operator="like" value="${this.escapeXml(likePattern)}" />
                        </filter>
                    </link-entity>
                </entity>
            </fetch>
        `.trim();
    }

    /**
     * Post-process records to resolve lookup names and option set labels
     */
    private async postProcessRecords(
        records: any[]
    ): Promise<any[]> {
        // For now, return records as-is
        // In a full implementation, this would resolve lookup display names
        // and option set labels for better display
        return records;
    }

    private buildLikePattern(searchText: string, preserveWildcards: boolean = false): string {
        const normalizedText = preserveWildcards
            ? searchText.replace(/\*/g, '%').replace(/\?/g, '_')
            : `%${searchText}%`;

        return normalizedText
            .replace(/\[/g, '[[]')
            .replace(/\]/g, '[]]');
    }

    /**
     * Search entity metadata using comprehensive recursive search
     */
    private async searchEntityMetadata(
        entityMetadata: any,
        searchRegex: RegExp,
        results: MetadataSearchResult[],
        environmentId: string
    ) {
        if (!entityMetadata || !entityMetadata.LogicalName) {
            return;
        }

        // Use comprehensive recursive search like the C# version
        this.searchMetadataObjectRecursively(
            entityMetadata.LogicalName,
            '',
            'Entity',
            entityMetadata,
            '',
            searchRegex,
            results,
            entityMetadata,
            environmentId
        );
    }

    /**
     * Recursive metadata search method that mirrors the C# implementation
     * This searches through all properties of an object, including nested objects and arrays
     */
    private searchMetadataObjectRecursively(
        entityName: string,
        linkType: string,
        metadataType: string,
        searchObject: any,
        itemIdentifier: string,
        searchRegex: RegExp,
        results: MetadataSearchResult[],
        entityMetadata: DataverseAPI.EntityMetadata,  // Add the entity metadata parameter
        environmentId: string  // Add environment ID parameter
    ) {
        if (!searchObject) return;

        // Update item identifier based on object type
        itemIdentifier = this.buildItemIdentifier(searchObject, itemIdentifier);

        // Handle arrays
        if (Array.isArray(searchObject)) {
            for (const item of searchObject) {
                this.searchMetadataObjectRecursively(
                    entityName,
                    linkType,
                    metadataType,
                    item,
                    itemIdentifier,
                    searchRegex,
                    results,
                    entityMetadata,
                    environmentId
                );
            }
            return;
        }

        // Handle objects
        if (typeof searchObject === 'object' && searchObject !== null) {
            for (const [propertyName, propertyValue] of Object.entries(searchObject)) {
                // Skip functions and certain system properties
                if (typeof propertyValue === 'function' || 
                    propertyName.startsWith('__') ||
                    propertyName === 'constructor') {
                    continue;
                }

                // If property value is an array or object, recurse into it
                if (Array.isArray(propertyValue) || 
                    (typeof propertyValue === 'object' && propertyValue !== null)) {
                    this.searchMetadataObjectRecursively(
                        entityName,
                        linkType,
                        metadataType,
                        propertyValue,
                        itemIdentifier,
                        searchRegex,
                        results,
                        entityMetadata,
                        environmentId
                    );
                } else {
                    // Search both property name and property value (primitive types)
                    const propertyValueStr = propertyValue?.toString() || '';
                    
                    if (searchRegex.test(propertyName) || 
                        (propertyValueStr && searchRegex.test(propertyValueStr))) {
                        
                        results.push({
                            entityName,
                            type: this.mapMetadataType(metadataType),
                            name: itemIdentifier,
                            displayName: itemIdentifier,
                            description: `${propertyName}: ${propertyValueStr}`,
                            matchLocation: searchRegex.test(propertyName) ? 'Property Name' : 'Property Value',
                            matchValue: searchRegex.test(propertyName) ? propertyName : propertyValueStr,
                            link: this.buildLinkForMetadataItem(entityMetadata, this.mapMetadataType(metadataType), environmentId)
                        });
                    }
                }
            }
        }
    }

    /**
     * Build item identifier based on object type (mirrors C# implementation)
     */
    private buildItemIdentifier(searchObject: any, currentIdentifier: string): string {
        if (!searchObject) return currentIdentifier;

        // Handle different metadata object types
        if (searchObject.LogicalName) {
            // Entity or Attribute metadata
            return searchObject.DisplayName?.UserLocalizedLabel?.Label || 
                   searchObject.DisplayName?.LocalizedLabels?.[0]?.Label || 
                   searchObject.LogicalName;
        }

        if (searchObject.SchemaName) {
            return searchObject.SchemaName;
        }

        if (searchObject.ReferencedEntity && searchObject.ReferencingEntity) {
            // OneToMany relationship
            return `${searchObject.ReferencedEntity} (${searchObject.ReferencedAttribute}) - ${searchObject.ReferencingEntity} (${searchObject.ReferencingAttribute})`;
        }

        if (searchObject.Entity1LogicalName && searchObject.Entity2LogicalName) {
            // ManyToMany relationship  
            return `${searchObject.Entity1LogicalName} (${searchObject.Entity1IntersectAttribute}) - ${searchObject.Entity2LogicalName} (${searchObject.Entity2IntersectAttribute})`;
        }

        if (searchObject.FormName) {
            return searchObject.FormName;
        }

        if (searchObject.ViewName) {
            return searchObject.ViewName;
        }

        if (searchObject.Name) {
            return searchObject.Name;
        }

        return currentIdentifier;
    }

    /**
     * Map metadata type string to valid type enum
     */
    private mapMetadataType(metadataType: string): 'entity' | 'attribute' | 'relationship' | 'form' | 'view' {
        const type = metadataType.toLowerCase();
        switch (type) {
            case 'attribute': return 'attribute';
            case 'relationship': return 'relationship';
            case 'form': return 'form';
            case 'view': return 'view';
            case 'entity':
            default: return 'entity';
        }
    }

    /**
     * Search attribute metadata using comprehensive recursive search
     */
    private searchAttributeMetadata(
        entityName: string,
        attributes: AttributeMetadata[],
        searchRegex: RegExp,
        results: MetadataSearchResult[],
        entityMetadata: DataverseAPI.EntityMetadata,
        environmentId: string
    ) {
        for (const attr of attributes) {
            if (!attr || !attr.LogicalName) {
                continue;
            }
            
            // Use comprehensive recursive search like the C# version
            this.searchMetadataObjectRecursively(
                entityName,
                'attributes',
                'Attribute',
                attr,
                attr.LogicalName,
                searchRegex,
                results,
                entityMetadata,
                environmentId
            );
        }
    }

    /**
     * Search relationship metadata
     */
    private searchRelationshipMetadata(
        entityName: string,
        relationships: any[],
        relationshipType: 'OneToMany' | 'ManyToOne' | 'ManyToMany',
        searchRegex: RegExp,
        results: MetadataSearchResult[],
        entityMetadata: DataverseAPI.EntityMetadata,
        environmentId: string
    ) {
        for (const rel of relationships) {
            if (!rel || !rel.SchemaName) {
                continue;
            }
            
            const schemaName = rel.SchemaName;
            const referencedEntity = rel.ReferencedEntity || rel.Entity1LogicalName || rel.Entity2LogicalName;
            const referencingEntity = rel.ReferencingEntity || entityName;
            
            if (searchRegex.test(schemaName)) {
                results.push({
                    entityName,
                    type: 'relationship',
                    name: schemaName,
                    displayName: `${relationshipType}: ${referencingEntity} -> ${referencedEntity}`,
                    description: `${relationshipType} relationship`,
                    matchLocation: 'Schema Name',
                    matchValue: schemaName
                });
            }
            
            if (referencedEntity && searchRegex.test(referencedEntity)) {
                results.push({
                    entityName,
                    type: 'relationship',
                    name: schemaName,
                    displayName: `${relationshipType}: ${referencingEntity} -> ${referencedEntity}`,
                    description: `${relationshipType} relationship`,
                    matchLocation: 'Referenced Entity',
                    matchValue: referencedEntity,
                    link: this.buildLinkForMetadataItem(entityMetadata, 'relationships', environmentId)
                });
            }
        }
    }

    /**
     * Search forms metadata
     */
    private searchFormsMetadata(
        entityName: string,
        forms: any[],
        searchRegex: RegExp,
        results: MetadataSearchResult[],
        entityMetadata: DataverseAPI.EntityMetadata,
        environmentId: string
    ) {
        for (const form of forms) {
            if (!form) continue;
            
            const formName = form.name;
            const formXml = form.formxml;
            
            if (formName && searchRegex.test(formName)) {
                results.push({
                    entityName,
                    type: 'form',
                    name: formName,
                    displayName: formName,
                    description: 'System Form',
                    matchLocation: 'Form Name',
                    matchValue: formName,
                    link: this.buildLinkForMetadataItem(entityMetadata, 'forms', environmentId)
                });
            }
            
            if (formXml && searchRegex.test(formXml)) {
                // Extract a brief snippet for display
                const match = formXml.match(searchRegex);
                const snippet = match ? this.extractSnippet(formXml, match.index || 0) : 'Form XML';
                
                results.push({
                    entityName,
                    type: 'form',
                    name: formName || 'Unknown Form',
                    displayName: formName || 'Unknown Form',
                    description: 'System Form XML',
                    matchLocation: 'Form XML',
                    matchValue: snippet,
                    link: this.buildLinkForMetadataItem(entityMetadata, 'forms', environmentId)
                });
            }
        }
    }

    /**
     * Search views metadata  
     */
    private searchViewsMetadata(
        entityName: string,
        views: any[],
        searchRegex: RegExp,
        results: MetadataSearchResult[],
        entityMetadata: DataverseAPI.EntityMetadata,
        environmentId: string
    ) {
        for (const view of views) {
            if (!view) continue;
            
            const viewName = view.name;
            const fetchXml = view.fetchxml;
            const layoutXml = view.layoutxml;
            
            if (viewName && searchRegex.test(viewName)) {
                results.push({
                    entityName,
                    type: 'view',
                    name: viewName,
                    displayName: viewName,
                    description: 'Saved Query (View)',
                    matchLocation: 'View Name',
                    matchValue: viewName,
                    link: this.buildLinkForMetadataItem(entityMetadata, 'views', environmentId)
                });
            }
            
            if (fetchXml && searchRegex.test(fetchXml)) {
                const match = fetchXml.match(searchRegex);
                const snippet = match ? this.extractSnippet(fetchXml, match.index || 0) : 'FetchXML';
                
                results.push({
                    entityName,
                    type: 'view',
                    name: viewName || 'Unknown View',
                    displayName: viewName || 'Unknown View', 
                    description: 'View FetchXML',
                    matchLocation: 'FetchXML',
                    matchValue: snippet,
                    link: this.buildLinkForMetadataItem(entityMetadata, 'views', environmentId)
                });
            }
            
            if (layoutXml && searchRegex.test(layoutXml)) {
                const match = layoutXml.match(searchRegex);
                const snippet = match ? this.extractSnippet(layoutXml, match.index || 0) : 'LayoutXML';
                
                results.push({
                    entityName,
                    type: 'view',
                    name: viewName || 'Unknown View',
                    displayName: viewName || 'Unknown View',
                    description: 'View LayoutXML',
                    matchLocation: 'LayoutXML', 
                    matchValue: snippet,
                    link: this.buildLinkForMetadataItem(entityMetadata, 'views', environmentId)
                });
            }
        }
    }

    /**
     * Extract a snippet around a match for display
     */
    private extractSnippet(text: string, matchIndex: number, contextLength: number = 50): string {
        const start = Math.max(0, matchIndex - contextLength);
        const end = Math.min(text.length, matchIndex + contextLength);
        let snippet = text.substring(start, end);
        
        if (start > 0) snippet = '...' + snippet;
        if (end < text.length) snippet = snippet + '...';
        
        return snippet.trim();
    }

    /**
     * Convert wildcard pattern to regex
     */
    private wildcardToRegex(pattern: string, caseSensitive: boolean = false): RegExp {
        // First escape all regex special characters except * and ?
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        // Then convert wildcards: * becomes .* and ? becomes .
        const regexPattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
        const flags = caseSensitive ? '' : 'i'; // Remove global flag to prevent state issues
        return new RegExp(regexPattern, flags);
    }

    /**
     * Escape XML special characters
     */
    private escapeXml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    /**
     * Build Power Platform maker portal link for metadata item (mirrors C# implementation)
     */
    private buildLinkForMetadataItem(entityMetadata: any, linkType: string, environmentId?: string): string {
        console.log('buildLinkForMetadataItem called with:', { entityLogicalName: entityMetadata?.LogicalName, linkType, environmentId });
        
        // Check parameters first
        if (!entityMetadata || !linkType) {
            console.log('Missing entityMetadata or linkType');
            return '';
        }
        
        // If no environmentId provided, we can't build the link yet
        if (!environmentId) {
            console.log('No environmentId provided, cannot build maker portal link');
            return '';
        }
        
        // Check if we have required metadata
        if (!entityMetadata?.MetadataId || !entityMetadata?.LogicalName) {
            console.warn('Missing required metadata for link building:', {
                hasMetadataId: !!entityMetadata?.MetadataId,
                hasLogicalName: !!entityMetadata?.LogicalName,
                entityMetadata
            });
            return '';
        }
        
        // Build link using environment ID: https://make.powerapps.com/environments/{environmentId}/entities/{MetadataId}/{LogicalName}#{type}
        const makerPortalUrl = `https://make.powerapps.com/environments/${environmentId}/entities/${entityMetadata.MetadataId}/${entityMetadata.LogicalName}#${linkType}`;
        
        console.log('Built maker portal link:', makerPortalUrl);
        return makerPortalUrl;
    }

    /**
     * Extract environment ID from organization settings
     */
    private async getEnvironmentIdFromOrganization(): Promise<string> {
        try {
            // Build FetchXML to query the organization entity for orgdborgsettings field
            const fetchXml = `
                <fetch>
                    <entity name="organization">
                        <attribute name="organizationid" />
                        <attribute name="orgdborgsettings" />
                    </entity>
                </fetch>
            `;

            const organizationResponse = await window.dataverseAPI.fetchXmlQuery(fetchXml);

            if (!organizationResponse || !organizationResponse.value || organizationResponse.value.length === 0) {
                console.error('No organization data found');
                return '';
            }

            const organization = organizationResponse.value[0];
            const orgDbOrgSettings = organization.orgdborgsettings;

            if (!orgDbOrgSettings || typeof orgDbOrgSettings !== 'string') {
                console.error('No orgdborgsettings found in organization data or it is not a string');
                return '';
            }

            const environmentIdMatch = orgDbOrgSettings.match(/<ProjectHostEnvironmentId>([^<]+)<\/ProjectHostEnvironmentId>/i);
            if (environmentIdMatch?.[1]) {
                const environmentId = environmentIdMatch[1].trim();
                console.log('Extracted environment ID from organization:', environmentId);
                return environmentId;
            }

            console.error('ProjectHostEnvironmentId not found in orgdborgsettings XML');
            return '';
        } catch (error) {
            console.error('Error extracting environment ID from organization:', error);
            return '';
        }
    }

    /**
     * Search picklist options to find matching option values for a given text search
     */
    private async searchPicklistOptions(entityName: string, attributeName: string, searchText: string, matchCase: boolean): Promise<number[]> {
        try {
            // Check cache first
            let picklistAttributes = metadataCache.getPicklistAttributes(entityName);
            
            if (!picklistAttributes) {
                // Cache miss - fetch from API
                const odataQuery = `EntityDefinitions(LogicalName='${entityName}')/Attributes/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=GlobalOptionSet($select=Options)`;
                
                const response = await window.dataverseAPI.queryData(odataQuery);
                
                if (!response || !response.value || !Array.isArray(response.value)) {
                    console.warn(`Could not get picklist attributes metadata for ${entityName}`);
                    return [];
                }
                
                // Cache the results
                picklistAttributes = response.value;
                metadataCache.cachePicklistAttributes(entityName, picklistAttributes);
                console.log(`Cached ${picklistAttributes.length} picklist attributes for entity ${entityName}`);
            } else {
                console.log(`Using cached picklist metadata for entity ${entityName}`);
            }

            // Find the specific attribute
            const targetAttribute = picklistAttributes.find((attr: any) => attr.LogicalName === attributeName);
            if (!targetAttribute) {
                console.warn(`Picklist attribute ${attributeName} not found for entity ${entityName}`);
                return [];
            }

            // Check if it has GlobalOptionSet or local OptionSet
            let optionSet = targetAttribute.GlobalOptionSet;
            if (!optionSet && targetAttribute.OptionSet) {
                optionSet = targetAttribute.OptionSet;
            }

            if (!optionSet || !(optionSet as any).Options || !Array.isArray((optionSet as any).Options)) {
                console.warn(`No OptionSet found for ${entityName}.${attributeName}`);
                return [];
            }

            const regex = this.wildcardToRegex(searchText, matchCase);
            const matchingValues: number[] = [];

            // Search through option labels
            for (const option of (optionSet as any).Options) {
                if (option && option.Label && option.Value !== undefined && option.Value !== null) {
                    // Handle different label structures
                    const label = option.Label.UserLocalizedLabel?.Label || 
                                 option.Label.LocalizedLabels?.[0]?.Label || 
                                 (typeof option.Label === 'string' ? option.Label : '');
                    
                    if (label && regex.test(label)) {
                        matchingValues.push(option.Value);
                    }
                }
            }

            console.log(`Found ${matchingValues.length} matching picklist options for ${attributeName} with search "${searchText}":`, matchingValues);
            return matchingValues;
        } catch (error) {
            console.error(`Error searching picklist options for ${entityName}.${attributeName}:`, error);
            return [];
        }
    }
}