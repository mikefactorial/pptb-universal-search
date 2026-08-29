import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeHeadless, normalizeInput } from './headless';
import { mockDataverseAPI } from './test/setup';

describe('headless invocation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('uses searchTerm and defaults to records scope', () => {
        const normalized = normalizeInput({
            searchTerm: 'contoso'
        });

        expect(normalized.searchTerm).toBe('contoso');
        expect(normalized.scope).toEqual(['records']);
        expect(normalized.entities).toEqual([]);
    });

    it('normalizes inspector-serialized arrays and scalars', () => {
        const normalized = normalizeInput({
            searchTerm: 'contoso',
            scope: '["records","metadata"]',
            entities: '"[\\"account\\"]"',
            maxResults: '25',
            matchCase: 'true'
        });

        expect(normalized.scope).toEqual(['records', 'metadata']);
        expect(normalized.entities).toEqual(['account']);
        expect(normalized.maxResults).toBe(25);
        expect(normalized.matchCase).toBe(true);
    });

    it('normalizes deeply escaped inspector entities values', () => {
        let deeplyEscaped = '["account"]';
        for (let i = 0; i < 12; i += 1) {
            deeplyEscaped = JSON.stringify(deeplyEscaped);
        }

        const normalized = normalizeInput({
            searchTerm: 'contoso',
            entities: deeplyEscaped
        });

        expect(normalized.entities).toEqual(['account']);
    });

    it('supports lookup searches for accounts', async () => {
        mockDataverseAPI.getEntityMetadata.mockImplementation(async (entityName: string) => {
            if (entityName === 'account') {
                return {
                    LogicalName: 'account',
                    DisplayName: { LocalizedLabels: [{ Label: 'Account' }] }
                };
            }

            return {
                LogicalName: 'contact',
                PrimaryIdAttribute: 'contactid',
                PrimaryNameAttribute: 'fullname'
            };
        });
        mockDataverseAPI.getEntityRelatedMetadata.mockResolvedValue({
            value: [
                {
                    LogicalName: 'primarycontactid',
                    AttributeType: 'Lookup',
                    IsValidForRead: true,
                    Targets: ['contact']
                }
            ]
        });
        mockDataverseAPI.fetchXmlQuery.mockImplementation(async (fetchXml: string) => {
            expect(fetchXml).toContain('link-entity');
            expect(fetchXml).toContain('attribute="fullname"');
            expect(fetchXml).toContain('value="%Jane%"');

            return {
                value: [
                    {
                        accountid: 'account-1',
                        name: 'Contoso Ltd'
                    }
                ]
            };
        });

        const result = await invokeHeadless(
            {
                searchTerm: 'Jane',
                entities: 'account',
                lookupField: 'primarycontactid',
                lookupTargetEntity: 'contact',
                lookupTargetPrimaryNameField: 'fullname'
            },
            { logger: { info: vi.fn(), error: vi.fn() }, updateProgress: vi.fn() }
        );

        expect(result.totalMatches).toBe(1);
        expect(result.results).toHaveLength(1);
        expect(result.results[0]).toEqual(expect.objectContaining({
            type: 'records',
            entityName: 'account',
            totalCount: 1,
            records: [
                expect.objectContaining({
                    id: 'account-1',
                    accountid: 'account-1',
                    name: 'Contoso Ltd'
                })
            ]
        }));
    });

    it('combines record and solution-component results from explicit scope', async () => {
        const logger = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        };

        mockDataverseAPI.getAllEntitiesMetadata.mockResolvedValue({
            value: [{ LogicalName: 'account' }]
        });
        mockDataverseAPI.getEntityMetadata.mockImplementation(async (entityName: string) => {
            if (entityName !== 'account') {
                return null;
            }

            return {
                LogicalName: 'account',
                ObjectTypeCode: 1,
                MetadataId: 'metadata-1',
                DisplayName: {
                    LocalizedLabels: [{ Label: 'Contoso Account' }],
                    UserLocalizedLabel: { Label: 'Contoso Account' }
                }
            };
        });
        mockDataverseAPI.getEntityRelatedMetadata.mockResolvedValue({
            value: [
                {
                    LogicalName: 'name',
                    AttributeType: 'String',
                    IsValidForRead: true
                }
            ]
        });
        mockDataverseAPI.fetchXmlQuery.mockImplementation(async (fetchXml: string) => {
            if (fetchXml.includes('<entity name="organization">')) {
                return {
                    value: [
                        {
                            orgdborgsettings: '<settings><ProjectHostEnvironmentId>env-1</ProjectHostEnvironmentId></settings>'
                        }
                    ]
                };
            }

            if (fetchXml.includes('<entity name="account">')) {
                return {
                    value: [
                        {
                            accountid: 'account-1',
                            name: 'Contoso'
                        }
                    ]
                };
            }

            return { value: [] };
        });

        const result = await invokeHeadless(
            {
                searchTerm: 'contoso',
                scope: ['records', 'solutionComponents']
            },
            { logger }
        );

        expect(result.totalMatches).toBeGreaterThanOrEqual(2);
        expect(result.results).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'records',
                entityName: 'account',
                totalCount: 1,
                records: [
                    expect.objectContaining({
                        id: 'account-1',
                        name: 'Contoso'
                    })
                ]
            }),
            expect.objectContaining({
                type: 'metadata',
                entityName: 'account'
            })
        ]));

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Starting headless invocation'));
        expect(logger.warn).toHaveBeenCalledWith('No entity list provided. Falling back to all available entities.');
        expect(logger.debug).toHaveBeenCalled();
    });

    it('resolves entities from display names to logical names', async () => {
        mockDataverseAPI.getAllEntitiesMetadata.mockResolvedValue({
            value: [
                {
                    LogicalName: 'account',
                    DisplayName: {
                        LocalizedLabels: [{ Label: 'Account' }],
                        UserLocalizedLabel: { Label: 'Account' }
                    }
                }
            ]
        });
        mockDataverseAPI.getEntityMetadata.mockResolvedValue({
            LogicalName: 'account',
            ObjectTypeCode: 1,
            MetadataId: 'metadata-1',
            DisplayName: {
                LocalizedLabels: [{ Label: 'Account' }],
                UserLocalizedLabel: { Label: 'Account' }
            }
        });
        mockDataverseAPI.getEntityRelatedMetadata.mockResolvedValue({
            value: [
                {
                    LogicalName: 'name',
                    AttributeType: 'String',
                    IsValidForRead: true
                }
            ]
        });
        mockDataverseAPI.fetchXmlQuery.mockResolvedValue({
            value: [
                {
                    accountid: 'account-1',
                    name: 'Contoso'
                }
            ]
        });

        const result = await invokeHeadless({
            searchTerm: 'contoso',
            entities: 'Account',
            scope: ['records']
        });

        expect(result.totalMatches).toBe(1);
        expect(result.results[0]).toEqual(expect.objectContaining({
            entityName: 'account',
            records: [
                expect.objectContaining({
                    id: 'account-1',
                    accountid: 'account-1'
                })
            ]
        }));
    });

    it('resolves spaced/plural display-like input to prefixed logical entity names', async () => {
        mockDataverseAPI.getAllEntitiesMetadata.mockResolvedValue({
            value: [
                {
                    LogicalName: 'pmav_superhero'
                }
            ]
        });
        mockDataverseAPI.getEntityMetadata.mockResolvedValue({
            LogicalName: 'pmav_superhero',
            ObjectTypeCode: 1,
            MetadataId: 'metadata-1',
            DisplayName: {
                LocalizedLabels: [{ Label: 'Super Heros' }],
                UserLocalizedLabel: { Label: 'Super Heros' }
            }
        });
        mockDataverseAPI.getEntityRelatedMetadata.mockResolvedValue({
            value: [
                {
                    LogicalName: 'name',
                    AttributeType: 'String',
                    IsValidForRead: true
                }
            ]
        });
        mockDataverseAPI.fetchXmlQuery.mockResolvedValue({
            value: [
                {
                    pmav_superheroid: 'hero-1',
                    name: 'Comics Hero'
                }
            ]
        });

        const result = await invokeHeadless({
            searchTerm: 'comics',
            scope: ['records'],
            entities: ['super heros'],
            maxResults: 50,
            matchCase: false
        });

        expect(result.totalMatches).toBe(1);
        expect(result.results[0]).toEqual(expect.objectContaining({
            entityName: 'pmav_superhero',
            records: [
                expect.objectContaining({
                    id: 'hero-1',
                    pmav_superheroid: 'hero-1',
                    name: 'Comics Hero'
                })
            ]
        }));
    });
});
