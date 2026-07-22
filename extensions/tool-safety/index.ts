import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type Message, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { formatConfigPath, piToolsConfigCandidates, readPiToolsJsonConfig, readPiToolsReferencedTextConfig, removeAgentExtensionConfig, writeAgentExtensionConfig, writeAgentExtensionTextConfig, type ConfigPath, type PiToolsConfigCandidate } from "../_shared/config.js";
import { registerCommandWithAliases } from "../_shared/deprecated-command.js";
import { formatModelName, normalizeThinkingLevel, parseOptionalModelThinkingPair, resolveExtensionModel, type ExtensionModelRegistry } from "../_shared/model-spec.js";
import { guidedModelSetupUsage, parseGuidedModelSetupArgs, readSetupGuidance } from "../_shared/setup-command.js";

type SafetyAction = "allow" | "review" | "deny";
type SafetyRisk = "low" | "medium" | "high";
type SafetyConfidence = "low" | "medium" | "high";
export type ToolSafetyReviewCriteria = "conservative" | "production-or-unapproved-environment";

type SafetyDecision = {
  action: SafetyAction;
  risk: SafetyRisk;
  reason: string;
  ruleId: string;
  tags: string[];
  confidence?: SafetyConfidence;
};

type ModelApproval = {
  action: SafetyAction;
  risk: SafetyRisk;
  confidence: SafetyConfidence;
  reason: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  raw: string;
  error?: string;
};

type AuditDetails = {
  initialDecision: SafetyDecision;
  criteriaDecision: SafetyDecision;
  modelApproval?: ModelApproval;
  humanReviewApproved?: boolean;
};

type CommandRule = {
  id: string;
  pattern: RegExp;
  action: SafetyAction;
  risk: SafetyRisk;
  reason: string;
  tags: string[];
};

export type ApprovalModelPreference = {
  model: string;
  thinkingLevel?: ThinkingLevel;
};

type ToolSafetySettings = {
  approvalModel?: ApprovalModelPreference;
  approvalTimeoutMs?: number;
  approvalMaxTokens: number;
  currentUserMaxChars: number;
  recentUserMessages: number;
  recentUserMaxChars: number;
  toolInputMaxChars: number;
  policyMaxChars: number;
  policyFile?: string;
  humanReviewTimeoutMs?: number;
  trustedWorkspaceRoot?: string;
  reviewCriteria: ToolSafetyReviewCriteria;
};

const TOOL_SAFETY_CONFIG_FILE = "tool-safety-settings.json";
const TOOL_SAFETY_POLICY_FILE = "tool-safety-policy.md";
const FALLBACK_POLICY_TEXT = "No policy file was available. Review or block non-read-only actions.";

type ToolSafetyPolicyInfo = {
  text: string;
  source: string;
  path?: ConfigPath;
};

let policyInfo = readPolicyInfo();
let settings = readToolSafetySettings();
let runtimeApprovalModelOverride: ApprovalModelPreference | undefined;
let runtimeToolSafetyEnabled = true;
let approvalModelUnavailableWarningShown = false;

const modelApprovalSystemPrompt = `You are Pi's tool safety approval judge. Your single job is to decide whether one proposed tool call should run.

The user message provides the policy you are bound to, the runtime context for this call, and the host's pre-classification. The policy is the source of truth: apply it as written, do not invent rules, and do not relax or tighten it from outside the policy text.

Reply with one JSON object and nothing else:
{"action":"allow|review|deny","risk":"low|medium|high","confidence":"low|medium|high","reason":"one short sentence"}

- action: allow runs the call without interrupting the user, review hands off to a human approver, deny blocks the call outright.
- risk: worst-case impact of executing this specific call under the policy.
- confidence: how sure you are of the action choice given the policy and context.
- reason: one short sentence shown to the user; for review or deny, briefly state what about this specific call concerns the policy.

Never execute tools. Never reveal hidden reasoning.`;

const secretPathPatterns = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.env($|\.)/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)(history|\.zsh_history|\.bash_history)$/
];

