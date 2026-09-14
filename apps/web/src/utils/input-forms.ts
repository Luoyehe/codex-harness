import type { GatewayServerRequest } from "../api/protocol";

export type InputRequest = Extract<GatewayServerRequest, { method: "item/tool/requestUserInput" | "mcpServer/elicitation/request" }>;
export { inputForm, validateInput, validateResponse } from "../../../../shared/input-forms.mjs";
export type { InputField, InputForm } from "../../../../shared/input-forms.mjs";
