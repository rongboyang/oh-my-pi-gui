import type { RemoteTabTarget } from "../shared/ipc-types";
import type { RemoteActionScope, RemoteTabEvent } from "../shared/remote-ipc";
import {
	parseRemoteClientFrame,
	parseRemoteModels,
	REMOTE_ERROR_CODES,
	REMOTE_MAX_DOCUMENT_BYTES,
	REMOTE_MAX_PAGE_ITEMS,
	REMOTE_MAX_PATH_LENGTH,
	REMOTE_MAX_QUEUE_BYTES,
	type RemoteActionCommand,
	type RemoteDocumentResult,
	type RemoteErrorCode,
	type RemoteHistoryPage,
	type RemoteInstance,
	type RemoteModels,
	type RemoteOutputPage,
	type RemoteReceipt,
	type RemoteSessionPage,
	type RemoteSnapshot,
} from "../shared/remote-wire";
import { RemoteAttachment } from "./remote-attachment";
import type { RemoteJournal } from "./remote-journal";
import {
	dialRemoteInstance,
	RemoteReconnect,
	type RemoteSshAttempt,
	RemoteSshError,
	type RemoteSshOptions,
} from "./remote-ssh";

interface RemoteConnectionContext {
	winAlive(): boolean;
	publish(event: RemoteTabEvent): void;
	persist(epoch: string, sessionId: string | null): void;
	lastEpoch(): string | undefined;
	ssh(signal: AbortSignal, showPrompt: boolean): RemoteSshOptions;
}

type RemoteDeltaEvent = Extract<RemoteTabEvent, { type: "delta" }>;
type RemoteTerminalReceipt = Extract<RemoteReceipt, { status: "succeeded" | "rejected" }>;
const TERMINAL_WAIT_MS = 10_000;

/** Owns the GUI side of one remote tab. Suspension does not send a Core action. */
export class RemoteConnection {
	readonly #retry = new RemoteReconnect();
	#attachment?: RemoteAttachment;
	#mux?: RemoteSshAttempt;
	#generation = 0;
	#connecting?: Promise<void>;
	#initialized = false;
	#sessionMissing = false;
	#restoredEpoch = false;
	#unknown = new Set<string>();
	#expectedSession: string | undefined;
	#switching = false;
	#running = false;
	readonly #waiting = new Map<string, (receipt: RemoteTerminalReceipt) => void>();

	constructor(
		private readonly tabId: string,
		private readonly target: RemoteTabTarget,
		private readonly instance: RemoteInstance,
		private readonly journal: RemoteJournal,
		private readonly context: RemoteConnectionContext,
	) {
		this.#expectedSession = target.sessionId;
	}

