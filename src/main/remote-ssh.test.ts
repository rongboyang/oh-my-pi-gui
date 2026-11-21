import type * as ChildProcess from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { connect } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createRemoteAskpass } from "./remote-askpass";
import {
	createRemoteSshAttempt,
	dialRemoteInstance,
	discoverRemoteInstances,
	RemoteReconnect,
	RemoteSshError,
} from "./remote-ssh";

const fake = vi.hoisted(() => ({
	script: "",
	calls: [] as Array<{ executable: string; args: readonly string[]; env: Record<string, string> }>,
}));
vi.mock("node:child_process", async importOriginal => {
	const original = await importOriginal<typeof ChildProcess>();
	return {
		...original,
		spawn(executable: string, args: string[], options: { env: Record<string, string> }) {
			fake.calls.push({ executable, args, env: options.env });
			return original.spawn(process.execPath, ["-e", args.includes("-O") ? "" : fake.script], {
				stdio: ["pipe", "pipe", "pipe"],
			});
		},
	};
});

const instance = {
	name: "test",
	instanceKey: "a".repeat(64),
	workspace: "/workspace",
	versions: [1],
	capabilities: ["snapshot"],
};
const options = { askpass: async () => null };
afterEach(() => {
	fake.calls.length = 0;
	vi.useRealTimers();
});

it("executes only the fixed list command with isolated SSH options and parses discovery", async () => {
	fake.script = `process.stdout.write(${JSON.stringify(JSON.stringify([instance]))})`;
	expect(await discoverRemoteInstances("alice@example.test", options)).toEqual([instance]);
	expect(fake.calls[0].executable).toBe("/usr/bin/ssh");
	expect(fake.calls[0].args).toEqual([
		"-T",
		"-a",
		"-x",
		"-o",
		"ForwardAgent=no",
		"-o",
		"ClearAllForwardings=yes",
		"-o",
		"PermitLocalCommand=no",
		"-o",
		"ControlMaster=no",
		"-o",
		"ControlPath=none",
		"--",
		"alice@example.test",
		"omp",
		"remote",
		"list",
		"--json",
	]);
	expect(fake.calls[0].env.SSH_ASKPASS_REQUIRE).toBe("force");
});

it("rejects unsafe targets and instance keys without launching a child", async () => {
	for (const target of ["-Fconfig", "host;touch /tmp/x", "host name", "ssh://host", "a@b@c"]) {
		await expect(discoverRemoteInstances(target, options)).rejects.toMatchObject({ code: "invalid_request" });
	}
	await expect(dialRemoteInstance("host", { ...instance, instanceKey: "a;id" }, options)).rejects.toMatchObject({
		code: "invalid_request",
	});
	expect(fake.calls).toHaveLength(0);
});

it("preserves attach bytes and completes after explicit close", async () => {
	fake.script = 'process.stdin.on("data", b => process.stdout.write(b)); setInterval(() => {}, 1000)';
	const stream = await dialRemoteInstance("host", instance, options);
	expect(fake.calls[0].args.slice(-5)).toEqual(["omp", "remote", "attach", "--instance", instance.instanceKey]);
	stream.send(Buffer.from("hello\n"));
	const [bytes] = await once(stream.stdout, "data");
	expect(bytes.toString()).toBe("hello\n");
	stream.close();
	await expect(stream.completion).resolves.toBeUndefined();
});

it("reuses only the authentication socket from the selected attempt and exits that master", async () => {
	const attempt = await createRemoteSshAttempt("user@host");
	try {
		fake.script = `process.stdout.write(${JSON.stringify(JSON.stringify([instance]))})`;
		await expect(attempt.discover(options)).resolves.toEqual([instance]);
		fake.script = 'process.stdin.on("data", b => process.stdout.write(b))';
		const stream = await attempt.dial(instance, options);
		stream.send(new TextEncoder().encode("test\n"));
		await once(stream.stdout, "data");
		const [discover, attach] = fake.calls;
		const socket = discover.args[discover.args.indexOf("-S") + 1];
		expect(attach.args[attach.args.indexOf("-S") + 1]).toBe(socket);
		const directory = socket.slice(0, socket.lastIndexOf("/"));
		expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
		await attempt.close();
		await expect(stream.completion).rejects.toMatchObject({ code: "auth_cancelled" });
		expect(fake.calls[2].args).toEqual(["-S", socket, "-O", "exit", "--", "user@host"]);
		await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(attempt.discover(options)).rejects.toMatchObject({ code: "auth_cancelled" });
	} finally {
		await attempt.close();
	}
});

