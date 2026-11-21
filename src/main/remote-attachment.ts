import {
	parseRemoteSnapshot,
	REMOTE_LEASE_HEARTBEAT_MS,
	REMOTE_MAX_QUEUE_BYTES,
	REMOTE_MAX_QUEUE_FRAMES,
	type RemoteErrorCode,
	type RemoteHelloResult,
	type RemoteInstance,
	type RemoteOperation,
	type RemoteRequestData,
	type RemoteSnapshot,
} from "../shared/remote-wire";
import { RemoteChannel, type RemoteDelta } from "./remote-channel";
import { RemoteSshError, type RemoteSshStream } from "./remote-ssh";

interface RemoteAttachmentEvents {
	handshake(): void;
	synchronizing(): void;
	snapshot(snapshot: RemoteSnapshot): void;
	delta(frame: RemoteDelta): void;
	/** May settle an action on the previous session when the action switched sessions. */
	receipt(frame: RemoteDelta): void;
}

/** An authenticated attachment's lease, authoritative view, sequence, and bounded sync gap. */
export class RemoteAttachment {
	readonly #channel: RemoteChannel;
	readonly closed: Promise<RemoteErrorCode>;
	#hello?: RemoteHelloResult;
	#lease?: number;
	#view?: RemoteSnapshot;
	#seq = 0;
	#syncing?: Promise<RemoteSnapshot>;
	#queued: RemoteDelta[] = [];
	#queuedBytes = 0;
	#heartbeat?: NodeJS.Timeout;
	#ended = false;

	constructor(
		stream: RemoteSshStream,
		private readonly events: RemoteAttachmentEvents,
	) {
		this.#channel = new RemoteChannel(stream, frame => this.#receive(frame));
		this.closed = this.#channel.closed;
		void this.closed.then(() => {
			this.#ended = true;
			clearTimeout(this.#heartbeat);
			this.#clearQueue();
		});
	}

	get hello(): RemoteHelloResult | undefined {
		return this.#hello;
	}

	get snapshot(): RemoteSnapshot | undefined {
		return this.#view;
	}

	get lease(): number | undefined {
		return this.#lease;
	}

	get ready(): boolean {
		return !this.#ended && this.#view !== undefined && this.#syncing === undefined;
	}

	async start(instance: RemoteInstance): Promise<RemoteSnapshot> {
		this.#hello = await this.#channel.hello(instance);
		this.events.handshake();
		const result = await this.#channel.request("acquire", {});
		const lease = object(result)?.lease;
		if (typeof lease !== "number" || !Number.isSafeInteger(lease) || lease < 1) {
			throw new RemoteSshError("protocol_incompatible");
		}
		this.#lease = lease;
		this.#scheduleHeartbeat(lease);
		return this.sync();
	}

	sync(): Promise<RemoteSnapshot> {
		if (this.#syncing) return this.#syncing;
		if (this.#lease === undefined || this.#ended) return Promise.reject(new RemoteSshError("disconnected"));
		this.#clearQueue();
		const synced = this.#channel.request("sync", { lease: this.#lease }).then(
			data => {
				const view = parseRemoteSnapshot(data);
				if (!view || view.epoch !== this.#hello?.epoch || view.cwd !== this.#hello.workspace) {
					this.close("protocol_incompatible");
					throw new RemoteSshError("protocol_incompatible");
				}
				if (this.#ended || view.seq < this.#seq) {
					this.close();
					throw new RemoteSshError("disconnected");
				}
				const queued = this.#queued;
				this.#clearQueue();
				this.#syncing = undefined;
				this.#view = view;
				this.#seq = view.seq;
				this.events.snapshot(view);
				for (const frame of queued) {
					if (frame.seq > view.seq) this.#receive(frame);
					else if (object(frame.event)?.type === "remote_receipt") this.events.receipt(frame);
				}
				if (this.#ended) throw new RemoteSshError("disconnected");
				return view;
			},
			error => {
				this.#syncing = undefined;
				this.close(error instanceof RemoteSshError ? error.code : "disconnected");
				throw error;
			},
		);
		this.#syncing = synced;
		this.events.synchronizing();
		return synced;
	}

	request<K extends RemoteOperation>(op: K, data: RemoteRequestData[K]): Promise<unknown> {
		return this.#channel.request(op, data);
	}

	close(code: RemoteErrorCode = "disconnected"): void {
		if (this.#ended) return;
		this.#ended = true;
		clearTimeout(this.#heartbeat);
		this.#clearQueue();
		this.#channel.close(code);
	}

	#receive(frame: RemoteDelta): void {
		if (this.#ended) return;
		if (!this.#hello || frame.epoch !== this.#hello.epoch) {
			this.close("stale_epoch");
			return;
		}
		const type = object(frame.event)?.type;
		if (this.#syncing) {
			const size = Buffer.byteLength(JSON.stringify(frame));
			if (this.#queued.length === REMOTE_MAX_QUEUE_FRAMES || this.#queuedBytes + size > REMOTE_MAX_QUEUE_BYTES) {
				this.close();
				return;
			}
			this.#queuedBytes += size;
			this.#queued.push(frame);
			return;
		}
		if (!this.#view || frame.seq !== this.#seq + 1) {
			this.close();
			return;
		}
		this.#seq = frame.seq;
		if (type === "remote_receipt") this.events.receipt(frame);
		if (frame.sessionId !== this.#view.sessionId || type === "remote_ready") {
			// A remote session switch/initialization crosses the old view. Only a fresh
			// snapshot can install it; don't let its first event mutate the wrong reducer.
			void this.sync().catch(() => {});
			return;
		}
		this.events.delta(frame);
	}

	#clearQueue(): void {
		this.#queued = [];
		this.#queuedBytes = 0;
	}

	#scheduleHeartbeat(lease: number): void {
		if (this.#ended) return;
		this.#heartbeat = setTimeout(() => {
			void this.#channel.request("heartbeat", { lease }).then(
				() => this.#scheduleHeartbeat(lease),
				error => this.close(error instanceof RemoteSshError ? error.code : "disconnected"),
			);
		}, REMOTE_LEASE_HEARTBEAT_MS);
		this.#heartbeat.unref();
	}
}

function object(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	return undefined;
}
