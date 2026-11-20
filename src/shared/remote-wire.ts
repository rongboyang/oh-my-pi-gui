// Remote v1 is independent of rpc-ui. Keep this file byte-identical in Core and GUI;
// it must remain portable TypeScript with no runtime imports.
export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const REMOTE_MAX_FRAME_BYTES = 1024 * 1024;
export const REMOTE_MAX_ID_LENGTH = 256;
export const REMOTE_MAX_PATH_LENGTH = 4096;
export const REMOTE_MAX_CAPABILITIES = 64;
export const REMOTE_MAX_VERSIONS = 16;
export const REMOTE_MAX_INSTANCES = 1024;
export const REMOTE_MAX_PAGE_ITEMS = 200;
export const REMOTE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const REMOTE_MAX_OUTPUT_PAGE_BYTES = 256 * 1024;
export const REMOTE_MAX_QUEUE_FRAMES = 1024;
export const REMOTE_MAX_QUEUE_BYTES = 8 * 1024 * 1024;
export const REMOTE_LEASE_HEARTBEAT_MS = 10_000;
export const REMOTE_LEASE_TIMEOUT_MS = 30_000;
export const REMOTE_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const REMOTE_MAX_RECEIPTS = 10_000;
export const REMOTE_RECONNECT_MAX_ATTEMPTS = 8;
export const REMOTE_RECONNECT_MAX_DELAY_MS = 30_000;
export const REMOTE_MAX_DOCUMENT_BYTES = 512 * 1024;

export const REMOTE_REQUIRED_CAPABILITIES = ["snapshot", "output", "approvals", "receipts"] as const;
export const REMOTE_OPTIONAL_CAPABILITIES = ["read_document"] as const;
// Unknown capability strings are retained for forward negotiation.
export type RemoteCapability = string;

export const REMOTE_ERROR_CODES = [
	"auth_cancelled",
	"auth_failed",
	"host_key_unknown",
	"host_key_changed",
	"cli_missing",
	"no_instance",
	"identity_mismatch",
	"protocol_incompatible",
	"busy",
	"stale_lease",
	"stale_epoch",
	"stale_session",
	"stale_run",
	"unknown_request",
	"unknown_result",
	"invalid_request",
	"unsupported",
	"overflow",
	"disconnected",
	"timeout",
	"internal_error",
	"preview_not_found",
	"preview_permission_denied",
	"preview_outside_workspace",
	"preview_unsupported",
	"preview_too_large",
	"preview_changed",
] as const;
export type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[number];
export interface RemoteError {
	code: RemoteErrorCode;
}

export interface RemoteInstance {
	name: string;
	instanceKey: string;
	workspace: string;
	versions: readonly number[];
	capabilities: readonly RemoteCapability[];
}

export interface RemoteHelloResult {
	version: typeof REMOTE_PROTOCOL_VERSION;
	instanceKey: string;
	workspace: string;
	epoch: string;
	capabilities: readonly RemoteCapability[];
	maxFrameBytes: number;
}
export interface RemoteLeaseResult {
	lease: number;
}

export interface RemoteSessionRow {
	sessionId: string;
	// Display metadata is supplied by Core, not used to locate a session on the client.
	name: string | null;
	updatedAt: string;
}
export interface RemoteSessionPage {
	sessions: readonly RemoteSessionRow[];
	cursor: string | null;
}
export interface RemoteHistoryPage {
	view: string;
	items: readonly unknown[];
	cursor: string | null;
}
export interface RemoteOutputPage {
	view: string;
	outputId: string;
	data: string;
	cursor: string | null;
	truncated: boolean;
}
export type RemoteReceipt =
	| { status: "accepted" }
	| { status: "succeeded"; data: unknown }
	| { status: "rejected"; error: RemoteError }
	| { status: "unknown" };
export type RemotePhase = "starting" | "idle" | "running" | "waiting" | "stopping";
export interface RemoteSnapshot {
	epoch: string;
	seq: number;
	view: string;
	// Null only while Core genuinely has no initialized session. Initialization can
	// assign a session ID before it awaits an approval.
	sessionId: string | null;
	cwd: string;
	phase: RemotePhase;
	runId: string | null;
	partialReply: unknown | null;
	currentTools: readonly unknown[];
	pendingApprovals: readonly unknown[];
	historyCursor: string | null;
}
export interface RemoteDocumentResult {
	path: string;
	content: string;
	mediaType: "text/plain" | "text/markdown";
}

