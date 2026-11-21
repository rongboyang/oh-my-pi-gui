import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import {
	parseRemoteInstanceList,
	REMOTE_MAX_FRAME_BYTES,
	REMOTE_MAX_QUEUE_BYTES,
	REMOTE_RECONNECT_MAX_ATTEMPTS,
	REMOTE_RECONNECT_MAX_DELAY_MS,
	type RemoteErrorCode,
	type RemoteInstance,
} from "../shared/remote-wire";
import { createRemoteAskpass, type RemoteAskpassCallback } from "./remote-askpass";

/** An attempt owns its authentication prompts and abort signal. timeoutMs bounds connection/discovery. */
export interface RemoteSshOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	askpass: RemoteAskpassCallback;
}

/** stdout is the unmodified attach byte stream. completion resolves on clean exit or explicit close. */
export interface RemoteSshStream {
	stdout: Readable;
	send(bytes: Uint8Array): void;
	close(): void;
	completion: Promise<void>;
}

/** Stable, non-sensitive failure classification; diagnostics and credentials are never retained. */
export class RemoteSshError extends Error {
	constructor(readonly code: RemoteErrorCode) {
		super(code === "cli_missing" ? "Remote omp was not found in the SSH non-interactive PATH" : code);
		this.name = "RemoteSshError";
	}
}

const STDERR_LIMIT = 16 * 1024;
const DISCOVERY_LIMIT = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

function validateTarget(target: string): void {
	// No options, shell metacharacters, whitespace, IPv6 literals or SSH URI syntax.
	if (target.length > 255 || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(target)) {
		throw new RemoteSshError("invalid_request");
	}
}

function classifyExit(code: number | null, stderr: string): RemoteErrorCode {
	if (code === 3) return "no_instance";
	if (code === 4) return "identity_mismatch";
	if (code === 5) return "protocol_incompatible";
	if (code === 2) return "invalid_request";
	if (code === 127 || /(?:omp: command not found|omp: not found|command not found: omp)/i.test(stderr))
		return "cli_missing";
	if (/REMOTE HOST IDENTIFICATION HAS CHANGED|host key has changed|offending .* key/i.test(stderr))
		return "host_key_changed";
	if (/host key verification failed|no .* host key is known|host key is not cached/i.test(stderr))
		return "host_key_unknown";
	if (/permission denied|authentication failed|too many authentication failures/i.test(stderr)) return "auth_failed";
	return "disconnected";
}

interface RunningSsh {
	child: ChildProcessWithoutNullStreams;
	completion: Promise<void>;
	close(): void;
	connected(): void;
}

async function startSsh(
	target: string,
	command: readonly string[],
	options: RemoteSshOptions,
	controlPath?: string,
): Promise<RunningSsh> {
	validateTarget(target);
	if (options.signal?.aborted) throw new RemoteSshError("auth_cancelled");
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RemoteSshError("invalid_request");
	let child: ChildProcessWithoutNullStreams | undefined;
	let forced: RemoteErrorCode | undefined;
	let explicitClose = false;
	const stop = (code: RemoteErrorCode) => {
		forced ??= code;
		child?.kill();
	};
	const askpass = await createRemoteAskpass(options.askpass, error =>
		stop(error instanceof RemoteSshError ? error.code : "auth_cancelled"),
	);
	if (options.signal?.aborted) {
		await askpass.close();
		throw new RemoteSshError("auth_cancelled");
	}
	try {
		child = spawn(
			"/usr/bin/ssh",
			[
				"-T",
				"-a",
				"-x",
				"-o",
				"ForwardAgent=no",
				"-o",
				"ClearAllForwardings=yes",
				"-o",
				"PermitLocalCommand=no",
				...(controlPath
					? ["-o", "ControlMaster=auto", "-o", "ControlPersist=90", "-S", controlPath]
					: ["-o", "ControlMaster=no", "-o", "ControlPath=none"]),
				"--",
				target,
				...command,
			],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, ...askpass.env, LC_ALL: "C" },
			},
		);
	} catch {
		await askpass.close();
		throw new RemoteSshError("disconnected");
	}
	const processChild = child;
	const abort = () => stop("auth_cancelled");
	options.signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => stop("timeout"), timeoutMs);
	let stderr = "";
	processChild.stderr.on("data", (chunk: Buffer) => {
		if (stderr.length < STDERR_LIMIT) stderr += chunk.toString("utf8").slice(0, STDERR_LIMIT - stderr.length);
	});
	// A closed remote stdin is surfaced through completion, not as an unhandled stream error.
	processChild.stdin.on("error", () => {});
	const done = Promise.withResolvers<void>();
	processChild.once("error", () => {
		forced ??= "disconnected";
	});
	processChild.once("close", code => {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		const failure = forced ?? (code === 0 ? undefined : classifyExit(code, stderr));
		stderr = "";
		const settle = () => {
			if (explicitClose) done.resolve();
			else if (failure) done.reject(new RemoteSshError(failure));
			else done.resolve();
		};
		void askpass.close().then(settle, settle);
	});
	// Consumers may install their own rejection handler after dial resolves.
	void done.promise.catch(() => {});
	return {
		child: processChild,
		completion: done.promise,
		connected: () => clearTimeout(timer),
		close: () => {
			explicitClose = true;
			processChild.kill();
		},
	};
}

