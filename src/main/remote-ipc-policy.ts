/** Classify a legacy local-only request by its window-scoped tab identity. */
export function allowsLocalIpc(scope: {
	tabId?: unknown;
	activeTabId: string | null;
	isLocalTab: (tabId: string) => boolean;
	isRemoteTab: (tabId: string) => boolean;
	isActiveRemote: boolean;
}): boolean {
	if (scope.tabId !== undefined) {
		return (
			typeof scope.tabId === "string" &&
			scope.tabId.length > 0 &&
			!scope.isRemoteTab(scope.tabId) &&
			scope.isLocalTab(scope.tabId)
		);
	}
	if (scope.isActiveRemote) return false;
	return scope.activeTabId === null || (!scope.isRemoteTab(scope.activeTabId) && scope.isLocalTab(scope.activeTabId));
}
