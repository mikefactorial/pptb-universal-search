# PPTB Headless Config Parameters

This document explains all headless-related parameters in `pptb.config.json`, plus how input values are interpreted by the headless entrypoint.

## Where Headless Is Configured

Headless behavior is controlled in two top-level sections:

- `invocation`: defines input/output schema shown to callers.
- `agents`: defines runtime behavior for invokable agent execution, including headless mode.

---

## `invocation` Section

### `invocation.version`
- Type: `string`
- Purpose: schema version for invocation metadata.
- Current value: `"1.0.0"`

### `invocation.capabilities`
- Type: `string[]`
- Purpose: advertises what the tool can do.
- Current value: `["dataverse-search"]`

### `invocation.prefill.properties`
This describes the input payload fields for headless invocation.

#### `searchTerm`
- Type: `string`
- Required: yes (runtime requirement)
- Purpose: primary explicit term to search.
- Behavior:
  - Trimmed.
  - If empty or missing, invocation throws: `A non-empty searchTerm is required for headless invocation.`

#### `scope`
- Type: `string[]`
- Allowed values: `records`, `metadata`, `solutionComponents`
- Default in config: `["records"]`
- Runtime behavior:
  - Invalid values are ignored.
  - If omitted/empty, defaults to `records`.

#### `entities`
- Type: `string` or serialized string array
- Required: optional
- Purpose: limits search to specific Dataverse logical entity names.
- Runtime behavior:
  - Values are trimmed.
  - Accepts logical names (`account`) and display names (`Account`).
  - Provided display names are resolved to logical names before search execution.
  - Supports Inspector-style serialized array strings, for example:
    - `["account","contact"]`
    - `"[\"account\"]"`
    - `account,contact`
    - `account` (single entity as plain string)
  - If still empty and record search runs, the tool fetches all entities metadata and searches across all entities.

#### `lookupField`
- Type: `string`
- Required: optional
- Purpose: lookup attribute logical name for lookup-based record search.

#### `lookupTargetEntity`
- Type: `string`
- Required: optional
- Purpose: target entity logical name used with `lookupField`.

#### `lookupTargetPrimaryNameField`
- Type: `string`
- Required: optional
- Purpose: target primary-name attribute for lookup filtering.
- Default behavior: falls back to `fullname` when omitted.

#### `maxResults`
- Type: `number`
- Default in config: `50`
- Runtime behavior:
  - Non-number/NaN => default `50`
  - Clamped to integer range `1..200`

#### `matchCase`
- Type: `boolean`
- Default in config: `false`
- Runtime behavior:
  - `true` enables case-sensitive match detection in result context extraction.
  - Any non-`true` value is treated as `false`.

---

## `invocation.returnTopic.properties`

This defines the response shape returned by headless invocation.

### `totalMatches`
- Type: `number`
- Meaning: total matched records/items across returned result groups.

### `results`
- Type: `array`
- Meaning: raw `SearchResult[]` objects produced by `UniversalSearchService` (not flattened).
- Item fields:
  - `id` (`string`): result bucket identifier
  - `type` (`string`): source category (`records`, `metadata`, `solution`)
  - `entityName` (`string`): Dataverse entity logical name
  - `tabTitle` (`string`): display title used by the tool
  - `totalCount` (`number`): number of records in this bucket
  - `records` (`array<object>`): full record payload returned by the tool
  - `error` (`string`, optional): per-bucket error details

---

## `agents` Section (Headless Runtime)

### `agents.version`
- Type: `string`
- Current value: `"1.0.0"`

### `agents.invokable`
- Type: `boolean`
- Current value: `true`
- Purpose: marks this as invokable by platform tooling.

### `agents.modes`
- Type: `string[]`
- Current values: `["one-way", "two-way"]`
- Purpose: allowed interaction modes.

### `agents.defaultMode`
- Type: `string`
- Current value: `"two-way"`
- Purpose: default interaction mode when caller does not specify one.

### `agents.timeoutMS`
- Type: `number`
- Current value: `180000`
- Purpose: max invocation runtime (milliseconds).

### `agents.headless`
- Type: `boolean`
- Current value: `true`
- Purpose: enables headless execution support.

### `agents.executionModes`
- Type: `string[]`
- Current values: `["windowed", "headless"]`
- Purpose: declares supported execution styles.

### `agents.defaultExecutionMode`
- Type: `string`
- Current value: `"headless"`
- Purpose: default execution style.

### `agents.headlessEntry`
- Type: `string`
- Current value: `"dist/headless.cjs"`
- Purpose: built entry file used for headless invocation.

---

## Runtime Context Passed to `invokeHeadless(...)`

Not configured in `pptb.config.json`, but available from the host at runtime:

- `toolId?: string`
- `toolName?: string`
- `invocationMode?: "one-way" | "two-way"`
- `authToken?: string`
- `updateProgress?: (percent: number, message: string) => void`
- `logger?: { debug?, info?, warn?, error? }`

This logger surface is what allows the MCP Server invocation UI to show live tool logs.

---

## Example Input Payload

```json
{
  "searchTerm": "contoso",
  "scope": ["records", "solutionComponents"],
  "entities": "account,contact",
  "maxResults": 50,
  "matchCase": false
}
```

## Example Lookup Input Payload

```json
{
  "searchTerm": "Jane",
  "scope": ["records"],
  "entities": ["account"],
  "lookupField": "primarycontactid",
  "lookupTargetEntity": "contact",
  "lookupTargetPrimaryNameField": "fullname"
}
```