// The response is the existing extension UI response payload, not a new wire model.
export type RemoteActionCommand =
	| { type: "prompt"; message: string }
	| { type: "new_session" }
	| { type: "open_session"; sessionId: string }
	| { type: "respond"; requestId: string; response: unknown }
	| { type: "stop"; runId: string };

export type RemoteRequestData = {
	acquire: Record<string, never>;
	heartbeat: { lease: number };
	sync: { lease: number; resumeSessionId?: string };
	sessions: { cursor?: string };
	history: { view: string; cursor?: string };
	output: { view: string; outputId: string; cursor?: string };
	receipt: { epoch: string; sessionId: string; actionId: string };
	action: { lease: number; epoch: string; sessionId: string; actionId: string; command: RemoteActionCommand };
	read_document: { path: string };
};
export type RemoteOperation = keyof RemoteRequestData;
export type RemoteRequest = {
	[K in RemoteOperation]: { type: "request"; id: string; op: K; data: RemoteRequestData[K] };
}[RemoteOperation];
export interface RemoteHello {
	type: "hello";
	id: string;
	versions: readonly number[];
	instanceKey: string;
	workspace: string;
	capabilities: readonly RemoteCapability[];
	maxFrameBytes: number;
}

function frameLimit(value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("Invalid remote frame limit");
}

/** NDJSON frame limits include the terminating newline. */
export class RemoteFrameDecoder {
	private buffer = new Uint8Array(0);
	private length = 0;
	private failed = false;

	constructor(private readonly maxFrameBytes = REMOTE_MAX_FRAME_BYTES) {
		frameLimit(maxFrameBytes);
	}

	push(chunk: Uint8Array): unknown[] {
		if (this.failed) throw new Error("Remote frame decoder has failed");
		const frames: unknown[] = [];
		try {
			let start = 0;
			for (let i = 0; i < chunk.length; i++) {
				if (chunk[i] !== 10) continue;
				this.append(chunk.subarray(start, i));
				const line = new TextDecoder("utf-8", { fatal: true }).decode(this.buffer.subarray(0, this.length));
				if (!line.trim()) throw new Error("Blank remote frame");
				frames.push(JSON.parse(line));
				this.length = 0;
				start = i + 1;
			}
			this.append(chunk.subarray(start));
			return frames;
		} catch (error) {
			this.failed = true;
			this.buffer = new Uint8Array(0);
			this.length = 0;
			throw error;
		}
	}

	finish(): void {
		if (this.failed) throw new Error("Remote frame decoder has failed");
		if (this.length !== 0) {
			this.failed = true;
			this.buffer = new Uint8Array(0);
			this.length = 0;
			throw new Error("Truncated remote frame");
		}
	}

	private append(bytes: Uint8Array): void {
		const size = this.length + bytes.length;
		// Even an unterminated frame needs room for its eventual newline.
		if (size >= this.maxFrameBytes) throw new RangeError("Remote frame exceeds byte limit");
		if (size > this.buffer.length) {
			const capacity = Math.min(this.maxFrameBytes - 1, Math.max(size, this.buffer.length * 2, 64));
			const buffer = new Uint8Array(capacity);
			buffer.set(this.buffer.subarray(0, this.length));
			this.buffer = buffer;
		}
		this.buffer.set(bytes, this.length);
		this.length = size;
	}
}

export function encodeRemoteFrame(value: object, maxFrameBytes = REMOTE_MAX_FRAME_BYTES): Uint8Array {
	frameLimit(maxFrameBytes);
	const json = JSON.stringify(value);
	if (typeof json !== "string") throw new TypeError("Remote frame is not JSON");
	const bytes = new TextEncoder().encode(`${json}\n`);
	if (bytes.length > maxFrameBytes) throw new RangeError("Remote frame exceeds byte limit");
	return bytes;
}
export type RemoteClientFrame = RemoteHello | RemoteRequest;
export type RemoteServerFrame =
	| { type: "reply"; id: string; ok: true; data: unknown }
	| { type: "reply"; id: string; ok: false; error: RemoteError }
	| { type: "event"; epoch: string; seq: number; sessionId: string; event: unknown };

