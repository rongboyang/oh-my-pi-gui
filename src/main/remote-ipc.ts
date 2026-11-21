import { createHash, randomUUID } from "node:crypto";
import { BrowserWindow, type IpcMainInvokeEvent, ipcMain } from "electron";
import { IPC_COMMANDS, IPC_EVENTS, type RemoteTabTarget } from "../shared/ipc-types";
import type { RemoteAuthPrompt, RemoteProfile, RemoteResult } from "../shared/remote-ipc";
import {
	parseRemoteClientFrame,
	REMOTE_PROTOCOL_VERSION,
	REMOTE_REQUIRED_CAPABILITIES,
	type RemoteActionCommand,
	type RemoteInstance,
} from "../shared/remote-wire";
import { codeOf, RemoteConnection } from "./remote-connection";
import type { RemoteJournal } from "./remote-journal";
import { createRemoteSshAttempt, type RemoteSshAttempt, RemoteSshError } from "./remote-ssh";
import type { SidecarPool } from "./sidecar-pool";
import type { WindowManager } from "./window";

interface RemotePreferences {
	readProfiles(): unknown;
	writeProfiles(rows: readonly RemoteProfile[]): void;
	readEpoch(key: string): string | undefined;
	writeEpoch(key: string, epoch: string): void;
}

interface Discovery {
	id: string;
	profile: RemoteProfile;
	controller: AbortController;
	selection?: { instances: readonly RemoteInstance[]; ssh: RemoteSshAttempt };
	expires?: NodeJS.Timeout;
}

interface Prompt {
	id: string;
	attemptId: string;
	answer(value: string | null): void;
}

interface WindowState {
	discovery?: Discovery;
	prompts: Map<string, Prompt>;
}

function identifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0\r\n]/.test(value);
}

function optionalCursor(value: unknown): string | undefined {
	if (value === undefined || identifier(value)) return value;
	throw new RemoteSshError("invalid_request");
}

