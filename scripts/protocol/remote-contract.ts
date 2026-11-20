import { readFile } from "node:fs/promises";
import * as path from "node:path";

const REMOTE_FILES = ["remote-wire.ts", "remote-wire.fixture.json"] as const;

/** The portable remote contract and its fixtures must be byte-identical in both repositories. */
export async function checkRemoteContract(guiRoot: string, coreRoot: string): Promise<string[]> {
	const errors: string[] = [];
	for (const file of REMOTE_FILES) {
		const guiPath = path.join(guiRoot, "src/shared", file);
		const corePath = path.join(coreRoot, "packages/coding-agent/src/modes/rpc", file);
		let gui: Buffer;
		let core: Buffer;
		try {
			gui = await readFile(guiPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			errors.push(`missing GUI remote protocol source: ${guiPath}`);
			continue;
		}
		try {
			core = await readFile(corePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			errors.push(`missing Core remote protocol source: ${corePath}`);
			continue;
		}
		if (!gui.equals(core)) errors.push(`DRIFT: ${guiPath} differs from ${corePath}`);
	}
	return errors;
}
