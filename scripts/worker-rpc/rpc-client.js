/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */
import { spawn } from "node:child_process";
import { isJsonValue, isRpcExtensionHostRequest, isRpcHostCorrelationId, isRpcHostService, RPC_HOST_MAX_LINE_BYTES, RPC_HOST_MAX_PENDING_REQUESTS, serializeRpcHostMessage, } from "./extension-host-transport.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
function isRpcReadyMessage(value) {
    return (typeof value === "object" &&
        value !== null &&
        Object.keys(value).length === 1 &&
        "type" in value &&
        value.type === "rpc_ready");
}
const HOST_FAILURE_DUPLICATE_ID = "Duplicate extension host request id";
const HOST_FAILURE_HANDLER = "Host handler failed";
const HOST_FAILURE_INVALID_RESPONSE = "Invalid host handler response";
const HOST_FAILURE_MALFORMED_REQUEST = "Malformed extension host request";
const HOST_FAILURE_REQUEST_LIMIT = "Host request limit exceeded";
const HOST_FAILURE_RESPONSE_TOO_LARGE = "Host handler response exceeds maximum size";
const HOST_FAILURE_SERVICE_UNAVAILABLE = "Host service unavailable";
const HOST_FAILURE_STOPPING = "Host request cancelled: RPC client stopping";
// ============================================================================
// RPC Client
// ============================================================================
export class RpcClient {
    process = null;
    stopReadingStdout = null;
    eventListeners = [];
    pendingRequests = new Map();
    requestId = 0;
    stderr = "";
    exitError = null;
    options;
    hostRequestHandlers = new Map();
    activeHostRequests = new Map();
    activeHostExecutions = 0;
    stopping = false;
    stopPromise = null;
    pendingStart = null;
    constructor(options = {}) {
        this.options = options;
        for (const [service, handler] of Object.entries(options.hostRequestHandlers ?? {})) {
            if (!isRpcHostService(service))
                throw new Error("Invalid host service name");
            this.hostRequestHandlers.set(service, handler);
        }
    }
    /**
     * Start the RPC agent process and wait for its exact readiness record.
     */
    async start() {
        if (this.process) {
            throw new Error("Client already started");
        }
        this.exitError = null;
        this.stderr = "";
        this.stopping = false;
        const cliPath = this.options.cliPath ?? "dist/cli.js";
        const args = ["--mode", "rpc"];
        if (this.options.provider) {
            args.push("--provider", this.options.provider);
        }
        if (this.options.model) {
            args.push("--model", this.options.model);
        }
        if (this.options.args) {
            args.push(...this.options.args);
        }
        const childProcess = spawn("node", [cliPath, ...args], {
            cwd: this.options.cwd,
            env: { ...process.env, ...this.options.env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.process = childProcess;
        const ready = new Promise((resolve, reject) => {
            this.pendingStart = { resolve, reject };
        });
        // Collect stderr for debugging
        childProcess.stderr?.on("data", (data) => {
            this.stderr += data.toString();
            process.stderr.write(data);
        });
        childProcess.once("exit", (code, signal) => {
            if (this.process !== childProcess)
                return;
            this.closeTransport(this.stopping ? new Error("RPC client stopped") : this.createProcessExitError(code, signal));
        });
        childProcess.once("error", (error) => {
            if (this.process !== childProcess)
                return;
            this.closeTransport(new Error(`Agent process error: ${error.message}. Stderr: ${this.stderr}`));
        });
        childProcess.stdin?.on("error", (error) => {
            if (this.process !== childProcess)
                return;
            this.closeTransport(new Error(`Agent process stdin error: ${error.message}. Stderr: ${this.stderr}`));
        });
        // Register the JSONL reader first so it emits a trailing unterminated line before EOF cleanup.
        this.stopReadingStdout = attachJsonlLineReader(childProcess.stdout, (line) => {
            this.handleLine(line);
        });
        childProcess.stdout?.once("end", () => this.onStdoutEnd(childProcess));
        if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
            this.closeTransport(this.createProcessExitError(childProcess.exitCode, childProcess.signalCode));
        }
        await ready;
    }
    /**
     * Stop the RPC agent process.
     *
     * Closes RPC stdin first and allows five seconds for graceful session cleanup.
     * A stuck child receives SIGTERM, then SIGKILL after one more second.
     */
    async stop() {
        if (this.stopPromise)
            return this.stopPromise;
        const childProcess = this.process;
        if (!childProcess)
            return;
        this.stopPromise = this.stopProcess(childProcess).finally(() => {
            this.stopPromise = null;
        });
        return this.stopPromise;
    }
    async stopProcess(childProcess) {
        this.stopping = true;
        this.rejectPendingStart(new Error("RPC client stopped"));
        this.cancelActiveHostRequests(HOST_FAILURE_STOPPING);
        try {
            if (childProcess.stdin && !childProcess.stdin.destroyed && !childProcess.stdin.writableEnded) {
                childProcess.stdin.end();
            }
        }
        catch {
            // Continue to bounded signal escalation below.
        }
        if (!(await this.waitForProcessExit(childProcess, 5000))) {
            this.signalProcess(childProcess, "SIGTERM");
            if (!(await this.waitForProcessExit(childProcess, 1000))) {
                this.signalProcess(childProcess, "SIGKILL");
                await this.waitForProcessExit(childProcess);
            }
        }
        this.stopReadingStdout?.();
        this.stopReadingStdout = null;
        if (this.process === childProcess)
            this.process = null;
        const stoppedError = this.exitError ?? new Error("RPC client stopped");
        this.exitError = stoppedError;
        this.rejectPendingRequests(stoppedError);
        this.stopping = false;
    }
    signalProcess(childProcess, signal) {
        try {
            childProcess.kill(signal);
        }
        catch {
            // The exit event remains authoritative even if signaling reports an error.
        }
    }
    onStdoutEnd(childProcess) {
        if (this.process !== childProcess)
            return;
        this.closeTransport(this.stopping
            ? new Error("RPC client stopped")
            : new Error(`Agent process stdout ended. Stderr: ${this.stderr}`));
        try {
            if (childProcess.stdin && !childProcess.stdin.destroyed && !childProcess.stdin.writableEnded) {
                childProcess.stdin.end();
            }
        }
        catch {
            // Transport is already terminal; process containment remains stop()'s responsibility.
        }
    }
    waitForProcessExit(childProcess, timeoutMs) {
        if (childProcess.exitCode !== null || childProcess.signalCode !== null)
            return Promise.resolve(true);
        return new Promise((resolve) => {
            const finish = (exited) => {
                if (timeout !== undefined)
                    clearTimeout(timeout);
                childProcess.off("exit", onExit);
                resolve(exited);
            };
            const onExit = () => finish(true);
            const timeout = timeoutMs === undefined ? undefined : setTimeout(() => finish(false), timeoutMs);
            childProcess.once("exit", onExit);
        });
    }
    /**
     * Subscribe to agent events.
     */
    onEvent(listener) {
        this.eventListeners.push(listener);
        return () => {
            const index = this.eventListeners.indexOf(listener);
            if (index !== -1) {
                this.eventListeners.splice(index, 1);
            }
        };
    }
    /**
     * Get collected stderr output (useful for debugging).
     */
    getStderr() {
        return this.stderr;
    }
    // =========================================================================
    // Command Methods
    // =========================================================================
    /**
     * Send a prompt to the agent.
     * Returns immediately after sending; use onEvent() to receive streaming events.
     * Use waitForIdle() to wait for completion.
     */
    async prompt(message, images) {
        await this.send({ type: "prompt", message, images });
    }
    /**
     * Queue a steering message to interrupt the agent mid-run.
     */
    async steer(message, images) {
        await this.send({ type: "steer", message, images });
    }
    /**
     * Queue a follow-up message to be processed after the agent finishes.
     */
    async followUp(message, images) {
        await this.send({ type: "follow_up", message, images });
    }
    /**
     * Abort current operation.
     */
    async abort() {
        await this.send({ type: "abort" });
    }
    /**
     * Clear queued steering and follow-up messages, returning their text.
     */
    async clearQueue() {
        const response = await this.send({ type: "clear_queue" });
        return this.getData(response);
    }
    /**
     * Start a new session, optionally with parent tracking.
     * @param parentSession - Optional parent session path for lineage tracking
     * @returns Object with `cancelled: true` if an extension cancelled the new session
     */
    async newSession(parentSession) {
        const response = await this.send({ type: "new_session", parentSession });
        return this.getData(response);
    }
    /**
     * Get current session state.
     */
    async getState() {
        const response = await this.send({ type: "get_state" });
        return this.getData(response);
    }
    /**
     * Set model by provider and ID.
     */
    async setModel(provider, modelId) {
        const response = await this.send({ type: "set_model", provider, modelId });
        return this.getData(response);
    }
    /**
     * Cycle to next model.
     */
    async cycleModel() {
        const response = await this.send({ type: "cycle_model" });
        return this.getData(response);
    }
    /**
     * Get list of available models.
     */
    async getAvailableModels() {
        const response = await this.send({ type: "get_available_models" });
        return this.getData(response).models;
    }
    /**
     * Set thinking level.
     */
    async setThinkingLevel(level) {
        await this.send({ type: "set_thinking_level", level });
    }
    /**
     * Cycle thinking level.
     */
    async cycleThinkingLevel() {
        const response = await this.send({ type: "cycle_thinking_level" });
        return this.getData(response);
    }
    /**
     * Get list of available thinking levels for the current model.
     */
    async getAvailableThinkingLevels() {
        const response = await this.send({ type: "get_available_thinking_levels" });
        return this.getData(response).levels;
    }
    /**
     * Set steering mode.
     */
    async setSteeringMode(mode) {
        await this.send({ type: "set_steering_mode", mode });
    }
    /**
     * Set follow-up mode.
     */
    async setFollowUpMode(mode) {
        await this.send({ type: "set_follow_up_mode", mode });
    }
    /**
     * Compact session context.
     */
    async compact(customInstructions) {
        const response = await this.send({ type: "compact", customInstructions });
        return this.getData(response);
    }
    /**
     * Set auto-compaction enabled/disabled.
     */
    async setAutoCompaction(enabled) {
        await this.send({ type: "set_auto_compaction", enabled });
    }
    /**
     * Set auto-retry enabled/disabled.
     */
    async setAutoRetry(enabled) {
        await this.send({ type: "set_auto_retry", enabled });
    }
    /**
     * Abort in-progress retry.
     */
    async abortRetry() {
        await this.send({ type: "abort_retry" });
    }
    /**
     * Execute a bash command.
     */
    async bash(command) {
        const response = await this.send({ type: "bash", command });
        return this.getData(response);
    }
    /**
     * Abort running bash command.
     */
    async abortBash() {
        await this.send({ type: "abort_bash" });
    }
    /**
     * Get session statistics.
     */
    async getSessionStats() {
        const response = await this.send({ type: "get_session_stats" });
        return this.getData(response);
    }
    /**
     * Export session to HTML.
     */
    async exportHtml(outputPath) {
        const response = await this.send({ type: "export_html", outputPath });
        return this.getData(response);
    }
    /**
     * Switch to a different session file.
     * @returns Object with `cancelled: true` if an extension cancelled the switch
     */
    async switchSession(sessionPath) {
        const response = await this.send({ type: "switch_session", sessionPath });
        return this.getData(response);
    }
    /**
     * Fork from a specific message.
     * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
     */
    async fork(entryId) {
        const response = await this.send({ type: "fork", entryId });
        return this.getData(response);
    }
    /**
     * Clone the current active branch into a new session.
     * @returns Object with `cancelled: true` if an extension cancelled the clone
     */
    async clone() {
        const response = await this.send({ type: "clone" });
        return this.getData(response);
    }
    /**
     * Get messages available for forking.
     */
    async getForkMessages() {
        const response = await this.send({ type: "get_fork_messages" });
        return this.getData(response).messages;
    }
    /**
     * Get session entries in append order, optionally only those after the `since` entry id.
     */
    async getEntries(since) {
        const response = await this.send({ type: "get_entries", since });
        return this.getData(response);
    }
    /**
     * Get the session entry tree.
     */
    async getTree() {
        const response = await this.send({ type: "get_tree" });
        return this.getData(response);
    }
    /**
     * Get text of last assistant message.
     */
    async getLastAssistantText() {
        const response = await this.send({ type: "get_last_assistant_text" });
        return this.getData(response).text;
    }
    /**
     * Set the session display name.
     */
    async setSessionName(name) {
        await this.send({ type: "set_session_name", name });
    }
    /**
     * Get all messages in the session.
     */
    async getMessages() {
        const response = await this.send({ type: "get_messages" });
        return this.getData(response).messages;
    }
    /**
     * Get available commands (extension commands, prompt templates, skills).
     */
    async getCommands() {
        const response = await this.send({ type: "get_commands" });
        return this.getData(response).commands;
    }
    // =========================================================================
    // Helpers
    // =========================================================================
    /**
     * Wait for agent to become idle (no streaming).
     * Resolves when agent_settled event is received.
     */
    waitForIdle(timeout = 60000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                unsubscribe();
                reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
            }, timeout);
            const unsubscribe = this.onEvent((event) => {
                if (event.type === "agent_settled") {
                    clearTimeout(timer);
                    unsubscribe();
                    resolve();
                }
            });
        });
    }
    /**
     * Collect events until agent becomes idle.
     */
    collectEvents(timeout = 60000) {
        return new Promise((resolve, reject) => {
            const events = [];
            const timer = setTimeout(() => {
                unsubscribe();
                reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
            }, timeout);
            const unsubscribe = this.onEvent((event) => {
                events.push(event);
                if (event.type === "agent_settled") {
                    clearTimeout(timer);
                    unsubscribe();
                    resolve(events);
                }
            });
        });
    }
    /**
     * Send prompt and wait for completion, returning all events.
     */
    async promptAndWait(message, images, timeout = 60000) {
        const eventsPromise = this.collectEvents(timeout);
        await this.prompt(message, images);
        return eventsPromise;
    }
    // =========================================================================
    // Internal
    // =========================================================================
    handleLine(line) {
        try {
            const data = JSON.parse(line);
            if (typeof data === "object" && data !== null && "type" in data && data.type === "rpc_ready") {
                if (isRpcReadyMessage(data) && this.pendingStart && !this.stopping && !this.exitError) {
                    const pendingStart = this.pendingStart;
                    this.pendingStart = null;
                    pendingStart.resolve();
                }
                return;
            }
            if (typeof data === "object" && data !== null && "type" in data && data.type === "extension_host_request") {
                void this.handleHostRequest(data, Buffer.byteLength(line) + 1).catch(() => {
                    this.writeMalformedRequestFailure(data);
                });
                return;
            }
            // Check if it's a response to a pending request
            if (typeof data === "object" &&
                data !== null &&
                "type" in data &&
                data.type === "response" &&
                "id" in data &&
                typeof data.id === "string" &&
                this.pendingRequests.has(data.id)) {
                const pending = this.pendingRequests.get(data.id);
                this.pendingRequests.delete(data.id);
                pending.resolve(data);
                return;
            }
            // Otherwise it's an event
            for (const listener of this.eventListeners) {
                listener(data);
            }
        }
        catch {
            // Ignore non-JSON lines
        }
    }
    async handleHostRequest(value, lineBytes) {
        let id;
        let active;
        let handlerExecutionStarted = false;
        try {
            if (this.stopping || this.exitError)
                return;
            if (typeof value !== "object" || value === null || !("id" in value))
                return;
            if (!isRpcHostCorrelationId(value.id))
                return;
            id = value.id;
            const duplicate = this.activeHostRequests.get(id);
            if (duplicate) {
                if (this.retireHostRequest(duplicate)) {
                    this.writeHostFailure(id, HOST_FAILURE_DUPLICATE_ID);
                }
                return;
            }
            if (lineBytes > RPC_HOST_MAX_LINE_BYTES || !isRpcExtensionHostRequest(value)) {
                this.writeHostFailure(id, HOST_FAILURE_MALFORMED_REQUEST);
                return;
            }
            if (!isJsonValue(value.payload)) {
                this.writeHostFailure(id, HOST_FAILURE_MALFORMED_REQUEST);
                return;
            }
            if (this.activeHostExecutions >= RPC_HOST_MAX_PENDING_REQUESTS) {
                this.writeHostFailure(id, HOST_FAILURE_REQUEST_LIMIT);
                return;
            }
            const request = value;
            const handler = this.hostRequestHandlers.get(request.service);
            if (!handler) {
                this.writeHostFailure(id, HOST_FAILURE_SERVICE_UNAVAILABLE);
                return;
            }
            active = { controller: new AbortController(), retired: false };
            this.activeHostRequests.set(id, active);
            this.activeHostExecutions++;
            handlerExecutionStarted = true;
            let data;
            try {
                data = await handler(request.payload, {
                    id,
                    service: request.service,
                    signal: active.controller.signal,
                });
            }
            catch {
                if (!active.retired)
                    this.writeHostFailure(id, HOST_FAILURE_HANDLER);
                return;
            }
            if (active.retired)
                return;
            if (!isJsonValue(data)) {
                this.writeHostFailure(id, HOST_FAILURE_INVALID_RESPONSE);
                return;
            }
            try {
                this.writeHostResponse({ type: "extension_host_response", id, success: true, data });
            }
            catch {
                this.writeHostFailure(id, HOST_FAILURE_RESPONSE_TOO_LARGE);
            }
        }
        catch {
            if (id !== undefined && !this.stopping && !this.exitError) {
                if (!active || this.retireHostRequest(active)) {
                    this.writeHostFailure(id, HOST_FAILURE_MALFORMED_REQUEST);
                }
            }
        }
        finally {
            if (handlerExecutionStarted)
                this.activeHostExecutions--;
            if (id !== undefined && active && this.activeHostRequests.get(id) === active) {
                this.activeHostRequests.delete(id);
            }
        }
    }
    writeMalformedRequestFailure(value) {
        try {
            if (this.stopping || this.exitError || typeof value !== "object" || value === null || !("id" in value))
                return;
            if (isRpcHostCorrelationId(value.id))
                this.writeHostFailure(value.id, HOST_FAILURE_MALFORMED_REQUEST);
        }
        catch {
            // A malformed value without a safely readable id cannot be correlated.
        }
    }
    writeHostFailure(id, error) {
        try {
            this.writeHostResponse({ type: "extension_host_response", id, success: false, error });
        }
        catch {
            // The transport boundary owns cleanup when a bounded failure cannot be written.
        }
    }
    writeHostResponse(response) {
        const childProcess = this.process;
        const stdin = childProcess?.stdin;
        if (!childProcess ||
            !stdin ||
            childProcess.exitCode !== null ||
            childProcess.signalCode !== null ||
            stdin.destroyed ||
            stdin.writableEnded ||
            !stdin.writable) {
            return;
        }
        stdin.write(serializeRpcHostMessage(response));
    }
    retireHostRequest(active) {
        if (active.retired)
            return false;
        active.retired = true;
        active.controller.abort();
        return true;
    }
    cancelActiveHostRequests(error) {
        for (const [id, active] of this.activeHostRequests) {
            if (this.retireHostRequest(active) && error !== undefined)
                this.writeHostFailure(id, error);
        }
    }
    closeTransport(error) {
        const terminalError = this.exitError ?? error;
        this.exitError = terminalError;
        this.rejectPendingStart(terminalError);
        this.cancelActiveHostRequests();
        this.rejectPendingRequests(terminalError);
    }
    rejectPendingStart(error) {
        const pendingStart = this.pendingStart;
        if (!pendingStart)
            return;
        this.pendingStart = null;
        pendingStart.reject(error);
    }
    createProcessExitError(code, signal) {
        return new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
    }
    rejectPendingRequests(error) {
        for (const pending of this.pendingRequests.values()) {
            pending.reject(error);
        }
        this.pendingRequests.clear();
    }
    async send(command) {
        const childProcess = this.process;
        const stdin = childProcess?.stdin;
        if (!childProcess || !stdin) {
            throw new Error("Client not started");
        }
        if (this.exitError) {
            throw this.exitError;
        }
        if (this.stopping) {
            throw new Error("RPC client is stopping");
        }
        if (childProcess.exitCode !== null) {
            const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
            this.exitError = error;
            throw error;
        }
        if (stdin.destroyed || !stdin.writable) {
            const error = new Error(`Agent process stdin is not writable. Stderr: ${this.stderr}`);
            this.exitError = error;
            throw error;
        }
        const id = `req_${++this.requestId}`;
        const fullCommand = { ...command, id };
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
            }, 30000);
            this.pendingRequests.set(id, {
                resolve: (response) => {
                    clearTimeout(timeout);
                    resolve(response);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
            });
            try {
                stdin.write(serializeJsonLine(fullCommand));
            }
            catch (error) {
                const writeError = error instanceof Error ? error : new Error(String(error));
                const pending = this.pendingRequests.get(id);
                this.pendingRequests.delete(id);
                pending?.reject(writeError);
            }
        });
    }
    getData(response) {
        if (!response.success) {
            const errorResponse = response;
            throw new Error(errorResponse.error);
        }
        // Type assertion: we trust response.data matches T based on the command sent.
        // This is safe because each public method specifies the correct T for its command.
        const successResponse = response;
        return successResponse.data;
    }
}
//# sourceMappingURL=rpc-client.js.map