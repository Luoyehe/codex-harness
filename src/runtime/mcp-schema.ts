import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DeliveryError, jsonBytes, type JsonValue } from './types.js';
import { schemaBudget } from './schema-budget.js';

const require = createRequire(import.meta.url);
let pending = 0;
const validated = new Map<string, number>();
const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const Ajv = require(workerData.ajv).default; const formats = require(workerData.formats);
  const ajv = new Ajv({ strictSchema: true, strictTypes: false, strictTuples: false, allErrors: false, ownProperties: true, validateFormats: true }); formats(ajv);
  for (const keyword of workerData.annotations) if (!ajv.getKeyword(keyword)) ajv.addKeyword({ keyword, valid: true });
  const validate = ajv.compile(workerData.schema);
  if (validate.$async) throw new Error('async');
  parentPort.postMessage({ valid: validate(workerData.input) === true });
} catch { parentPort.postMessage({ unsupported: true }); }
`;

/** Untrusted patterns and schema compilation cannot monopolize the runtime event loop. */
export async function validateMcpArguments(schema: JsonValue, input: JsonValue): Promise<void> {
  const schemaJson = jsonBytes(schema, 128 * 1024), inputJson = jsonBytes(input, 1024 * 1024);
  const annotations = [...schemaBudget(schema, { nodes: 8192, depth: 32, code: 'unsupported_tool_schema' })];
  let dialect = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema.$schema : undefined;
  if (typeof dialect === 'string' && /^https:\/\/json-schema\.org\/draft\/(2019-09|2020-12)\/schema#$/.test(dialect)) {
    dialect = dialect.slice(0, -1);
    schema = { ...(schema as Record<string, JsonValue>), $schema: dialect };
  }
  let module = 'ajv/dist/2020.js';
  if (typeof dialect === 'string' && /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(dialect)) { module = 'ajv'; schema = { ...(schema as { [key: string]: JsonValue }), $schema: 'http://json-schema.org/draft-07/schema#' }; }
  else if (dialect === 'https://json-schema.org/draft/2019-09/schema') module = 'ajv/dist/2019.js';
  else if (dialect !== undefined && dialect !== 'https://json-schema.org/draft/2020-12/schema') throw new DeliveryError('unsupported_tool_schema', 'Tool JSON Schema dialect is not supported');
  const key = createHash('sha256').update(schemaJson).update('\0').update(inputJson).digest('hex');
  if ((validated.get(key) ?? 0) > Date.now()) return;
  if (pending >= 2) throw new DeliveryError('capacity', 'Two tool schemas are already being validated');
  pending++;
  try {
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(workerCode, { eval: true, workerData: { ajv: require.resolve(module), formats: require.resolve('ajv-formats'), schema, input, annotations }, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
      let settled = false;
      const finish = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate().then(() => { if (error) reject(error); else resolve(); }, () => reject(new DeliveryError('unsupported_tool_schema', 'Tool schema worker cleanup failed'))); };
      const timer = setTimeout(() => finish(new DeliveryError('unsupported_tool_schema', 'Tool schema validation exceeded its time budget')), 1500);
      worker.once('message', value => finish(value?.valid === true ? undefined : new DeliveryError(value?.unsupported ? 'unsupported_tool_schema' : 'invalid_params', value?.unsupported ? 'Tool schema could not be validated safely' : 'Arguments do not match the discovered tool schema')));
      worker.once('error', () => finish(new DeliveryError('unsupported_tool_schema', 'Tool schema validation worker failed')));
      worker.once('exit', () => { if (!settled) finish(new DeliveryError('unsupported_tool_schema', 'Tool schema validation ended without a result')); });
    });
    if (validated.size >= 64) validated.delete(validated.keys().next().value!);
    validated.set(key, Date.now() + 300000);
  } finally { pending--; }
}
