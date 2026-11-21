import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RemoteTabTarget } from "../../../shared/ipc-types";
import type { RemoteActionScope, RemoteResult } from "../../../shared/remote-ipc";
import type { RemoteDocumentResult } from "../../../shared/remote-wire";
import { I18nProvider, translate } from "../../lib/i18n";
import { remoteErrorText } from "./RemoteConnect";
import { RemoteDocumentPreview, type RemoteDocumentReader } from "./RemoteDocumentPreview";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

// The dialog is a Modal: it portals to document.body and focuses its panel.
let activeElement: HTMLElement | null = null;
Object.defineProperty(document, "activeElement", {
	configurable: true,
	get: () => activeElement,
});

/** Structural stand-in for linkedom nodes, keeping tests decoupled from its types. */
interface TestElement {
	textContent: string | null;
	getAttribute: (name: string) => string | null;
}

function one(selector: string): TestElement | null {
	return document.querySelector(selector) as unknown as TestElement | null;
}

function all(selector: string): TestElement[] {
	return Array.from(document.querySelectorAll(selector) as unknown as ArrayLike<TestElement>);
}

const TARGET: RemoteTabTarget = {
	profileId: "profile-1",
	target: "dev.example",
	instanceKey: "f".repeat(64),
	workspace: "/srv/remote/workspace",
};

const SCOPE: RemoteActionScope = { epoch: "epoch-1", sessionId: "session-1" };

function documentResult(
	path: string,
	content: string,
	mediaType: RemoteDocumentResult["mediaType"] = "text/plain",
): RemoteResult<RemoteDocumentResult> {
	return { ok: true, data: { content, mediaType, path } };
}

/** Reads resolved by the test, one gate per requested path. */
interface Gated {
	gates: Map<string, PromiseWithResolvers<RemoteResult<RemoteDocumentResult>>>;
	read: Mock<RemoteDocumentReader>;
}

function gated(): Gated {
	const gates = new Map<string, PromiseWithResolvers<RemoteResult<RemoteDocumentResult>>>();
	const read = vi.fn<RemoteDocumentReader>((_tabId, _scope, path) => {
		const pending = Promise.withResolvers<RemoteResult<RemoteDocumentResult>>();
		gates.set(path, pending);
		return pending.promise;
	});
	return { gates, read };
}

function gate(gatedRead: Gated, path: string): PromiseWithResolvers<RemoteResult<RemoteDocumentResult>> {
	const found = gatedRead.gates.get(path);
	if (!found) throw new Error(`No read issued for ${path}`);
	return found;
}

function preview(props: { gated: Gated; path: string; scope?: RemoteActionScope }): ReactElement {
	return (
		<RemoteDocumentPreview
			onClose={() => {}}
			path={props.path}
			read={props.gated.read}
			scope={props.scope ?? SCOPE}
			tabId="tab-1"
			target={TARGET}
		/>
	);
}

let container: HTMLElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await render(element);
}

async function render(element: ReactElement): Promise<void> {
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

/** Resolve one read and let the resulting state update paint. */
async function settle(
	pending: PromiseWithResolvers<RemoteResult<RemoteDocumentResult>>,
	value: RemoteResult<RemoteDocumentResult>,
): Promise<void> {
	await act(async () => {
		pending.resolve(value);
	});
	await flush();
}

beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
		activeElement = this;
	});
});

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	document.body.innerHTML = "";
	activeElement = null;
	vi.restoreAllMocks();
});

