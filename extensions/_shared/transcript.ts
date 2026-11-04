import type { ImageContent, Message, TextContent, ToolResultMessage, TranscriptContext } from "@earendil-works/pi-ai";

/**
 * Bounded transcript serialization shared by active child-review consumers.
 * System messages are intentionally omitted before windowing: reviewer prompts
 * provide their own trusted system instructions and must not disclose parent
 * system records.
 */
export function serializeRecentMessages(transcript: TranscriptContext, maxMessages: number, maxChars: number): string {
  const messages = transcript.messages.filter((message) => message.role !== "system");
  const recent = messages.slice(-maxMessages);
  const serialized = recent.map((message, index) => serializeMessage(message, messages.length - recent.length + index + 1)).join("\n\n---\n\n");
  return truncateText(serialized || "(no recent transcript messages)", maxChars);
}

function serializeMessage(message: Message, index: number): string {
  if (message.role === "user") return `#${index} USER\n${contentToText(message.content)}`;
  if (message.role === "assistant") {
    const textParts = message.content.filter((item): item is TextContent => item.type === "text").map((item) => item.text.trim()).filter(Boolean);
    const toolCalls = message.content.filter((item) => item.type === "toolCall").map((item) => `- ${item.name} ${truncateOneLine(JSON.stringify(item.arguments), 500)}`);
    return [
      `#${index} ASSISTANT (${message.provider}/${message.model}, stop=${message.stopReason})`,
      textParts.join("\n\n") || "(no assistant text)",
      toolCalls.length > 0 ? `Tool calls:\n${toolCalls.join("\n")}` : undefined
    ].filter(Boolean).join("\n");
  }
  const toolResult = message as ToolResultMessage;
  return [`#${index} TOOL RESULT ${toolResult.toolName}${toolResult.isError ? " (error)" : ""}`, truncateText(contentToText(toolResult.content), 3000)].join("\n");
}

function contentToText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content.map((item) => item.type === "text" ? item.text : `[image: ${item.mimeType}]`).join("\n");
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 40))}\n...[truncated ${text.length - maxChars} chars]`;
}

function truncateOneLine(text: string, maxChars: number): string {
  return truncateText(text.replace(/\s+/g, " ").trim(), maxChars);
}
