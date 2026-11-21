import type {
	RemoteActionCommand,
	RemoteDocumentResult,
	RemoteErrorCode,
	RemoteHistoryPage,
	RemoteInstance,
	RemoteOutputPage,
	RemoteReceipt,
	RemoteSessionPage,
	RemoteSnapshot,
} from "./remote-wire";

export type RemoteResult<T> = { ok: true; data: T } | { ok: false; code: RemoteErrorCode };

export interface RemoteProfile {
	id: string;
	target: string;
}

export interface RemoteDiscovery {
	profile: RemoteProfile;
	instances: readonly RemoteInstance[];
}

export interface RemoteActionScope {
	epoch: string;
	sessionId: string;
}

export type RemoteTabEvent = { tabId: string; generation: number } & (
	| {
			type: "status";
			state: "disconnected" | "connecting" | "handshake" | "synchronizing" | "connected";
			code?: RemoteErrorCode;
			restarted?: boolean;
	  }
	| { type: "snapshot"; snapshot: RemoteSnapshot }
	| { type: "delta"; epoch: string; sessionId: string; seq: number; event: unknown }
	| { type: "receipts"; unresolved: number }
);

export interface RemoteAuthPrompt {
	attemptId: string;
	promptId: string;
	target: string;
	prompt: string;
	confirm: boolean;
}

export interface RemoteApi {
	profiles(): Promise<readonly RemoteProfile[]>;
	discover(target: string, attemptId: string): Promise<RemoteResult<RemoteDiscovery>>;
	cancelDiscovery(attemptId: string): Promise<void>;
	connect(attemptId: string, instanceKey: string): Promise<RemoteResult<{ tabId: string }>>;
	reconnect(tabId: string): Promise<RemoteResult<null>>;
	disconnect(tabId: string): Promise<void>;
	/** Publish a new snapshot, then only deltas newer than that snapshot, to this window. */
	sync(tabId: string): Promise<RemoteResult<null>>;
	sessions(tabId: string, cursor?: string): Promise<RemoteResult<RemoteSessionPage>>;
	history(tabId: string, view: string, cursor?: string): Promise<RemoteResult<RemoteHistoryPage>>;
	output(tabId: string, view: string, outputId: string, cursor?: string): Promise<RemoteResult<RemoteOutputPage>>;
	readDocument(tabId: string, scope: RemoteActionScope, path: string): Promise<RemoteResult<RemoteDocumentResult>>;
	action(tabId: string, scope: RemoteActionScope, command: RemoteActionCommand): Promise<RemoteResult<RemoteReceipt>>;
	answerAuth(attemptId: string, promptId: string, answer: string | null): Promise<void>;
	onEvent(callback: (event: RemoteTabEvent) => void): () => void;
	onAuth(callback: (prompt: RemoteAuthPrompt) => void): () => void;
	onAuthClosed(callback: (promptId: string) => void): () => void;
}