	connect(attempt?: RemoteSshAttempt, showPrompt = true): Promise<void> {
		if (this.#connecting) return this.#connecting;
		if (this.#attachment?.ready && this.#initialized) return Promise.resolve();
		const generation = ++this.#generation;
		this.#initialized = false;
		this.#restoredEpoch = false;
		this.#status("connecting");
		const current = (): boolean => generation === this.#generation && this.context.winAlive();
		const pending = this.#retry
			.run(async (signal, trial) => {
				if (trial === 0) this.#mux = attempt;
				const options = this.context.ssh(signal, showPrompt && trial === 0);
				let attachment: RemoteAttachment | undefined;
				let bootstrapping = true;
				let receivedSnapshot: RemoteSnapshot | undefined;
				const buffered: RemoteDeltaEvent[] = [];
				let bufferedBytes = 0;
				try {
					const stream = this.#mux
						? await this.#mux.dial(this.instance, options)
						: await dialRemoteInstance(this.target.target, this.instance, options);
					if (!current()) {
						stream.close();
						throw new RemoteSshError("auth_cancelled");
					}
					attachment = new RemoteAttachment(stream, {
						handshake: () => current() && this.#status("handshake"),
						synchronizing: () => current() && this.#status("synchronizing"),
						snapshot: snapshot => {
							if (!current()) return;
							receivedSnapshot = snapshot;
							if (bootstrapping) {
								buffered.length = 0;
								bufferedBytes = 0;
							} else this.#publishSnapshot(snapshot);
						},
						delta: frame => {
							if (!current()) return;
							const event = { ...frame, type: "delta", tabId: this.tabId, generation } as const;
							if (bootstrapping) {
								bufferedBytes += Buffer.byteLength(JSON.stringify(frame));
								if (buffered.length < 128 && bufferedBytes <= REMOTE_MAX_QUEUE_BYTES) buffered.push(event);
								else attachment?.close();
							} else this.#publishDelta(event);
						},
						receipt: frame => {
							if (!current()) return;
							const value = object(frame.event);
							const receipt = parseReceipt(value?.receipt);
							if (typeof value?.actionId === "string" && receipt && terminal(receipt)) {
								this.#finish(value.actionId, frame.epoch);
								this.#waiting.get(value.actionId)?.(receipt);
							}
						},
					});
					this.#attachment = attachment;
					const snapshot = await attachment.start(this.instance);
					const oldEpoch = this.context.lastEpoch();
					this.#restoredEpoch = oldEpoch !== undefined && oldEpoch !== snapshot.epoch;
					this.#sessionMissing =
						this.#expectedSession !== undefined && snapshot.sessionId !== this.#expectedSession;
					const currentReceipts = await this.#reconcile(attachment);
					if (this.#sessionMissing && this.#restoredEpoch && snapshot.phase === "idle" && this.#expectedSession) {
						const currentId = snapshot.sessionId;
						if (currentId && currentReceipts && (await hasSession(attachment, this.#expectedSession))) {
							const result = await this.#send(
								attachment,
								{ epoch: snapshot.epoch, sessionId: currentId },
								{
									type: "open_session",
									sessionId: this.#expectedSession,
								},
							);
							if (result.status === "succeeded") {
								await attachment.sync();
								this.#sessionMissing = receivedSnapshot?.sessionId !== this.#expectedSession;
							}
						}
					}
					if (!attachment.ready) await attachment.sync();
					if (!current() || !attachment.ready || !receivedSnapshot) throw new RemoteSshError("disconnected");
					this.#initialized = true;
					bootstrapping = false;
					this.#publishSnapshot(receivedSnapshot);
					for (const event of buffered) this.#publishDelta(event);
					buffered.length = 0;
					void attachment.closed.then(code => {
						if (!current()) return;
						this.#attachment = undefined;
						this.#initialized = false;
						this.#releaseMux();
						this.#status("disconnected", code);
						if (code === "disconnected" || code === "timeout") {
							const finishing = this.#connecting;
							void (finishing ?? Promise.resolve()).then(
								() => {
									if (current()) void this.connect(undefined, false).catch(() => {});
								},
								() => {},
							);
						}
					});
				} catch (error) {
					attachment?.close();
					if (current()) {
						this.#attachment = undefined;
						this.#releaseMux();
					}
					throw error;
				}
			})
			.catch(error => {
				if (current()) this.#status("disconnected", codeOf(error));
				throw error;
			})
			.finally(() => {
				if (this.#connecting === pending) this.#connecting = undefined;
			});
		this.#connecting = pending;
		return pending;
	}

	disconnect(): void {
		this.#generation++;
		this.#connecting = undefined;
		this.#initialized = false;
		this.#retry.cancel();
		this.#attachment?.close();
		this.#attachment = undefined;
		this.#releaseMux();
		this.#status("disconnected");
	}

	async sync(): Promise<null> {
		await this.#require().sync();
		return null;
	}

	async sessions(cursor?: string): Promise<RemoteSessionPage> {
		return sessionPage(await this.#require().request("sessions", cursor ? { cursor } : {}));
	}

	async models(view: string): Promise<RemoteModels> {
		const attachment = this.#requireView(view);
		if (!attachment.hello?.capabilities.includes("select_model")) throw new RemoteSshError("unsupported");
		const models = parseRemoteModels(await attachment.request("models", { view }));
		if (!models) throw new RemoteSshError("protocol_incompatible");
		if (attachment !== this.#attachment || attachment.snapshot?.view !== view)
			throw new RemoteSshError("stale_session");
		return models;
	}

	async history(view: string, cursor?: string): Promise<RemoteHistoryPage> {
		const attachment = this.#requireView(view);
		const result = object(await attachment.request("history", { view, ...(cursor ? { cursor } : {}) }));
		if (
			result?.view !== view ||
			!Array.isArray(result?.items) ||
			result.items.length > REMOTE_MAX_PAGE_ITEMS ||
			!validCursor(result.cursor)
		)
			throw new RemoteSshError("protocol_incompatible");
		return { view, items: result.items, cursor: result.cursor };
	}

	async output(view: string, outputId: string, cursor?: string): Promise<RemoteOutputPage> {
		const attachment = this.#requireView(view);
		const result = object(await attachment.request("output", { view, outputId, ...(cursor ? { cursor } : {}) }));
		if (
			result?.view !== view ||
			result.outputId !== outputId ||
			typeof result.data !== "string" ||
			typeof result.truncated !== "boolean" ||
			!validCursor(result.cursor)
		)
			throw new RemoteSshError("protocol_incompatible");
		return { view, outputId, data: result.data, truncated: result.truncated, cursor: result.cursor };
	}

	async readDocument(scope: RemoteActionScope, path: string): Promise<RemoteDocumentResult> {
		const attachment = this.#require();
		const snapshot = attachment.snapshot;
		if (!snapshot || !attachment.ready) throw new RemoteSshError("disconnected");
		if (scope.epoch !== snapshot.epoch) throw new RemoteSshError("stale_epoch");
		if (this.#sessionMissing || scope.sessionId !== snapshot.sessionId) throw new RemoteSshError("stale_session");
		if (!attachment.hello?.capabilities.includes("read_document")) throw new RemoteSshError("unsupported");
		const value = object(await attachment.request("read_document", { path }));
		if (
			attachment !== this.#attachment ||
			attachment.snapshot?.epoch !== scope.epoch ||
			attachment.snapshot.sessionId !== scope.sessionId
		)
			throw new RemoteSshError("stale_session");
		const prefix = this.target.workspace === "/" ? "/" : `${this.target.workspace}/`;
		if (
			typeof value?.path !== "string" ||
			value.path.length > REMOTE_MAX_PATH_LENGTH ||
			!value.path.startsWith(prefix) ||
			/[\\\r\n\0]/.test(value.path) ||
			value.path.split("/").includes("..") ||
			typeof value.content !== "string" ||
			Buffer.byteLength(value.content) > REMOTE_MAX_DOCUMENT_BYTES ||
			(value.mediaType !== "text/plain" && value.mediaType !== "text/markdown")
		)
			throw new RemoteSshError("protocol_incompatible");
		return { path: value.path, content: value.content, mediaType: value.mediaType };
	}

	async action(scope: RemoteActionScope, command: RemoteActionCommand): Promise<RemoteReceipt> {
		const attachment = this.#require();
		const snapshot = attachment.snapshot;
		if (!snapshot || !attachment.ready) throw new RemoteSshError("disconnected");
		if (scope.epoch !== snapshot.epoch) throw new RemoteSshError("stale_epoch");
		if (scope.sessionId !== snapshot.sessionId) throw new RemoteSshError("stale_session");
		const switchSession = command.type === "new_session" || command.type === "open_session";
		const changesModel = command.type === "set_model";
		if (changesModel && !attachment.hello?.capabilities.includes("select_model"))
			throw new RemoteSshError("unsupported");
		if (this.#sessionMissing && !switchSession && !(command.type === "respond" && !this.#running))
			throw new RemoteSshError("stale_session");
		const exclusive = switchSession || changesModel;
		if (this.#switching || (exclusive && this.#running)) throw new RemoteSshError("busy");
		this.#switching = exclusive;
		try {
			const result = await this.#send(attachment, scope, command);
			if (switchSession && result.status === "succeeded") {
				this.#sessionMissing = false;
				await attachment.sync();
			}
			return result;
		} finally {
			this.#switching = false;
		}
	}

	#require(): RemoteAttachment {
		if (!this.#attachment || !this.#initialized) throw new RemoteSshError("disconnected");
		return this.#attachment;
	}

	#requireView(view: string): RemoteAttachment {
		const attachment = this.#require();
		if (attachment.snapshot?.view !== view) throw new RemoteSshError("stale_session");
		return attachment;
	}

	async #send(
		attachment: RemoteAttachment,
		scope: RemoteActionScope,
		command: RemoteActionCommand,
	): Promise<RemoteReceipt> {
		const lease = attachment.lease;
		if (lease === undefined) throw new RemoteSshError("stale_lease");
		const candidate = { lease, epoch: scope.epoch, sessionId: scope.sessionId, actionId: "validate", command };
		if (!parseRemoteClientFrame({ type: "request", id: "validate", op: "action", data: candidate }))
			throw new RemoteSshError("invalid_request");
		const { actionId } = this.journal.begin(this.target, scope);
		const settled = Promise.withResolvers<RemoteReceipt>();
		const waitsForTerminal =
			command.type === "new_session" ||
			command.type === "open_session" ||
			command.type === "stop" ||
			command.type === "set_model";
		if (waitsForTerminal) this.#waiting.set(actionId, settled.resolve);
		try {
			let receipt = parseReceipt(await attachment.request("action", { ...candidate, actionId }));
			if (!receipt) throw new RemoteSshError("protocol_incompatible");
			if (waitsForTerminal && receipt.status === "accepted") {
				const timer = setTimeout(() => settled.resolve({ status: "unknown" }), TERMINAL_WAIT_MS);
				timer.unref();
				try {
					receipt = await Promise.race([
						settled.promise,
						attachment.closed.then((): RemoteReceipt => ({ status: "unknown" })),
					]);
					if (receipt.status === "unknown" && attachment.ready) {
						receipt = parseReceipt(await attachment.request("receipt", { ...scope, actionId })) ?? receipt;
					}
				} finally {
					clearTimeout(timer);
				}
			}
			if (terminal(receipt)) this.#finish(actionId, scope.epoch);
			else if (receipt.status === "unknown") this.#reportUnknown(actionId);
			return receipt;
		} catch (error) {
			const code = codeOf(error);
			if (
				[
					"invalid_request",
					"stale_lease",
					"stale_epoch",
					"stale_session",
					"stale_run",
					"unknown_request",
					"busy",
					"unsupported",
				].includes(code)
			) {
				this.#finish(actionId, scope.epoch);
				throw error;
			}
			this.#reportUnknown(actionId);
			return { status: "unknown" };
		} finally {
			this.#waiting.delete(actionId);
		}
	}

	async #reconcile(attachment: RemoteAttachment): Promise<boolean> {
		const records = this.journal.pending(this.target);
		let noUnsettledCurrent = true;
		this.#unknown = new Set();
		for (const record of records) {
			const current = record.epoch === attachment.hello?.epoch;
			const receipt = current
				? parseReceipt(
						await attachment.request("receipt", {
							epoch: record.epoch,
							sessionId: record.sessionId,
							actionId: record.actionId,
						}),
					)
				: ({ status: "unknown" } as const);
			if (!receipt) throw new RemoteSshError("protocol_incompatible");
			if (terminal(receipt)) this.#finish(record.actionId, record.epoch);
			else {
				if (current) noUnsettledCurrent = false;
				if (receipt.status === "unknown") this.#unknown.add(record.actionId);
			}
		}
		this.#publishReceipts();
		return noUnsettledCurrent;
	}

	#finish(actionId: string, epoch: string): void {
		try {
			this.journal.finish(this.target, actionId, epoch);
		} catch {
			// The verified outcome is still authoritative. The surviving ID can be reconciled again.
		}
		if (this.#unknown.delete(actionId)) this.#publishReceipts();
	}

	#reportUnknown(actionId: string): void {
		this.#unknown.add(actionId);
		this.#publishReceipts();
	}

	#publishReceipts(): void {
		this.context.publish({
			type: "receipts",
			tabId: this.tabId,
			generation: this.#generation,
			unresolved: this.#unknown.size,
		});
	}

	#publishSnapshot(snapshot: RemoteSnapshot): void {
		this.#running = snapshot.runId !== null;
		if (snapshot.sessionId && (!this.#sessionMissing || snapshot.sessionId === this.#expectedSession)) {
			this.#expectedSession = snapshot.sessionId;
			this.#sessionMissing = false;
			this.context.persist(snapshot.epoch, snapshot.sessionId);
		}
		this.context.publish({ type: "snapshot", tabId: this.tabId, generation: this.#generation, snapshot });
		this.#status("connected", this.#sessionMissing ? "stale_session" : undefined);
	}

	#publishDelta(event: RemoteTabEvent & { type: "delta" }): void {
		const type = object(event.event)?.type;
		if (type === "agent_start" || type === "agent_end") this.#running = type === "agent_start";
		this.context.publish(event);
	}

	#status(state: (RemoteTabEvent & { type: "status" })["state"], code?: RemoteErrorCode): void {
		this.context.publish({
			type: "status",
			tabId: this.tabId,
			generation: this.#generation,
			state,
			code,
			restarted: this.#restoredEpoch,
		});
	}

	#releaseMux(): void {
		if (!this.#mux) return;
		void this.#mux.close().catch(() => {});
		this.#mux = undefined;
	}
}

export function codeOf(error: unknown): RemoteErrorCode {
	return error instanceof RemoteSshError ? error.code : "internal_error";
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function validCursor(value: unknown): value is string | null {
	return value === null || (typeof value === "string" && value.length > 0 && value.length <= 256);
}

function parseReceipt(value: unknown): RemoteReceipt | null {
	const result = object(value);
	if (result?.status === "unknown" || result?.status === "accepted") return { status: result.status };
	if (result?.status === "succeeded" && result.data !== undefined) return { status: "succeeded", data: result.data };
	const code = object(result?.error)?.code;
	return result?.status === "rejected" &&
		typeof code === "string" &&
		(REMOTE_ERROR_CODES as readonly string[]).includes(code)
		? { status: "rejected", error: { code: code as RemoteErrorCode } }
		: null;
}

function terminal(receipt: RemoteReceipt): receipt is RemoteTerminalReceipt {
	return receipt.status === "succeeded" || receipt.status === "rejected";
}

function sessionPage(value: unknown): RemoteSessionPage {
	const page = object(value);
	if (
		!page ||
		!Array.isArray(page.sessions) ||
		page.sessions.length > REMOTE_MAX_PAGE_ITEMS ||
		!validCursor(page.cursor)
	)
		throw new RemoteSshError("protocol_incompatible");
	const sessions = page.sessions.map(row => {
		const item = object(row);
		if (
			typeof item?.sessionId !== "string" ||
			typeof item.updatedAt !== "string" ||
			(typeof item.name !== "string" && item.name !== null)
		)
			throw new RemoteSshError("protocol_incompatible");
		return { sessionId: item.sessionId, updatedAt: item.updatedAt, name: item.name };
	});
	return { sessions, cursor: page.cursor };
}

async function hasSession(attachment: RemoteAttachment, sessionId: string): Promise<boolean> {
	const seen = new Set<string>();
	let cursor: string | null = null;
	do {
		const page = sessionPage(await attachment.request("sessions", cursor ? { cursor } : {}));
		if (page.sessions.some(session => session.sessionId === sessionId)) return true;
		cursor = page.cursor;
		if (cursor) {
			if (seen.has(cursor) || seen.size >= 1000) throw new RemoteSshError("overflow");
			seen.add(cursor);
		}
	} while (cursor);
	return false;
}