/** Discover only already-running instances on the specified OpenSSH alias or user@host. */
export async function discoverRemoteInstances(
	target: string,
	options: RemoteSshOptions,
	controlPath?: string,
): Promise<readonly RemoteInstance[]> {
	const ssh = await startSsh(target, ["omp", "remote", "list", "--json"], options, controlPath);
	const chunks: Buffer[] = [];
	let size = 0;
	let overflow = false;
	ssh.child.stdin.end();
	ssh.child.stdout.on("data", (chunk: Buffer) => {
		size += chunk.length;
		if (size > DISCOVERY_LIMIT) {
			overflow = true;
			ssh.close();
		} else chunks.push(chunk);
	});
	await ssh.completion;
	if (overflow) throw new RemoteSshError("overflow");
	try {
		const instances = parseRemoteInstanceList(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		if (!instances) throw new Error();
		if (instances.length === 0) throw new RemoteSshError("no_instance");
		return instances;
	} catch (error) {
		if (error instanceof RemoteSshError) throw error;
		throw new RemoteSshError("protocol_incompatible");
	}
}

/** Attach to a previously selected instance. The caller must perform the wire hello and synchronization. */
export async function dialRemoteInstance(
	target: string,
	instance: RemoteInstance,
	options: RemoteSshOptions,
	controlPath?: string,
): Promise<RemoteSshStream> {
	if (!/^[0-9a-f]{64}$/.test(instance.instanceKey)) throw new RemoteSshError("invalid_request");
	const ssh = await startSsh(
		target,
		["omp", "remote", "attach", "--instance", instance.instanceKey],
		options,
		controlPath,
	);
	ssh.child.stdout.once("readable", ssh.connected);
	return {
		stdout: ssh.child.stdout,
		completion: ssh.completion,
		close: ssh.close,
		send(bytes) {
			if (
				bytes.byteLength > REMOTE_MAX_FRAME_BYTES ||
				ssh.child.stdin.writableLength + bytes.byteLength > REMOTE_MAX_QUEUE_BYTES
			) {
				ssh.close();
				throw new RemoteSshError("overflow");
			}
			if (!ssh.child.stdin.writable) throw new RemoteSshError("disconnected");
			ssh.child.stdin.write(bytes);
		},
	};
}

export interface RemoteSshAttempt {
	discover(options: RemoteSshOptions): Promise<readonly RemoteInstance[]>;
	dial(instance: RemoteInstance, options: RemoteSshOptions): Promise<RemoteSshStream>;
	close(): Promise<void>;
}

/** One UI attempt's authenticated SSH connection, never the user's preexisting master. */
export async function createRemoteSshAttempt(target: string): Promise<RemoteSshAttempt> {
	validateTarget(target);
	const directory = await mkdtemp("/tmp/omp-mux-");
	const socket = `${directory}/s`;
	const abort = new AbortController();
	let cleanup: Promise<void> | undefined;
	function bind(options: RemoteSshOptions): RemoteSshOptions {
		return {
			...options,
			signal: options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal,
		};
	}
	async function close(): Promise<void> {
		abort.abort();
		try {
			const exit = Promise.withResolvers<void>();
			const child = spawn("/usr/bin/ssh", ["-S", socket, "-O", "exit", "--", target], {
				stdio: "ignore",
				timeout: 3_000,
			});
			child.once("error", () => exit.resolve());
			child.once("close", () => exit.resolve());
			await exit.promise;
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
	return {
		discover: options => discoverRemoteInstances(target, bind(options), socket),
		dial: (instance, options) => dialRemoteInstance(target, instance, bind(options), socket),
		close: () => (cleanup ??= close()),
	};
}

/** Bounded retry of transport failures only. A new run invalidates and aborts the previous generation. */
export class RemoteReconnect {
	private generation = 0;
	private controller?: AbortController;

	cancel(): void {
		this.generation++;
		this.controller?.abort();
		this.controller = undefined;
	}

	async run<T>(connect: (signal: AbortSignal, attempt: number) => Promise<T>): Promise<T> {
		this.cancel();
		const generation = this.generation;
		const controller = new AbortController();
		this.controller = controller;
		for (let attempt = 0; attempt < REMOTE_RECONNECT_MAX_ATTEMPTS; attempt++) {
			if (controller.signal.aborted || generation !== this.generation) throw new RemoteSshError("auth_cancelled");
			try {
				const result = await connect(controller.signal, attempt);
				if (controller.signal.aborted || generation !== this.generation) throw new RemoteSshError("auth_cancelled");
				return result;
			} catch (error) {
				if (controller.signal.aborted || generation !== this.generation) throw new RemoteSshError("auth_cancelled");
				if (
					!(error instanceof RemoteSshError) ||
					!["disconnected", "timeout"].includes(error.code) ||
					attempt + 1 === REMOTE_RECONNECT_MAX_ATTEMPTS
				)
					throw error;
				const delay = Math.min(1000 * 2 ** attempt, REMOTE_RECONNECT_MAX_DELAY_MS);
				const wait = Promise.withResolvers<void>();
				const timer = setTimeout(wait.resolve, delay);
				const abort = () => {
					clearTimeout(timer);
					wait.resolve();
				};
				controller.signal.addEventListener("abort", abort, { once: true });
				await wait.promise;
				controller.signal.removeEventListener("abort", abort);
			}
		}
		throw new RemoteSshError("disconnected");
	}
}
