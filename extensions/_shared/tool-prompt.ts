function jsonSchemaGuideline(toolName: string, boundary: "input" | "output", schemaValue: unknown): string {
  const schema = JSON.stringify(schemaValue);
  if (schema === undefined) {
    throw new Error(`Cannot serialize the ${toolName} ${boundary} schema`);
  }
  return `${toolName} ${boundary}: JSON Schema: ${schema}`;
}

export function inputJsonSchemaGuideline(toolName: string, parameters: unknown): string {
  return jsonSchemaGuideline(toolName, "input", parameters);
}

export function outputJsonSchemaGuideline(toolName: string, outputSchema: unknown): string {
  return jsonSchemaGuideline(toolName, "output", outputSchema);
}
