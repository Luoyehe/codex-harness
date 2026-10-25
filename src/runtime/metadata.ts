import { existsSync, readFileSync } from 'node:fs';

const source = new URL('../../package.json', import.meta.url);
const file = existsSync(source) ? source : new URL('../../../package.json', import.meta.url);
const metadata = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; codexVersion?: unknown };
if (typeof metadata.version !== 'string' || typeof metadata.codexVersion !== 'string') throw new Error('Package identity is missing');
export const APP_VERSION: string = metadata.version;
export const CODEX_VERSION: string = metadata.codexVersion;