// Transport must enforce the negotiated byte limit before buffering/parsing NDJSON.
// These validators check the envelope and command boundary, not Core payload models.
type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: ObjectValue, required: readonly string[], optional: readonly string[] = []): boolean {
	return (
		required.every(key => Object.hasOwn(value, key)) &&
		Object.keys(value).every(key => required.includes(key) || optional.includes(key))
	);
}
function text(value: unknown, max = REMOTE_MAX_ID_LENGTH): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
}
function instanceKey(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function sequence(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function versions(value: unknown): boolean {
	return (
		Array.isArray(value) && value.length > 0 && value.length <= REMOTE_MAX_VERSIONS && value.every(positiveInteger)
	);
}
function capabilities(value: unknown): boolean {
	return Array.isArray(value) && value.length <= REMOTE_MAX_CAPABILITIES && value.every(item => text(item));
}
function optionalId(value: ObjectValue, key: string): boolean {
	return !Object.hasOwn(value, key) || text(value[key]);
}
function command(value: unknown): boolean {
	if (!object(value)) return false;
	switch (value.type) {
		case "prompt":
			return (
				keys(value, ["type", "message"]) &&
				typeof value.message === "string" &&
				value.message.length <= REMOTE_MAX_FRAME_BYTES
			);
		case "new_session":
			return keys(value, ["type"]);
		case "open_session":
			return keys(value, ["type", "sessionId"]) && text(value.sessionId);
		case "respond":
			return keys(value, ["type", "requestId", "response"]) && text(value.requestId) && object(value.response);
		case "stop":
			return keys(value, ["type", "runId"]) && text(value.runId);
		default:
			return false;
	}
}
function requestData(op: unknown, data: unknown): boolean {
	if (!object(data)) return false;
	switch (op) {
		case "acquire":
			return keys(data, []);
		case "heartbeat":
			return keys(data, ["lease"]) && positiveInteger(data.lease);
		case "sync":
			return (
				keys(data, ["lease"], ["resumeSessionId"]) &&
				positiveInteger(data.lease) &&
				optionalId(data, "resumeSessionId")
			);
		case "sessions":
			return keys(data, [], ["cursor"]) && optionalId(data, "cursor");
		case "history":
			return keys(data, ["view"], ["cursor"]) && text(data.view) && optionalId(data, "cursor");
		case "output":
			return (
				keys(data, ["view", "outputId"], ["cursor"]) &&
				text(data.view) &&
				text(data.outputId) &&
				optionalId(data, "cursor")
			);
		case "receipt":
			return (
				keys(data, ["epoch", "sessionId", "actionId"]) &&
				text(data.epoch) &&
				text(data.sessionId) &&
				text(data.actionId)
			);
		case "action":
			return (
				keys(data, ["lease", "epoch", "sessionId", "actionId", "command"]) &&
				positiveInteger(data.lease) &&
				text(data.epoch) &&
				text(data.sessionId) &&
				text(data.actionId) &&
				command(data.command)
			);
		case "read_document":
			return keys(data, ["path"]) && text(data.path, REMOTE_MAX_PATH_LENGTH);
		default:
			return false;
	}
}

export function parseRemoteClientFrame(value: unknown): RemoteClientFrame | null {
	if (!object(value) || !text(value.id)) return null;
	if (value.type === "hello") {
		return keys(value, ["type", "id", "versions", "instanceKey", "workspace", "capabilities", "maxFrameBytes"]) &&
			versions(value.versions) &&
			instanceKey(value.instanceKey) &&
			text(value.workspace, REMOTE_MAX_PATH_LENGTH) &&
			capabilities(value.capabilities) &&
			positiveInteger(value.maxFrameBytes) &&
			value.maxFrameBytes <= REMOTE_MAX_FRAME_BYTES
			? (value as unknown as RemoteHello)
			: null;
	}
	if (value.type === "request" && keys(value, ["type", "id", "op", "data"]) && requestData(value.op, value.data)) {
		return value as unknown as RemoteRequest;
	}
	return null;
}

export function parseRemoteServerFrame(value: unknown): RemoteServerFrame | null {
	if (!object(value)) return null;
	if (value.type === "reply" && text(value.id)) {
		if (value.ok === true && keys(value, ["type", "id", "ok", "data"]) && value.data !== undefined)
			return value as unknown as RemoteServerFrame;
		if (
			value.ok === false &&
			keys(value, ["type", "id", "ok", "error"]) &&
			object(value.error) &&
			keys(value.error, ["code"]) &&
			typeof value.error.code === "string" &&
			(REMOTE_ERROR_CODES as readonly string[]).includes(value.error.code)
		)
			return value as unknown as RemoteServerFrame;
	}
	if (
		value.type === "event" &&
		keys(value, ["type", "epoch", "seq", "sessionId", "event"]) &&
		text(value.epoch) &&
		sequence(value.seq) &&
		text(value.sessionId) &&
		object(value.event)
	)
		return value as unknown as RemoteServerFrame;
	return null;
}

/** Validate a successful hello against the exact offer used on this connection. */
export function parseRemoteHelloResult(value: unknown, offer: RemoteHello): RemoteHelloResult | null {
	if (
		!parseRemoteClientFrame(offer) ||
		offer.type !== "hello" ||
		!offer.versions.includes(REMOTE_PROTOCOL_VERSION) ||
		!REMOTE_REQUIRED_CAPABILITIES.every(capability => offer.capabilities.includes(capability)) ||
		!object(value) ||
		!keys(value, ["version", "instanceKey", "workspace", "epoch", "capabilities", "maxFrameBytes"]) ||
		value.version !== REMOTE_PROTOCOL_VERSION ||
		!instanceKey(value.instanceKey) ||
		value.instanceKey !== offer.instanceKey ||
		!text(value.workspace, REMOTE_MAX_PATH_LENGTH) ||
		value.workspace !== offer.workspace ||
		!text(value.epoch) ||
		!capabilities(value.capabilities) ||
		!Array.isArray(value.capabilities) ||
		!REMOTE_REQUIRED_CAPABILITIES.every(capability => (value.capabilities as unknown[]).includes(capability)) ||
		!positiveInteger(value.maxFrameBytes) ||
		value.maxFrameBytes > offer.maxFrameBytes
	)
		return null;
	return value as unknown as RemoteHelloResult;
}

export function parseRemoteSnapshot(value: unknown): RemoteSnapshot | null {
	if (
		!object(value) ||
		!keys(value, [
			"epoch",
			"seq",
			"view",
			"sessionId",
			"cwd",
			"phase",
			"runId",
			"partialReply",
			"currentTools",
			"pendingApprovals",
			"historyCursor",
		]) ||
		!text(value.epoch) ||
		!sequence(value.seq) ||
		!text(value.view) ||
		!(value.sessionId === null || text(value.sessionId)) ||
		!text(value.cwd, REMOTE_MAX_PATH_LENGTH) ||
		!(
			value.phase === "starting" ||
			value.phase === "idle" ||
			value.phase === "running" ||
			value.phase === "waiting" ||
			value.phase === "stopping"
		) ||
		!(value.runId === null || text(value.runId)) ||
		value.partialReply === undefined ||
		!Array.isArray(value.currentTools) ||
		!Array.isArray(value.pendingApprovals) ||
		!(value.historyCursor === null || text(value.historyCursor))
	)
		return null;
	return value as unknown as RemoteSnapshot;
}

export function parseRemoteInstanceList(value: unknown): readonly RemoteInstance[] | null {
	if (!Array.isArray(value) || value.length > REMOTE_MAX_INSTANCES) return null;
	for (const item of value) {
		if (
			!object(item) ||
			!keys(item, ["name", "instanceKey", "workspace", "versions", "capabilities"]) ||
			!text(item.name) ||
			!instanceKey(item.instanceKey) ||
			!text(item.workspace, REMOTE_MAX_PATH_LENGTH) ||
			!versions(item.versions) ||
			!capabilities(item.capabilities)
		)
			return null;
	}
	return value as RemoteInstance[];
}
