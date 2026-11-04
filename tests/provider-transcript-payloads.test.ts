import assert from "node:assert/strict";
import test from "node:test";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamOpenAICodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { buildCompacterTranscript, SUMMARIZATION_SYSTEM_PROMPT } from "../extensions/compacter/index.js";
import { buildToolSafetyApprovalTranscript, modelApprovalSystemPrompt } from "../extensions/tool-safety/index.js";

const fakeJwt = [
  "e30",
  Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture" } })).toString("base64url"),
  "fixture-signature"
].join(".");

async function capturePayload(
  streamFunction: (model: Model<any>, context: TranscriptContext, options: any) => AsyncIterable<unknown>,
  model: Model<any>,
  context: TranscriptContext,
  apiKey: string,
  options: Record<string, unknown> = {}
): Promise<Record<string, any>> {
  let payload: Record<string, any> | undefined;
  const controller = new AbortController();
  const stream = streamFunction(model, context, {
    apiKey,
    signal: controller.signal,
    maxRetries: 0,
    ...options,
    onPayload(candidate: Record<string, any>) {
      payload = structuredClone(candidate);
      controller.abort();
    }
  });
  for await (const _event of stream) {
    // Capture and abort before transport.
  }
  assert.ok(payload);
  return payload;
}

test("compacter and tool-safety exact prompts reach real provider payloads before network", async () => {
  const codex = getBuiltinModel("openai-codex", "gpt-6-luna");
  const anthropic = getBuiltinModel("anthropic", "claude-sonnet-4-5");
  assert.ok(codex && anthropic);
  const originalFetch = globalThis.fetch;
  const fetchAttempts: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    fetchAttempts.push(String(input));
    throw new Error("Provider transcript test forbids network I/O.");
  }) as typeof fetch;
  try {
    for (const fixture of [
      {
        label: "compacter",
        transcript: buildCompacterTranscript("COMPACT_USER_SENTINEL"),
        systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
        userSentinel: "COMPACT_USER_SENTINEL"
      },
      {
        label: "tool-safety",
        transcript: buildToolSafetyApprovalTranscript("SAFETY_USER_SENTINEL"),
        systemPrompt: modelApprovalSystemPrompt,
        userSentinel: "SAFETY_USER_SENTINEL"
      }
    ]) {
      const openai = await capturePayload(streamOpenAICodexResponses, codex, fixture.transcript, fakeJwt, { transport: "sse" });
      const claude = await capturePayload(streamAnthropic, anthropic, fixture.transcript, "fixture-api-key");
      assert.equal(openai.instructions, fixture.systemPrompt, `${fixture.label} OpenAI instructions`);
      assert.equal((JSON.stringify(openai.input).match(new RegExp(fixture.userSentinel, "g")) ?? []).length, 1);
      assert.equal(openai.tools, undefined);
      assert.equal(JSON.stringify(openai).includes("additional_tools"), false);

      const anthropicSystem = Array.isArray(claude.system)
        ? claude.system.map((block: Record<string, unknown>) => block.text).filter((text: unknown) => typeof text === "string").join("\n\n")
        : claude.system;
      assert.equal(anthropicSystem, fixture.systemPrompt, `${fixture.label} Anthropic system`);
      assert.equal((JSON.stringify(claude.messages).match(new RegExp(fixture.userSentinel, "g")) ?? []).length, 1);
      assert.equal(claude.tools, undefined);
    }
    assert.deepEqual(fetchAttempts, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
