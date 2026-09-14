export interface InputRequest { method: "item/tool/requestUserInput" | "mcpServer/elicitation/request"; params: any; }
export interface InputField {
  id: string; label: string; description?: string; type: "string" | "number" | "integer" | "boolean" | "array";
  required: boolean; secret?: boolean; options?: { value: string; label: string }[]; other?: boolean;
  min?: number; max?: number; format?: string; defaultValue?: unknown;
}
export interface InputForm { fields: InputField[]; error?: string; url?: string; message: string; }
export function inputForm(request: InputRequest): InputForm;
export function validateInput(form: InputForm, values: Record<string, unknown>, options?: { coerceNumbers?: boolean }): { content?: Record<string, unknown>; error?: string };
export function validateResponse(request: InputRequest, payload: unknown): { error?: string };
