import { useState, useMemo, useRef, useLayoutEffect, type MouseEvent as ReactMouseEvent } from 'react';
import { SearchOptions } from '../types/search';
import './SearchResults.css';

const MIN_COLUMN_WIDTH = 60;

interface SearchResult {
    id: string;
    entityName: string;
    tabTitle: string;
    type: string;
    records: any[];
    totalCount: number;
    error?: string;
}

interface SearchResultsProps {
    results: SearchResult[];
    searchText: string;
    isSearching: boolean;
    searchOptions: SearchOptions;
}

export function SearchResults({ results, searchText, isSearching, searchOptions }: SearchResultsProps) {
    const [activeTabIndex, setActiveTabIndex] = useState(0);
    const [sortColumn, setSortColumn] = useState<string | null>(null);
    const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
    const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
    const headerRefs = useRef<Record<string, HTMLTableCellElement | null>>({});
    const tableRef = useRef<HTMLTableElement>(null);
    const justResizedRef = useRef(false);

    // Filter out results with errors or no records for tabs
    const validResults = results.filter(result => !result.error && result.records.length > 0);
    const activeResult = validResults[activeTabIndex];

    // Get columns from records, preferring formatted values and excluding system fields
    const columns = useMemo(() => {
        if (!activeResult || !activeResult.records.length) return [];
        
        const allKeys = new Set<string>();
        const formattedKeys = new Set<string>();
        
        // First pass: identify all keys and formatted keys
        activeResult.records.forEach(record => {
            Object.keys(record).forEach(key => {
                if (key.includes('@OData.Community.Display.V1.FormattedValue')) {
                    const baseKey = key.replace('@OData.Community.Display.V1.FormattedValue', '');
                    formattedKeys.add(baseKey);
                } else if (!key.startsWith('_') && 
                    key !== 'id' && 
                    !key.includes('@') &&
                    !key.startsWith('createdon') &&
                    !key.startsWith('createdby') &&
                    !key.startsWith('modifiedon') &&
                    !key.startsWith('modifiedby') &&
                    !key.startsWith('versionnumber') &&
                    key !== 'owningbusinessunit' &&
                    key !== 'owninguser' &&
                    key !== 'owningteam') {
                    allKeys.add(key);
                }
            });
        });
        
        // Filter to show only relevant columns, preferring those with formatted values
        const finalKeys = Array.from(allKeys).filter(key => {
            // Hide Link column but keep it available in the record data
            if (key === 'Link') {
                return false;
            }
            // Skip raw values if we have formatted versions
            if (formattedKeys.has(key)) {
                return false; // We'll use the formatted version instead
            }
            return true;
        });
        
        // Add formatted keys as display columns
        formattedKeys.forEach(key => {
            finalKeys.push(key);
        });
        
        // Sort columns with primary fields first
        const sortedKeys = finalKeys.sort((a, b) => {
            // Put primary name and id fields first
            const aIsPrimary = a.includes('name') || a === `${activeResult.entityName}id` || a === 'contactid';
            const bIsPrimary = b.includes('name') || b === `${activeResult.entityName}id` || b === 'contactid';
            
            if (aIsPrimary && !bIsPrimary) return -1;
            if (!aIsPrimary && bIsPrimary) return 1;
            
            return a.localeCompare(b);
        });
        
        return sortedKeys;
    }, [activeResult]);

    // Sort records if sort is applied
    const sortedRecords = useMemo(() => {
        if (!activeResult || !sortColumn) return activeResult?.records || [];
        
        return [...activeResult.records].sort((a, b) => {
            const aVal = a[sortColumn];
            const bVal = b[sortColumn];
            
            // Handle null/undefined values
            if (aVal == null && bVal == null) return 0;
            if (aVal == null) return sortDirection === 'asc' ? -1 : 1;
            if (bVal == null) return sortDirection === 'asc' ? 1 : -1;
            
            // Convert to strings for comparison
            const aStr = String(aVal).toLowerCase();
            const bStr = String(bVal).toLowerCase();
            
            const comparison = aStr.localeCompare(bStr);
            return sortDirection === 'asc' ? comparison : -comparison;
        });
    }, [activeResult, sortColumn, sortDirection]);

    const handleSort = (column: string) => {
        // Swallow the click the browser fires at the end of a column drag
        if (justResizedRef.current) return;

        if (sortColumn === column) {
            setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
        } else {
            setSortColumn(column);
            setSortDirection('asc');
        }
    };

    // Column widths are only usable once every column in the current tab has one
    const hasColumnWidths = columns.length > 0 && columns.every(column => columnWidths[column]);
    const totalColumnWidth = hasColumnWidths
        ? columns.reduce((sum, column) => sum + columnWidths[column], 0)
        : 0;

    // Capture the widths the browser picked for us before switching the table to a
    // fixed layout, so turning on resizing doesn't visibly reflow the grid. Runs
    // again whenever the column set changes (i.e. a different result tab).
    useLayoutEffect(() => {
        if (hasColumnWidths || columns.length === 0) return;

        const measured: Record<string, number> = {};
        let total = 0;
        for (const column of columns) {
            const width = headerRefs.current[column]?.offsetWidth;
            // jsdom and pre-paint renders report 0 - leave the grid on auto layout
            if (!width) return;
            measured[column] = width;
            total += width;
        }

        // Collapsed borders are shared between cells, so the header widths can add
        // up to a little more than the table itself. Trim the last column to match
        // rather than introduce a one-pixel horizontal scrollbar.
        const tableWidth = tableRef.current?.offsetWidth ?? 0;
        if (tableWidth && total > tableWidth) {
            const lastColumn = columns[columns.length - 1];
            measured[lastColumn] = Math.max(MIN_COLUMN_WIDTH, measured[lastColumn] - (total - tableWidth));
        }

        setColumnWidths(measured);
    }, [columns, hasColumnWidths]);

    const handleResizeStart = (event: ReactMouseEvent, column: string) => {
        event.preventDefault();
        event.stopPropagation();

        const startX = event.clientX;
        const startWidth = columnWidths[column] ?? headerRefs.current[column]?.offsetWidth ?? MIN_COLUMN_WIDTH;
        let dragged = false;

        const handleMouseMove = (moveEvent: MouseEvent) => {
            dragged = true;
            const width = Math.max(MIN_COLUMN_WIDTH, startWidth + moveEvent.clientX - startX);
            setColumnWidths(previous => ({ ...previous, [column]: width }));
        };

        const handleMouseUp = () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            document.body.classList.remove('column-resizing');

            if (dragged) {
                // When the pointer leaves the handle mid-drag the browser fires the
                // closing click on the nearest common ancestor - the <th> - where it
                // would sort the column that was just resized.
                justResizedRef.current = true;
                setTimeout(() => { justResizedRef.current = false; }, 0);
            }
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        document.body.classList.add('column-resizing');
    };

    const getCellValue = (record: any, column: string): any => {
        // First try to get the formatted value
        const formattedKey = `${column}@OData.Community.Display.V1.FormattedValue`;
        if (record[formattedKey] !== undefined) {
            return record[formattedKey];
        }
        
        // Fall back to raw value
        return record[column];
    };

    const highlightSearchText = (text: string, searchTerm: string): JSX.Element => {
        if (!searchTerm || !text) {
            return <span>{text || ''}</span>;
        }
        
        const textStr = String(text);
        // Remove wildcards from search term for highlighting
        const cleanSearchTerm = searchTerm.replace(/\*/g, '');
        
        if (!cleanSearchTerm) {
            return <span>{textStr}</span>;
        }
        
        // Use case sensitivity based on search options
        const flags = searchOptions.matchCase ? 'g' : 'gi';
        const regex = new RegExp(`(${cleanSearchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, flags);
        
        // Only highlight if the text actually contains the search term
        if (!regex.test(textStr)) {
            return <span>{textStr}</span>;
        }
        
        // Reset regex since test() advances the lastIndex
        regex.lastIndex = 0;
        const parts = textStr.split(regex);
        
        return (
            <span>
                {parts.map((part, index) => {
                    // Create a new regex for each test to avoid lastIndex issues
                    const testFlags = searchOptions.matchCase ? '' : 'i';
                    const testRegex = new RegExp(`^${cleanSearchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, testFlags);
                    return testRegex.test(part) ? 
                        <mark key={index} className="highlight">{part}</mark> : 
                        <span key={index}>{part}</span>;
                })}
            </span>
        );
    };

    const formatCellValue = (value: any, searchTerm: string): JSX.Element => {
        if (value == null) {
            return <span className="null-value">—</span>;
        }
        
        // Handle different data types
        if (typeof value === 'boolean') {
            const displayValue = value ? 'Yes' : 'No';
            return <span className={`boolean-value ${value}`}>{highlightSearchText(displayValue, searchTerm)}</span>;
        }
        
        if (typeof value === 'object') {
            // Handle lookup/reference objects
            if (value.name || value.Name) {
                return highlightSearchText(value.name || value.Name, searchTerm);
            }
            // Handle other objects by showing JSON
            return <span className="object-value">{highlightSearchText(JSON.stringify(value), searchTerm)}</span>;
        }
        
        // Handle dates
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
            try {
                const date = new Date(value);
                const dateStr = date.toLocaleString();
                return <span className="date-value">{highlightSearchText(dateStr, searchTerm)}</span>;
            } catch {
                return highlightSearchText(value, searchTerm);
            }
        }
        
        return highlightSearchText(String(value), searchTerm);
    };

    // Function to handle row click and open record in Dataverse
    const handleRowClick = async (record: any) => {
        if (!activeResult) return;
        
        console.log('Row clicked:', { 
            resultType: activeResult.type, 
            recordKeys: Object.keys(record),
            record: record,
            hasLink: 'Link' in record,
            linkValue: record.Link
        });
        
        try {
            // Check if this is a metadata result (either by type or presence of metadata-specific fields)
            const isMetadataResult = activeResult.type === 'metadata' || 
                                   record.Type || record['Match Location'] || record['Match Value'];
            
            if (isMetadataResult) {
                // For metadata results, we don't want to try opening as records
                // Check if we have a Link field
                if (record.Link && record.Link.trim()) {
                    try {
                        const newWindow = window.open(record.Link, '_blank');
                        if (newWindow) {
                            await window.toolboxAPI.utils.showNotification({
                                title: 'Maker Portal Opened',
                                body: 'Power Platform maker portal opened in new browser tab.',
                                type: 'success'
                            });
                        } else {
                            throw new Error('Popup blocked or failed to open window');
                        }
                    } catch (windowError) {
                        console.warn('Failed to open maker portal window, copying link to clipboard:', windowError);
                        
                        // Fallback: copy to clipboard
                        await window.toolboxAPI.utils.copyToClipboard(record.Link);
                        await window.toolboxAPI.utils.showNotification({
                            title: 'Maker Portal Link Copied',
                            body: 'Could not open maker portal directly. Link copied to clipboard - paste in browser to open.',
                            type: 'warning'
                        });
                    }
                } else {
                    // Metadata result but no link available
                    await window.toolboxAPI.utils.showNotification({
                        title: 'Metadata Item',
                        body: 'This is a metadata item. Power Platform maker portal links are not yet implemented.',
                        type: 'info'
                    });
                }
                return;
            }
            
            // For non-metadata results (actual records), continue with the existing logic
            
            // Try to find the entity ID in various possible fields
            const entityName = activeResult.entityName;
            const primaryIdField = `${entityName}id`;
            
            let entityId = record.id || record[primaryIdField] || record[`${entityName}_id`];
            
            // If we still don't have an ID, try to find any field ending with 'id'
            if (!entityId) {
                const idFields = Object.keys(record).filter(key => 
                    key.toLowerCase().endsWith('id') && 
                    record[key] && 
                    typeof record[key] === 'string' &&
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record[key])
                );
                
                if (idFields.length > 0) {
                    entityId = record[idFields[0]];
                }
            }
            
            if (!entityId) {
                console.warn('Could not find entity ID for record:', record);
                await window.toolboxAPI.utils.showNotification({
                    title: 'Cannot Open Record',
                    body: 'Could not determine the record ID to open.',
                    type: 'warning'
                });
                return;
            }
            
            // Ensure entityId is a valid GUID
            const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!guidRegex.test(entityId)) {
                console.warn('Invalid entity ID format:', entityId);
                await window.toolboxAPI.utils.showNotification({
                    title: 'Cannot Open Record',
                    body: 'Invalid record ID format.',
                    type: 'warning'
                });
                return;
            }
            
            // Open the record using PPTB API
            // Get the current connection to construct the record URL
            const connection = await window.toolboxAPI.connections.getActiveConnection();
            if (!connection || !connection.url) {
                await window.toolboxAPI.utils.showNotification({
                    title: 'Cannot Open Record',
                    body: 'No active Dataverse connection found.',
                    type: 'warning'
                });
                return;
            }
            
            // Construct the record URL
            const baseUrl = connection.url.replace(/\/$/, ''); // Remove trailing slash
            const recordUrl = `${baseUrl}/main.aspx?etn=${entityName}&id=${entityId}&pagetype=entityrecord`;
             
            try {
                const newWindow = window.open(recordUrl, '_blank');
                if (newWindow) {
                    await window.toolboxAPI.utils.showNotification({
                        title: 'Record Opened',
                        body: 'Record opened in new browser tab.',
                        type: 'success'
                    });
                } else {
                    throw new Error('Popup blocked or failed to open window');
                }
            } catch (windowError) {
                console.warn('Failed to open in new window, copying to clipboard:', windowError);
                
                // Final fallback: copy to clipboard
                await window.toolboxAPI.utils.copyToClipboard(recordUrl);
                await window.toolboxAPI.utils.showNotification({
                    title: 'Record URL Copied',
                    body: 'Could not open record directly. URL copied to clipboard - paste in browser to open.',
                    type: 'warning'
                });
            }
        } catch (error) {
            console.error('Error opening record:', error);
            await window.toolboxAPI.utils.showNotification({
                title: 'Error Opening Record',
                body: `Failed to open record: ${(error as Error).message}`,
                type: 'error'
            });
        }
    };

    // Helper function to check if a value contains the search term
    const containsSearchTerm = (value: any, searchTerm: string): boolean => {
        if (!searchTerm.trim() || value == null) return false;
        
        const cleanSearchTerm = searchTerm.replace(/\*/g, '');
        if (!cleanSearchTerm) return false;
        
        let textToSearch = '';
        if (typeof value === 'object') {
            textToSearch = value.name || value.Name || JSON.stringify(value);
        } else if (typeof value === 'boolean') {
            textToSearch = value ? 'Yes' : 'No';
        } else {
            textToSearch = String(value);
        }
        
        // Use case sensitivity based on search options
        const flags = searchOptions.matchCase ? '' : 'i';
        const regex = new RegExp(cleanSearchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
        return regex.test(textToSearch);
    };

    if (results.length === 0) {
        return (
            <div className="search-results">
                <div className="results-header">
                    <h3>Search Results</h3>
                </div>
                {isSearching ? (
                    <div className="loading-message">
                        <div className="spinner"></div>
                        <span>Searching...</span>
                    </div>
                ) : (
                    <div className="no-results">
                        {searchText ? 'No results found. Try adjusting your search criteria.' : 'Enter a search term and click Search to begin.'}
                    </div>
                )}
            </div>
        );
    }

    const totalRecords = results.reduce((sum, r) => sum + r.totalCount, 0);

    return (
        <div className="search-results">
            <div className="results-header">
                <h3>Search Results</h3>
                <div className="results-summary">
                    Found {results.length} result tab{results.length === 1 ? '' : 's'} with {totalRecords} total record{totalRecords === 1 ? '' : 's'}.
                    {isSearching && <span className="searching-indicator"> (Search in progress...)</span>}
                </div>
            </div>
            
            {/* Show errors if any */}
            {results.some(r => r.error) && (
                <div className="error-results">
                    {results.filter(r => r.error).map(result => (
                        <div key={result.id} className="error-item">
                            <strong>{result.tabTitle}:</strong> {result.error}
                        </div>
                    ))}
                </div>
            )}
            
            {/* Tabs for valid results */}
            {validResults.length > 0 && (
                <div className="results-tabs">
                    <div className="tab-headers">
                        {validResults.map((result, index) => (
                            <button
                                key={result.id}
                                className={`tab-header ${index === activeTabIndex ? 'active' : ''}`}
                                onClick={() => setActiveTabIndex(index)}
                            >
                                {result.tabTitle}
                            </button>
                        ))}
                    </div>
                    
                    {/* Active tab content */}
                    {activeResult && (
                        <div className="tab-content">
                            <div className="tab-info">
                                <span>{activeResult.totalCount} record{activeResult.totalCount === 1 ? '' : 's'} found</span>
                                {sortColumn && (
                                    <span className="sort-info">
                                        Sorted by {sortColumn} ({sortDirection === 'asc' ? 'A-Z' : 'Z-A'})
                                    </span>
                                )}
                            </div>
                            
                            {activeResult.records.length > 0 ? (
                                <div className="data-grid-container">
                                    <table
                                        ref={tableRef}
                                        className={`data-grid ${hasColumnWidths ? 'resizable' : ''}`}
                                        // table-layout: fixed is ignored unless the table has a
                                        // definite width, so size it to its columns explicitly
                                        style={hasColumnWidths ? { width: `${totalColumnWidth}px` } : undefined}
                                    >
                                        {hasColumnWidths && (
                                            <colgroup>
                                                {columns.map(column => (
                                                    <col key={column} style={{ width: `${columnWidths[column]}px` }} />
                                                ))}
                                            </colgroup>
                                        )}
                                        <thead>
                                            <tr>
                                                {columns.map(column => (
                                                    <th
                                                        key={column}
                                                        ref={element => { headerRefs.current[column] = element; }}
                                                        className={`sortable ${sortColumn === column ? `sorted-${sortDirection}` : ''}`}
                                                        onClick={() => handleSort(column)}
                                                        title={`Click to sort by ${column}`}
                                                    >
                                                        <div className="header-content">
                                                            <span>{column.replace(/@OData\.Community\.Display\.V1\.FormattedValue$/, '')}</span>
                                                            <span className="sort-indicator">
                                                                {sortColumn === column ?
                                                                    (sortDirection === 'asc' ? ' ↑' : ' ↓') :
                                                                    ' ↕'
                                                                }
                                                            </span>
                                                        </div>
                                                        <div
                                                            className="column-resizer"
                                                            role="separator"
                                                            aria-orientation="vertical"
                                                            aria-label={`Resize ${column} column`}
                                                            onMouseDown={event => handleResizeStart(event, column)}
                                                            onClick={event => event.stopPropagation()}
                                                            title="Drag to resize column"
                                                        />
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {sortedRecords.map((record, recordIndex) => (
                                                <tr 
                                                    key={record.id || recordIndex} 
                                                    className="data-row clickable-row"
                                                    onClick={() => handleRowClick(record)}
                                                    title="Click to open record in Dataverse"
                                                >
                                                    {columns.map(column => {
                                                        const cellValue = getCellValue(record, column);
                                                        return (
                                                            <td 
                                                                key={column} 
                                                                className={`data-cell ${
                                                                    containsSearchTerm(record[column], searchText) ? 'has-highlight' : ''
                                                                }`}
                                                            >
                                                                {formatCellValue(cellValue, searchText)}
                                                            </td>
                                                        );
                                                    })}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            ) : (
                                <div className="no-records">
                                    No records to display in this result set.
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}