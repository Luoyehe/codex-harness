import { existsSync, readFileSync } from 'node:fs';
import { Ajv, type ValidateFunction } from 'ajv';
import { createRequire } from 'node:module';
import type { FormatsPlugin } from 'ajv-formats';
import { canonical, DeliveryError, jsonBytes, object, type JsonObject, type JsonValue } from './types.js';
import { outputSchema } from './structured-output.js';
import { permissionsWithinRequest } from './permission-grants.js';

const schemaRelative = 'protocol/json/codex_app_server_protocol.v2.schemas.json';
const sourceSchema = new URL(`../../${schemaRelative}`, import.meta.url);
const schemaFile = existsSync(sourceSchema) ? sourceSchema : new URL(`../../../${schemaRelative}`, import.meta.url);
const document = JSON.parse(readFileSync(schemaFile, 'utf8')) as { definitions: Record<string, object> };
const ajv = new Ajv({ strict: false, allErrors: false, ownProperties: true });
for (const [name, min, max] of [
  ['uint', 0, Number.MAX_SAFE_INTEGER], ['uint16', 0, 65535], ['uint32', 0, 4294967295], ['uint64', 0, Number.MAX_SAFE_INTEGER],
  ['int32', -2147483648, 2147483647], ['int64', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
] as const) ajv.addFormat(name, { type: 'number', validate: value => Number.isSafeInteger(value) && value >= min && value <= max });
ajv.addFormat('double', { type: 'number', validate: Number.isFinite });
const validators = new Map<string, ValidateFunction>();
const addFormats = createRequire(import.meta.url)('ajv-formats') as FormatsPlugin;
export function validateOfficial(name: string, value: JsonValue): void {
  jsonBytes(value);
  let validate = validators.get(name);
  if (!validate) {
    if (document.definitions[name]) validate = ajv.compile({ $ref: `#/definitions/${name}`, definitions: document.definitions });
    else {
      const standalone = new URL(`${name}.json`, schemaFile);
      if (!existsSync(standalone)) throw new DeliveryError('unsupported_schema', `Missing official schema ${name}`);
      validate = ajv.compile(JSON.parse(readFileSync(standalone, 'utf8')) as object);
    }
    validators.set(name, validate);
  }
  if (!validate(value)) throw new DeliveryError('invalid_params', `Invalid ${name}: ${ajv.errorsText(validate.errors)}`);
}
export function options(input: JsonValue | undefined, turn: boolean): JsonObject {
  if (input === undefined) return {};
  const value = object(input, 'options');
  const allowed = ['model', 'modelProvider', 'effort', 'approvalPolicy', 'sandbox', 'personality', 'collaborationMode', 'serviceTier', 'summary', 'permissions', 'approvalsReviewer', 'outputSchema'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new DeliveryError('invalid_params', `Unsupported option ${key}`);
  const result = { ...value };
  if (turn) delete result.modelProvider;
  if (result.outputSchema !== undefined && result.outputSchema !== null) outputSchema(result.outputSchema);
  if (result.permissions != null && result.sandbox != null) throw new DeliveryError('invalid_params', 'Choose a named permission profile or a sandbox mode, not both');
  if (result.collaborationMode !== undefined && result.collaborationMode !== null) {
    validateOfficial('CollaborationMode', result.collaborationMode);
    if (!turn) { const settings = object(object(result.collaborationMode).settings); result.model = settings.model!; if (settings.reasoning_effort !== null) result.effort = settings.reasoning_effort!; }
  }
  if (!turn) {
    delete result.outputSchema;
    delete result.collaborationMode;
    const config: JsonObject = {};
    if (result.effort !== undefined) { if (result.effort !== null) validateOfficial('ReasoningEffort', result.effort); config.model_reasoning_effort = result.effort; delete result.effort; }
    if (result.summary !== undefined) { if (result.summary !== null) validateOfficial('ReasoningSummary', result.summary); config.model_reasoning_summary = result.summary; delete result.summary; }
    if (Object.keys(config).length) result.config = config;
  }
  if (turn && result.sandbox !== undefined) {
    validateOfficial('SandboxMode', result.sandbox);
    const mode = result.sandbox; delete result.sandbox;
    result.sandboxPolicy = mode === 'read-only' ? { type: 'readOnly', networkAccess: false } : mode === 'danger-full-access' ? { type: 'dangerFullAccess' } : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
  return result;
}

const responseSchemas: Record<string, string> = {
  'item/commandExecution/requestApproval': 'CommandExecutionRequestApprovalResponse',
  'item/fileChange/requestApproval': 'FileChangeRequestApprovalResponse',
  'item/permissions/requestApproval': 'PermissionsRequestApprovalResponse',
  'item/tool/requestUserInput': 'ToolRequestUserInputResponse',
  'mcpServer/elicitation/request': 'McpServerElicitationRequestResponse',
};
export const supportedPrompt = (method: string): boolean => Object.hasOwn(responseSchemas, method);
const formKeywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'title', 'description', 'enum', 'enumNames', 'const', 'oneOf', 'anyOf', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'format', 'default', '$schema']);
const formats = new Set(['email', 'uri', 'date', 'date-time']);
function formSchema(schema: JsonValue, depth = 0): void {
  if (depth > 16) throw new DeliveryError('unsupported_schema', 'Form schema is too deep');
  if (typeof schema === 'boolean') return;
  const value = object(schema, 'requestedSchema');
  for (const [key, entry] of Object.entries(value)) {
    if (!formKeywords.has(key)) throw new DeliveryError('unsupported_schema', `Unsupported form keyword ${key}`);
    if (key === 'format' && (typeof entry !== 'string' || !formats.has(entry))) throw new DeliveryError('unsupported_schema', 'Unsupported form format');
    if (key === 'properties') for (const child of Object.values(object(entry))) formSchema(child, depth + 1);
    if (key === 'items' || key === 'additionalProperties') formSchema(entry, depth + 1);
    if (key === 'oneOf' || key === 'anyOf') { if (!Array.isArray(entry) || entry.length > 32) throw new DeliveryError('unsupported_schema', 'Invalid form union'); for (const child of entry) formSchema(child, depth + 1); }
  }
}
export function validatePrompt(method: string, params: JsonObject, response: JsonValue): void {
  const schemaName = responseSchemas[method]; if (!schemaName) throw new DeliveryError('unsupported_prompt', 'This prompt is unsupported');
  jsonBytes(response, 1024 * 1024); validateOfficial(schemaName, response); const answer = object(response, 'response');
  if (method === 'item/commandExecution/requestApproval' && Array.isArray(params.availableDecisions) && !params.availableDecisions.some(decision => canonical(decision) === canonical(answer.decision!))) throw new DeliveryError('invalid_params', 'Decision was not offered by the native request');
  if (method === 'item/permissions/requestApproval') {
    validateOfficial('RequestPermissionProfile', params.permissions!);
    if (!permissionsWithinRequest(object(answer.permissions), object(params.permissions))) throw new DeliveryError('invalid_params', 'Granted permissions exceed the requested permissions');
  }
  if (method === 'item/tool/requestUserInput') {
    const answers = object(answer.answers); const questions = params.questions;
    if (!Array.isArray(questions)) throw new DeliveryError('invalid_prompt', 'Invalid native question list');
    const ids = new Set(questions.map(question => object(question).id));
    for (const key of Object.keys(answers)) if (!ids.has(key)) throw new DeliveryError('invalid_params', 'Unknown question id');
    for (const question of questions) {
      const q = object(question); if (typeof q.id !== 'string' || !Object.hasOwn(answers, q.id)) throw new DeliveryError('invalid_params', 'Each question requires an answer');
      const values = object(answers[q.id]).answers as JsonValue[];
      if (!q.isOther && Array.isArray(q.options) && q.options.length) {
        const offered = (q.options as JsonValue[]).map(option => object(option).label);
        if (values.some(value => !offered.includes(value))) throw new DeliveryError('invalid_params', 'Answer is not an offered option');
      }
    }
  }
  if (method === 'mcpServer/elicitation/request') {
    if (answer.action !== 'accept') { if (answer.content !== undefined && answer.content !== null) throw new DeliveryError('invalid_params', 'Decline and cancel require absent or null content'); return; }
    if (params.mode === 'url') { if (answer.content !== undefined && answer.content !== null) throw new DeliveryError('invalid_params', 'URL confirmation requires absent or null content'); return; }
    if (params.mode !== 'form') throw new DeliveryError('unsupported_schema', 'This elicitation extension is not supported');
    jsonBytes(params.requestedSchema, 64 * 1024); const requested = object(params.requestedSchema, 'requestedSchema');
    if (requested.type !== 'object' || !requested.properties || typeof requested.properties !== 'object' || Array.isArray(requested.properties)) throw new DeliveryError('unsupported_schema', 'MCP forms require an object schema with properties');
    formSchema(requested);
    const formAjv = new Ajv({ strict: true, allErrors: false, ownProperties: true, validateFormats: true });
    formAjv.addKeyword({ keyword: 'enumNames', schemaType: 'array', valid: true });
    addFormats(formAjv, { mode: 'full', formats: ['email', 'uri', 'date', 'date-time'] });
    let validate: ValidateFunction;
    try { validate = formAjv.compile(params.requestedSchema as object); } catch { throw new DeliveryError('unsupported_schema', 'Unsupported or invalid form schema'); }
    if (!validate(answer.content)) throw new DeliveryError('invalid_params', `Invalid form: ${formAjv.errorsText(validate.errors)}`);
  }
}
