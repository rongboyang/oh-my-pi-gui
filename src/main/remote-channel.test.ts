import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	encodeRemoteFrame,
	parseRemoteClientFrame,
	REMOTE_MAX_FRAME_BYTES,
	REMOTE_REQUIRED_CAPABILITIES,
	type RemoteClientFrame,
} from "../shared/remote-wire";
import { RemoteChannel, type RemoteDelta } from "./remote-channel";

const instance = {
	name: "existing",
	workspace: "/remote/project",
	instanceKey: "a".repeat(64),
	versions: [1],
	capabilities: REMOTE_REQUIRED_CAPABILITIES,
};

function fixture() {
	const stdout = new PassThrough();
	const completed = Promise.withResolvers<void>();
	const requests: RemoteClientFrame[] = [];
	const events: RemoteDelta[] = [];
	const channel = new RemoteChannel(
		{
			stdout,
			send(bytes) {
				const frame = parseRemoteClientFrame(JSON.parse(new TextDecoder().decode(bytes)));
				if (!frame) throw new Error("Invalid client request");
				requests.push(frame);
			},
			completion: completed.promise,
			close() {
				stdout.destroy();
				completed.resolve();
			},
		},
		frame => events.push(frame),
	);
	function reply(index: number, data: unknown) {
		stdout.write(encodeRemoteFrame({ type: "reply", id: requests[index].id, ok: true, data }));
	}
	return { stdout, channel, events, reply };
}

const hello = {
	version: 1,
	epoch: "instance-epoch",
	instanceKey: instance.instanceKey,
	workspace: instance.workspace,
	maxFrameBytes: REMOTE_MAX_FRAME_BYTES,
	capabilities: REMOTE_REQUIRED_CAPABILITIES,
};

describe("remote SSH attach channel", () => {
	it("rejects a syntactically valid hello from the wrong instance", async () => {
		const { channel, reply } = fixture();
		try {
			const handshake = channel.hello(instance);
			reply(0, { ...hello, workspace: "/another/project" });
			await expect(handshake).rejects.toMatchObject({ code: "identity_mismatch" });
		} finally {
			channel.close();
		}
	});

	it("correlates out-of-order replies and decodes a live event split across chunks", async () => {
		const { channel, events, reply, stdout } = fixture();
		try {
			const handshake = channel.hello(instance);
			reply(0, hello);
			await handshake;
			const one = channel.request("sessions", {});
			const two = channel.request("acquire", {});
			const event = {
				type: "event",
				epoch: hello.epoch,
				sessionId: "live",
				seq: 3,
				event: { type: "message_update", text: "你好 🌎" },
			};
			reply(2, { lease: 1 });
			const bytes = encodeRemoteFrame(event);
			stdout.write(bytes.subarray(0, bytes.length - 6));
			stdout.write(bytes.subarray(bytes.length - 6));
			reply(1, { sessions: [{ sessionId: "live" }], cursor: null });
			await expect(one).resolves.toMatchObject({ sessions: [{ sessionId: "live" }] });
			await expect(two).resolves.toEqual({ lease: 1 });
			expect(events).toEqual([event]);
		} finally {
			channel.close();
		}
	});

	it("rejects every pending operation when the peer sends malformed data", async () => {
		const { channel, stdout } = fixture();
		const one = channel.request("sessions", {});
		const two = channel.request("acquire", {});
		stdout.write("{}\n");
		await expect(one).rejects.toMatchObject({ code: "protocol_incompatible" });
		await expect(two).rejects.toMatchObject({ code: "protocol_incompatible" });
		await expect(channel.closed).resolves.toBe("protocol_incompatible");
	});
});
