import { describe, expect, it } from "vitest";
import { allowsLocalIpc } from "./remote-ipc-policy";

describe("local IPC tab scope", () => {
	const scope = {
		activeTabId: "remote",
		isActiveRemote: true,
		// Identical workspace paths or session names do not determine ownership.
		isLocalTab: (id: string) => id === "local",
		isRemoteTab: (id: string) => id === "remote",
	};

	it("allows an explicitly scoped background local tab, not a remote with the same paths", () => {
		expect(allowsLocalIpc({ ...scope, tabId: "local" })).toBe(true);
		expect(allowsLocalIpc({ ...scope, tabId: "remote" })).toBe(false);
	});

	it("rejects foreign, malformed, and missing scope on a remote active tab", () => {
		expect(allowsLocalIpc({ ...scope, tabId: "foreign" })).toBe(false);
		expect(allowsLocalIpc({ ...scope, tabId: "" })).toBe(false);
		expect(allowsLocalIpc(scope)).toBe(false);
	});

	it("allows legacy local and no-tab welcome requests without accepting explicit unknown tabs", () => {
		expect(allowsLocalIpc({ ...scope, activeTabId: "local", isActiveRemote: false })).toBe(true);
		expect(allowsLocalIpc({ ...scope, activeTabId: null, isActiveRemote: false })).toBe(true);
		expect(allowsLocalIpc({ ...scope, activeTabId: null, isActiveRemote: false, tabId: "foreign" })).toBe(false);
	});
});
