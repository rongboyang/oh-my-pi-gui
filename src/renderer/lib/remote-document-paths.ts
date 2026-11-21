import { REMOTE_MAX_PATH_LENGTH } from "../../shared/remote-wire";
import { hasAnsi, parseAnsi } from "./ansi";
import { parseFileTarget, trimAddress } from "./link-targets";
import { PREVIEW_TEXT_CHARS } from "./preview";

const MAX_LINKS_PER_OUTPUT = 24;
const FILE_TOKEN = /[^\s<>"'`()[\]{}，。；：！？、]+/g;

/** Select plausible file references without resolving or testing existence on the client. */
export function remoteDocumentPath(value: string): string | null {
	const path = parseFileTarget(value.trim().replace(/#[a-zA-Z0-9-]+$/, "")).path;
	if (
		!path ||
		path.length > REMOTE_MAX_PATH_LENGTH ||
		path.startsWith("//") ||
		path.startsWith("~") ||
		/^[a-z][a-z0-9+.-]*:/i.test(path) ||
		/[\\\0\n\r<>]/.test(path) ||
		!/(?:^|\/)[^./][^/]*\.[a-zA-Z0-9-]{1,16}$/.test(path)
	)
		return null;
	return path;
}

/** A small list of unique candidates in output order. Over-limit bodies are still pageable. */
export function findRemoteDocumentPaths(value: string): string[] {
	const suffix = value.slice(-PREVIEW_TEXT_CHARS);
	const source = hasAnsi(suffix)
		? parseAnsi(suffix)
				.map(segment => segment.text)
				.join("")
		: suffix;
	const paths = new Set<string>();
	for (const match of source.matchAll(FILE_TOKEN)) {
		if (match.index === 0 && value.length > suffix.length) continue;
		const path = remoteDocumentPath(trimAddress(match[0]));
		if (!path) continue;
		paths.add(path);
		if (paths.size === MAX_LINKS_PER_OUTPUT) break;
	}
	return [...paths];
}
