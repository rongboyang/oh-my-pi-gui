import type { RemoteTabEvent } from "../../../shared/remote-ipc";
import type { RemoteSnapshot } from "../../../shared/remote-wire";
import type { ExtensionUIRequest } from "../../../shared/rpc-types";

export interface RemoteMessage {
	key: string;
	role: string;
	text: string;
	truncated: boolean;
	failed: boolean;
	outputId?: string;
	toolName?: string;
}

export interface RemoteTool {
	key: string;
	name: string;
	text: string;
	done: boolean;
	failed: boolean;
	truncated: boolean;
	outputId?: string;
}

export interface RemoteSessionState {
	generation: number;
	seq: number;
	snapshot: RemoteSnapshot | null;
	status: Extract<RemoteTabEvent, { type: "status" }> | null;
	live: readonly RemoteMessage[];
	partial: RemoteMessage | null;
	tools: ReadonlyMap<string, RemoteTool>;
	approvals: readonly ExtensionUIRequest[];
	unresolved: number;
	gap: boolean;
}

export const EMPTY_REMOTE_SESSION: RemoteSessionState = {
	generation: -1,
	seq: -1,
	snapshot: null,
	status: null,
	live: [],
	partial: null,
	tools: new Map(),
	approvals: [],
	unresolved: 0,
	gap: false,
};

export function remoteSessionEvent(state: RemoteSessionState, event: RemoteTabEvent): RemoteSessionState {
	if (event.generation < state.generation) return state;
	if (event.generation > state.generation) state = { ...EMPTY_REMOTE_SESSION, generation: event.generation };
	switch (event.type) {
		case "status":
			return { ...state, status: event };
		case "receipts":
			return { ...state, unresolved: event.unresolved };
		case "snapshot": {
			const snapshot = event.snapshot;
			const previous = state.snapshot;
			if (previous && previous.epoch === snapshot.epoch && snapshot.seq < state.seq) return state;
			const first = remoteRecord(snapshot.partialReply);
			const partial = parseMessage(first.message, text(first.messageId) ?? "remote-partial");
			const tools = new Map<string, RemoteTool>();
			for (const tool of snapshot.currentTools) {
				const item = parseTool(tool, undefined);
				if (item) tools.set(item.key, item);
			}
			return {
				...state,
				snapshot,
				seq: snapshot.seq,
				live: [],
				partial,
				tools,
				approvals: snapshot.pendingApprovals.flatMap(value => {
					const request = approval(value);
					return request ? [request] : [];
				}),
				gap: false,
			};
		}
		case "delta": {
			const snapshot = state.snapshot;
			if (!snapshot || state.gap || (event.epoch === snapshot.epoch && event.seq <= state.seq)) return state;
			if (event.epoch !== snapshot.epoch || event.sessionId !== snapshot.sessionId || event.seq !== state.seq + 1)
				return { ...state, gap: true };
			return reduceDelta({ ...state, seq: event.seq }, snapshot, remoteRecord(event.event));
		}
	}
}

function reduceDelta(
	state: RemoteSessionState,
	snapshot: RemoteSnapshot,
	value: Record<string, unknown>,
): RemoteSessionState {
	switch (value.type) {
		case "agent_start": {
			const runId = text(value.runId);
			return runId ? { ...state, snapshot: { ...snapshot, runId, phase: "running" } } : state;
		}
		case "agent_end":
			return {
				...state,
				partial: null,
				snapshot: { ...snapshot, runId: null, phase: state.approvals.length ? "waiting" : "idle" },
			};
		case "message_start":
		case "message_update":
		case "message_end": {
			const key = text(value.messageId) ?? `event-${state.seq}`;
			const payload = remoteRecord(value.message);
			let message = parseMessage(value.message, key);
			if (!message && typeof value.preview === "string")
				message = {
					key,
					text: value.preview,
					role: text(value.role) ?? "assistant",
					truncated: true,
					failed: false,
				};
			if (!message) return state;
			if (value.type === "message_end") {
				return {
					...state,
					partial: message.role === "assistant" ? null : state.partial,
					live: mergeRemoteMessages(state.live, [message]),
				};
			}
			return payload.role === "assistant" || value.truncated === true ? { ...state, partial: message } : state;
		}
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end": {
			const key = text(value.toolCallId);
			const item = key ? parseTool(value, state.tools.get(key)) : null;
			return item ? { ...state, tools: new Map(state.tools).set(item.key, item) } : state;
		}
		case "extension_ui_request": {
			if (value.method === "cancel" && typeof value.targetId === "string") {
				return removeRemoteApproval(state, value.targetId);
			}
			const request = approval(value);
			if (!request || state.approvals.some(item => item.id === request.id)) return state;
			return {
				...state,
				snapshot: snapshot.phase === "starting" ? snapshot : { ...snapshot, phase: "waiting" },
				approvals: [...state.approvals, request],
			};
		}
		case "command_output": {
			const data = text(value.text) ?? text(value.preview);
			return data
				? {
						...state,
						live: [
							...state.live,
							{
								key: text(value.outputId) ?? `output-${state.seq}`,
								role: "output",
								text: data,
								truncated: value.truncated === true,
								failed: false,
								outputId: text(value.outputId),
							},
						],
					}
				: state;
		}
		default:
			return state;
	}
}

