import { isDeepStrictEqual } from "node:util";

export function anthropicWireSchema(parameters) {
  const schema = structuredClone(parameters);
  delete schema.additionalProperties;
  delete schema.anyOf;
  schema.required ??= [];
  return schema;
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function openAICodexTools(payload) {
  if ((payload.tools?.length ?? 0) > 0) return payload.tools ?? [];
  if (!Array.isArray(payload.input)) return [];
  return payload.input.flatMap((item) => {
    if (!isRecord(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) return [];
    return item.tools.flatMap((tool) => isRecord(tool) ? [{
      name: typeof tool.name === "string" ? tool.name : undefined,
      description: typeof tool.description === "string" ? tool.description : undefined,
      parameters: tool.parameters
    }] : []);
  });
}

export function validateProviderPayloads({ openai, anthropic, systemPrompt, providerTools, networkAttempts }) {
  if (networkAttempts !== 0) throw new Error(`Provider payload capture made ${networkAttempts} network attempt(s).`);
  if (openai.instructions !== systemPrompt) {
    throw new Error("OpenAI payload instructions do not exactly equal the effective system prompt.");
  }
  const anthropicSystem = Array.isArray(anthropic.system)
    ? anthropic.system.map((block) => block?.text).filter((text) => typeof text === "string").join("\n\n")
    : anthropic.system;
  if (anthropicSystem !== systemPrompt) {
    throw new Error("Anthropic payload system text does not exactly equal the effective system prompt.");
  }

  const expectedNames = providerTools.map((tool) => tool.name);
  if (Array.isArray(openai.tools) && openai.tools.length > 0) {
    throw new Error("OpenAI Pi 1.5 payload unexpectedly uses legacy top-level tools.");
  }
  const openaiTools = openAICodexTools(openai);
  if (!Array.isArray(openai.input) || !openai.input.some((item) => isRecord(item) && item.type === "additional_tools")) {
    throw new Error("OpenAI Pi 1.5 payload is missing its additional_tools transcript record.");
  }
  const anthropicTools = Array.isArray(anthropic.tools) ? anthropic.tools : [];
  assertExact(openaiTools.map((tool) => tool.name), expectedNames, "OpenAI tool order/names");
  assertExact(anthropicTools.map((tool) => tool.name), expectedNames, "Anthropic tool order/names");
  for (const expected of providerTools) {
    const openaiTool = openaiTools.find((tool) => tool.name === expected.name);
    const anthropicTool = anthropicTools.find((tool) => tool.name === expected.name);
    assertExact(openaiTool?.parameters, expected.parameters, `OpenAI ${expected.name} schema`);
    assertExact(anthropicTool?.input_schema, anthropicWireSchema(expected.parameters), `Anthropic ${expected.name} schema`);
  }
}

function assertExact(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} does not exactly match the registered provider declarations.`);
  }
}