function profileFor(target: string): RemoteProfile {
	return { id: createHash("sha256").update(target).digest("hex"), target };
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

const MAX_PROFILES = 64;
const DISCOVERY_SELECTION_TIMEOUT_MS = 90_000;

export function registerRemoteIpc(
	pool: SidecarPool,
	windows: WindowManager,
	journal: RemoteJournal,
	prefs: RemotePreferences,
): void {
	const state = new WeakMap<BrowserWindow, WindowState>();
	const connections = new Map<string, RemoteConnection>();

	function cleanupDiscovery(owner: WindowState, discovery: Discovery): void {
		if (owner.discovery === discovery) owner.discovery = undefined;
		clearTimeout(discovery.expires);
		discovery.controller.abort();
		if (discovery.selection) void discovery.selection.ssh.close().catch(() => {});
	}

	function windowState(win: BrowserWindow): WindowState {
		const value = state.get(win);
		if (value) return value;
		const created: WindowState = { prompts: new Map() };
		state.set(win, created);
		win.once("closed", () => {
			if (created.discovery) cleanupDiscovery(created, created.discovery);
			for (const prompt of created.prompts.values()) prompt.answer(null);
			created.prompts.clear();
		});
		return created;
	}

	function owner(event: IpcMainInvokeEvent): BrowserWindow | null {
		if (process.platform !== "darwin" || !event.senderFrame || event.senderFrame !== event.sender.mainFrame)
			return null;
		const win = BrowserWindow.fromWebContents(event.sender);
		return win && !win.isDestroyed() && windows.recordFor(win) ? win : null;
	}

	function handle<T>(channel: string, operation: (win: BrowserWindow, ...args: unknown[]) => Promise<T> | T): void {
		ipcMain.handle(channel, async (event, ...args): Promise<RemoteResult<T>> => {
			const win = owner(event);
			if (!win) return { ok: false, code: "unsupported" };
			try {
				return { ok: true, data: await operation(win, ...args) };
			} catch (error) {
				return { ok: false, code: codeOf(error) };
			}
		});
	}

	function promptFor(win: BrowserWindow, target: string, attemptId: string, showPrompt: boolean) {
		return async (details: { prompt: string; confirm: boolean }, signal: AbortSignal): Promise<string | null> => {
			if (signal.aborted || win.isDestroyed()) return null;
			if (!showPrompt) throw new RemoteSshError(details.confirm ? "host_key_unknown" : "auth_failed");
			const { prompts } = windowState(win);
			const promptId = randomUUID();
			const reply = Promise.withResolvers<string | null>();
			const cancel = () => reply.resolve(null);
			prompts.set(promptId, { id: promptId, attemptId, answer: reply.resolve });
			signal.addEventListener("abort", cancel, { once: true });
			const payload: RemoteAuthPrompt = { attemptId, promptId, target, ...details };
			win.webContents.send(IPC_EVENTS.REMOTE_AUTH, payload);
			try {
				return await reply.promise;
			} finally {
				signal.removeEventListener("abort", cancel);
				prompts.delete(promptId);
				if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.REMOTE_AUTH_CLOSED, promptId);
			}
		};
	}

	function profiles(): RemoteProfile[] {
		const raw = prefs.readProfiles();
		return Array.isArray(raw)
			? raw.slice(0, MAX_PROFILES).flatMap(value => {
					const entry = asRecord(value);
					return typeof entry.target === "string" &&
						/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(entry.target) &&
						identifier(entry.target)
						? [profileFor(entry.target)]
						: [];
				})
			: [];
	}

	function connection(win: BrowserWindow, id: unknown): RemoteConnection {
		if (!identifier(id) || !pool.remoteForTab(win, id)) throw new RemoteSshError("invalid_request");
		const result = connections.get(id);
		if (!result) throw new RemoteSshError("disconnected");
		return result;
	}

	function attach(
		win: BrowserWindow,
		tabId: string,
		target: RemoteTabTarget,
		instance: RemoteInstance,
	): RemoteConnection {
		const epochKey = createHash("sha256")
			.update(JSON.stringify([target.profileId, target.instanceKey, target.workspace]))
			.digest("hex");
		const remote = new RemoteConnection(tabId, target, instance, journal, {
			winAlive: () => !win.isDestroyed() && pool.remoteForTab(win, tabId) !== null,
			publish: event => {
				if (win.isDestroyed() || !pool.remoteForTab(win, tabId)) return;
				if (event.type === "status") {
					if (event.state === "disconnected")
						pool.adoptRemoteState(win, tabId, { status: event.code ? "error" : "asleep", running: false });
					else if (event.state === "connecting")
						pool.adoptRemoteState(win, tabId, { status: "starting", running: false });
					else if (event.state === "connected") pool.adoptRemoteState(win, tabId, { status: "ready" });
				} else if (event.type === "snapshot") {
					pool.adoptRemoteState(win, tabId, { running: event.snapshot.runId !== null });
				} else if (event.type === "delta") {
					const type = asRecord(event.event).type;
					if (type === "agent_start" || type === "agent_end")
						pool.adoptRemoteState(win, tabId, { running: type === "agent_start" });
				}
				win.webContents.send(IPC_EVENTS.REMOTE_TAB, event);
			},
			persist: (epoch, sessionId) => {
				if (win.isDestroyed() || !pool.remoteForTab(win, tabId)) return;
				if (prefs.readEpoch(epochKey) !== epoch) prefs.writeEpoch(epochKey, epoch);
				if (pool.remoteForTab(win, tabId)?.target.sessionId !== sessionId)
					pool.adoptRemoteState(win, tabId, { sessionId });
			},
			lastEpoch: () => prefs.readEpoch(epochKey),
			ssh: (signal, showPrompt) => ({
				signal,
				askpass: promptFor(win, target.target, randomUUID(), showPrompt),
			}),
		});
		pool.adoptRemoteHandle(win, tabId, {
			disconnect: () => {
				remote.disconnect();
				connections.delete(tabId);
			},
		});
		connections.set(tabId, remote);
		return remote;
	}

	ipcMain.handle(IPC_COMMANDS.REMOTE_PROFILES, event => (owner(event) ? profiles() : []));
	handle(IPC_COMMANDS.REMOTE_DISCOVER, async (win, rawTarget, id) => {
		if (typeof rawTarget !== "string" || !identifier(id)) throw new RemoteSshError("invalid_request");
		const profile = profileFor(rawTarget.trim());
		const data = windowState(win);
		if (data.discovery) cleanupDiscovery(data, data.discovery);
		const discovery: Discovery = { id, profile, controller: new AbortController() };
		data.discovery = discovery;
		let ssh: RemoteSshAttempt | undefined;
		try {
			ssh = await createRemoteSshAttempt(profile.target);
			const signal = discovery.controller.signal;
			const instances = await ssh.discover({ signal, askpass: promptFor(win, profile.target, id, true) });
			if (signal.aborted || data.discovery !== discovery || win.isDestroyed())
				throw new RemoteSshError("auth_cancelled");
			discovery.selection = { instances, ssh };
			discovery.expires = setTimeout(() => cleanupDiscovery(data, discovery), DISCOVERY_SELECTION_TIMEOUT_MS);
			discovery.expires.unref();
			return { profile, instances };
		} catch (error) {
			cleanupDiscovery(data, discovery);
			if (ssh) void ssh.close().catch(() => {});
			throw error;
		}
	});
	ipcMain.handle(IPC_COMMANDS.REMOTE_CANCEL_DISCOVERY, (event, id: unknown) => {
		const win = owner(event);
		const data = win ? state.get(win) : undefined;
		if (data?.discovery && data.discovery.id === id) cleanupDiscovery(data, data.discovery);
	});
	handle(IPC_COMMANDS.REMOTE_CONNECT, (win, id, instanceKey) => {
		const data = windowState(win);
		const discover = data.discovery;
		if (!discover || discover.id !== id || !discover.selection) throw new RemoteSshError("no_instance");
		const instance = discover.selection.instances.find(row => row.instanceKey === instanceKey);
		if (!instance) throw new RemoteSshError("identity_mismatch");
		if (
			!instance.versions.includes(REMOTE_PROTOCOL_VERSION) ||
			!REMOTE_REQUIRED_CAPABILITIES.every(capability => instance.capabilities.includes(capability))
		)
			throw new RemoteSshError("protocol_incompatible");
		const { profile, selection } = discover;
		prefs.writeProfiles([profile, ...profiles().filter(row => row.id !== profile.id)].slice(0, MAX_PROFILES));
		clearTimeout(discover.expires);
		data.discovery = undefined;
		discover.controller.abort();
		const target = {
			profileId: profile.id,
			target: profile.target,
			instanceKey: instance.instanceKey,
			workspace: instance.workspace,
		};
		const tabId = pool.acquireRemote(win, target, { disconnect: () => connections.get(tabId)?.disconnect() });
		const remote = attach(win, tabId, target, instance);
		void remote.connect(selection.ssh).catch(() => {});
		return { tabId };
	});
	handle(IPC_COMMANDS.REMOTE_RECONNECT, async (win, rawId) => {
		if (!identifier(rawId)) throw new RemoteSshError("invalid_request");
		const remote = pool.remoteForTab(win, rawId);
		if (!remote) throw new RemoteSshError("invalid_request");
		const { target } = remote;
		const instance: RemoteInstance = {
			name: "",
			workspace: target.workspace,
			instanceKey: target.instanceKey,
			versions: [REMOTE_PROTOCOL_VERSION],
			capabilities: REMOTE_REQUIRED_CAPABILITIES,
		};
		await (connections.get(rawId) ?? attach(win, rawId, target, instance)).connect();
		return null;
	});
	ipcMain.handle(IPC_COMMANDS.REMOTE_DISCONNECT, (event, tabId: unknown) => {
		const win = owner(event);
		if (win && identifier(tabId) && pool.remoteForTab(win, tabId)) connections.get(tabId)?.disconnect();
	});
	handle(IPC_COMMANDS.REMOTE_SYNC, (win, id) => connection(win, id).sync());
	handle(IPC_COMMANDS.REMOTE_SESSIONS, (win, id, cursor) => connection(win, id).sessions(optionalCursor(cursor)));
	handle(IPC_COMMANDS.REMOTE_MODELS, (win, id, view) => {
		if (!identifier(view)) throw new RemoteSshError("invalid_request");
		return connection(win, id).models(view);
	});
	handle(IPC_COMMANDS.REMOTE_HISTORY, (win, id, view, cursor) => {
		if (!identifier(view)) throw new RemoteSshError("invalid_request");
		return connection(win, id).history(view, optionalCursor(cursor));
	});
	handle(IPC_COMMANDS.REMOTE_OUTPUT, (win, id, view, outputId, cursor) => {
		if (!identifier(view) || !identifier(outputId)) throw new RemoteSshError("invalid_request");
		return connection(win, id).output(view, outputId, optionalCursor(cursor));
	});
	handle(IPC_COMMANDS.REMOTE_READ_DOCUMENT, (win, id, rawScope, path) => {
		const { epoch, sessionId } = asRecord(rawScope);
		if (
			!identifier(epoch) ||
			!identifier(sessionId) ||
			typeof path !== "string" ||
			!parseRemoteClientFrame({ type: "request", id: "validate", op: "read_document", data: { path } })
		)
			throw new RemoteSshError("invalid_request");
		return connection(win, id).readDocument({ epoch, sessionId }, path);
	});
	handle(IPC_COMMANDS.REMOTE_ACTION, (win, id, rawScope, command) => {
		const { epoch, sessionId } = asRecord(rawScope);
		if (
			!identifier(epoch) ||
			!identifier(sessionId) ||
			!parseRemoteClientFrame({
				type: "request",
				id: "validate",
				op: "action",
				data: { lease: 1, epoch, sessionId, actionId: "validate", command },
			})
		)
			throw new RemoteSshError("invalid_request");
		return connection(win, id).action({ epoch, sessionId }, command as RemoteActionCommand);
	});
	ipcMain.handle(IPC_COMMANDS.REMOTE_ANSWER_AUTH, (event, attemptId: unknown, id: unknown, answer: unknown) => {
		const win = owner(event);
		if (
			!win ||
			!identifier(id) ||
			!identifier(attemptId) ||
			(answer !== null && (typeof answer !== "string" || answer.length > 4096 || /[\r\n\0]/.test(answer)))
		)
			return;
		const prompt = state.get(win)?.prompts.get(id);
		if (prompt?.attemptId === attemptId) prompt.answer(answer);
	});
}