export function removeRemoteApproval(state: RemoteSessionState, id: string): RemoteSessionState {
	const approvals = state.approvals.filter(item => item.id !== id);
	if (approvals.length === state.approvals.length) return state;
	const snapshot = state.snapshot;
	return {
		...state,
		approvals,
		snapshot:
			snapshot?.phase === "waiting" && !approvals.length
				? { ...snapshot, phase: snapshot.runId ? "running" : "idle" }
				: snapshot,
	};
}

export function mergeRemoteMessages(
	history: readonly RemoteMessage[],
	live: readonly RemoteMessage[],
): RemoteMessage[] {
	const rows = new Map<string, RemoteMessage>();
	for (const item of history) rows.set(item.key, item);
	for (const item of live) rows.set(item.key, item);
	return Array.from(rows.values());
}

export function parseMessage(value: unknown, fallback: string): RemoteMessage | null {
	const message = remoteRecord(value);
	const role = text(message.role);
	if (!role) return null;
	const toolName = text(message.toolName);
	const toolCallId = text(message.toolCallId);
	const timestamp = message.timestamp;
	const normalizedTime =
		typeof timestamp === "string" || typeof timestamp === "number" ? String(timestamp) : undefined;
	const key = text(message.id) ?? (normalizedTime ? `${role}-${normalizedTime}` : text(message.entryId)) ?? fallback;
	const result =
		textOf(message.content) ??
		text(message.output) ??
		text(message.errorMessage) ??
		text(message.summary) ??
		text(message.preview);
	if (result === undefined) return null;
	return {
		key: role === "toolResult" && toolCallId ? `tool:${toolCallId}` : key,
		role,
		text: result,
		truncated: message.truncated === true,
		failed: message.isError === true || message.stopReason === "error",
		outputId: text(message.outputId),
		toolName,
	};
}

function parseTool(value: unknown, previous: RemoteTool | undefined): RemoteTool | null {
	const source = remoteRecord(value);
	const key = text(source.toolCallId);
	const name = text(source.toolName);
	if (!key || !name) return null;
	return {
		key,
		name,
		text: textOf(source.result ?? source.partialResult) ?? text(source.preview) ?? previous?.text ?? "",
		done: source.done === true || source.type === "tool_execution_end" || previous?.done === true,
		failed: source.isError === true || previous?.failed === true,
		truncated: source.truncated === true || previous?.truncated === true,
		outputId: text(source.outputId) ?? previous?.outputId,
	};
}

function approval(value: unknown): ExtensionUIRequest | null {
	const source = remoteRecord(value);
	const { id, method } = source;
	if (source.type !== "extension_ui_request" || !text(id)) return null;
	switch (method) {
		case "confirm":
			if (typeof source.title !== "string" || typeof source.message !== "string") return null;
			break;
		case "select":
			if (
				typeof source.title !== "string" ||
				!Array.isArray(source.options) ||
				!source.options.every(option => typeof option === "string")
			)
				return null;
			break;
		case "input":
		case "editor":
			if (typeof source.title !== "string") return null;
			break;
		case "ask":
		case "askDialog":
			if (!Array.isArray(source.questions)) return null;
			break;
		case "form":
			if (!Array.isArray(source.sections)) return null;
			break;
		case "open_url":
			if (typeof source.url !== "string") return null;
			break;
		default:
			return null;
	}
	return value as ExtensionUIRequest;
}

function textOf(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	const content = Array.isArray(value) ? value : remoteRecord(value).content;
	if (!Array.isArray(content)) return undefined;
	const pieces = content.flatMap(block => {
		const part = remoteRecord(block);
		return part.type === "text" && typeof part.text === "string" ? [part.text] : [];
	});
	return pieces.length ? pieces.join("") : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length ? value : undefined;
}

function remoteRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