describe("RemoteDocumentPreview", () => {
	it("loads once and shows the remote body as literal text, not as markup", async () => {
		const gatedRead = gated();
		await mount(preview({ gated: gatedRead, path: "notes.txt" }));

		expect(gatedRead.read).toHaveBeenCalledTimes(1);
		expect(gatedRead.read).toHaveBeenCalledWith("tab-1", SCOPE, "notes.txt");
		expect(one("[role='status']")).not.toBeNull();
		expect(one("pre")).toBeNull();

		await settle(gate(gatedRead, "notes.txt"), documentResult("notes.txt", "# not a heading\n\nplain 42"));

		expect(one("[role='status']")).toBeNull();
		expect(one("pre")?.textContent).toBe("# not a heading\n\nplain 42");
		expect(one("h1")).toBeNull();
	});

	it("drops a stale reply when the path moved on, keeping the current document", async () => {
		const gatedRead = gated();
		await mount(preview({ gated: gatedRead, path: "a.txt" }));
		await render(preview({ gated: gatedRead, path: "b.txt" }));

		expect(gatedRead.read).toHaveBeenCalledTimes(2);
		// The superseded load went back to loading, never to the first body.
		expect(one("[role='status']")).not.toBeNull();

		await settle(gate(gatedRead, "b.txt"), documentResult("b.txt", "current document"));
		expect(one("pre")?.textContent).toBe("current document");

		// The abandoned request lands late: it must not repaint the dialog.
		await settle(gate(gatedRead, "a.txt"), documentResult("a.txt", "stale document"));
		expect(one("pre")?.textContent).toBe("current document");
		expect(document.body.textContent).not.toContain("stale document");
	});

	it("reads once per document: new callback identities never re-read, a new session does", async () => {
		const first = gated();
		const second = gated();
		await mount(preview({ gated: first, path: "notes.txt" }));

		// Same tab/session/path with fresh `read` and `scope` object identities.
		await render(preview({ gated: first, path: "notes.txt", scope: { ...SCOPE } }));
		expect(first.read).toHaveBeenCalledTimes(1);
		await render(preview({ gated: second, path: "notes.txt", scope: { ...SCOPE } }));
		expect(second.read).not.toHaveBeenCalled();
		expect(first.read).toHaveBeenCalledTimes(1);

		// A new epoch is a different document on a different session: re-read.
		await render(preview({ gated: second, path: "notes.txt", scope: { epoch: "epoch-2", sessionId: "session-2" } }));
		expect(second.read).toHaveBeenCalledTimes(1);
		expect(second.read).toHaveBeenCalledWith("tab-1", { epoch: "epoch-2", sessionId: "session-2" }, "notes.txt");

		// Only the newer answer reaches the screen.
		await settle(gate(second, "notes.txt"), documentResult("notes.txt", "second epoch body"));
		expect(one("pre")?.textContent).toBe("second epoch body");
	});

	it("renders markdown through the remote pipeline, inert on this machine", async () => {
		const gatedRead = gated();
		await mount(preview({ gated: gatedRead, path: "notes.md" }));
		await settle(
			gate(gatedRead, "notes.md"),
			documentResult(
				"notes.md",
				"# Title\n\n**bold** body\n\n![shot](https://evil.example/a.png)\n\n[next](./other.md)\n\n`src/main.ts`",
				"text/markdown",
			),
		);

		// Markdown parsed, through the shared sanitized renderer.
		expect(one("h1")?.textContent).toBe("Title");
		expect(all("strong").map(node => node.textContent)).toEqual(["bold"]);
		expect(document.body.textContent).not.toContain("**bold**");
		// …with no web or local resource load, and no link that could open a
		// local path or recurse into another preview.
		expect(one("img")).toBeNull();
		expect(one("a")).toBeNull();
		// Markdown goes through the markdown path, not the plain-text <pre>.
		expect(one("pre")).toBeNull();
	});

	it("shows the shared remote error copy for an explicit rejection", async () => {
		const gatedRead = gated();
		await mount(preview({ gated: gatedRead, path: "gone.txt" }));
		await settle(gate(gatedRead, "gone.txt"), { ok: false, code: "disconnected" });

		const alert = one("[role='alert']");
		expect(alert?.textContent).toBe(remoteErrorText(translate, "disconnected"));
		expect(alert?.textContent).toBeTruthy();
		expect(alert?.textContent).not.toBe(remoteErrorText(translate, "internal_error"));
		expect(one("pre")).toBeNull();
		expect(one("[role='status']")).toBeNull();
	});

	it("ends the load when the transport itself rejects, instead of spinning", async () => {
		const read = vi.fn().mockRejectedValue(new Error("channel closed"));
		await mount(
			<RemoteDocumentPreview
				onClose={() => {}}
				path="notes.txt"
				read={read}
				scope={SCOPE}
				tabId="tab-1"
				target={TARGET}
			/>,
		);
		await flush();

		expect(one("pre")).toBeNull();
		expect(one("[role='status']")).toBeNull();
		expect(one("[role='alert']")?.textContent).toBe(remoteErrorText(translate, "internal_error"));
	});

	it("names the remote host and the normalized response path, with no local-path action", async () => {
		const gatedRead = gated();
		await mount(preview({ gated: gatedRead, path: "./notes/../notes/a.txt" }));
		await settle(gate(gatedRead, "./notes/../notes/a.txt"), documentResult("notes/a.txt", "body"));

		const titles = all("[title]").map(node => node.getAttribute("title") ?? "");
		expect(titles.some(title => title.includes("dev.example") && title.endsWith(":notes/a.txt"))).toBe(true);
		// The requested spelling is never shown once the reply normalized it, and
		// nothing local was resolved from it.
		expect(titles.some(title => title.includes("../"))).toBe(false);
		// Only the dialog's own dismiss controls exist — no Reveal/Open-beside action.
		expect(all("button").length).toBe(2);
		expect(one("a")).toBeNull();
	});
});
