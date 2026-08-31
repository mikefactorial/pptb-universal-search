import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchResults } from './SearchResults';
import { SearchOptions } from '../types/search';

// Match the actual interface from SearchResults.tsx
interface SearchResult {
  id: string;
  entityName: string;
  tabTitle: string;
  type: string;
  records: any[];
  totalCount: number;
  error?: string;
}

describe('SearchResults', () => {
  const defaultSearchOptions: SearchOptions = {
    matchCase: false,
    searchPicklists: false,
    searchLookups: false,
    searchAttributes: true,
    searchEntities: true,
    searchRelationships: false,
    searchFormsViews: false,
    alwaysGetLatestSolution: false
  };

  const defaultProps = {
    results: [] as SearchResult[],
    searchText: '',
    isSearching: false,
    searchOptions: defaultSearchOptions
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic Rendering', () => {
    it('should render results header', () => {
      render(<SearchResults {...defaultProps} />);
      
      expect(screen.getByText(/search results/i)).toBeInTheDocument();
    });

    it('should show prompt when no search text and not searching', () => {
      render(<SearchResults {...defaultProps} searchText="" isSearching={false} />);
      
      expect(screen.getByText(/enter a search term and click search to begin/i)).toBeInTheDocument();
    });

    it('should show searching message when searching', () => {
      render(<SearchResults {...defaultProps} isSearching={true} />);
      
      expect(screen.getByText(/searching/i)).toBeInTheDocument();
    });

    it('should show no results message when search complete with no results', () => {
      render(<SearchResults {...defaultProps} searchText="test" isSearching={false} results={[]} />);
      
      expect(screen.getByText(/no results found/i)).toBeInTheDocument();
    });
  });

  describe('Results Display', () => {
    it('should render results tabs when results exist', () => {
      const mockResults: SearchResult[] = [
        {
          id: '1',
          entityName: 'account',
          tabTitle: 'Accounts (5)',
          type: 'record',
          records: [
            { id: 'acc1', name: 'Test Account 1', accountnumber: '001' },
            { id: 'acc2', name: 'Test Account 2', accountnumber: '002' }
          ],
          totalCount: 5
        },
        {
          id: '2',
          entityName: 'contact',
          tabTitle: 'Contacts (3)',
          type: 'record',
          records: [
            { id: 'con1', firstname: 'John', lastname: 'Doe' },
            { id: 'con2', firstname: 'Jane', lastname: 'Smith' }
          ],
          totalCount: 3
        }
      ];

      render(<SearchResults {...defaultProps} results={mockResults} searchText="test" />);
      
      expect(screen.getByText('Accounts (5)')).toBeInTheDocument();
      expect(screen.getByText('Contacts (3)')).toBeInTheDocument();
    });

    it('should show records in table format', () => {
      const mockResults: SearchResult[] = [
        {
          id: '1',
          entityName: 'account',
          tabTitle: 'Accounts (2)',
          type: 'record',
          records: [
            { id: 'acc1', name: 'Test Account 1', accountnumber: '001' },
            { id: 'acc2', name: 'Test Account 2', accountnumber: '002' }
          ],
          totalCount: 2
        }
      ];

      render(<SearchResults {...defaultProps} results={mockResults} searchText="test" />);
      
      expect(screen.getByRole('table')).toBeInTheDocument();
      // Text is highlighted, so check for the mark elements (there are multiple)
      expect(screen.getAllByText('Test', { selector: 'mark.highlight' })).toHaveLength(2);
      expect(screen.getByText('Account 1')).toBeInTheDocument();
      expect(screen.getByText('Account 2')).toBeInTheDocument();
    });

    it('should handle empty record sets', () => {
      // Empty results array should show the no search message
      render(<SearchResults {...defaultProps} results={[]} searchText="test" />);
      
      expect(screen.getByText(/no results found/i)).toBeInTheDocument();
    });

    it('should filter out results with errors', () => {
      const mockResults: SearchResult[] = [
        {
          id: '1',
          entityName: 'account',
          tabTitle: 'Accounts',
          type: 'record',
          records: [{ id: 'acc1', name: 'Test Account' }],
          totalCount: 1
        },
        {
          id: '2',
          entityName: 'contact',
          tabTitle: 'Contacts',
          type: 'record',
          records: [],
          totalCount: 0,
          error: 'Access denied'
        }
      ];

      render(<SearchResults {...defaultProps} results={mockResults} searchText="test" />);
      
      // Should only show the account tab, not the contact tab with error
      expect(screen.getByText('Accounts')).toBeInTheDocument();
      expect(screen.queryByText('Contacts')).not.toBeInTheDocument();
    });
  });

  describe('Search Text Highlighting', () => {
    it('should highlight search terms in results', () => {
      const mockResults: SearchResult[] = [
        {
          id: '1',
          entityName: 'account',
          tabTitle: 'Accounts (1)',
          type: 'record',
          records: [
            { id: 'acc1', name: 'Test Company Inc', accountnumber: '001' }
          ],
          totalCount: 1
        }
      ];

      render(<SearchResults {...defaultProps} results={mockResults} searchText="test" />);
      
      // Should highlight "test" in "Test Company Inc"
      const highlightedElements = document.querySelectorAll('.highlight');
      expect(highlightedElements.length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed results gracefully', () => {
      const malformedResults: any[] = [
        {
          id: '1',
          entityName: 'account',
          tabTitle: 'Accounts',
          type: 'record',
          records: [{ id: 'acc1', name: 'Test Account' }], // Valid records array
          totalCount: 1
        }
      ];

      expect(() => {
        render(<SearchResults {...defaultProps} results={malformedResults} searchText="test" />);
      }).not.toThrow();
    });
  });

  describe('Column Resizing', () => {
    const mockResults: SearchResult[] = [
      {
        id: '1',
        entityName: 'account',
        tabTitle: 'Accounts (2)',
        type: 'record',
        records: [
          { id: 'acc1', name: 'Test Account 1', accountnumber: '001' },
          { id: 'acc2', name: 'Test Account 2', accountnumber: '002' }
        ],
        totalCount: 2
      }
    ];

    // jsdom reports every offsetWidth as 0, which the component treats as
    // "not measurable yet" and leaves the grid on auto layout.
    beforeEach(() => {
      Object.defineProperty(HTMLTableCellElement.prototype, 'offsetWidth', {
        configurable: true,
        value: 150
      });
    });

    afterEach(() => {
      delete (HTMLTableCellElement.prototype as any).offsetWidth;
    });

    it('should render a resize handle for every column', () => {
      render(<SearchResults {...defaultProps} results={mockResults} searchText="test" />);

      const handles = document.querySelectorAll('.column-resizer');
      const headers = document.querySelectorAll('.data-grid th');

      expect(handles).toHaveLength(headers.length);
      expect(handles.length).toBeGreaterThan(0);
    });

    it('should widen a column when its handle is dragged right', () => {
      render(<SearchResults {...defaultProps} results={mockResults} searchText="test" />);

      const handle = document.querySelectorAll('.column-resizer')[0];
      fireEvent.mouseDown(handle, { clientX: 100 });
      fireEvent.mouseMove(document, { clientX: 140 });
      fireEvent.mouseUp(document);

      const firstColumn = document.querySelectorAll('colgroup col')[0] as HTMLElement;
      expect(firstColumn.style.width).toBe('190px');
    });

    it('should give the table an explicit width so fixed layout applies', () => {
      render(<SearchResults {...defaultProps} results={mockResults} searchText="test" />);

      // Two columns (name, accountnumber) measured at 150px each
      const table = screen.getByRole('table') as HTMLTableElement;
      expect(table).toHaveClass('resizable');
      expect(table.style.width).toBe('300px');
    });

    it('should grow the table width along with the column', () => {
      render(<SearchResults {...defaultProps} results={mockResults} searchText="test" />);

      const handle = document.querySelectorAll('.column-resizer')[0];
      fireEvent.mouseDown(handle, { clientX: 100 });
      fireEvent.mouseMove(document, { clientX: 140 });
      fireEvent.mouseUp(document);

      const table = screen.getByRole('table') as HTMLTableElement;
      expect(table.style.width).toBe('340px');
    });

    it('should not sort the grid when a resize handle is clicked', () => {
      render(<SearchResults {...defaultProps} results={mockResults} searchText="test" />);

      const handle = document.querySelectorAll('.column-resizer')[0];
      fireEvent.mouseDown(handle, { clientX: 100 });
      fireEvent.click(handle);
      fireEvent.mouseUp(document);

      expect(screen.queryByText(/sorted by/i)).not.toBeInTheDocument();
    });

    it('should not sort when the click closing a drag lands on the header', () => {
      render(<SearchResults {...defaultProps} results={mockResults} searchText="test" />);

      const handle = document.querySelectorAll('.column-resizer')[0];
      const header = document.querySelectorAll('.data-grid th')[0];

      fireEvent.mouseDown(handle, { clientX: 100 });
      fireEvent.mouseMove(document, { clientX: 140 });
      fireEvent.mouseUp(document);
      // The browser closes a drag with a click on the common ancestor of the
      // mousedown and mouseup targets, which is the <th> carrying the sort handler
      fireEvent.click(header);

      expect(screen.queryByText(/sorted by/i)).not.toBeInTheDocument();
    });

    it('should still sort on a plain header click after a resize', async () => {
      render(<SearchResults {...defaultProps} results={mockResults} searchText="test" />);

      const handle = document.querySelectorAll('.column-resizer')[0];
      const header = document.querySelectorAll('.data-grid th')[0];

      fireEvent.mouseDown(handle, { clientX: 100 });
      fireEvent.mouseMove(document, { clientX: 140 });
      fireEvent.mouseUp(document);
      fireEvent.click(header);

      // The suppression lasts only for that trailing click
      await new Promise(resolve => setTimeout(resolve, 0));
      fireEvent.click(header);

      expect(screen.getByText(/sorted by/i)).toBeInTheDocument();
    });

    it('should clamp a column to the minimum width when dragged far left', () => {
      render(<SearchResults {...defaultProps} results={mockResults} searchText="test" />);

      const handle = document.querySelectorAll('.column-resizer')[0];
      fireEvent.mouseDown(handle, { clientX: 300 });
      fireEvent.mouseMove(document, { clientX: 0 });
      fireEvent.mouseUp(document);

      const firstColumn = document.querySelectorAll('colgroup col')[0] as HTMLElement;
      expect(firstColumn.style.width).toBe('60px');
    });
  });
});
