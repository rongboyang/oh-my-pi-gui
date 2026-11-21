type RemoteSessionControl = "new" | "saved";

interface RemoteSessionControlEvent {
	tabId: string;
	command: RemoteSessionControl;
}

declare global {
	interface WindowEventMap {
		"omp:remote-session-control": CustomEvent<RemoteSessionControlEvent>;
	}
}

export function controlRemoteSession(tabId: string, command: RemoteSessionControl): void {
	window.dispatchEvent(new CustomEvent("omp:remote-session-control", { detail: { tabId, command } }));
}
