import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { DeliveryError, jsonBytes, type JsonValue } from './types.js';

const require = createRequire(import.meta.url);
let pending = 0;
const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const Ajv = require(workerData.ajv).default; const formats = require(workerData.formats);
  const ajv = new Ajv({ strictSchema: true, strictTypes: false, strictTuples: false, allErrors: false, ownProperties: true, validateFormats: true }); formats(ajv);
  const validate = ajv.compile(workerData.schema);
  if (validate.$async) throw new Error('async');
  parentPort.postMessage({ valid: validate(workerData.input) === true });
} catch { parentPort.postMessage({ unsupported: true }); }
`;

/** Untrusted patterns and schema compilation cannot monopolize the runtime event loop. */
export async function validateMcpArguments(schema: JsonValue, input: JsonValue): Promise<void> {
  jsonBytes(schema, 128 * 1024); jsonBytes(input, 1024 * 1024);
  let nodes = 0;
  const visit = (value: JsonValue, depth: number): void => {
    if (++nodes > 8192 || depth > 32) throw new DeliveryError('unsupported_tool_schema', 'Tool schema exceeds validation budget');
    if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      if (key === '$async' || ((key === '$ref' || key === '$dynamicRef' || key === '$recursiveRef') && (typeof item !== 'string' || !item.startsWith('#')))) throw new DeliveryError('unsupported_tool_schema', 'Tool schema requires unsupported external or asynchronous validation');
      visit(item as JsonValue, depth + 1);
    }
  }; visit(schema, 0);
  const dialect = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema.$schema : undefined;
  let module = 'ajv/dist/2020.js';
  if (dialect === 'http://json-schema.org/draft-07/schema#' || dialect === 'https://json-schema.org/draft-07/schema') module = 'ajv';
  else if (dialect === 'https://json-schema.org/draft/2019-09/schema') module = 'ajv/dist/2019.js';
  else if (dialect !== undefined && dialect !== 'https://json-schema.org/draft/2020-12/schema') throw new DeliveryError('unsupported_tool_schema', 'Tool JSON Schema dialect is not supported');
  if (pending >= 2) throw new DeliveryError('capacity', 'Two tool schemas are already being validated');
  pending++;
  try {
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(workerCode, { eval: true, workerData: { ajv: require.resolve(module), formats: require.resolve('ajv-formats'), schema, input }, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
      let settled = false;
      const finish = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate().then(() => { if (error) reject(error); else resolve(); }, () => reject(new DeliveryError('unsupported_tool_schema', 'Tool schema worker cleanup failed'))); };
      const timer = setTimeout(() => finish(new DeliveryError('unsupported_tool_schema', 'Tool schema validation exceeded its time budget')), 1500);
      worker.once('message', value => finish(value?.valid === true ? undefined : new DeliveryError(value?.unsupported ? 'unsupported_tool_schema' : 'invalid_params', value?.unsupported ? 'Tool schema could not be validated safely' : 'Arguments do not match the discovered tool schema')));
      worker.once('error', () => finish(new DeliveryError('unsupported_tool_schema', 'Tool schema validation worker failed')));
      worker.once('exit', () => { if (!settled) finish(new DeliveryError('unsupported_tool_schema', 'Tool schema validation ended without a result')); });
    });
  } finally { pending--; }
}
