import { randomUUID } from "node:crypto";
import {
	encodeRemoteFrame,
	parseRemoteHelloResult,
	parseRemoteServerFrame,
	REMOTE_MAX_FRAME_BYTES,
	REMOTE_MAX_QUEUE_FRAMES,
	REMOTE_OPTIONAL_CAPABILITIES,
	REMOTE_PROTOCOL_VERSION,
	REMOTE_REQUIRED_CAPABILITIES,
	type RemoteClientFrame,
	type RemoteErrorCode,
	RemoteFrameDecoder,
	type RemoteHello,
	type RemoteHelloResult,
	type RemoteInstance,
	type RemoteOperation,
	type RemoteRequest,
	type RemoteRequestData,
	type RemoteServerFrame,
} from "../shared/remote-wire";
import { RemoteSshError, type RemoteSshStream } from "./remote-ssh";

export type RemoteDelta = Extract<RemoteServerFrame, { type: "event" }>;

interface PendingReply {
	finish(frame: Extract<RemoteServerFrame, { type: "reply" }>): void;
	fail(error: RemoteSshError): void;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** Correlates one SSH attach's replies. No request is retried or retained across streams. */
export class RemoteChannel {
	readonly #decoder = new RemoteFrameDecoder();
	readonly #pending = new Map<string, PendingReply>();
	readonly #terminated = Promise.withResolvers<RemoteErrorCode>();
	readonly closed = this.#terminated.promise;
	#failure?: RemoteSshError;
	#maxFrameBytes = REMOTE_MAX_FRAME_BYTES;

	constructor(
		private readonly stream: RemoteSshStream,
		private readonly onEvent: (frame: RemoteDelta) => void,
	) {
		void stream.completion.then(
			() => this.#finish(),
			error => this.close(error instanceof RemoteSshError ? error.code : "disconnected"),
		);
		stream.stdout.on("data", this.#read);
		stream.stdout.on("error", this.#onReadError);
	}

	async hello(instance: RemoteInstance): Promise<RemoteHelloResult> {
		const hello: RemoteHello = {
			type: "hello",
			id: randomUUID(),
			versions: [REMOTE_PROTOCOL_VERSION],
			instanceKey: instance.instanceKey,
			workspace: instance.workspace,
			capabilities: [...REMOTE_REQUIRED_CAPABILITIES, ...REMOTE_OPTIONAL_CAPABILITIES],
			maxFrameBytes: REMOTE_MAX_FRAME_BYTES,
		};
		const reply = await this.#send(hello);
		const identity = typeof reply === "object" && reply !== null ? (reply as Record<string, unknown>) : null;
		if (
			identity &&
			((typeof identity.instanceKey === "string" && identity.instanceKey !== hello.instanceKey) ||
				(typeof identity.workspace === "string" && identity.workspace !== hello.workspace))
		)
			throw new RemoteSshError("identity_mismatch");
		const verified = parseRemoteHelloResult(reply, hello);
		if (!verified) throw new RemoteSshError("protocol_incompatible");
		this.#maxFrameBytes = verified.maxFrameBytes;
		return verified;
	}

	request<K extends RemoteOperation>(op: K, data: RemoteRequestData[K]): Promise<unknown> {
		return this.#send({ type: "request", id: randomUUID(), op, data } as RemoteRequest);
	}

	close(code: RemoteErrorCode = "disconnected"): void {
		if (this.#failure) return;
		const error = new RemoteSshError(code);
		this.#failure = error;
		this.stream.stdout.off("data", this.#read);
		for (const pending of this.#pending.values()) pending.fail(error);
		this.#pending.clear();
		this.#terminated.resolve(code);
		this.stream.close();
	}

	#send(frame: RemoteClientFrame): Promise<unknown> {
		if (this.#failure) return Promise.reject(this.#failure);
		if (this.#pending.size >= REMOTE_MAX_QUEUE_FRAMES) return Promise.reject(new RemoteSshError("overflow"));
		let bytes: Uint8Array;
		try {
			bytes = encodeRemoteFrame(frame, this.#maxFrameBytes);
		} catch {
			return Promise.reject(new RemoteSshError("overflow"));
		}
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => this.close("timeout"), REQUEST_TIMEOUT_MS);
		timer.unref();
		this.#pending.set(frame.id, {
			finish: reply => {
				clearTimeout(timer);
				if (reply.ok) resolve(reply.data);
				else reject(new RemoteSshError(reply.error.code));
			},
			fail: error => {
				clearTimeout(timer);
				reject(error);
			},
		});
		try {
			this.stream.send(bytes);
		} catch (error) {
			this.close(error instanceof RemoteSshError ? error.code : "disconnected");
		}
		return promise;
	}

	readonly #read = (bytes: Buffer): void => {
		try {
			for (const raw of this.#decoder.push(bytes)) {
				if (this.#failure) break;
				const value = parseRemoteServerFrame(raw);
				if (!value) {
					this.close("protocol_incompatible");
					break;
				}
				if (value.type === "event") this.onEvent(value);
				else {
					const pending = this.#pending.get(value.id);
					if (!pending) {
						this.close("protocol_incompatible");
						break;
					}
					this.#pending.delete(value.id);
					pending.finish(value);
				}
			}
		} catch (error) {
			this.close(error instanceof RangeError ? "overflow" : "protocol_incompatible");
		}
	};

	readonly #onReadError = (): void => this.close();

	#finish(): void {
		if (this.#failure) return;
		try {
			this.#decoder.finish();
		} catch {
			this.close("protocol_incompatible");
			return;
		}
		this.close();
	}
}
