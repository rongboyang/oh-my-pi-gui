import { expect, it } from "vitest";
import type { RemoteTabEvent } from "../../../shared/remote-ipc";
import type { RemoteSnapshot } from "../../../shared/remote-wire";
import { EMPTY_REMOTE_SESSION, mergeRemoteMessages, parseMessage, remoteSessionEvent } from "./remote-session-state";

const tabId = "ssh-tab";
const confirm = {
	type: "extension_ui_request",
	method: "confirm",
	id: "approval",
	title: "Write?",
	message: "remote workspace",
};
const first: RemoteSnapshot = {
	epoch: "original",
	seq: 5,
	view: "view-original",
	sessionId: "session",
	cwd: "/remote/workspace",
	phase: "waiting",
	runId: "run",
	partialReply: { messageId: "stream", message: { role: "assistant", timestamp: 7, content: "part" } },
	currentTools: [{ toolCallId: "tool-id", toolName: "bash", done: false, outputId: "tool-id" }],
	pendingApprovals: [confirm],
	historyCursor: null,
};

function snapshot(generation: number, capture: RemoteSnapshot): RemoteTabEvent {
	return { type: "snapshot", tabId, generation, snapshot: capture };
}

function delta(seq: number, event: object, generation = 1, epoch = first.epoch): RemoteTabEvent {
	return { type: "delta", tabId, generation, epoch, sessionId: "session", seq, event };
}

it("restores an in-flight reply, its tool reference and approval, then merges completion once", () => {
	let state = remoteSessionEvent(EMPTY_REMOTE_SESSION, snapshot(1, first));
	expect(state.partial?.text).toBe("part");
	expect(state.approvals).toEqual([confirm]);
	expect(state.tools.get("tool-id")).toMatchObject({ done: false, outputId: "tool-id" });
	state = remoteSessionEvent(
		state,
		delta(6, { type: "extension_ui_request", method: "cancel", targetId: "approval" }),
	);
	const end = { role: "assistant", timestamp: 7, content: "partial plus new text" };
	state = remoteSessionEvent(state, delta(7, { type: "message_end", messageId: "stream", message: end }));
	expect(state.approvals).toEqual([]);
	expect(state.snapshot?.phase).toBe("running");
	expect(state.partial).toBeNull();
	const history = parseMessage(end, "history-row");
	if (!history) throw new Error("history entry was discarded");
	expect(mergeRemoteMessages([history], state.live)).toHaveLength(1);
	expect(state.live[0].text).toBe("partial plus new text");
});

it("refuses gaps and does not apply an old attachment's confirmation to a restarted instance", () => {
	let state = remoteSessionEvent(EMPTY_REMOTE_SESSION, snapshot(1, first));
	state = remoteSessionEvent(state, delta(7, { type: "agent_end" }));
	expect(state.gap).toBe(true);
	expect(state.snapshot?.runId).toBe("run");
	const restarted = {
		...first,
		epoch: "restarted",
		seq: 0,
		phase: "idle",
		runId: null,
		pendingApprovals: [],
		partialReply: null,
	} as const;
	state = remoteSessionEvent(state, snapshot(2, restarted));
	state = remoteSessionEvent(state, delta(8, confirm));
	expect(state.gap).toBe(false);
	expect(state.approvals).toEqual([]);
	expect(state.snapshot?.epoch).toBe("restarted");
});
