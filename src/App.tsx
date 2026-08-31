import { useCallback, useState, useEffect, useRef } from 'react';
import { useConnection, useToolboxEvents } from './hooks/useToolboxAPI';
import { EntitySelectionPanel } from './components/EntitySelectionPanel';
import { SearchControlsPanel } from './components/SearchControlsPanel';
import { SearchResults } from './components/SearchResults';
import { SearchProgressIndicator } from './components/SearchProgressIndicator';
import { SearchMode, SearchOptions, SearchResult, SearchProgress, SearchCallbacks, SearchCancellation } from './types/search';
import { UniversalSearchService } from './services/UniversalSearchService';

function App() {
    const { connection, isLoading, refreshConnection } = useConnection();
    const [searchMode, setSearchMode] = useState<SearchMode>('records');
    const [searchText, setSearchText] = useState('*');
    const [searchService] = useState(() => new UniversalSearchService());
    const [searchOptions, setSearchOptions] = useState<SearchOptions>({
        matchCase: false,
        searchPicklists: false,
        searchLookups: false,
        searchAttributes: true,
        searchEntities: true,
        searchRelationships: false,
        searchFormsViews: false,
        alwaysGetLatestSolution: false
    });
    const [selectedEntities, setSelectedEntities] = useState<string[]>([]);
    const [selectedSolution, setSelectedSolution] = useState<string | null>(null);
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [isLeftPanelCollapsed, setIsLeftPanelCollapsed] = useState(false);
    const [isFullScreen, setIsFullScreen] = useState(false);
    const [searchProgress, setSearchProgress] = useState<SearchProgress>({
        currentEntity: '',
        entitiesCompleted: 0,
        totalEntities: 0,
        isSearching: false
    });
    const searchCancellationRef = useRef<SearchCancellation>({
        isCancelled: false,
        cancel: () => {}
    });

    const toggleFullScreen = () => {
        const newFullScreen = !isFullScreen;
        setIsFullScreen(newFullScreen);
        setIsLeftPanelCollapsed(newFullScreen);
    };

    // Keyboard shortcut for fullscreen toggle
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'F11' || (e.ctrlKey && e.key === 'Enter')) {
                e.preventDefault();
                toggleFullScreen();
            }
        };
        
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isFullScreen]);

    // Theme application utility
    const applyTheme = useCallback(async () => {
        try {
            if (window.toolboxAPI?.utils?.getCurrentTheme) {
                const theme = await window.toolboxAPI.utils.getCurrentTheme();
                console.log('Applying theme:', theme);
                
                // Apply theme to document
                if (theme === 'dark' || theme.includes('dark')) {
                    document.documentElement.setAttribute('data-theme', 'dark');
                } else {
                    document.documentElement.removeAttribute('data-theme');
                }
            } else {
                console.log('Theme API not available, using default theme');
            }
        } catch (error) {
            console.error('Error applying theme:', error);
            // Fallback to light theme
            document.documentElement.removeAttribute('data-theme');
        }
    }, []);

    // Theme detection and application
    useEffect(() => {
        // Apply theme on initial load
        applyTheme();
    }, [applyTheme]);

    // Handle platform events
    const handleEvent = useCallback(
        (event: string, _data: any) => {
            switch (event) {
                case 'connection:updated':
                case 'connection:created':
                    refreshConnection();
                    break;

                case 'connection:deleted':
                    refreshConnection();
                    setSearchResults([]);
                    break;

                case 'settings:updated':
                    // Refresh theme when settings change
                    applyTheme();
                    break;
            }
        },
        [refreshConnection, applyTheme]
    );

    useToolboxEvents(handleEvent);

    const handleSearch = async () => {
        if (!searchText.trim() || !connection) return;
        
        // Reset state
        setIsSearching(true);
        setSearchResults([]);
        setSearchProgress({
            currentEntity: '',
            entitiesCompleted: 0,
            totalEntities: 0,
            isSearching: true
        });
        
        // Create new cancellation token
        const cancellation: SearchCancellation = {
            isCancelled: false,
            cancel: () => {
                cancellation.isCancelled = true;
                setIsSearching(false);
                setSearchProgress(prev => ({ ...prev, isSearching: false }));
            }
        };
        searchCancellationRef.current = cancellation;
        
        // Track accumulated results
        const accumulatedResults: SearchResult[] = [];
        
        // Setup callbacks for progressive updates
        const callbacks: SearchCallbacks = {
            onProgress: (progress) => {
                setSearchProgress(progress);
            },
            onResultUpdate: (result) => {
                // Only show successful results with data immediately - don't show error results as tabs
                if (!result.error && result.totalCount > 0) {
                    setSearchResults(prev => {
                        // Check if this result already exists (update case)
                        const existingIndex = prev.findIndex(r => r.id === result.id);
                        if (existingIndex >= 0) {
                            // Update existing result
                            const newResults = [...prev];
                            newResults[existingIndex] = result;
                            return newResults;
                        } else {
                            // Add new result
                            return [...prev, result];
                        }
                    });
                }
                
                // Track all results (including errors) for final summary
                const existingIndex = accumulatedResults.findIndex(r => r.id === result.id);
                if (existingIndex >= 0) {
                    accumulatedResults[existingIndex] = result;
                } else {
                    accumulatedResults.push(result);
                }
            },
            onComplete: (allResults) => {
                // Only show successful results with data in the final UI
                const successfulResults = allResults.filter(r => !r.error && r.totalCount > 0);
                setSearchResults(successfulResults);
                setIsSearching(false);
                
                const emptyResults = allResults.filter(r => !r.error && r.totalCount === 0);
                const errorResults = allResults.filter(r => r.error);
                const totalRecords = successfulResults.reduce((sum, result) => sum + result.totalCount, 0);
                
                // Log detailed errors to console for debugging
                if (errorResults.length > 0) {
                    console.group('Search Errors Details:');
                    errorResults.forEach(result => {
                        console.error(`${result.entityName}: ${result.error}`);
                    });
                    console.groupEnd();
                }
                
                let notificationBody = '';
                let notificationType: 'success' | 'warning' | 'error' = 'success';
                
                if (cancellation.isCancelled) {
                    notificationBody = `Search cancelled. Found ${totalRecords} results in ${successfulResults.length} entities.`;
                    notificationType = 'warning';
                } else if (successfulResults.length === 0 && errorResults.length === 0) {
                    notificationBody = `No results found in ${emptyResults.length} entities searched.`;
                    notificationType = 'warning';
                } else if (successfulResults.length === 0 && errorResults.length > 0) {
                    notificationBody = `No results found. ${errorResults.length} entities had search errors.`;
                    notificationType = 'error';
                } else {
                    notificationBody = `Found ${totalRecords} results in ${successfulResults.length} entities.`;
                    if (errorResults.length > 0) {
                        notificationBody += ` (${errorResults.length} entities had errors - check console for details)`;
                        notificationType = 'warning';
                    }
                }
                
                window.toolboxAPI.utils.showNotification({
                    title: cancellation.isCancelled ? 'Search Cancelled' : 'Search Complete',
                    body: notificationBody,
                    type: notificationType
                });
            },
            onError: (error) => {
                console.error('Search error:', error);
                setIsSearching(false);
                setSearchProgress(prev => ({ ...prev, isSearching: false }));
                
                window.toolboxAPI.utils.showNotification({
                    title: 'Search Error',
                    body: error.message,
                    type: 'error'
                });
            }
        };
        
        try {
            await searchService.searchProgressive(
                searchText,
                searchMode,
                selectedEntities,
                selectedSolution,
                searchOptions,
                callbacks,
                cancellation
            );
        } catch (error) {
            // Error handling is already done in callbacks.onError
            console.error('Search failed:', error);
        }
    };

    const handleCancelSearch = () => {
        if (searchCancellationRef.current) {
            searchCancellationRef.current.cancel();
        }
    };

    if (!connection && !isLoading) {
        return (
            <div className="app">
                <header className="header">
                    <h1>🔍 Universal Search</h1>
                    <p className="subtitle">Search across records, metadata, and solution components</p>
                </header>
                <div className="error-message">
                    <strong>⚠️ No Connection</strong><br/>
                    Please connect to a Dataverse environment first.
                </div>
            </div>
        );
    }

    return (
        <div className={`app ${isFullScreen ? 'fullscreen' : ''}`}>
            <div className="main-container">
                <div className={`left-panel ${isLeftPanelCollapsed ? 'collapsed' : ''}`}>
                    <EntitySelectionPanel
                        connection={connection}
                        searchMode={searchMode}
                        selectedEntities={selectedEntities}
                        selectedSolution={selectedSolution}
                        onEntitiesChange={setSelectedEntities}
                        onSolutionChange={setSelectedSolution}
                    />
                </div>
                
                <div className={`right-panel ${isLeftPanelCollapsed ? 'expanded' : ''}`}>
                    {/* Panel toggle arrow - fixed position, changes direction */}
                    <button 
                        className="panel-toggle-arrow"
                        onClick={() => setIsLeftPanelCollapsed(!isLeftPanelCollapsed)}
                        title={isLeftPanelCollapsed ? 'Show entity selection panel' : 'Hide entity selection panel'}
                    >
                        {isLeftPanelCollapsed ? '▶' : '◀'}
                    </button>
                    <SearchControlsPanel
                        searchMode={searchMode}
                        searchText={searchText}
                        searchOptions={searchOptions}
                        isSearching={isSearching}
                        onModeChange={setSearchMode}
                        onSearchTextChange={setSearchText}
                        onOptionsChange={setSearchOptions}
                        onSearch={handleSearch}
                    />
                    
                    {/* Show progress indicator at top when searching with no results yet */}
                    {searchProgress.isSearching && searchResults.length === 0 && (
                        <SearchProgressIndicator
                            progress={searchProgress}
                            onCancel={handleCancelSearch}
                            position="top"
                        />
                    )}
                    
                    <SearchResults
                        results={searchResults}
                        searchText={searchText}
                        isSearching={isSearching}
                        searchOptions={searchOptions}
                    />
                    
                    {/* Show progress indicator at bottom when searching with results visible */}
                    {searchProgress.isSearching && searchResults.length > 0 && (
                        <SearchProgressIndicator
                            progress={searchProgress}
                            onCancel={handleCancelSearch}
                            position="bottom"
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

export default App;