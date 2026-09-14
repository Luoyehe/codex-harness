/** Shared browser/gateway interpreter. Unknown constraints disable acceptance;
 * cancellation remains possible. Never include submitted values in errors. */
const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const own = (v, key) => Object.hasOwn(v, key);
const text = (v, max = 4000) => typeof v === "string" ? v.slice(0, max) : "";
const keysOnly = (v, allowed) => Object.keys(v).every((key) => allowed.includes(key));
const fail = (message) => { throw new Error(message); };
const MAX_TEXT = 20_000;
function choices(schema, allowed) {
  if (!object(schema) || allowed && !keysOnly(schema, allowed)) fail("枚举包含未支持的约束");
  const forms = ["enum", "oneOf", "anyOf"].filter((key) => own(schema, key));
  if (forms.length > 1) fail("不能同时使用多种枚举约束");
  if (!forms.length) { if (own(schema, "enumNames")) fail("枚举名称缺少对应选项"); return undefined; }
  const raw = schema[forms[0]];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) fail("枚举数量无效");
  if (schema.enumNames !== undefined && (!Array.isArray(schema.enumNames) || schema.enumNames.length !== raw.length || schema.enumNames.some((v) => typeof v !== "string" || v.length > 2000))) fail("枚举名称无效");
  const values = raw.map((entry, index) => {
    if (forms[0] === "enum") {
      if (typeof entry !== "string" || entry.length > MAX_TEXT) fail("枚举值不是有效字符串");
      return { value: entry, label: text(schema.enumNames?.[index], 256) || entry };
    }
    if (!object(entry) || !keysOnly(entry, ["const", "title"]) || typeof entry.const !== "string" || entry.const.length > MAX_TEXT || entry.title !== undefined && typeof entry.title !== "string") fail("枚举结构不受支持");
    return { value: entry.const, label: text(entry.title, 256) || entry.const };
  });
  if (new Set(values.map((v) => v.value)).size !== values.length) fail("枚举值重复");
  return values;
}
export function inputForm(request) {
  try {
    if (!object(request) || !object(request.params)) fail("请求结构无效");
    if (request.method === "item/tool/requestUserInput") {
      const questions = request.params.questions;
      if (!Array.isArray(questions) || questions.length > 32 || !questions.length) fail("问题数量无效");
      const fields = questions.map((q) => {
        if (!object(q) || typeof q.id !== "string" || !q.id || q.id.length > 256 || typeof q.isOther !== "boolean" || typeof q.isSecret !== "boolean" || !Array.isArray(q.options) && q.options !== null) fail("问题结构无效");
        if (q.options && (!q.options.length || q.options.length > 100 || q.options.some((o) => !object(o) || typeof o.label !== "string" || !o.label || o.label.length > 2000))) fail("选项结构无效");
        if (q.options && new Set(q.options.map((o) => o.label)).size !== q.options.length) fail("选项值重复");
        return { id: q.id, label: text(q.header, 256) || q.id, description: text(q.question), type: "string", required: true, secret: q.isSecret, other: q.isOther, min: 1, max: MAX_TEXT,
          options: q.options?.map((o) => ({ value: o.label, label: `${o.label}${o.description ? ` — ${text(o.description)}` : ""}` })) };
      });
      if (new Set(fields.map((f) => f.id)).size !== fields.length) fail("问题 ID 重复");
      return { fields, message: "Codex 请求补充信息" };
    }
    if (request.method !== "mcpServer/elicitation/request") fail("不支持此请求类型");
    const params = request.params;
    if (params.mode === "url") {
      if (typeof params.url !== "string" || params.url.length > 8000) fail("交互网址无效");
      const url = new URL(params.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) fail("交互网址不安全或无效");
      return { fields: [], message: text(params.message), url: url.href };
    }
    if (!["form", "openai/form"].includes(params.mode)) fail("未支持的交互模式");
    const schema = params.requestedSchema;
    if (!object(schema) || schema.type !== "object" || !object(schema.properties) || Object.keys(schema.properties).length > 32) fail("仅支持最多 32 个字段的平面表单");
    if (!keysOnly(schema, ["type", "properties", "required", "$schema", "title", "description", "additionalProperties"]) || schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") fail("表单包含未支持的约束");
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((id) => typeof id !== "string" || !own(schema.properties, id)) || new Set(schema.required).size !== schema.required.length)) fail("必填字段无效");
    const required = new Set(schema.required ?? []);
    const common = ["type", "title", "description", "default", "writeOnly"];
    const allowed = { string: ["enum", "enumNames", "oneOf", "minLength", "maxLength", "format"], number: ["minimum", "maximum"], integer: ["minimum", "maximum"], boolean: [], array: ["items", "minItems", "maxItems"] };
    const fields = Object.entries(schema.properties).map(([id, raw]) => {
      if (!id || id.length > 256 || !object(raw) || !own(allowed, raw.type)) fail("不支持嵌套对象或此字段类型");
      if (!keysOnly(raw, [...common, ...allowed[raw.type]])) fail("字段包含未支持的约束");
      if (raw.writeOnly !== undefined && typeof raw.writeOnly !== "boolean") fail("敏感字段标记无效");
      if (raw.format !== undefined && !["email", "uri", "date", "date-time", "password"].includes(raw.format)) fail("未支持的字符串格式");
      let options;
      if (raw.type === "string") options = choices(raw);
      else if (raw.type === "array") {
        options = choices(raw.items, ["type", "enum", "anyOf"]);
        if (!options || own(raw.items, "enum") && raw.items.type !== "string" || own(raw.items, "anyOf") && raw.items.type !== undefined && raw.items.type !== "string") fail("数组仅支持字符串枚举");
      }
      const min = raw.minLength ?? raw.minimum ?? raw.minItems;
      const max = raw.maxLength ?? raw.maximum ?? raw.maxItems;
      const count = raw.type === "string" || raw.type === "array";
      if ([min, max].some((v) => v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || count && (!Number.isSafeInteger(v) || v < 0))) || min !== undefined && max !== undefined && min > max) fail("字段范围无效");
      const secret = raw.writeOnly === true || raw.format === "password";
      return { id, label: text(raw.title, 256) || id, description: text(raw.description), type: raw.type, required: required.has(id), secret, format: raw.format, options, min, max, defaultValue: secret ? undefined : raw.default };
    });
    const form = { fields, message: text(params.message) };
    for (const field of fields) if (field.defaultValue !== undefined && validateInput({ ...form, fields: [{ ...field, required: true }] }, { [field.id]: field.defaultValue }, { coerceNumbers: false }).error) fail("字段默认值不符合约束");
    return form;
  } catch (e) { return { fields: [], message: "此交互表单无法安全呈现", error: e instanceof Error ? e.message : String(e) }; }
}
function validDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v; }
export function validateInput(form, values, options = {}) {
  if (form.error) return { error: form.error };
  if (!object(values) || Object.keys(values).some((key) => !form.fields.some((f) => f.id === key))) return { error: "回答包含未知字段" };
  const content = Object.create(null);
  for (const field of form.fields) {
    let value = own(values, field.id) ? values[field.id] : undefined;
    if (value === undefined) { if (field.required) return { error: `${field.label}：请填写此字段` }; continue; }
    if (field.type === "number" || field.type === "integer") {
      if (options.coerceNumbers !== false && typeof value === "string" && /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) value = Number(value);
      if (typeof value !== "number" || !Number.isFinite(value) || field.type === "integer" && !Number.isInteger(value)) return { error: `${field.label}：请输入有效数字` };
    } else if (field.type === "boolean") {
      if (value !== true && value !== false) return { error: `${field.label}：请选择是或否` };
    } else if (field.type === "array") {
      if (!Array.isArray(value) || value.length > 100 || new Set(value).size !== value.length || value.some((v) => !field.options?.some((o) => o.value === v))) return { error: `${field.label}：选择无效` };
    } else {
      if (typeof value !== "string" || value.length > MAX_TEXT) return { error: `${field.label}：文本无效或过长` };
      if (field.options?.length && !field.other && !field.options.some((o) => o.value === value)) return { error: `${field.label}：请选择提供的选项` };
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { error: `${field.label}：邮箱格式无效` };
      if (field.format === "uri") { try { new URL(value); } catch { return { error: `${field.label}：网址无效` }; } }
      if (field.format === "date" && !validDate(value)) return { error: `${field.label}：日期无效` };
      if (field.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !validDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value)))) return { error: `${field.label}：时间必须包含有效日期和时区` };
    }
    const size = typeof value === "number" ? value : typeof value === "string" ? [...value].length : Array.isArray(value) ? value.length : undefined;
    if (size !== undefined && (field.min !== undefined && size < field.min || field.max !== undefined && size > field.max)) return { error: `${field.label}：不符合允许的范围` };
    content[field.id] = value;
  }
  return { content };
}
/** Empty tool answers mean explicit user cancellation, not fabricated input. */
export function validateResponse(request, payload) {
  if (!object(payload)) return { error: "回答结构无效" };
  try { if (new TextEncoder().encode(JSON.stringify(payload)).length > 128 * 1024) return { error: "回答超过大小限制" }; } catch { return { error: "回答无法序列化" }; }
  if (request.method === "item/tool/requestUserInput") {
    if (!keysOnly(payload, ["answers"]) || !object(payload.answers)) return { error: "回答结构无效" };
    if (!Object.keys(payload.answers).length) return {};
    const values = Object.create(null);
    for (const [id, answer] of Object.entries(payload.answers)) {
      if (!object(answer) || !keysOnly(answer, ["answers"]) || !Array.isArray(answer.answers) || answer.answers.length !== 1 || typeof answer.answers[0] !== "string") return { error: "每个问题只能提交一个有效回答" };
      values[id] = answer.answers[0];
    }
    const checked = validateInput(inputForm(request), values, { coerceNumbers: false });
    return checked.error ? { error: checked.error } : {};
  }
  if (request.method !== "mcpServer/elicitation/request") return { error: "不支持此请求类型" };
  if (!keysOnly(payload, ["action", "content", "_meta"]) || !["accept", "decline", "cancel"].includes(payload.action) || payload._meta != null) return { error: "交互回答结构无效" };
  if (payload.action !== "accept") return payload.content == null ? {} : { error: "取消或拒绝回答不能携带内容" };
  const form = inputForm(request);
  if (form.error) return { error: form.error };
  if (form.url) return payload.content == null ? {} : { error: "网址交互不能携带表单内容" };
  const checked = validateInput(form, payload.content, { coerceNumbers: false });
  return checked.error ? { error: checked.error } : {};
}