it.each([
	[3, "", "no_instance"],
	[4, "", "identity_mismatch"],
	[5, "", "protocol_incompatible"],
	[2, "Error: unknown flag: --json\nRun `omp --help` for available flags.", "protocol_incompatible"],
	[127, "", "cli_missing"],
	[255, "Host key verification failed", "host_key_unknown"],
	[255, "REMOTE HOST IDENTIFICATION HAS CHANGED", "host_key_changed"],
	[255, "Permission denied", "auth_failed"],
])("maps exit %i and SSH diagnostics to %s", async (exit, stderr, code) => {
	fake.script = `process.stderr.write(${JSON.stringify(stderr)}); process.exitCode=${exit}`;
	await expect(discoverRemoteInstances("host", options)).rejects.toMatchObject({ code });
});

it("bounds discovery and aborts stalled attempts", async () => {
	fake.script = 'process.stdout.write("x".repeat(9 * 1024 * 1024))';
	await expect(discoverRemoteInstances("host", options)).rejects.toMatchObject({ code: "overflow" });
	fake.script = "setInterval(() => {}, 1000)";
	const controller = new AbortController();
	const pending = discoverRemoteInstances("host", { ...options, signal: controller.signal });
	controller.abort();
	await expect(pending).rejects.toMatchObject({ code: "auth_cancelled" });
	// Exercise the real child-process timeout and termination, not just a mocked timer.
	await expect(discoverRemoteInstances("host", { ...options, timeoutMs: 20 })).rejects.toMatchObject({
		code: "timeout",
	});
});

it("isolates askpass prompts on a private socket without writing answers or putting them in argv", async () => {
	const secret = "sensitive-passphrase";
	const prompts: unknown[] = [];
	const endpoint = await createRemoteAskpass(
		async prompt => {
			prompts.push(prompt);
			return secret;
		},
		() => {},
	);
	try {
		const helper = endpoint.env.SSH_ASKPASS;
		const source = await fs.readFile(helper, "utf8");
		expect(source).not.toContain(secret);
		expect((await fs.stat(helper)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(endpoint.env.OMP_ASKPASS_SOCKET)).mode & 0o777).toBe(0o600);
		const intruder = connect(endpoint.env.OMP_ASKPASS_SOCKET);
		await once(intruder, "connect");
		intruder.end("wrong-token confirm RmluZ2VycHJpbnQ/\n");
		await once(intruder, "close");
		expect(prompts).toEqual([]);
		const socket = connect(endpoint.env.OMP_ASKPASS_SOCKET);
		await once(socket, "connect");
		socket.write(`${endpoint.env.OMP_ASKPASS_TOKEN} confirm ${Buffer.from("Fingerprint?").toString("base64")}\n`);
		let answer = "";
		for await (const chunk of socket) answer += chunk.toString();
		expect(answer).toBe(`${secret}\n`);
		expect(prompts).toEqual([{ prompt: "Fingerprint?", confirm: true }]);
		if (process.platform === "darwin") {
			const { spawn } = await vi.importActual<typeof ChildProcess>("node:child_process");
			const child = spawn(helper, ['Password:\n"quoted"'], {
				env: { ...process.env, ...endpoint.env, SSH_ASKPASS_PROMPT: "" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			child.stdout.on("data", chunk => {
				output += chunk.toString();
			});
			await once(child, "close");
			expect(output).toBe(`${secret}\n`);
			expect(prompts[1]).toEqual({ prompt: 'Password:\n"quoted"', confirm: false });
			expect(child.spawnargs.join(" ")).not.toContain(secret);
		}
	} finally {
		await endpoint.close();
	}
	await expect(fs.stat(endpoint.env.OMP_ASKPASS_SOCKET)).rejects.toThrow();
});

it.skipIf(process.platform !== "darwin")("fails the askpass helper when the prompt is cancelled", async () => {
	const cancel = vi.fn();
	const endpoint = await createRemoteAskpass(async () => null, cancel);
	try {
		const { spawn } = await vi.importActual<typeof ChildProcess>("node:child_process");
		const child = spawn(endpoint.env.SSH_ASKPASS, ["Password:"], {
			env: { ...process.env, ...endpoint.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", chunk => {
			output += chunk.toString();
		});
		const [code] = await once(child, "close");
		expect(code).not.toBe(0);
		expect(output).toBe("");
		expect(cancel).toHaveBeenCalledOnce();
	} finally {
		await endpoint.close();
	}
});

it("does not retry trust failures and invalidates late results on cancellation", async () => {
	const reconnect = new RemoteReconnect();
	const connectAttempt = vi.fn(async () => {
		throw new RemoteSshError("host_key_changed");
	});
	await expect(reconnect.run(connectAttempt)).rejects.toMatchObject({ code: "host_key_changed" });
	expect(connectAttempt).toHaveBeenCalledTimes(1);
	const late = Promise.withResolvers<string>();
	const pending = reconnect.run(() => late.promise);
	reconnect.cancel();
	late.resolve("stale");
	await expect(pending).rejects.toMatchObject({ code: "auth_cancelled" });
});
