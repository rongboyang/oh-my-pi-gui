import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type Socket } from "node:net";
import path from "node:path";

export interface RemoteAskpassPrompt {
	prompt: string;
	confirm: boolean;
}

export type RemoteAskpassCallback = (prompt: RemoteAskpassPrompt) => Promise<string | null>;

/** A private, attempt-scoped askpass endpoint. No Electron or Node executable is needed by ssh. */
export async function createRemoteAskpass(
	askpass: RemoteAskpassCallback,
	cancel: () => void,
): Promise<{
	env: Record<string, string>;
	close(): Promise<void>;
}> {
	const dir = await fs.mkdtemp("/tmp/omp-ssh-");
	const socketPath = path.join(dir, "s");
	const helper = path.join(dir, "askpass");
	const token = randomBytes(32).toString("hex");
	const sockets = new Set<Socket>();
	let closed = false;
	const server = createServer({ allowHalfOpen: true }, socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		let request = "";
		let received = false;
		socket.on("data", (chunk: Buffer) => {
			if (received) return;
			request += chunk.toString("utf8");
			if (request.length > 16 * 1024) {
				socket.destroy();
				return;
			}
			const newline = request.indexOf("\n");
			if (newline < 0) return;
			received = true;
			const fields = request.slice(0, newline).split(" ");
			if (fields.length !== 3 || fields[0] !== token || !/^(confirm|other)$/.test(fields[1])) {
				socket.destroy();
				return;
			}
			const prompt = Buffer.from(fields[2], "base64").toString("utf8");
			const confirm = fields[1] === "confirm";
			void Promise.resolve()
				.then(() => askpass({ prompt, confirm }))
				.then(
					answer => {
						if (closed || socket.destroyed) return;
						if (answer === null || /[\r\n\0]/.test(answer)) {
							socket.destroy();
							cancel();
							return;
						}
						socket.end(`${answer}\n`);
					},
					() => {
						socket.destroy();
						if (!closed) cancel();
					},
				);
		});
	});
	try {
		// The wrapper transmits the prompt on stdin; answers never appear in argv or files.
		await fs.writeFile(
			helper,
			'#!/bin/sh\nmode=other\nif [ "$SSH_ASKPASS_PROMPT" = confirm ]; then mode=confirm; fi\nprompt=$(printf "%s" "$1" | /usr/bin/base64 | /usr/bin/tr -d "\\n")\nprintf "%s %s %s\\n" "$OMP_ASKPASS_TOKEN" "$mode" "$prompt" | /usr/bin/nc -U "$OMP_ASKPASS_SOCKET" | { IFS= read -r answer || exit 1; printf "%s\\n" "$answer"; }\n',
			{ mode: 0o700 },
		);
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(socketPath, () => {
			server.removeListener("error", listening.reject);
			listening.resolve();
		});
		await listening.promise;
		await fs.chmod(socketPath, 0o600);
	} catch (error) {
		server.close();
		await fs.rm(dir, { recursive: true, force: true });
		throw error;
	}
	return {
		env: {
			SSH_ASKPASS: helper,
			SSH_ASKPASS_REQUIRE: "force",
			DISPLAY: ":0",
			OMP_ASKPASS_SOCKET: socketPath,
			OMP_ASKPASS_TOKEN: token,
		},
		async close() {
			if (closed) return;
			closed = true;
			for (const socket of sockets) socket.destroy();
			const stopped = Promise.withResolvers<void>();
			server.close(() => stopped.resolve());
			await stopped.promise;
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}
