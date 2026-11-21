import { expect, it } from "vitest";
import { findRemoteDocumentPaths, remoteDocumentPath } from "./remote-document-paths";

it("finds path references in captured output without turning URLs into remote paths", () => {
	const output = "\x1b[32m[docs/guide.md#7ABC]\x1b[0m\n./notes.txt:14 docs/guide.md\nhttps://sample.test/guide.md";
	expect(findRemoteDocumentPaths(output)).toEqual(["docs/guide.md", "./notes.txt"]);
});

it("keeps absolute and relative paths on the remote host and leaves resolution to Core", () => {
	expect(remoteDocumentPath("/remote/workstation/Guide With Space.md#L4")).toBe(
		"/remote/workstation/Guide With Space.md",
	);
	expect(remoteDocumentPath("../another-workspace/private.txt")).toBe("../another-workspace/private.txt");
	for (const value of [
		"https://example.test/readme.md",
		"//example.test/readme.md",
		"artifact://tmp/notes.txt",
		"~/note.md",
	])
		expect(remoteDocumentPath(value)).toBeNull();
});
