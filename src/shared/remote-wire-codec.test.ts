import { describe, expect, it } from "vitest";
import type { RemoteHello } from "./remote-wire";
import {
	encodeRemoteFrame,
	parseRemoteClientFrame,
	parseRemoteHelloResult,
	parseRemoteInstanceList,
	parseRemoteServerFrame,
	parseRemoteSnapshot,
	RemoteFrameDecoder,
} from "./remote-wire";
import fixture from "./remote-wire.fixture.json";

const offer = fixture.hello as RemoteHello;
const ready = fixture.helloAccepted.data;
const snapshot = fixture.runningSnapshot.data;

describe("remote frame codec", () => {
	it("handles split UTF-8 and multiple frames in one chunk", () => {
		const encoder = new TextEncoder();
		const bytes = encoder.encode('{"text":"é🙂"}\n{"n":2}\n');
		const split = bytes.indexOf(0xc3) + 1;
		const decoder = new RemoteFrameDecoder();
		expect(decoder.push(bytes.subarray(0, split))).toEqual([]);
		expect(decoder.push(bytes.subarray(split))).toEqual([{ text: "é🙂" }, { n: 2 }]);
		expect(() => decoder.finish()).not.toThrow();
	});

	it("counts UTF-8 bytes and the newline against the frame limit", () => {
		const value = { text: "é" };
		const bytes = encodeRemoteFrame(value);
		expect(encodeRemoteFrame(value, bytes.length)).toEqual(bytes);
		expect(() => encodeRemoteFrame(value, bytes.length - 1)).toThrow();
		const decoder = new RemoteFrameDecoder(bytes.length);
		expect(decoder.push(bytes)).toEqual([value]);
		expect(() => new RemoteFrameDecoder(bytes.length - 1).push(bytes.subarray(0, -1))).toThrow();
		for (const limit of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => new RemoteFrameDecoder(limit)).toThrow();
			expect(() => encodeRemoteFrame(value, limit)).toThrow();
		}
	});

	it("rejects invalid UTF-8, blank, invalid JSON, and unterminated frames", () => {
		for (const input of [
			new Uint8Array([0xff, 10]),
			new Uint8Array([0xc3, 10]),
			new TextEncoder().encode("  \n"),
			new TextEncoder().encode("{bad}\n"),
		]) {
			const decoder = new RemoteFrameDecoder();
			expect(() => decoder.push(input)).toThrow();
			expect(() => decoder.push(new Uint8Array())).toThrow();
		}
		const decoder = new RemoteFrameDecoder();
		decoder.push(new TextEncoder().encode('{"x":1}'));
		expect(() => decoder.finish()).toThrow();
	});
});

describe("remote response validation", () => {
	it("requires negotiated identity, version, frame size, and capabilities", () => {
		expect(parseRemoteHelloResult(ready, offer)).toEqual(ready);
		for (const changes of [
			{ version: 2 },
			{ instanceKey: "a".repeat(64) },
			{ instanceKey: "A".repeat(64) },
			{ workspace: "/other" },
			{ workspace: "/work/project\nHost: evil" },
			{ epoch: "bad\0epoch" },
			{ maxFrameBytes: 0 },
			{ maxFrameBytes: offer.maxFrameBytes + 1 },
			{ maxFrameBytes: 1.5 },
			{ maxFrameBytes: Number.MAX_SAFE_INTEGER + 1 },
			{ capabilities: ["snapshot", "output", "approvals"] },
		])
			expect(parseRemoteHelloResult({ ...ready, ...changes }, offer)).toBeNull();
		expect(parseRemoteHelloResult(ready, { ...offer, capabilities: ["snapshot"] })).toBeNull();
		expect(parseRemoteHelloResult(ready, { ...offer, versions: [2] })).toBeNull();
	});

	it("rejects hostile discovery, hello, event, and snapshot metadata", () => {
		const instance = {
			name: "host",
			instanceKey: offer.instanceKey,
			workspace: offer.workspace,
			versions: [1],
			capabilities: offer.capabilities,
		};
		expect(parseRemoteInstanceList([instance])).toEqual([instance]);
		for (const changes of [
			{ name: "host\nInjected" },
			{ workspace: "/path\0bad" },
			{ instanceKey: "a".repeat(63) },
			{ instanceKey: "g".repeat(64) },
		]) {
			expect(parseRemoteInstanceList([{ ...instance, ...changes }])).toBeNull();
		}
		expect(parseRemoteClientFrame({ ...offer, workspace: "/path\rheader" })).toBeNull();
		expect(parseRemoteServerFrame({ ...fixture.delta, event: null })).toBeNull();
		expect(parseRemoteServerFrame({ ...fixture.delta, event: [] })).toBeNull();
		expect(parseRemoteSnapshot(snapshot)).toEqual(snapshot);
		for (const changes of [
			{ cwd: "/path\nheader" },
			{ epoch: "bad\0epoch" },
			{ seq: -1 },
			{ seq: 1.5 },
			{ seq: Number.MAX_SAFE_INTEGER + 1 },
			{ phase: "unknown" },
			{ sessionId: "" },
			{ currentTools: {} },
			{ pendingApprovals: null },
			{ historyCursor: 1 },
			{ partialReply: undefined },
		])
			expect(parseRemoteSnapshot({ ...snapshot, ...changes })).toBeNull();
	});
});
