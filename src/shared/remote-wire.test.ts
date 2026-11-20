import { describe, expect, it } from "vitest";
import { parseRemoteClientFrame, parseRemoteInstanceList, parseRemoteServerFrame } from "./remote-wire";
import fixture from "./remote-wire.fixture.json";

describe("remote v1 shared wire fixtures", () => {
	it("decodes hello and the missing-required-capability rejection", () => {
		expect(parseRemoteClientFrame(fixture.hello)).toEqual(fixture.hello);
		expect(parseRemoteClientFrame(fixture.helloMissingCapabilities)).toEqual(fixture.helloMissingCapabilities);
		expect(fixture.helloMissingCapabilities.capabilities).not.toContain("receipts");
		expect(fixture.helloRejected.id).toBe(fixture.helloMissingCapabilities.id);
		expect(parseRemoteServerFrame(fixture.helloAccepted)).toEqual(fixture.helloAccepted);
		expect(parseRemoteServerFrame(fixture.helloRejected)).toEqual(fixture.helloRejected);
		expect(fixture.helloRejected.error.code).toBe("protocol_incompatible");
	});

	it("decodes acquisition and initialization with an outstanding approval", () => {
		expect(parseRemoteClientFrame(fixture.acquire)).toEqual(fixture.acquire);
		expect(parseRemoteServerFrame(fixture.acquired)).toEqual(fixture.acquired);
		expect(parseRemoteClientFrame(fixture.sync)).toEqual(fixture.sync);
		expect(parseRemoteServerFrame(fixture.initializingSnapshot)).toEqual(fixture.initializingSnapshot);
		expect(fixture.initializingSnapshot.data.pendingApprovals[0].requestId).toBe("approval-1");
	});

	it("decodes a snapshot followed by the next event in the same epoch and session", () => {
		expect(parseRemoteServerFrame(fixture.runningSnapshot)).toEqual(fixture.runningSnapshot);
		expect(parseRemoteServerFrame(fixture.delta)).toEqual(fixture.delta);
		expect(fixture.delta.epoch).toBe(fixture.runningSnapshot.data.epoch);
		expect(fixture.delta.sessionId).toBe(fixture.runningSnapshot.data.sessionId);
		expect(fixture.delta.seq).toBe(fixture.runningSnapshot.data.seq + 1);
	});

	it("decodes a write and accepted, rejected and unknown receipts", () => {
		expect(parseRemoteClientFrame(fixture.action)).toEqual(fixture.action);
		expect(parseRemoteClientFrame(fixture.receipt)).toEqual(fixture.receipt);
		for (const reply of [fixture.accepted, fixture.succeeded, fixture.rejected, fixture.unknown]) {
			expect(parseRemoteServerFrame(reply)).toEqual(reply);
		}
		expect([
			fixture.accepted.data.status,
			fixture.succeeded.data.status,
			fixture.rejected.data.status,
			fixture.unknown.data.status,
		]).toEqual(["accepted", "succeeded", "rejected", "unknown"]);
	});

	it("rejects writes without fencing or with an unauthorized command", () => {
		const { lease: _lease, ...unfenced } = fixture.action.data;
		expect(parseRemoteClientFrame({ ...fixture.action, data: unfenced })).toBeNull();
		expect(parseRemoteClientFrame({ ...fixture.action, data: { ...fixture.action.data, lease: 0 } })).toBeNull();
		expect(
			parseRemoteClientFrame({
				...fixture.action,
				data: { ...fixture.action.data, command: { type: "exec", command: "pwd" } },
			}),
		).toBeNull();
		expect(parseRemoteClientFrame({ ...fixture.action, data: { ...fixture.action.data, cwd: "/other" } })).toBeNull();
	});

	it("rejects malformed events and replies", () => {
		expect(parseRemoteServerFrame({ ...fixture.delta, seq: -1 })).toBeNull();
		expect(parseRemoteServerFrame({ ...fixture.delta, sessionId: "" })).toBeNull();
		const { event: _event, ...missingEvent } = fixture.delta;
		expect(parseRemoteServerFrame(missingEvent)).toBeNull();
		expect(parseRemoteServerFrame({ type: "reply", id: "hello-1", ok: false, error: {} })).toBeNull();
	});

	it("validates discovery results without importing Core", () => {
		const instances = [
			{
				name: "project",
				instanceKey: fixture.hello.instanceKey,
				workspace: fixture.hello.workspace,
				versions: [1],
				capabilities: fixture.hello.capabilities,
			},
		];
		expect(parseRemoteInstanceList(instances)).toEqual(instances);
		expect(parseRemoteInstanceList([{ ...instances[0], instanceKey: "../bad" }])).toBeNull();
	});
});
