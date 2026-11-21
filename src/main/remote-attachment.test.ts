import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	encodeRemoteFrame,
	parseRemoteClientFrame,
	REMOTE_MAX_FRAME_BYTES,
	REMOTE_REQUIRED_CAPABILITIES,
	type RemoteClientFrame,
	type RemoteSnapshot,
} from "../shared/remote-wire";
import { RemoteAttachment } from "./remote-attachment";

const instance = {
	name: "existing",
	workspace: "/remote/project",
	instanceKey: "a".repeat(64),
	versions: [1],
	capabilities: REMOTE_REQUIRED_CAPABILITIES,
};
const epoch = "instance-epoch";
const view: RemoteSnapshot = {
	epoch,
	seq: 8,
	view: "view-a",
	sessionId: "first",
	cwd: instance.workspace,
	phase: "running",
	runId: "run-a",
	partialReply: null,
	currentTools: [],
	pendingApprovals: [],
	historyCursor: null,
};

function fixture() {
	const stdout = new PassThrough();
	const completed = Promise.withResolvers<void>();
	let incoming = Promise.withResolvers<RemoteClientFrame>();
	const applied: string[] = [];
	const attachment = new RemoteAttachment(
		{
			stdout,
			send(bytes) {
				const request = parseRemoteClientFrame(JSON.parse(new TextDecoder().decode(bytes)));
				if (!request) throw new Error("Invalid client request");
				incoming.resolve(request);
			},
			completion: completed.promise,
			close() {
				stdout.destroy();
				completed.resolve();
			},
		},
		{
			handshake() {},
			synchronizing() {},
			snapshot: current => applied.push(`view:${current.sessionId}:${current.seq}`),
			delta: frame => applied.push(`event:${frame.sessionId}:${frame.seq}`),
			receipt: frame => applied.push(`receipt:${frame.sessionId}:${frame.seq}`),
		},
	);
	async function reply(data: unknown, ...events: object[]): Promise<void> {
		const request = await incoming.promise;
		incoming = Promise.withResolvers<RemoteClientFrame>();
		stdout.write(
			Buffer.concat([
				encodeRemoteFrame({ type: "reply", id: request.id, ok: true, data }),
				...events.map(event => encodeRemoteFrame(event)),
			]),
		);
	}
	return {
		attachment,
		applied,
		reply,
		event: (data: object) => stdout.write(encodeRemoteFrame(data)),
		async start() {
			const started = attachment.start(instance);
			await reply({
				version: 1,
				epoch,
				instanceKey: instance.instanceKey,
				workspace: instance.workspace,
				maxFrameBytes: REMOTE_MAX_FRAME_BYTES,
				capabilities: REMOTE_REQUIRED_CAPABILITIES,
			});
			await reply({ lease: 2 });
			return { started };
		},
	};
}

function delta(seq: number, sessionId = "first", type = "message_update") {
	return { type: "event", epoch, sessionId, seq, event: { type } };
}

describe("remote attachment view", () => {
	it("installs the snapshot before applying only newer ordered deltas, including same-packet deltas", async () => {
		const conn = fixture();
		try {
			const { started } = await conn.start();
			await conn.reply(view, delta(8), delta(9), delta(10));
			await started;
			expect(conn.applied).toEqual(["view:first:8", "event:first:9", "event:first:10"]);
		} finally {
			conn.attachment.close();
		}
	});

	it("closes an attachment whose stream has a sequence gap", async () => {
		const conn = fixture();
		const { started } = await conn.start();
		await conn.reply(view);
		await started;
		conn.event(delta(10));
		await expect(conn.attachment.closed).resolves.toBe("disconnected");
		expect(conn.applied).toEqual(["view:first:8"]);
	});

	it("settles a session-changing receipt without applying a different session's delta to the old view", async () => {
		const conn = fixture();
		try {
			const { started } = await conn.start();
			await conn.reply(view);
			await started;
			conn.event(delta(9, "second", "remote_receipt"));
			const resynced = conn.attachment.sync();
			await conn.reply({ ...view, view: "view-b", sessionId: "second", seq: 9 }, delta(10, "second"));
			await resynced;
			expect(conn.applied).toEqual(["view:first:8", "receipt:second:9", "view:second:9", "event:second:10"]);
		} finally {
			conn.attachment.close();
		}
	});
});