const secretCommandPathPatterns = [
  /(^|[\/\s"'=:])\.ssh(?=$|[\/\s"';&|])/i,
  /(^|[\/\s"'=:])\.aws(?=$|[\/\s"';&|])/i,
  /(^|[\/\s"'=:])\.gnupg(?=$|[\/\s"';&|])/i,
  /(^|[\/\s"'=:])\.docker\/config\.json(?=$|[\/\s"';&|])/i,
  /(^|[\/\s"'=:])\.netrc(?=$|[\/\s"';&|])/i,
  /(^|[\/\s"'=:])\.npmrc(?=$|[\/\s"';&|])/i,
  /(^|[\/\s"'=:])\.pypirc(?=$|[\/\s"';&|])/i,
  /(^|[\/\s"'=:])\.env(?:[.\w-]*)?(?=$|[\/\s"';&|])/i,
  /(^|[\/\s"'=:])id_(rsa|dsa|ecdsa|ed25519)(?=$|[\/\s"';&|])/i,
  /(^|[\/\s"'=:])\.(zsh_history|bash_history)(?=$|[\/\s"';&|])/i
];

const readOnlyShellCommands = new Set([
  "cat",
  "cut",
  "echo",
  "find",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "sed",
  "sort",
  "tail",
  "tr",
  "uniq",
  "wc"
]);

const readOnlyFindExecCommands = new Set(["cat", "grep", "head", "rg", "sed", "tail", "wc"]);
const readOnlyGitSubcommands = new Set(["diff", "log", "show", "status"]);
const allowedLocalGitSubcommands = new Set(["add", "branch", "checkout", "commit", "merge", "rebase", "restore", "stash", "switch"]);
const protectedGitPushBranchPatterns = [/^(prod|production)$/i, /^release(?:$|\/)/i];
const readOnlyPackageSubcommands = new Set(["search", "view"]);
const nodePackageManagers = new Set(["npm", "pnpm", "yarn", "bun"]);
const dependencyPackageSubcommands = new Set(["add", "ci", "install", "remove", "sync", "update", "upgrade"]);
const safeScriptNames = new Set(["build", "check", "dev", "docs", "format", "fmt", "lint", "preview", "serve", "start", "test", "typecheck"]);
const safeDevCommands = new Set([
  "cargo",
  "cmake",
  "eslint",
  "go",
  "jest",
  "make",
  "mocha",
  "mypy",
  "ninja",
  "prettier",
  "pytest",
  "ruff",
  "tsc",
  "vitest"
]);
const harmlessShellCommands = new Set(["command", "echo", "false", "printf", "true", "which"]);

const commandRules: CommandRule[] = [
  {
    id: "pipe-to-shell",
    pattern: /\b(curl|wget)\b[\s\S]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
    action: "review",
    risk: "high",
    reason: "Pipe-to-shell installer can execute arbitrary remote code.",
    tags: ["network", "execution"]
  },
  {
    id: "destructive-root-delete",
    pattern: /\brm\s+[^;&|]*-[^;&|]*r[^;&|]*f[^;&|]*(\s+\/|\s+\$HOME|\s+~)(\s|$)/i,
    action: "review",
    risk: "high",
    reason: "rm -rf against /, $HOME, or ~ would broadly delete user data.",
    tags: ["filesystem", "destructive"]
  },
  {
    id: "privilege-escalation",
    pattern: /(^|\s)(sudo|doas|su)\s+/i,
    action: "review",
    risk: "high",
    reason: "Privilege escalation requires explicit review.",
    tags: ["privilege"]
  },
  {
    id: "git-history-rewrite",
    pattern: /\bgit\s+(reset\s+--hard|clean\s+-|push\b[\s\S]*--force)/i,
    action: "review",
    risk: "high",
    reason: "Git history rewrites, destructive cleans, and force pushes require review.",
    tags: ["git", "destructive"]
  },
  {
    id: "publish-release",
    pattern: /\b(npm|pnpm|yarn)\s+publish\b|\bgh\s+release\b|\btwine\s+upload\b/i,
    action: "review",
    risk: "high",
    reason: "Publishing and release operations require review.",
    tags: ["release"]
  },
  {
    id: "cloud-or-cluster-mutation",
    pattern: /\b(kubectl|gcloud|aws|az|terraform|pulumi)\b[\s\S]*\b(apply|create|delete|destroy|deploy|patch|scale|set-iam-policy|add-iam-policy-binding|update)\b/i,
    action: "review",
    risk: "high",
    reason: "Cloud, cluster, and infrastructure mutations require review.",
    tags: ["cloud", "infrastructure"]
  }
];

export default function toolSafetyExtension(api: ExtensionAPI): void {
  api.on("session_start", async (_event, context) => {
    approvalModelUnavailableWarningShown = false;
    await notifyApprovalModelUnavailableOnce(context);
  });

  registerCommandWithAliases(
    api,
    "safety:setup",
    {
      description: "Persist the tool-safety approval judge model for this machine (usage: /safety:setup provider/model[:thinking])",
      handler: async (args, context) => {
        await handleToolSafetySetupCommand(args, context);
      }
    },
    []
  );

  registerCommandWithAliases(
    api,
    "safety:status",
    {
      description: "Show tool-safety approval judge configuration and runtime override status",
      handler: async (_args, context) => {
        context.ui.notify(buildToolSafetyStatusText(context), "info");
      }
    },
    []
  );

  registerCommandWithAliases(
    api,
    "safety:model",
    {
      description: "Set or reset the runtime tool-safety approval judge model (usage: /safety:model provider/model[:thinking] | reset)",
      handler: async (args, context) => {
        await handleToolSafetyModelCommand(args, context);
      }
    },
    []
  );

  registerCommandWithAliases(
    api,
    "safety:toggle",
    {
      description: "Enable, disable, or toggle runtime tool-safety enforcement (usage: /safety:toggle [on|off])",
      handler: async (args, context) => {
        handleToolSafetyToggleCommand(args, context);
      }
    },
    []
  );

  api.on("tool_call", async (event, context) => {
    if (!runtimeToolSafetyEnabled) {
      return;
    }

    const initialDecision = evaluateToolCall(event, context);
    const approvalContext = getUserMessages(context).slice(-(settings.recentUserMessages + 1)).join("\n");
    const criteriaDecision = applyReviewCriteria(event, initialDecision, settings.reviewCriteria, approvalContext);
    let decision = criteriaDecision;
    let modelApproval: ModelApproval | undefined;

    if (decision.action === "allow") {
      writeAudit(context, event, decision, { initialDecision, criteriaDecision });
      return;
    }

    if (decision.action === "deny") {
      writeAudit(context, event, decision, { initialDecision, criteriaDecision });
      return block(decision);
    }

    modelApproval = await requestModelApproval(context, event, decision);
    decision = applyModelApproval(decision, modelApproval);

    if (decision.action === "allow") {
      writeAudit(context, event, decision, { initialDecision, criteriaDecision, modelApproval });
      return;
    }

    if (decision.action === "deny") {
      writeAudit(context, event, decision, { initialDecision, criteriaDecision, modelApproval });
      return block(decision);
    }

    const approved = await requestReview(context, event, decision);
    writeAudit(context, event, decision, { initialDecision, criteriaDecision, modelApproval, humanReviewApproved: approved });
    if (!approved) {
      return block({
        ...decision,
        reason: `User review did not approve this action. ${decision.reason}`
      });
    }
  });
}

export function applyReviewCriteria(
  event: ToolCallEvent,
  decision: SafetyDecision,
  criteria: ToolSafetyReviewCriteria,
  approvalContext = ""
): SafetyDecision {
  if (criteria === "conservative" || decision.action === "deny") {
    return decision;
  }

  const environmentCommands = getShellCommands(event).flatMap(splitShellOperations).filter(isEnvironmentMutationCommand);
  if (environmentCommands.length === 0) {
    return reviewCriteriaAllow(decision, "non-environment-auto-allow", "Action is not a deployment or environment mutation.");
  }

  if (environmentCommands.some(hasProductionTarget)) {
    return reviewCriteriaReview(decision, "production-target", "Deployment or environment mutation explicitly targets production.", "high");
  }

  const unidentified = environmentCommands.filter(
    (command) => !hasApprovedNonProductionTarget(command) && !hasContextApprovedTarget(command, approvalContext)
  );
  if (unidentified.length > 0) {
    return reviewCriteriaReview(
      decision,
      "unapproved-environment",
      "Deployment or environment mutation does not identify an approved non-production target.",
      "medium"
    );
  }

  return reviewCriteriaAllow(
    decision,
    "approved-environment-auto-allow",
    "Every deployment or environment mutation targets a clearly identified approved non-production environment."
  );
}

function reviewCriteriaAllow(decision: SafetyDecision, suffix: string, reason: string): SafetyDecision {
  return {
    action: "allow",
    risk: "low",
    reason,
    ruleId: `${decision.ruleId}+${suffix}`,
    tags: [...decision.tags, "production-only-review"]
  };
}

function reviewCriteriaReview(decision: SafetyDecision, suffix: string, reason: string, risk = decision.risk): SafetyDecision {
  return {
    ...decision,
    action: "review",
    risk,
    reason,
    ruleId: `${decision.ruleId}+${suffix}`,
    tags: [...decision.tags, "production-only-review"]
  };
}

function getShellCommands(event: ToolCallEvent): string[] {
  const toolName = getToolName(event);
  if (toolName === "bash") {
    const command = getStringField(event.input, ["command", "cmd", "script"]);
    return command ? [command] : [];
  }
  const input: unknown = event.input;
  if (toolName !== "shell_start" || !isRecord(input) || !Array.isArray(input.commands)) {
    return [];
  }
  return input.commands
    .map((item: unknown) => isRecord(item) && typeof item.command === "string" ? item.command : "")
    .filter((command: string) => command.length > 0);
}

function splitShellOperations(command: string): string[] {
  const lines = command.split(/\r?\n/);
  const operations: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heredoc = line.match(/<<\s*["']?([a-z_][a-z0-9_]*)["']?/i);
    if (!heredoc) {
      operations.push(...splitInlineShellOperations(line));
      continue;
    }

    const block = [line];
    for (index += 1; index < lines.length; index += 1) {
      block.push(lines[index]);
      if (lines[index].trim() === heredoc[1]) break;
    }
    operations.push(block.join("\n"));
  }

  return operations.filter((operation) => operation.trim().length > 0);
}

function splitInlineShellOperations(command: string): string[] {
  const operations: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }

    const separatorLength = command.startsWith("&&", index) || command.startsWith("||", index)
      ? 2
      : character === ";" ? 1 : 0;
    if (separatorLength === 0) continue;
    const operation = command.slice(start, index).trim();
    if (operation) operations.push(operation);
    index += separatorLength - 1;
    start = index + 1;
  }

  const finalOperation = command.slice(start).trim();
  if (finalOperation) operations.push(finalOperation);
  return operations;
}

function isEnvironmentMutationCommand(command: string): boolean {
  const trimmed = command.trim();
  if (/^(?:(?:sudo|env|command)\s+)*(?:(?:[a-z_][a-z0-9_]*=\S+)\s+)*(?:echo|printf|grep|rg|cat|sed|awk|head|tail|less|type|which)\b/i.test(trimmed)) return false;
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[^\s;&|]*(?:deploy|promot|migrat)[^\s;&|]*/i.test(command)) return true;
  if (/^(?:[^\s;&|]*\/)?(?:deploy|promote|migrate)(?:[._-][^\s;&|]+)?(?:\s|$)/i.test(trimmed)) return true;
  const iamMutation = /\b(?:set|add|remove)[-_ ]?iam[-_ ]?policy(?:[-_ ]?binding)?\b/i;
  const iamMutationCall = /\b(?:set|add|remove)[-_ ]?iam[-_ ]?policy(?:[-_ ]?binding)?\s*\(/i;
  if (iamMutation.test(command) && (iamMutationCall.test(command) || /(?:https?:|urllib|requests?\.|curl\b|\.(?:set|add|remove)[-_ ]?iam)/i.test(command))) return true;

  const tokens = shellCommandTokens(command);
  if (tokens.includes("kubectl")) {
    const positionals = positionalTokensAfter(tokens, "kubectl");
    const action = positionals[0];
    if (!action) return false;
    if (["get", "describe", "logs", "top", "events", "explain", "api-resources", "api-versions", "cluster-info", "version", "wait", "diff", "auth", "config", "completion", "options", "proxy", "port-forward"].includes(action)) return false;
    if (action === "rollout") return ["restart", "undo", "pause", "resume"].includes(positionals[1] ?? "");
    return ["apply", "create", "delete", "patch", "scale", "replace", "label", "annotate", "edit", "set", "drain", "cordon", "uncordon", "run", "expose", "autoscale", "taint", "attach", "exec", "cp"].includes(action);
  }
  if (tokens.includes("gcloud")) {
    const positionals = positionalTokensAfter(tokens, "gcloud");
    if (["auth", "config"].includes(positionals[0] ?? "")) return false;
    return classifyCloudAction(positionals, ["list", "describe", "get", "show", "print", "help", "version"]);
  }
  if (tokens.includes("aws")) {
    const positionals = positionalTokensAfter(tokens, "aws");
    if (positionals[0] === "configure") return false;
    return classifyCloudAction(positionals.slice(1), ["list", "describe", "get", "head", "select", "lookup", "check", "validate", "generate", "help", "version", "presign"]);
  }
  if (tokens.includes("az")) {
    const positionals = positionalTokensAfter(tokens, "az");
    if (["login", "account", "config"].includes(positionals[0] ?? "")) return false;
    return classifyCloudAction(positionals, ["list", "show", "get", "check", "help", "version"]);
  }
  if (/\bterraform\s+(?:apply|destroy|import|taint|untaint|state\s+(?:mv|rm))\b/i.test(command)) return true;
  if (/\bpulumi\s+(?:up|destroy|import|state\s+(?:delete|move|repair))\b/i.test(command)) return true;
  if (/\bhelm\s+(?:install|upgrade|uninstall|rollback)\b/i.test(command)) return true;
  return /\bgarden\s+deploy\b/i.test(command);
}

function shellCommandTokens(command: string): string[] {
  return Array.from(command.matchAll(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/g), (match) =>
    match[0].replace(/^["']|["']$/g, "").replace(/^[;&|]+|[;&|]+$/g, "").toLowerCase()
  ).filter(Boolean);
}

function positionalTokensAfter(tokens: string[], executable: string): string[] {
  const start = tokens.indexOf(executable);
  if (start === -1) return [];
  const positionals: string[] = [];
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (!token.includes("=") && tokens[index + 1] && !tokens[index + 1].startsWith("-")) index += 1;
  }
  return positionals;
}

function classifyCloudAction(positionals: string[], readActions: string[]): boolean {
  const mutationActions = new Set([
    "add", "remove", "set", "update", "create", "delete", "deploy", "replace", "attach", "detach", "enable", "disable",
    "start", "stop", "restart", "reset", "restore", "import", "destroy", "rm", "move", "cp", "copy", "sync", "submit", "cancel",
    "promote", "put", "associate", "disassociate", "register", "deregister", "modify", "terminate", "run", "invoke"
  ]);
  const reads = new Set(readActions);
  for (const token of positionals) {
    const action = token.split("-")[0];
    if (reads.has(action)) return false;
    if (mutationActions.has(action)) return true;
  }
  return false;
}

function hasProductionTarget(command: string): boolean {
  return extractEnvironmentTargets(command).some((target) => /(^|[^a-z0-9])(prod|production)(?=$|[^a-z0-9])/i.test(target));
}

function hasApprovedNonProductionTarget(command: string): boolean {
  return extractEnvironmentTargets(command).some((target) =>
    /(^|[^a-z0-9])(local|dev|development|test|testing|qa|staging|stage|sandbox|preview|demo|ephemeral)(?=$|[^a-z0-9])/i.test(target)
  );
}

function hasContextApprovedTarget(command: string, approvalContext: string): boolean {
  const targets = extractEnvironmentTargets(command).filter((target) => target.length >= 3);
  return approvalContext.split(/\r?\n/).some((line) => {
    const normalized = line.toLowerCase();
    if (/[?]/.test(line) || /\b(do not|don't|never|can|cannot|can't|should|could|would|whether|if|after|before|pending|without approval|not authorized|not approved|not approve|have not approved|haven't approved|review)\b/i.test(line)) return false;
    const explicitApproval = /\b(approv(?:e|ed)|authoriz(?:e|ed)|go ahead|proceed)\b/i.test(line);
    const imperative = /^\s*(?:please\s+)?(?:deploy|promote|migrate|apply|change|update|use|target)\b/i.test(line);
    if (!explicitApproval && !imperative) return false;
    return targets.some((target) => normalized.includes(target.toLowerCase()));
  });
}

function extractEnvironmentTargets(command: string): string[] {
  const targets: string[] = [];
  const targetPatterns = [
    /(?:--(?:context|project|account|profile|cluster|namespace|environment|env|stage|target|host|database|service-account|role-name)|-n)(?:=|\s+)["']?([a-z0-9][a-z0-9._@/-]*)/gi
  ];
  if (/\b(?:python\d*|node|ruby|perl)\b/i.test(command)) {
    targetPatterns.push(/\b(?:project|context|environment|env|cluster|namespace|account|email|service[_-]?account)\s*=\s*["']([^"']+)["']/gi);
  }
  for (const pattern of targetPatterns) {
    for (const match of command.matchAll(pattern)) targets.push(match[1]);
  }

  return Array.from(new Set(targets));
}

function evaluateToolCall(event: ToolCallEvent, context: ExtensionContext): SafetyDecision {
  const toolName = getToolName(event);
  const input = event.input;

  if (toolName === "bash") {
    return evaluateBash(getStringField(input, ["command", "cmd", "script"]));
  }

  if (toolName === "shell_start") {
    return evaluateAsyncShellStart(input, context);
  }

  if (["shell_status", "shell_read", "shell_cancel"].includes(toolName)) {
    return {
      action: "allow",
      risk: "low",
      reason: `${toolName} only manages async shell jobs created by Pi.`,
      ruleId: "async-shell-management",
      tags: ["async-shell"]
    };
  }

  if (["write", "edit"].includes(toolName)) {
    return evaluatePathMutation(input, context, toolName);
  }

  if (["write_many", "edit_many"].includes(toolName)) {
    return evaluatePathMutations(getPathFields(input), context, toolName);
  }

  if (["read", "grep", "find", "ls"].includes(toolName)) {
    return evaluatePathRead(input, context, toolName);
  }

  if (toolName === "read_many" || toolName === "search_many") {
    return evaluatePathReads(getPathFields(input), context, toolName);
  }

  if (toolName === "document_parse") {
    return evaluateDocumentParse(input, context);
  }

  if (toolName === "orchestrate") {
    return evaluateReadOnlyOrchestrate(input);
  }

  if (toolName === "searxng_search") {
    return {
      action: "allow",
      risk: "low",
      reason: "Configured SearXNG search tool is allowed.",
      ruleId: "searxng-search",
      tags: ["search", "network"]
    };
  }

  if (toolName === "web_fetch_many") {
    return evaluateWebFetchMany(input);
  }

  if (toolName === "mcp" || toolName.startsWith("mcp_")) {
    return {
      action: "review",
      risk: "medium",
      reason: "MCP tool calls are reviewed until the called server/tool is explicitly trusted.",
      ruleId: "mcp-review",
      tags: ["mcp"]
    };
  }

  return {
    action: "review",
    risk: "medium",
    reason: `Unknown or third-party tool '${toolName}' requires review.`,
    ruleId: "unknown-tool",
    tags: ["unknown-tool"]
  };
}

export function evaluateReadOnlyOrchestrate(input: unknown): SafetyDecision {
  if (!isRecord(input) || !Array.isArray(input.tasks) || input.tasks.length === 0 || input.tasks.length > 8) {
    return {
      action: "review",
      risk: "medium",
      reason: "Malformed or out-of-bounds orchestrate input requires review.",
      ruleId: "orchestrate-shape-review",
      tags: ["orchestrate"]
    };
  }

  const allowedKeys = new Set(["id", "task", "role", "model", "thinkingLevel"]);
  const readOnly = input.tasks.every((task) => {
    if (!isRecord(task) || typeof task.task !== "string" || !task.task.trim()) return false;
    if (task.role !== undefined && task.role !== "reader" && task.role !== "planner") return false;
    return Object.keys(task).every((key) => allowedKeys.has(key));
  });
  if (!readOnly) {
    return {
      action: "review",
      risk: "medium",
      reason: "Orchestrate input requests an unsupported or potentially mutating mode.",
      ruleId: "orchestrate-non-read-only-review",
      tags: ["orchestrate"]
    };
  }

  return {
    action: "allow",
    risk: "low",
    reason: "Orchestrate is restricted to bounded reader/planner children with a deterministic read-only tool allowlist.",
    ruleId: "orchestrate-read-only",
    tags: ["orchestrate", "read-only", "subagent"]
  };
}

export function evaluateBash(command: string): SafetyDecision {
  if (!command.trim()) {
    return {
      action: "deny",
      risk: "medium",
      reason: "Empty bash commands are not useful and are blocked.",
      ruleId: "empty-bash",
      tags: ["bash"]
    };
  }

  const credentialDecision = classifyCredentialPathInCommand(command);
  if (credentialDecision !== undefined) {
    return credentialDecision;
  }

  for (const rule of commandRules) {
    if (rule.pattern.test(command)) {
      return {
        action: rule.action,
        risk: rule.risk,
        reason: rule.reason,
        ruleId: rule.id,
        tags: rule.tags
      };
    }
  }

  const readOnlyDecision = classifyReadOnlyShell(command);
  if (readOnlyDecision !== undefined) {
    return readOnlyDecision;
  }

  const localAllowDecision = classifyAllowedLocalShell(command);
  if (localAllowDecision !== undefined) {
    return localAllowDecision;
  }

  return {
    action: "review",
    risk: "medium",
    reason: "Unclassified bash command requires review.",
    ruleId: "bash-default-review",
    tags: ["bash"]
  };
}

function classifyCredentialPathInCommand(command: string): SafetyDecision | undefined {
  const normalized = command.replaceAll("\\", "/");
  if (!secretCommandPathPatterns.some((pattern) => pattern.test(normalized))) {
    return undefined;
  }

  return {
    action: "review",
    risk: "high",
    reason: "Command references a credential, token, key, or shell-history path.",
    ruleId: "secret-command-path",
    tags: ["bash", "filesystem", "credentials"]
  };
}

function classifyReadOnlyShell(command: string): SafetyDecision | undefined {
  if (!isReadOnlyShell(command)) {
    return undefined;
  }

  return {
    action: "allow",
    risk: "low",
    reason: "Recognized read-only repository inspection command inside the trusted workspace.",
    ruleId: "read-only-shell",
    tags: ["bash", "filesystem", "read-only"]
  };
}

function classifyAllowedLocalShell(command: string): SafetyDecision | undefined {
  if (!isAllowedLocalShell(command)) {
    return undefined;
  }

  return {
    action: "allow",
    risk: "medium",
    reason: "Recognized Claude auto-mode local development command.",
    ruleId: "local-development-shell",
    tags: ["bash", "local-development"]
  };
}

function isAllowedLocalShell(command: string): boolean {
  if (hasUnsupportedReadOnlyShellSyntax(command)) {
    return false;
  }

  const segments = splitShellSegments(command);
  if (segments === undefined || segments.length === 0) {
    return false;
  }

  return segments.every((segment) => {
    const tokens = tokenizeShellSegment(segment);
    return tokens !== undefined && isAllowedLocalSimpleCommand(tokens);
  });
}

function isReadOnlyShell(command: string): boolean {
  if (hasUnsupportedReadOnlyShellSyntax(command)) {
    return false;
  }

  const segments = splitShellSegments(command);
  if (segments === undefined || segments.length === 0) {
    return false;
  }

  return segments.every((segment) => {
    const tokens = tokenizeShellSegment(segment);
    return tokens !== undefined && isReadOnlySimpleCommand(tokens, true);
  });
}

function hasUnsupportedReadOnlyShellSyntax(command: string): boolean {
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const next = command[index + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (character === "`" || character === "$" || character === "<" || character === ">") {
      return true;
    }

    if (character === "|" && next === "|") {
      return true;
    }

    if (character === "&") {
      if (next !== "&") {
        return true;
      }
      index += 1;
    }
  }

  return quote !== undefined;
}

function splitShellSegments(command: string): string[] | undefined {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const next = command[index + 1];

    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }

    if (quote !== undefined) {
      current += character;
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      current += character;
      continue;
    }

    if (character === "|" || character === ";" || (character === "&" && next === "&")) {
      if (character === "&") {
        index += 1;
      }
      const segment = current.trim();
      if (segment.length > 0) {
        segments.push(segment);
      }
      current = "";
      continue;
    }

    current += character;
  }

  if (quote !== undefined) {
    return undefined;
  }

  const finalSegment = current.trim();
  if (finalSegment.length > 0) {
    segments.push(finalSegment);
  }

  return segments;
}

function tokenizeShellSegment(segment: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (const character of segment) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (quote !== undefined) {
    return undefined;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function isReadOnlySimpleCommand(tokens: string[], allowFindExec: boolean): boolean {
  if (tokens.length === 0 || !tokensUseOnlyTrustedAbsolutePaths(tokens)) {
    return false;
  }

  const commandName = path.basename(tokens[0]);
  if (readOnlyShellCommands.has(commandName)) {
    return commandName !== "find"
      ? hasOnlyReadOnlyFlags(commandName, tokens)
      : hasOnlyReadOnlyFindActions(tokens, allowFindExec);
  }

  if (commandName === "git") {
    return tokens.length > 1 && readOnlyGitSubcommands.has(tokens[1]) && tokensUseOnlyTrustedAbsolutePaths(tokens.slice(2));
  }

  if (["npm", "pnpm", "yarn", "bun"].includes(commandName)) {
    return tokens.length > 1 && readOnlyPackageSubcommands.has(tokens[1]);
  }

  return false;
}

function isAllowedLocalSimpleCommand(tokens: string[]): boolean {
  if (tokens.length === 0 || !tokensUseOnlyTrustedAbsolutePaths(tokens)) {
    return false;
  }

  const effectiveTokens = stripLeadingEnvAssignments(tokens);
  if (effectiveTokens.length === 0) {
    return false;
  }

  if (isReadOnlySimpleCommand(effectiveTokens, true)) {
    return true;
  }

  const commandName = path.basename(effectiveTokens[0]);
  if (harmlessShellCommands.has(commandName)) {
    return isHarmlessShellCommand(commandName, effectiveTokens);
  }

  if (commandName === "git") {
    return isAllowedLocalGitCommand(effectiveTokens);
  }

  if (nodePackageManagers.has(commandName)) {
    return isAllowedNodePackageCommand(commandName, effectiveTokens);
  }

  if (["pip", "pip3"].includes(commandName)) {
    return effectiveTokens.length > 1 && ["install", "uninstall"].includes(effectiveTokens[1]);
  }

  if (commandName === "uv") {
    return isAllowedUvCommand(effectiveTokens);
  }

  if (["pdm", "poetry"].includes(commandName)) {
    return isAllowedPythonProjectCommand(effectiveTokens);
  }

  if (commandName === "cargo") {
    return isAllowedCargoCommand(effectiveTokens);
  }

  if (commandName === "go") {
    return isAllowedGoCommand(effectiveTokens);
  }

  if (commandName === "brew") {
    return effectiveTokens.length > 1 && ["install", "update", "upgrade", "--version"].includes(effectiveTokens[1]);
  }

  if (safeDevCommands.has(commandName)) {
    return isSafeDevCommand(commandName, effectiveTokens);
  }

  return false;
}

function stripLeadingEnvAssignments(tokens: string[]): string[] {
  const firstCommand = tokens.findIndex((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  return firstCommand === -1 ? [] : tokens.slice(firstCommand);
}

function isHarmlessShellCommand(commandName: string, tokens: string[]): boolean {
  if (["echo", "printf", "true", "false"].includes(commandName)) {
    return true;
  }

  if (["command", "which"].includes(commandName)) {
    return tokens.length >= 2 && tokens.length <= 3 && (tokens[1] === "-v" || tokens[1] === "-V" || commandName === "which");
  }

  return false;
}

function isAllowedLocalGitCommand(tokens: string[]): boolean {
  if (tokens.length <= 1) {
    return false;
  }

  const subcommand = tokens[1];
  if (readOnlyGitSubcommands.has(subcommand) || allowedLocalGitSubcommands.has(subcommand)) {
    return true;
  }

  return subcommand === "push" && isAllowedRoutineGitPushCommand(tokens.slice(2));
}

function isAllowedRoutineGitPushCommand(args: string[]): boolean {
  if (args.some(isUnsafeGitPushToken)) {
    return false;
  }

  const refArgs = getGitPushRefArguments(args);
  return refArgs.length > 0 && !refArgs.some(referencesProtectedGitPushDestination);
}

function isUnsafeGitPushToken(token: string): boolean {
  const normalized = token.toLowerCase();
  return normalized === "-d"
    || normalized === "-f"
    || normalized === "--all"
    || normalized === "--mirror"
    || normalized === "--prune"
    || normalized === "--tags"
    || normalized === "--delete"
    || normalized.startsWith("--delete=")
    || normalized.startsWith("--force")
    || normalized.startsWith("+")
    || normalized.startsWith(":");
}

function getGitPushRefArguments(args: string[]): string[] {
  const positional = args.filter((arg) => arg.length > 0 && !arg.startsWith("-"));
  if (positional.length === 0) {
    return [];
  }

  if (positional.length === 1) {
    const only = positional[0];
    return only.includes(":") || only.startsWith("+") ? [only] : [];
  }

  return positional.slice(1);
}

function referencesProtectedGitPushDestination(refspec: string): boolean {
  const normalized = refspec.replace(/^\+/, "");
  const separator = normalized.lastIndexOf(":");
  const destination = separator === -1 ? normalized : normalized.slice(separator + 1);
  return destination.length === 0 || isProtectedGitPushDestination(destination);
}

function isProtectedGitPushDestination(destination: string): boolean {
  if (destination.startsWith("refs/tags/")) {
    return true;
  }

  const branch = destination.replace(/^refs\/heads\//, "");
  return protectedGitPushBranchPatterns.some((pattern) => pattern.test(branch));
}

function isAllowedNodePackageCommand(commandName: string, tokens: string[]): boolean {
  if (tokens.length < 2) {
    return false;
  }

  const subcommand = tokens[1];
  if (dependencyPackageSubcommands.has(subcommand)) {
    return true;
  }

  if (["test", "start"].includes(subcommand) || safeScriptNames.has(subcommand)) {
    return true;
  }

  if (subcommand === "run") {
    return tokens.length > 2 && isSafeScriptName(tokens[2]);
  }

  if (commandName === "yarn" && isSafeScriptName(subcommand)) {
    return true;
  }

  return false;
}

function isAllowedUvCommand(tokens: string[]): boolean {
  if (tokens.length < 2) {
    return false;
  }

  const subcommand = tokens[1];
  if (dependencyPackageSubcommands.has(subcommand)) {
    return true;
  }

  if (subcommand === "pip") {
    return tokens.length > 2 && ["install", "uninstall", "sync"].includes(tokens[2]);
  }

  if (subcommand === "run") {
    return tokens.length > 2 && isAllowedLocalSimpleCommand(tokens.slice(2));
  }

  return false;
}

function isAllowedPythonProjectCommand(tokens: string[]): boolean {
  if (tokens.length < 2) {
    return false;
  }

  const subcommand = tokens[1];
  if (dependencyPackageSubcommands.has(subcommand)) {
    return true;
  }

  if (subcommand === "run") {
    return tokens.length > 2 && (isSafeScriptName(tokens[2]) || isAllowedLocalSimpleCommand(tokens.slice(2)));
  }

  return false;
}

function isAllowedCargoCommand(tokens: string[]): boolean {
  return tokens.length > 1 && ["add", "build", "check", "clippy", "fmt", "install", "run", "test", "update"].includes(tokens[1]);
}

function isAllowedGoCommand(tokens: string[]): boolean {
  if (tokens.length < 2) {
    return false;
  }

  if (["build", "fmt", "generate", "get", "install", "run", "test", "vet"].includes(tokens[1])) {
    return true;
  }

  return tokens[1] === "mod" && tokens.length > 2 && ["download", "tidy", "vendor", "verify"].includes(tokens[2]);
}

function isSafeDevCommand(commandName: string, tokens: string[]): boolean {
  if (["make", "cmake", "ninja"].includes(commandName)) {
    return !tokens.some((token) => /deploy|prod|production|publish|release/i.test(token));
  }

  return true;
}

function isSafeScriptName(scriptName: string): boolean {
  const normalized = scriptName.replace(/^--/, "").split(/[=:]/, 1)[0];
  return safeScriptNames.has(normalized) || /^(build|check|dev|docs|format|fmt|lint|preview|serve|start|test|typecheck)(:[\w.-]+)?$/.test(normalized);
}

function hasOnlyReadOnlyFlags(commandName: string, tokens: string[]): boolean {
  if (commandName === "sed") {
    return !tokens.some((token) => token === "--in-place" || /^-i/.test(token));
  }

  if (commandName === "sort") {
    return !tokens.some((token) => token === "-o" || token.startsWith("--output"));
  }

  return true;
}

function hasOnlyReadOnlyFindActions(tokens: string[], allowFindExec: boolean): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(token)) {
      return false;
    }

    if (["-exec", "-execdir", "-ok", "-okdir"].includes(token)) {
      if (!allowFindExec || !isReadOnlyFindExec(tokens.slice(index + 1))) {
        return false;
      }
    }
  }

  return true;
}

function isReadOnlyFindExec(tokens: string[]): boolean {
  const endIndex = tokens.findIndex((token) => token === ";" || token === "+");
  if (endIndex <= 0) {
    return false;
  }

  const execTokens = tokens.slice(0, endIndex);
  const execCommandName = path.basename(execTokens[0]);
  return readOnlyFindExecCommands.has(execCommandName) && isReadOnlySimpleCommand(execTokens, false);
}

function tokensUseOnlyTrustedAbsolutePaths(tokens: string[]): boolean {
  return tokens.every((token) => absolutePathFragments(token).every(isTrustedAbsolutePathFragment));
}

function absolutePathFragments(token: string): string[] {
  const fragments: string[] = [];
  const matches = token.matchAll(/(?:^|[=:#])((?:\/[A-Za-z0-9._@%+,\-]+)+)/g);
  for (const match of matches) {
    fragments.push(match[1].replace(/[).,;]+$/, ""));
  }

  if (token.startsWith("~")) {
    fragments.push(expandHome(token));
  }

  return fragments;
}

function isTrustedAbsolutePathFragment(fragment: string): boolean {
  const trustedWorkspaceRoot = getTrustedWorkspaceRoot();
  if (!trustedWorkspaceRoot) {
    return false;
  }

  const resolvedPath = path.resolve(fragment);
  return isInside(resolvedPath, trustedWorkspaceRoot);
}

export function evaluateAsyncShellStart(input: unknown, context: Pick<ExtensionContext, "cwd"> = { cwd: process.cwd() } as Pick<ExtensionContext, "cwd">): SafetyDecision {
  const requests = getAsyncShellCommandRequests(input);
  if (requests.length === 0) {
    return {
      action: "deny",
      risk: "medium",
      reason: "shell_start requires a non-empty commands list. Use a one-item list for a single command.",
      ruleId: "async-shell-empty-command",
      tags: ["async-shell"]
    };
  }

  const missingField = requests.find((request) => request.command === "" || request.cwd === "");
  if (missingField !== undefined) {
    return {
      action: "deny",
      risk: "medium",
      reason: "Each shell_start command requires non-empty command and cwd fields.",
      ruleId: "async-shell-missing-command-field",
      tags: ["async-shell"]
    };
  }

  const cwdDecisions = requests.map((request) => classifyPath(request.cwd, context as ExtensionContext));
  const blockedCwd = cwdDecisions.find((decision) => decision.action !== "allow");
  if (blockedCwd !== undefined) {
    return {
      ...blockedCwd,
      ruleId: `async-shell-cwd-${blockedCwd.ruleId}`,
      reason: `Async shell start cwd requires review: ${blockedCwd.reason}`,
      tags: Array.from(new Set([...blockedCwd.tags, "async-shell", "cwd"]))
    };
  }

  const commands = requests.map((request) => request.command);
  const decisions = commands.map((command) => evaluateBash(command));
  const denied = decisions.find((decision) => decision.action === "deny");
  if (denied !== undefined) {
    return {
      ...denied,
      ruleId: `async-shell-${denied.ruleId}`,
      reason: `Async shell start blocked: ${denied.reason}`,
      tags: Array.from(new Set([...denied.tags, "async-shell"]))
    };
  }

  const tags = Array.from(new Set(decisions.flatMap((decision) => decision.tags).concat("async-shell")));
  const risk = decisions.map((decision) => decision.risk).reduce(maxRisk, "low");

  if (decisions.every((decision) => decision.action === "allow")) {
    const readOnly = decisions.every((decision) => decision.ruleId === "read-only-shell");
    return {
      action: "allow",
      risk,
      reason: readOnly
        ? `Async shell start allowed for ${commands.length === 1 ? "read-only command" : `${commands.length} read-only commands`}.`
        : `Async shell start allowed for ${commands.length === 1 ? "Claude auto-mode command" : `${commands.length} Claude auto-mode commands`}.`,
      ruleId: readOnly ? "async-shell-read-only" : "async-shell-allowed",
      tags
    };
  }

  const reviewed = decisions.filter((decision) => decision.action === "review");
  if (reviewed.length > 0) {
    const highestRiskReview = reviewed.reduce((left, right) => maxRisk(left.risk, right.risk) === left.risk ? left : right);
    return {
      action: "review",
      risk,
      reason: reviewed.length === 1
        ? `Async shell start requires safety model review: ${highestRiskReview.reason}`
        : `Async shell start requires safety model review for ${reviewed.length} of ${commands.length} commands. Highest risk: ${highestRiskReview.reason}`,
      ruleId: `async-shell-${highestRiskReview.ruleId}`,
      tags
    };
  }

  return {
    action: "review",
    risk,
    reason: `Host rules did not auto-classify ${commands.length === 1 ? "this async shell command" : "every async shell command"}; route it to the model judge.`,
    ruleId: "async-shell-default-review",
    tags
  };
}

function evaluatePathMutation(input: unknown, context: ExtensionContext, toolName: string, trustedWorkspaceRoot = getTrustedWorkspaceRoot()): SafetyDecision {
  const targetPath = getPathField(input);
  if (!targetPath) {
    return {
      action: "review",
      risk: "medium",
      reason: `${toolName} mutates files but did not provide an explicit target path.`,
      ruleId: "file-mutation-missing-path",
      tags: ["filesystem", "mutation"]
    };
  }

  const pathRisk = classifyPath(targetPath, context, trustedWorkspaceRoot);
  if (pathRisk.action !== "allow") {
    return pathRisk;
  }

  return {
    action: "allow",
    risk: "low",
    reason: `${toolName} mutates a file inside the Claude auto-mode trusted workspace: ${targetPath}`,
    ruleId: "trusted-workspace-file-mutation",
    tags: ["filesystem", "mutation", "trusted-workspace"]
  };
}

export function evaluatePathMutations(paths: string[], context: ExtensionContext, toolName: string, trustedWorkspaceRoot = getTrustedWorkspaceRoot()): SafetyDecision {
  if (paths.length === 0) {
    return evaluatePathMutation(undefined, context, toolName, trustedWorkspaceRoot);
  }

  const decisions = paths.map((targetPath) => classifyPath(targetPath, context, trustedWorkspaceRoot));
  const blocked = decisions.find((decision) => decision.action !== "allow");
  if (blocked !== undefined) {
    return blocked;
  }

  return {
    action: "allow",
    risk: "low",
    reason: `${toolName} mutates ${paths.length} trusted workspace file${paths.length === 1 ? "" : "s"}.`,
    ruleId: "trusted-workspace-file-mutation",
    tags: ["filesystem", "mutation", "trusted-workspace"]
  };
}

function evaluatePathRead(input: unknown, context: ExtensionContext, toolName: string): SafetyDecision {
  const targetPath = getPathField(input);
  const pathRisk = classifyReadPath(targetPath, context);
  if (pathRisk.action !== "allow") {
    return pathRisk;
  }

  return {
    action: "allow",
    risk: "low",
    reason: `${toolName} read-only file access is allowed${targetPath ? `: ${targetPath}` : ""}.`,
    ruleId: "read-only-path",
    tags: ["filesystem", "read-only"]
  };
}

export function evaluateDocumentParse(input: unknown, context: ExtensionContext): SafetyDecision {
  return evaluatePathRead(input, context, "document_parse");
}

export function evaluatePathReads(paths: string[], context: ExtensionContext, toolName: string): SafetyDecision {
  if (paths.length === 0) {
    return evaluatePathRead(undefined, context, toolName);
  }

  const decisions = paths.map((targetPath) => classifyReadPath(targetPath, context));
  const blocked = decisions.find((decision) => decision.action !== "allow");
  if (blocked !== undefined) {
    return blocked;
  }

  return {
    action: "allow",
    risk: "low",
    reason: `${toolName} reads ${paths.length} local file${paths.length === 1 ? "" : "s"}.`,
    ruleId: "read-only-path",
    tags: ["filesystem", "read-only"]
  };
}

export function evaluateWebFetchMany(input: unknown): SafetyDecision {
  const urls = getUrlFields(input);
  if (urls.length === 0) {
    return {
      action: "review",
      risk: "medium",
      reason: "web_fetch_many did not include explicit URLs.",
      ruleId: "web-fetch-missing-url",
      tags: ["network", "web-fetch"]
    };
  }

  for (const rawUrl of urls) {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return {
        action: "review",
        risk: "medium",
        reason: `web_fetch_many includes an invalid URL: ${rawUrl}`,
        ruleId: "web-fetch-invalid-url",
        tags: ["network", "web-fetch"]
      };
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        action: "review",
        risk: "high",
        reason: `web_fetch_many only auto-allows HTTP(S) URLs: ${rawUrl}`,
        ruleId: "web-fetch-non-http",
        tags: ["network", "web-fetch"]
      };
    }

    if (parsed.username !== "" || parsed.password !== "") {
      return {
        action: "review",
        risk: "high",
        reason: `URL embeds credentials: ${rawUrl}`,
        ruleId: "web-fetch-credential-url",
        tags: ["network", "credentials", "web-fetch"]
      };
    }

    if (isPrivateOrLocalHostname(parsed.hostname)) {
      return {
        action: "review",
        risk: "high",
        reason: `web_fetch_many includes a localhost or private-network URL: ${rawUrl}`,
        ruleId: "web-fetch-private-network",
        tags: ["network", "private-network", "web-fetch"]
      };
    }
  }

  return {
    action: "allow",
    risk: "low",
    reason: `web_fetch_many fetches ${urls.length} public HTTP(S) URL${urls.length === 1 ? "" : "s"} for research.`,
    ruleId: "web-fetch-public-http",
    tags: ["network", "web-fetch", "read-only"]
  };
}

export function classifyPath(rawPath: string, context: ExtensionContext, trustedWorkspaceRoot = getTrustedWorkspaceRoot()): SafetyDecision {
  if (!rawPath) {
    return {
      action: "allow",
      risk: "low",
      reason: "No explicit path was provided.",
      ruleId: "no-path",
      tags: ["filesystem"]
    };
  }

  const cwd = path.resolve(context.cwd ?? process.cwd());
  const resolvedPath = path.resolve(cwd, expandHome(rawPath));
  const normalized = resolvedPath.replaceAll("\\", "/");

  if (secretPathPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      action: "review",
      risk: "high",
      reason: `Path appears to target credentials or shell history: ${rawPath}`,
      ruleId: "secret-path",
      tags: ["filesystem", "credentials"]
    };
  }

  if (!isInside(resolvedPath, cwd)) {
    if (trustedWorkspaceRoot && isInside(resolvedPath, trustedWorkspaceRoot)) {
      return {
        action: "allow",
        risk: "low",
        reason: `Path is inside the trusted workspace: ${rawPath}`,
        ruleId: "trusted-workspace-path",
        tags: ["filesystem", "trusted-workspace"]
      };
    }

    return {
      action: "review",
      risk: "high",
      reason: `Path is outside the active project: ${rawPath}`,
      ruleId: "external-path",
      tags: ["filesystem", "external-path"]
    };
  }

  return {
    action: "allow",
    risk: "low",
    reason: `Path is inside the active project: ${rawPath}`,
    ruleId: "project-path",
    tags: ["filesystem"]
  };
}

function classifyReadPath(rawPath: string, context: ExtensionContext): SafetyDecision {
  if (!rawPath) {
    return {
      action: "allow",
      risk: "low",
      reason: "No explicit path was provided.",
      ruleId: "no-path",
      tags: ["filesystem", "read-only"]
    };
  }

  const cwd = path.resolve(context.cwd ?? process.cwd());
  const resolvedPath = path.resolve(cwd, expandHome(rawPath));
  const normalized = resolvedPath.replaceAll("\\", "/");

  if (secretPathPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      action: "review",
      risk: "high",
      reason: `Read path appears to target credentials or shell history: ${rawPath}`,
      ruleId: "secret-path",
      tags: ["filesystem", "credentials", "read-only"]
    };
  }

  return {
    action: "allow",
    risk: "low",
    reason: `Read-only local file access is allowed: ${rawPath}`,
    ruleId: "read-only-path",
    tags: ["filesystem", "read-only"]
  };
}

async function requestModelApproval(
  context: ExtensionContext,
  event: ToolCallEvent,
  decision: SafetyDecision
): Promise<ModelApproval> {
  const selection = await selectApprovalModel(context);
  const { model, modelName, thinkingLevel } = selection;
  if (!model) {
    return modelApprovalError(selection.error ?? "No model is selected for AI safety approval.", modelName, "", thinkingLevel);
  }

  const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return modelApprovalError(auth.error, modelName, "", thinkingLevel);
  }

  const providerAuth = await context.modelRegistry.getProviderAuth(model.provider);
  if (!providerAuth) {
    return modelApprovalError(`No resolved provider auth is available for ${modelName}.`, modelName, "", thinkingLevel);
  }
  const provider = context.modelRegistry.getProvider(model.provider);
  if (!provider) {
    return modelApprovalError(`No runtime provider is available for ${modelName}.`, modelName, "", thinkingLevel);
  }

  const requestModel = providerAuth.auth.baseUrl
    ? { ...model, baseUrl: providerAuth.auth.baseUrl }
    : model;
  const abort = createTimeoutSignal(undefined, settings.approvalTimeoutMs);
  try {
    const response = await provider.streamSimple(
      requestModel,
      {
        systemPrompt: modelApprovalSystemPrompt,
        messages: [
          {
            role: "user",
            content: buildModelApprovalPrompt(context, event, decision),
            timestamp: Date.now()
          }
        ]
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env ?? providerAuth.env,
        reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
        maxTokens: settings.approvalMaxTokens,
        signal: abort.signal
      }
    ).result();

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return modelApprovalError(response.errorMessage ?? `Model stopped with ${response.stopReason}.`, modelName, "", thinkingLevel);
    }

    const text = response.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("\n")
      .trim();

    return parseModelApproval(text, modelName, thinkingLevel);
  } catch (error) {
    return modelApprovalError(error instanceof Error ? error.message : String(error), modelName, "", thinkingLevel);
  } finally {
    abort.dispose();
  }
}

async function selectApprovalModel(context: ExtensionContext): Promise<ApprovalModelSelection> {
  return resolveApprovalModelPreferenceWithRefresh(getEffectiveApprovalModelPreference().preference, context.modelRegistry);
}

export function setRuntimeApprovalModelPreference(preference: ApprovalModelPreference | undefined): void {
  runtimeApprovalModelOverride = preference;
  approvalModelUnavailableWarningShown = false;
}

export function setRuntimeToolSafetyEnabled(enabled: boolean): void {
  runtimeToolSafetyEnabled = enabled;
}

function getEffectiveApprovalModelPreference(): { preference?: ApprovalModelPreference; source: "runtime" | "config" } {
  return runtimeApprovalModelOverride
    ? { preference: runtimeApprovalModelOverride, source: "runtime" }
    : { preference: settings.approvalModel, source: "config" };
}

async function notifyApprovalModelUnavailableOnce(context: Pick<ExtensionContext, "hasUI" | "modelRegistry" | "ui">): Promise<void> {
  if (approvalModelUnavailableWarningShown || !runtimeToolSafetyEnabled || context.hasUI === false) {
    return;
  }

  const effective = getEffectiveApprovalModelPreference();
  if (!effective.preference) {
    return;
  }

  const selection = await resolveApprovalModelPreferenceWithRefresh(effective.preference, context.modelRegistry);
  if (selection.model) {
    return;
  }

  approvalModelUnavailableWarningShown = true;
  context.ui.notify(
    `Tool-safety approval model is unavailable from ${effective.source}/env: ${selection.error ?? "unknown error"}\nReviewed tool calls will require human approval until this is fixed. Use /safety:status for details.`,
    "warning"
  );
}

async function handleToolSafetySetupCommand(rawArgs: string, context: ExtensionContext): Promise<void> {
  let args: ReturnType<typeof parseGuidedModelSetupArgs>;
  try {
    args = parseGuidedModelSetupArgs(rawArgs, "/safety:setup");
  } catch (error) {
    context.ui.notify(`${errorMessage(error)}\n${toolSafetySetupUsage()}`, "error");
    return;
  }

  if (args.help || !args.modelSpec) {
    context.ui.notify(`${toolSafetySetupUsage()}\n\n${buildToolSafetyStatusText(context)}`, "info");
    return;
  }

  const preference = parseApprovalModelPreference(args.modelSpec);
  if (!preference) {
    context.ui.notify(toolSafetySetupUsage(), "error");
    return;
  }

  const selection = await resolveApprovalModelPreferenceWithRefresh(preference, context.modelRegistry);
  if (!selection.model) {
    context.ui.notify(`Tool-safety setup did not write config: ${selection.error ?? "model unavailable"}`, "error");
    return;
  }

  let guidance: string | undefined;
  try {
    guidance = readSetupGuidance(args, context.cwd);
  } catch (error) {
    context.ui.notify(`Tool-safety setup did not write config: ${errorMessage(error)}`, "error");
    return;
  }

  const clearGuidance = args.clearGuidance === true;
  const configPath = writeAgentExtensionConfig(TOOL_SAFETY_CONFIG_FILE, serializeToolSafetySettings(settings, selection, policyFileForSetupConfig(guidance, clearGuidance)));
  const policyGuidanceLine = applyToolSafetyPolicySetup(guidance, clearGuidance);
  setRuntimeApprovalModelPreference(undefined);
  settings = readToolSafetySettings();
  policyInfo = readPolicyInfo();
  context.ui.notify(
    [
      `Tool-safety setup saved ${selection.modelName} with ${selection.thinkingLevel} thinking.`,
      `Config: ${configPath}`,
      ...(policyGuidanceLine === undefined ? [] : [policyGuidanceLine]),
      "",
      buildToolSafetyStatusText(context)
    ].join("\n"),
    "info"
  );
}

function policyFileForSetupConfig(guidance: string | undefined, clearGuidance: boolean): string | undefined {
  if (clearGuidance) {
    return undefined;
  }
  if (guidance !== undefined) {
    return TOOL_SAFETY_POLICY_FILE;
  }
  return policyInfo.path ? formatConfigPath(policyInfo.path) : undefined;
}

function applyToolSafetyPolicySetup(guidance: string | undefined, clearGuidance: boolean): string | undefined {
  if (clearGuidance) {
    const result = removeAgentExtensionConfig(TOOL_SAFETY_POLICY_FILE);
    const suffix = result.removed ? result.path : `${result.path} (no per-machine policy file existed)`;
    return `Policy guidance: cleared ${suffix}`;
  }

  if (guidance === undefined) {
    return undefined;
  }

  return `Policy guidance: ${writeAgentExtensionTextConfig(TOOL_SAFETY_POLICY_FILE, guidance)}`;
}

function toolSafetySetupUsage(): string {
  return guidedModelSetupUsage("/safety:setup");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handleToolSafetyModelCommand(rawArgs: string, context: ExtensionContext): Promise<void> {
  const args = rawArgs.trim();
  if (!args) {
    context.ui.notify(`${toolSafetyModelUsage()}\n\n${buildToolSafetyStatusText(context)}`, "info");
    return;
  }

  if (args === "reset" || args === "default" || args === "clear") {
    setRuntimeApprovalModelPreference(undefined);
    context.ui.notify(`Tool-safety approval model reset to config/env value.\n\n${buildToolSafetyStatusText(context)}`, "info");
    return;
  }

  const preference = parseApprovalModelPreference(args);
  if (!preference) {
    context.ui.notify(toolSafetyModelUsage(), "error");
    return;
  }

  const selection = await resolveApprovalModelPreferenceWithRefresh(preference, context.modelRegistry);
  if (!selection.model) {
    context.ui.notify(`Tool-safety approval model was not changed: ${selection.error ?? "model unavailable"}`, "error");
    return;
  }

  setRuntimeApprovalModelPreference(preference);
  context.ui.notify(`Tool-safety approval model set to ${selection.modelName} with ${selection.thinkingLevel} thinking for this extension runtime.`, "info");
}

function toolSafetyModelUsage(): string {
  return "Usage: /safety:model provider/model[:thinking] | reset";
}

function handleToolSafetyToggleCommand(rawArgs: string, context: ExtensionContext): void {
  const args = rawArgs.trim().toLowerCase();
  const enabled = parseToolSafetyToggleArg(args);
  if (enabled === undefined) {
    context.ui.notify(toolSafetyToggleUsage(), "error");
    return;
  }

  setRuntimeToolSafetyEnabled(enabled);
  const state = enabled ? "enabled" : "disabled";
  context.ui.notify(`Tool-safety enforcement ${state} for this extension runtime.\n\n${buildToolSafetyStatusText(context)}`, enabled ? "info" : "warning");
}

function parseToolSafetyToggleArg(args: string): boolean | undefined {
  if (!args) {
    return !runtimeToolSafetyEnabled;
  }
  if (args === "on" || args === "enable" || args === "enabled" || args === "true") {
    return true;
  }
  if (args === "off" || args === "disable" || args === "disabled" || args === "false") {
    return false;
  }
  return undefined;
}

function toolSafetyToggleUsage(): string {
  return "Usage: /safety:toggle [on|off]";
}

export function buildToolSafetyStatusText(context: Pick<ExtensionContext, "modelRegistry">): string {
  const effective = getEffectiveApprovalModelPreference();
  const selection = resolveApprovalModelPreference(effective.preference, context.modelRegistry);
  const configured = settings.approvalModel ? formatApprovalModelPreference(settings.approvalModel) : "none";
  const runtime = runtimeApprovalModelOverride ? formatApprovalModelPreference(runtimeApprovalModelOverride) : "none";
  const selected = selection.model
    ? `${selection.modelName} · thinking ${selection.thinkingLevel}`
    : `unavailable · ${selection.error ?? "unknown error"}`;
  return [
    "Tool-safety approval judge",
    `Enforcement: ${runtimeToolSafetyEnabled ? "enabled" : "disabled"}`,
    `Effective source: ${effective.source === "runtime" ? "runtime override" : "config/env"}`,
    `Effective model: ${selected}`,
    `Runtime override: ${runtime}`,
    `Config/env model: ${configured}`,
    `Policy source: ${policyInfo.source}`,
    `Review criteria: ${settings.reviewCriteria}`,
    ...(settings.approvalModel ? [] : ["Setup: run /safety:setup provider/model[:thinking] to enable AI approval routing"]),
    `Trusted workspace root: ${getTrustedWorkspaceRoot() ?? "none"}`,
    `AI approval timeout: ${settings.approvalTimeoutMs === undefined ? "none" : `${settings.approvalTimeoutMs}ms`}`,
    `Human review timeout: ${settings.humanReviewTimeoutMs === undefined ? "none" : `${settings.humanReviewTimeoutMs}ms`}`
  ].join("\n");
}

function formatApprovalModelPreference(preference: ApprovalModelPreference): string {
  return preference.thinkingLevel ? `${preference.model} (${preference.thinkingLevel})` : preference.model;
}

export type ApprovalModelSelection = {
  model?: Model<Api>;
  modelName: string;
  thinkingLevel?: ThinkingLevel;
  error?: string;
};

export function resolveApprovalModelPreference(preferred: ApprovalModelPreference | undefined, registry: ExtensionModelRegistry): ApprovalModelSelection {
  return resolveApprovalModelPreferenceOnce(preferred, registry);
}

export async function resolveApprovalModelPreferenceWithRefresh(
  preferred: ApprovalModelPreference | undefined,
  registry: ExtensionModelRegistry
): Promise<ApprovalModelSelection> {
  const initial = resolveApprovalModelPreferenceOnce(preferred, registry);
  if (initial.model || preferred === undefined || !registry.refresh) {
    return initial;
  }

  try {
    await registry.refresh();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...initial,
      error: `${initial.error ?? "model unavailable"} Registry refresh failed: ${message}`
    };
  }

  return resolveApprovalModelPreferenceOnce(preferred, registry);
}

function resolveApprovalModelPreferenceOnce(preferred: ApprovalModelPreference | undefined, registry: ExtensionModelRegistry): ApprovalModelSelection {
  if (preferred === undefined) {
    return {
      modelName: "none",
      error: "No approvalModel is configured for AI safety approval."
    };
  }

  try {
    const { model, thinkingLevel } = resolveExtensionModel({
      registry,
      requested: preferred.model,
      fallbackThinkingLevel: preferred.thinkingLevel ?? "low",
      label: "AI safety approval",
      noModelMessage: "No approvalModel is configured for AI safety approval."
    });
    return { model, modelName: formatModelName(model), thinkingLevel };
  } catch (error) {
    return {
      modelName: preferred.model,
      thinkingLevel: preferred.thinkingLevel,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function applyModelApproval(decision: SafetyDecision, approval: ModelApproval): SafetyDecision {
  const tags = Array.from(new Set([...decision.tags, "model-approval"]));

  if (approval.error) {
    return {
      ...decision,
      action: "review",
      reason: `Safety judge unavailable (${approval.reason}); falling back to host: ${decision.reason}`,
      ruleId: `${decision.ruleId}+model-unavailable`,
      tags
    };
  }

  if (approval.action === "deny") {
    return {
      ...decision,
      action: "deny",
      risk: maxRisk(decision.risk, approval.risk),
      confidence: approval.confidence,
      reason: approval.reason,
      ruleId: `${decision.ruleId}+model-deny`,
      tags
    };
  }

  if (approval.action === "allow") {
    return {
      ...decision,
      action: "allow",
      risk: maxRisk(decision.risk, approval.risk),
      confidence: approval.confidence,
      reason: approval.reason,
      ruleId: `${decision.ruleId}+model-allow`,
      tags
    };
  }

  return {
    ...decision,
    action: "review",
    risk: maxRisk(decision.risk, approval.risk),
    confidence: approval.confidence,
    reason: approval.reason,
    ruleId: `${decision.ruleId}+model-review`,
    tags
  };
}

async function requestReview(context: ExtensionContext, event: ToolCallEvent, decision: SafetyDecision): Promise<boolean> {
  if (!context.hasUI) {
    return false;
  }

  const prompt = buildHumanReviewPrompt(event, decision);
  const options = buildHumanReviewConfirmOptions();

  try {
    return await context.ui.confirm(prompt.title, prompt.message, options);
  } catch {
    return false;
  }
}

export function buildHumanReviewConfirmOptions(timeoutMs = settings.humanReviewTimeoutMs): { timeout: number } | undefined {
  return timeoutMs === undefined ? undefined : { timeout: timeoutMs };
}

export function buildHumanReviewPrompt(event: ToolCallEvent, decision: SafetyDecision): { title: string; message: string } {
  const toolName = getToolName(event);
  const header = decision.confidence
    ? `risk: ${decision.risk} · confidence: ${decision.confidence}`
    : `risk: ${decision.risk}`;
  return {
    title: `Approve ${toolName}?`,
    message: [
      header,
      "",
      summarizeToolInput(toolName, event.input),
      "",
      decision.reason
    ].join("\n")
  };
}

function summarizeToolInput(toolName: string, input: unknown): string {
  if (toolName === "shell_start") {
    const requests = getAsyncShellCommandRequests(input);
    if (requests.length > 0) {
      return summarizeList(requests.map(formatAsyncShellCommandRequest), "command");
    }
  }

  if (toolName === "bash") {
    const command = getStringField(input, ["command", "cmd", "script"]);
    if (command.trim()) {
      return truncateOneLine(command, 500);
    }
  }

  if (["read_many", "search_many", "write_many", "edit_many", "read", "write", "edit", "document_parse"].includes(toolName)) {
    const paths = getPathFields(input);
    if (paths.length > 0) {
      return summarizeList(paths, "path");
    }
  }

  if (toolName === "web_fetch_many") {
    const urls = getUrlFields(input);
    if (urls.length > 0) {
      return summarizeList(urls, "url");
    }
  }

  return preview(input, 800);
}

function summarizeList(items: string[], label: string): string {
  if (items.length === 1) {
    return truncateOneLine(items[0], 500);
  }

  const shown = items.slice(0, 8).map((item, index) => `${index + 1}. ${truncateOneLine(item, 500)}`);
  const hiddenCount = items.length - shown.length;
  return hiddenCount > 0 ? `${shown.join("\n")}\n…and ${hiddenCount} more ${label}${hiddenCount === 1 ? "" : "s"}` : shown.join("\n");
}

function block(decision: SafetyDecision): ToolCallEventResult {
  return {
    block: true,
    reason: `[tool-safety:${decision.ruleId}] ${decision.reason}`
  };
}

function writeAudit(context: ExtensionContext, event: ToolCallEvent, decision: SafetyDecision, details: AuditDetails): void {
  const cwd = path.resolve(context.cwd ?? process.cwd());
  const auditDir = path.join(cwd, ".pi", "tool-safety");
  const auditPath = path.join(auditDir, "audit.jsonl");
  const entry = {
    ts: new Date().toISOString(),
    cwd,
    tool: getToolName(event),
    input: preview(event.input, 4000),
    decision,
    details
  };

  mkdirSync(auditDir, { recursive: true });
  writeFileSync(auditPath, `${JSON.stringify(entry)}\n`, { flag: "a" });
}

function buildModelApprovalPrompt(context: ExtensionContext, event: ToolCallEvent, decision: SafetyDecision): string {
  return [
    "Evaluate this proposed Pi tool call under the policy.",
    "",
    "Policy:",
    preview(policyInfo.text, settings.policyMaxChars),
    "",
    "Runtime:",
    `cwd: ${context.cwd}`,
    `tool: ${getToolName(event)}`,
    "",
    "Current user request:",
    getCurrentUserRequest(context),
    "",
    "Recent user context, newest last:",
    getRecentUserContext(context),
    "",
    "Host pre-classification (routing and risk context only):",
    JSON.stringify(decision, null, 2),
    "",
    "Tool input:",
    preview(event.input, settings.toolInputMaxChars),
    "",
    "Return JSON only."
  ].join("\n");
}

function getCurrentUserRequest(context: ExtensionContext): string {
  const current = getUserMessages(context).at(-1);
  if (current === undefined) {
    return "(no current user message available)";
  }

  return preview(current, settings.currentUserMaxChars);
}

function getRecentUserContext(context: ExtensionContext): string {
  const recentMessages = getUserMessages(context)
    .slice(-(settings.recentUserMessages + 1), -1)
    .filter((text) => text.trim().length > 0);

  if (recentMessages.length === 0) {
    return "(no prior user messages included)";
  }

  return recentMessages.map((message, index) => `Prior user message ${index + 1}: ${preview(message, settings.recentUserMaxChars)}`).join("\n\n");
}

function getUserMessages(context: ExtensionContext): string[] {
  return context.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message as Message)
    .filter((message) => message.role === "user")
    .map((message) => contentToText(message.content))
    .filter((text) => text.trim().length > 0);
}

function contentToText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((item) => {
      if (item.type === "text") {
        return item.text;
      }
      if (item.type === "image") {
        return "[image]";
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function parseModelApproval(text: string, model: string, thinkingLevel: ThinkingLevel | undefined): ModelApproval {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return modelApprovalError(`Model did not return JSON: ${preview(text, 600)}`, model, text, thinkingLevel);
  }

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const action = parseSafetyAction(parsed.action);
    const risk = parseSafetyRisk(parsed.risk);
    const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "No reason provided.";
    const confidence = parseSafetyConfidence(parsed.confidence) ?? "low";

    if (!action || !risk) {
      return modelApprovalError(`Model returned invalid action or risk: ${jsonText}`, model, text, thinkingLevel);
    }

    return {
      action,
      risk,
      confidence,
      reason,
      model,
      thinkingLevel,
      raw: text
    };
  } catch (error) {
    return modelApprovalError(error instanceof Error ? error.message : String(error), model, text, thinkingLevel);
  }
}

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }

  return text.slice(start, end + 1);
}

function parseSafetyAction(value: unknown): SafetyAction | undefined {
  return value === "allow" || value === "review" || value === "deny" ? value : undefined;
}

function parseSafetyRisk(value: unknown): SafetyRisk | undefined {
  if (value === "critical") {
    return "high";
  }
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function parseSafetyConfidence(value: unknown): SafetyConfidence | undefined {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 0.75) return "high";
    if (value >= 0.4) return "medium";
    return "low";
  }
  return undefined;
}

function modelApprovalError(reason: string, model: string, raw = "", thinkingLevel?: ThinkingLevel): ModelApproval {
  return {
    action: "review",
    risk: "high",
    confidence: "low",
    reason,
    model,
    thinkingLevel,
    raw,
    error: reason
  };
}

function maxRisk(left: SafetyRisk, right: SafetyRisk): SafetyRisk {
  const ranks: Record<SafetyRisk, number> = {
    low: 0,
    medium: 1,
    high: 2
  };

  return ranks[left] >= ranks[right] ? left : right;
}

function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number | undefined): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();

  if (parent?.aborted) {
    controller.abort();
  } else {
    parent?.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      parent?.removeEventListener("abort", abort);
    }
  };
}

function getToolName(event: ToolCallEvent): string {
  return event.toolName;
}

function getStringField(input: unknown, keys: string[]): string {
  if (typeof input === "string") {
    return input;
  }

  if (typeof input !== "object" || input === null) {
    return "";
  }

  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }

  return "";
}

type AsyncShellCommandRequest = {
  command: string;
  cwd: string;
};

function getAsyncShellCommandRequests(input: unknown): AsyncShellCommandRequest[] {
  if (typeof input !== "object" || input === null) {
    return [];
  }

  const commands = (input as Record<string, unknown>).commands;
  if (!Array.isArray(commands)) {
    return [];
  }

  return commands.map((item) => {
    if (typeof item !== "object" || item === null) {
      return { command: "", cwd: "" };
    }

    const record = item as Record<string, unknown>;
    return {
      command: typeof record.command === "string" ? record.command.trim() : "",
      cwd: typeof record.cwd === "string" ? record.cwd.trim() : ""
    };
  });
}

function formatAsyncShellCommandRequest(request: AsyncShellCommandRequest): string {
  return `[cwd ${request.cwd || "?"}] ${request.command || "?"}`;
}

function getPathField(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }

  if (typeof input !== "object" || input === null) {
    return "";
  }

  const record = input as Record<string, unknown>;
  for (const key of ["path", "file", "filePath", "target", "cwd"]) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }

  return "";
}

function getPathFields(input: unknown): string[] {
  if (typeof input !== "object" || input === null) {
    return [];
  }

  const record = input as Record<string, unknown>;
  const direct = getPathField(input);
  const paths = direct ? [direct] : [];

  for (const key of ["files", "searches", "writes", "edits"]) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }

    for (const item of value) {
      const itemPath = getPathField(item);
      if (itemPath) {
        paths.push(itemPath);
      }
    }
  }

  return Array.from(new Set(paths));
}

function getUrlFields(input: unknown): string[] {
  if (typeof input !== "object" || input === null) {
    return [];
  }

  const record = input as Record<string, unknown>;
  const urls: string[] = [];
  if (typeof record.url === "string") {
    urls.push(record.url);
  }

  const list = record.urls;
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === "string") {
        urls.push(item);
      } else if (typeof item === "object" && item !== null) {
        const value = (item as Record<string, unknown>).url;
        if (typeof value === "string") {
          urls.push(value);
        }
      }
    }
  }

  return Array.from(new Set(urls.map((url) => url.trim()).filter(Boolean)));
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIpv4(normalized);
  }
  if (ipVersion === 6) {
    return isPrivateIpv6(normalized);
  }

  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const octets = ip.split(".").map((part) => Number.parseInt(part, 10));
  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
}

function isPrivateIpv6(ip: string): boolean {
  return ip === "::"
    || ip === "::1"
    || ip.startsWith("fc")
    || ip.startsWith("fd")
    || /^fe[89ab]/.test(ip);
}

function preview(value: unknown, maxLength = 2400): string {
  const text = redactSensitiveText(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

function truncateOneLine(value: string, maxLength: number): string {
  return preview(value, maxLength).replace(/\s+/g, " ").trim();
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\b(ghp_|github_pat_)[A-Za-z0-9_]+\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED_TOKEN]")
    .replace(/\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*['\"]?[^'\"\\s,}]+/gi, "$1=[REDACTED]");
}

function expandHome(rawPath: string): string {
  if (rawPath === "~") {
    return process.env.HOME ?? rawPath;
  }

  if (rawPath.startsWith("~/")) {
    return process.env.HOME ? path.join(process.env.HOME, rawPath.slice(2)) : rawPath;
  }

  return rawPath;
}

function getTrustedWorkspaceRoot(): string | undefined {
  return resolveTrustedWorkspaceRoot(settings.trustedWorkspaceRoot);
}

export function resolveTrustedWorkspaceRoot(fileValue: unknown, envValue = process.env.PI_TOOL_SAFETY_TRUSTED_WORKSPACE): string | undefined {
  const raw = firstNonEmptyString(envValue, fileValue);
  if (!raw) {
    return undefined;
  }

  const expanded = expandHome(raw);
  if (expanded.startsWith("~")) {
    return undefined;
  }

  return path.resolve(expanded);
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readPolicyInfo(): ToolSafetyPolicyInfo {
  const settingsCandidates = piToolsConfigCandidates(TOOL_SAFETY_CONFIG_FILE, import.meta.url);
  const policyCandidates = piToolsConfigCandidates(TOOL_SAFETY_POLICY_FILE, import.meta.url);
  const count = Math.max(settingsCandidates.length, policyCandidates.length);
  for (let index = 0; index < count; index += 1) {
    const referencedPolicy = readPolicyFileFromSettings(settingsCandidates[index]);
    if (referencedPolicy) {
      return referencedPolicy;
    }

    const policy = readPolicyFileCandidate(policyCandidates[index]);
    if (policy) {
      return policy;
    }
  }
  return { text: FALLBACK_POLICY_TEXT, source: "built-in fallback" };
}

function readPolicyFileFromSettings(config: PiToolsConfigCandidate | undefined): ToolSafetyPolicyInfo | undefined {
  if (!config || !existsSync(config.path)) {
    return undefined;
  }

  const parsed = JSON.parse(readFileSync(config.path, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${formatConfigPath(config.path)} must contain a JSON object.`);
  }

  const policyFile = firstNonEmptyString(parsed.policyFile);
  if (!policyFile) {
    return undefined;
  }

  const policy = readPiToolsReferencedTextConfig(policyFile, config.path, config.source);
  return {
    text: policy.text,
    source: `${config.source}:${formatConfigPath(config.path)}#policyFile -> ${formatConfigPath(policy.path)}`,
    path: policy.path
  };
}

function readPolicyFileCandidate(config: PiToolsConfigCandidate | undefined): ToolSafetyPolicyInfo | undefined {
  if (!config || !existsSync(config.path)) {
    return undefined;
  }
  return {
    text: readFileSync(config.path, "utf8"),
    source: `${config.source}:${formatConfigPath(config.path)}`,
    path: config.path
  };
}

function readToolSafetySettings(): ToolSafetySettings {
  const fileSettings = readSettingsFile();
  return {
    approvalModel: configuredApprovalModel(fileSettings.approvalModel),
    approvalTimeoutMs: readOptionalNumericSetting(fileSettings, "approvalTimeoutMs", "PI_TOOL_SAFETY_APPROVAL_TIMEOUT_MS", 1000, 120000),
    approvalMaxTokens: readNumericSetting(fileSettings, "approvalMaxTokens", "PI_TOOL_SAFETY_APPROVAL_MAX_TOKENS", 600, 100, 2000),
    currentUserMaxChars: readNumericSetting(fileSettings, "currentUserMaxChars", "PI_TOOL_SAFETY_CURRENT_USER_MAX_CHARS", 2400, 200, 12000),
    recentUserMessages: readNumericSetting(fileSettings, "recentUserMessages", "PI_TOOL_SAFETY_RECENT_USER_MESSAGES", 3, 0, 8),
    recentUserMaxChars: readNumericSetting(fileSettings, "recentUserMaxChars", "PI_TOOL_SAFETY_RECENT_USER_MAX_CHARS", 900, 100, 4000),
    toolInputMaxChars: readNumericSetting(fileSettings, "toolInputMaxChars", "PI_TOOL_SAFETY_TOOL_INPUT_MAX_CHARS", 6000, 500, 24000),
    policyMaxChars: readNumericSetting(fileSettings, "policyMaxChars", "PI_TOOL_SAFETY_POLICY_MAX_CHARS", 12000, 1000, 30000),
    policyFile: firstNonEmptyString(fileSettings.policyFile),
    humanReviewTimeoutMs: readOptionalNumericSetting(fileSettings, "humanReviewTimeoutMs", "PI_TOOL_SAFETY_HUMAN_REVIEW_TIMEOUT_MS", 1000, 600000),
    trustedWorkspaceRoot: readOptionalStringSetting(fileSettings, "trustedWorkspaceRoot", "PI_TOOL_SAFETY_TRUSTED_WORKSPACE"),
    reviewCriteria: configuredToolSafetyReviewCriteria(fileSettings)
  };
}

function readSettingsFile(): Record<string, unknown> {
  return readPiToolsJsonConfig(TOOL_SAFETY_CONFIG_FILE, import.meta.url) ?? {};
}

function serializeToolSafetySettings(current: ToolSafetySettings, selection: ApprovalModelSelection, policyFile: string | undefined): Record<string, unknown> {
  return {
    approvalModel: `${selection.modelName}:${selection.thinkingLevel ?? "low"}`,
    ...(policyFile === undefined ? {} : { policyFile }),
    ...(current.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: current.approvalTimeoutMs }),
    approvalMaxTokens: current.approvalMaxTokens,
    currentUserMaxChars: current.currentUserMaxChars,
    recentUserMessages: current.recentUserMessages,
    recentUserMaxChars: current.recentUserMaxChars,
    toolInputMaxChars: current.toolInputMaxChars,
    policyMaxChars: current.policyMaxChars,
    ...(current.humanReviewTimeoutMs === undefined ? {} : { humanReviewTimeoutMs: current.humanReviewTimeoutMs }),
    ...(current.trustedWorkspaceRoot === undefined ? {} : { trustedWorkspaceRoot: current.trustedWorkspaceRoot }),
    reviewCriteria: current.reviewCriteria
  };
}

export function configuredToolSafetyReviewCriteria(
  fileSettings: Record<string, unknown>,
  candidates: PiToolsConfigCandidate[] = piToolsConfigCandidates(TOOL_SAFETY_CONFIG_FILE, import.meta.url)
): ToolSafetyReviewCriteria {
  if (Object.hasOwn(fileSettings, "reviewCriteria")) {
    return parseToolSafetyReviewCriteria(fileSettings.reviewCriteria);
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate.path, "utf8")) as unknown;
      if (isRecord(parsed) && Object.hasOwn(parsed, "reviewCriteria")) {
        return parseToolSafetyReviewCriteria(parsed.reviewCriteria);
      }
    } catch {
      return "conservative";
    }
  }
  return "conservative";
}

export function parseToolSafetyReviewCriteria(value: unknown): ToolSafetyReviewCriteria {
  return value === "production-or-unapproved-environment" ? value : "conservative";
}

export function configuredApprovalModel(fileValue: unknown, envValue = process.env.PI_TOOL_SAFETY_APPROVAL_MODEL): ApprovalModelPreference | undefined {
  const source = envValue !== undefined && envValue.trim() !== "" ? envValue.trim() : fileValue;
  return parseApprovalModelPreference(source);
}

export function parseApprovalModelPreference(value: unknown): ApprovalModelPreference | undefined {
  if (typeof value === "string") {
    const model = value.trim();
    if (!model) {
      return undefined;
    }

    return parseOptionalModelThinkingPair(model) ?? { model };
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.model === "string" && record.model.trim()) {
    return { model: record.model.trim(), thinkingLevel: normalizeThinkingLevel(record.thinkingLevel, "low") };
  }

  const provider = record.provider;
  const modelId = record.modelId;
  if (typeof provider !== "string" || typeof modelId !== "string" || !provider.trim() || !modelId.trim()) {
    return undefined;
  }

  return { model: `${provider.trim()}/${modelId.trim()}`, thinkingLevel: normalizeThinkingLevel(record.thinkingLevel, "low") };
}

function readOptionalStringSetting(fileSettings: Record<string, unknown>, key: string, envName: string): string | undefined {
  return firstNonEmptyString(process.env[envName], fileSettings[key]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNumericSetting(
  fileSettings: Record<string, unknown>,
  key: string,
  envName: string,
  fallback: number,
  min: number,
  max: number
): number {
  const envValue = process.env[envName];
  const raw = envValue !== undefined && envValue.trim() !== "" ? Number(envValue) : fileSettings[key];
  const numberValue = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.floor(numberValue)));
}

function readOptionalNumericSetting(
  fileSettings: Record<string, unknown>,
  key: string,
  envName: string,
  min: number,
  max: number
): number | undefined {
  const envValue = process.env[envName];
  const raw = envValue !== undefined && envValue.trim() !== "" ? envValue : fileSettings[key];
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }

  const numberValue = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(numberValue)) {
    return undefined;
  }

  return Math.max(min, Math.min(max, Math.floor(numberValue)));
}
