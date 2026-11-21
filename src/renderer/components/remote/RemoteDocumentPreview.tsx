/**
 * Read-only preview of one document that lives on a remote omp instance.
 *
 * Phase 2: a path carried by a remote transcript, tool result or approval opens
 * here instead of the local file preview. Everything shown came back from that
 * instance over the tab's connection — this dialog performs no local file read,
 * writes no temporary file, caches nothing, and offers no local-path action
 * (Reveal/Show in Finder/Open beside), because the path belongs to the remote
 * workspace and means nothing on this machine. A relative path is forwarded
 * verbatim and resolved by the remote instance against its own bound workspace
 * root; the header then shows the path the reply normalized.
 *
 * Transport stays with the parent: `read` is a callback onto that tab's
 * `read_document` action, so the dialog carries no IPC wiring and can be mounted
 * by any remote surface. Exactly one read runs per (tab, session, path): when
 * the path changes, the effect cleanup logically abandons the previous attempt,
 * so a slow reply for a superseded path can never replace the document the user
 * is looking at now.
 *
 * Markdown renders through the shared MarkdownRenderer with `remote`, which
 * keeps untrusted remote content inert on this machine: no image fetch, no
 * mermaid render, and links stay plain text — never a local file open, a
 * outbound request, or another preview request for a neighbouring path.
 */
import { Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RemoteTabTarget } from "../../../shared/ipc-types";
import type { RemoteActionScope, RemoteResult } from "../../../shared/remote-ipc";
import type { RemoteDocumentResult, RemoteErrorCode } from "../../../shared/remote-wire";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { PREVIEW_SCROLL_LG } from "../../lib/preview";
import { Button, Modal, Spinner } from "../common";
import { remoteErrorText } from "./RemoteConnect";

/** Parent-owned transport onto one tab's `read_document` action: the preview
 * never imports IPC, so any remote surface can host it. */
export type RemoteDocumentReader = (
	tabId: string,
	scope: RemoteActionScope,
	path: string,
) => Promise<RemoteResult<RemoteDocumentResult>>;

export interface RemoteDocumentPreviewProps {
	/** The remote tab this preview reads through. */
	tabId: string;
	/** Immutable connection identity — the dialog names the host it read from. */
	target: RemoteTabTarget;
	/** Session/epoch the read is scoped to; a new one invalidates the document. */
	scope: RemoteActionScope;
	/** Path as the remote side addressed it. Never resolved against a local root. */
	path: string;
	onClose: () => void;
	/** Transport onto `read_document`, supplied by the parent. */
	read: RemoteDocumentReader;
}

type Preview = { kind: "ready"; doc: RemoteDocumentResult } | { kind: "error"; code: RemoteErrorCode };

/** State tagged with the load it belongs to, so a reply can never be shown for
 * a document the user has already navigated away from. */
interface PreviewState {
	key: string;
	preview: Preview;
}

export function RemoteDocumentPreview({ tabId, target, scope, path, onClose, read }: RemoteDocumentPreviewProps) {
	const t = useT();
	const key = `${tabId}\u0000${scope.epoch}\u0000${scope.sessionId}\u0000${path}`;
	// `read` and `scope` are read through a ref on purpose: parents may rebuild
	// the callback or the scope object on every render, and only the identity of
	// the document may trigger a load — never the identity of a prop closure.
	const latest = useRef({ read, scope });
	latest.current = { read, scope };
	const [state, setState] = useState<PreviewState | null>(null);

	useEffect(() => {
		let current = true;
		void (async () => {
			let preview: Preview;
			try {
				const result = await latest.current.read(tabId, latest.current.scope, path);
				preview = result.ok ? { kind: "ready", doc: result.data } : { kind: "error", code: result.code };
			} catch {
				// A rejected transport (dropped tab, thrown IPC) still ends the load:
				// the dialog shows the generic remote failure instead of spinning.
				preview = { kind: "error", code: "internal_error" };
			}
			// Abandoned by cleanup: another document already owns this dialog.
			if (!current) return;
			setState({ key, preview });
		})();
		return () => {
			current = false;
		};
	}, [key, path, tabId]);

	const preview = state?.key === key ? state.preview : null;
	const doc = preview?.kind === "ready" ? preview.doc : undefined;
	// Until the reply lands there is no normalized path to show, so the request
	// stands in; afterwards the response path — the remote workspace's own
	// normalization — is what the user sees.
	const shownPath = doc?.path ?? path;

	return (
		<Modal onClose={onClose} open size="lg" title={t("remote.preview.title")}>
			<div className="flex min-w-0 flex-col gap-3">
				<header className="flex min-w-0 items-start gap-2 text-omp-sm text-(--omp-dim)">
					<Server aria-hidden className="mt-px shrink-0" size={15} />
					<span className="min-w-0 wrap-anywhere" title={`${target.target}:${shownPath}`}>
						{t("remote.preview.location", { path: shownPath, target: target.target })}
					</span>
				</header>
				{!preview && <Spinner label={t("remote.preview.loading")} />}
				{preview?.kind === "error" && (
					<p role="alert" className="text-omp-sm text-(--omp-error)">
						{remoteErrorText(t, preview.code)}
					</p>
				)}
				{doc &&
					(doc.mediaType === "text/markdown" ? (
						<div className={`${PREVIEW_SCROLL_LG} min-w-0 select-text`}>
							<MarkdownRenderer content={doc.content} remote sourcePath={doc.path} />
						</div>
					) : (
						<pre
							className={`${PREVIEW_SCROLL_LG} my-1 select-text whitespace-pre-wrap break-words font-mono text-omp-xs`}
						>
							{doc.content}
						</pre>
					))}
				<footer className="flex justify-end border-t border-(--omp-border-muted) pt-2">
					<Button onClick={onClose} size="sm" variant="secondary">
						{t("common.close")}
					</Button>
				</footer>
			</div>
		</Modal>
	);
}
