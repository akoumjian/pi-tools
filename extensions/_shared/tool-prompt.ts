export function inputJsonSchemaGuideline(toolName: string, parameters: unknown): string {
  const schema = JSON.stringify(parameters);
  if (schema === undefined) {
    throw new Error(`Cannot serialize the ${toolName} input schema`);
  }
  return `${toolName} input: JSON Schema: ${schema}`;
}
