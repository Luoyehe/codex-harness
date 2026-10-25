import { object } from './types';
const supported = new Set(['type', 'title', 'description', 'properties', 'required', 'additionalProperties', 'enum', 'enumNames', 'oneOf', 'anyOf', 'const', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'format', 'default', '$schema']);
export const fieldType = (s: Record<string, unknown>): string | undefined => Array.isArray(s.type) ? (s.type.find(v => v !== 'null') as string | undefined) ?? 'null' : typeof s.type === 'string' ? s.type : undefined;
export function schemaSupported(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = object(value);
  if (Object.keys(s).some(k => !supported.has(k))) return false;
  const types = Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type];
  if (Array.isArray(s.type) && !types.length || types.some(t => !['object', 'string', 'number', 'integer', 'boolean', 'array', 'null'].includes(String(t))) || types.filter(t => t !== 'null').length > 1 || new Set(types).size !== types.length) return false;
  const type = fieldType(s);
  if (s.format && !['email', 'uri', 'date', 'date-time'].includes(String(s.format))) return false;
  if (s.oneOf && (!Array.isArray(s.oneOf) || !s.oneOf.every(v => Object.hasOwn(object(v), 'const') && schemaSupported(v)))) return false;
  if (s.anyOf && (!Array.isArray(s.anyOf) || !s.anyOf.every(v => Object.hasOwn(object(v), 'const') && schemaSupported(v)))) return false;
  if (type === 'object') return Object.values(object(s.properties)).every(schemaSupported) && (s.additionalProperties === undefined || typeof s.additionalProperties === 'boolean');
  if (type === 'array') return Boolean(s.items) && schemaSupported(s.items) && !['object', 'array'].includes(fieldType(object(s.items)) ?? '');
  return true;
}
export function validateValue(schema: unknown, value: unknown, name = '字段'): string[] {
  const s = object(schema), errors: string[] = [], type = fieldType(s);
  if (!schemaSupported(schema)) return [`${name}使用了暂不支持的表单类型。`];
  if (value === undefined) return [`${name}尚未提供。`];
  if (Object.hasOwn(s, 'const') && JSON.stringify(s.const) !== JSON.stringify(value)) errors.push(`${name}必须使用指定值。`);
  if (Array.isArray(s.enum) && !s.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) errors.push(`${name}请选择允许的值。`);
  if (Array.isArray(s.oneOf) && s.oneOf.filter(v => validateValue(v, value, name).length === 0).length !== 1) errors.push(`${name}请选择唯一允许的值。`);
  if (Array.isArray(s.anyOf) && !s.anyOf.some(v => validateValue(v, value, name).length === 0)) errors.push(`${name}请选择允许的值。`);
  if (value === null) return s.type === undefined || s.type === 'null' || Array.isArray(s.type) && s.type.includes('null') ? errors : [...errors, `${name}不允许空值。`];
  if (type === 'null') return [...errors, `${name}必须为空值。`];
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${name}必须是对象。`];
    const v = object(value), properties = object(s.properties);
    for (const key of Array.isArray(s.required) ? s.required : []) if (!Object.hasOwn(v, String(key)) || v[String(key)] === undefined) errors.push(`${String(key)}为必填项。`);
    for (const [key, child] of Object.entries(v)) { if (Object.hasOwn(properties, key)) errors.push(...validateValue(properties[key], child, key)); else if (s.additionalProperties === false) errors.push(`${key}不是允许的字段。`); }
  } else if (type === 'string') {
    if (typeof value !== 'string') return [`${name}必须是文本。`];
    if (typeof s.minLength === 'number' && [...value].length < s.minLength) errors.push(`${name}至少需要 ${s.minLength} 个字符。`);
    if (typeof s.maxLength === 'number' && [...value].length > s.maxLength) errors.push(`${name}不能超过 ${s.maxLength} 个字符。`);
    if (s.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors.push(`${name}需要有效邮箱。`);
    if (s.format === 'uri') { try { new URL(value); } catch { errors.push(`${name}需要完整 URL。`); } }
    if (s.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) errors.push(`${name}需要有效日期。`);
    if (s.format === 'date-time' && (Number.isNaN(Date.parse(value)) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))) errors.push(`${name}需要带时区的日期时间。`);
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) return [`${name}需要有效${type === 'integer' ? '整数' : '数字'}。`];
    if ((typeof s.minimum === 'number' && value < s.minimum) || (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum)) errors.push(`${name}小于允许下限。`);
    if ((typeof s.maximum === 'number' && value > s.maximum) || (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum)) errors.push(`${name}超过允许上限。`);
  } else if (type === 'boolean' && typeof value !== 'boolean') errors.push(`${name}必须是是/否值。`);
  else if (type === 'array') {
    if (!Array.isArray(value)) return [`${name}需要一个列表。`];
    if (typeof s.minItems === 'number' && value.length < s.minItems) errors.push(`${name}至少选择 ${s.minItems} 项。`);
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) errors.push(`${name}最多选择 ${s.maxItems} 项。`);
    if (s.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) errors.push(`${name}不能重复。`);
    value.forEach(v => errors.push(...validateValue(s.items, v, name)));
  }
  return errors;
}
