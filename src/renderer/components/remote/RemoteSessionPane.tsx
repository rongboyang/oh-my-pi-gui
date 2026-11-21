import { Cable, CircleStop, RotateCw, Server } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useEffectEvent, useMemo, useReducer, useRef, useState } from "react";
import type { RemoteTabTarget } from "../../../shared/ipc-types";
import type { RemoteActionScope, RemoteTabEvent } from "../../../shared/remote-ipc";
import type { RemoteActionCommand, RemoteErrorCode, RemoteSessionRow } from "../../../shared/remote-wire";
import type { ExtensionUIResponse } from "../../../shared/rpc-types";
import { AnsiText } from "../../lib/ansi";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { PREVIEW_SCROLL_LG } from "../../lib/preview";
import { findRemoteDocumentPaths } from "../../lib/remote-document-paths";
import { toast } from "../../stores/toast";
import { Button } from "../common";
import { RemoteExtensionDialog } from "../dialogs/ExtensionDialog";
import { remoteErrorText } from "./RemoteConnect";
import { RemoteDocumentPreview } from "./RemoteDocumentPreview";
import { RemoteModelPicker } from "./RemoteModelPicker";
import {
	EMPTY_REMOTE_SESSION,
	mergeRemoteMessages,
	parseMessage,
	type RemoteMessage,
	remoteSessionEvent,
	removeRemoteApproval,
} from "./remote-session-state";

const seenTabs = new Set<string>();

interface History {
	view: string;
	rows: readonly RemoteMessage[];
	cursor: string | null;
}

export function RemoteSessionPane({
	tabId,
	target,
	active,
}: {
	tabId: string;
	target: RemoteTabTarget;
	active: boolean;
}) {
	const t = useT();
	const [state, dispatch] = useReducer(
		(current: typeof EMPTY_REMOTE_SESSION, event: RemoteTabEvent | { type: "dismissApproval"; id: string }) =>
			event.type === "dismissApproval"
				? removeRemoteApproval(current, event.id)
				: remoteSessionEvent(current, event),
		EMPTY_REMOTE_SESSION,
	);
	const [history, setHistory] = useState<History | null>(null);
	const [loadingHistory, setLoadingHistory] = useState(false);
	const [draft, setDraft] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<RemoteErrorCode | null>(null);
	const [catalog, setCatalog] = useState<{ rows: readonly RemoteSessionRow[]; cursor: string | null } | null>(null);
	const [selection, setSelection] = useState("");
	const [document, setDocument] = useState<{ path: string; scope: RemoteActionScope; generation: number } | null>(
		null,
	);
	const transcript = useRef<HTMLDivElement>(null);
	const composer = useRef<HTMLTextAreaElement>(null);
	const viewRef = useRef<string | undefined>(undefined);
	const loadId = useRef(0);
	const operationId = useRef(0);
	const nearTail = useRef(true);
	const approvalInFlight = useRef(new Set<string>());
	const snapshot = state.snapshot;
	const view = snapshot?.view;
	viewRef.current = view;
	const connection = state.status?.state ?? "disconnected";
	const statusCode = state.status?.code;
	const connected = connection === "connected" && !!snapshot && !state.gap;
	const sessionId = snapshot?.sessionId;
	const runId = snapshot?.runId;
	const epoch = snapshot?.epoch;
	const generation = state.generation;
	const openDocument = useCallback(
		(path: string) => {
			if (epoch && sessionId) setDocument({ path, scope: { epoch, sessionId }, generation });
		},
		[epoch, sessionId, generation],
	);
	const canWrite = connected && !!sessionId && !submitting && snapshot.phase !== "starting";
	const canPrompt = canWrite && !runId && statusCode !== "stale_session";
	const visibleHistory = useMemo(
		() => mergeRemoteMessages(history?.view === view ? (history?.rows ?? []) : [], state.live),
		[history, state.live, view],
	);
	const toolResults = useMemo(
		() =>
			new Set(visibleHistory.filter(row => row.role === "toolResult" || row.role === "output").map(row => row.key)),
		[visibleHistory],
	);

	useEffect(() => {
		let mounted = true;
		const dispose = window.omp.remote.onEvent(event => {
			if (event.tabId === tabId) dispatch(event);
		});
		const first = !seenTabs.has(tabId);
		seenTabs.add(tabId);
		void window.omp.remote
			.sync(tabId)
			.then(async result => {
				if (mounted && first && !result.ok && result.code === "disconnected") {
					const resumed = await window.omp.remote.reconnect(tabId);
					if (mounted && !resumed.ok) setError(resumed.code);
				}
			})
			.catch(() => mounted && setError("disconnected"));
		return () => {
			mounted = false;
			loadId.current++;
			operationId.current++;
			dispose();
		};
	}, [tabId]);

	const loadHistory = useCallback(
		async (current: string, cursor?: string) => {
			const id = ++loadId.current;
			setLoadingHistory(true);
			try {
				const result = await window.omp.remote.history(tabId, current, cursor);
				if (id !== loadId.current || current !== viewRef.current) return;
				if (!result.ok) {
					if (result.code !== "stale_session") setError(result.code);
					return;
				}
				const rows = result.data.items.flatMap((item, index) => {
					const message = parseMessage(item, `${current}:${cursor ?? "start"}:${index}`);
					return message ? [message] : [];
				});
				setHistory(previous => ({
					view: current,
					rows: cursor && previous?.view === current ? mergeRemoteMessages(previous.rows, rows) : rows,
					cursor: result.data.cursor,
				}));
			} catch {
				if (id === loadId.current) setError("disconnected");
			} finally {
				if (id === loadId.current) setLoadingHistory(false);
			}
		},
		[tabId],
	);

	useEffect(() => {
		if (view) void loadHistory(view);
	}, [view, loadHistory]);

	useEffect(() => {
		if (state.gap)
			void window.omp.remote.sync(tabId).then(result => {
				if (!result.ok) setError(result.code);
			});
	}, [state.gap, tabId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: stick to the tail when rendered transcript content grows.
	useEffect(() => {
		const pane = transcript.current;
		if (nearTail.current && pane) pane.scrollTop = pane.scrollHeight;
	}, [visibleHistory, state.partial, state.tools]);

	async function changeConnection(): Promise<void> {
		setError(null);
		if (connection !== "disconnected") {
			await window.omp.remote.disconnect(tabId);
			return;
		}
		const result = await window.omp.remote.reconnect(tabId);
		if (!result.ok) setError(result.code);
	}

	async function send(command: RemoteActionCommand): Promise<boolean> {
		if (!snapshot || !sessionId || !connected) return false;
		const response = command.type === "respond";
		if (!response && submitting) return false;
		if (response && approvalInFlight.current.has(command.requestId)) return false;
		const id = response ? operationId.current : ++operationId.current;
		if (response) approvalInFlight.current.add(command.requestId);
		else setSubmitting(true);
		setError(null);
		try {
			const result = await window.omp.remote.action(tabId, { epoch: snapshot.epoch, sessionId }, command);
			if (operationId.current !== id && !response) return false;
			if (!result.ok) {
				setError(result.code);
				if (response && result.code === "unknown_request")
					dispatch({ type: "dismissApproval", id: command.requestId });
				return false;
			}
			if (result.data.status === "rejected") {
				setError(result.data.error.code);
				return false;
			}
			if (result.data.status === "unknown" || (result.data.status === "accepted" && command.type !== "prompt")) {
				setError("unknown_result");
				return false;
			}
			if (
				(command.type === "new_session" || command.type === "open_session") &&
				result.data.status === "succeeded" &&
				result.data.data !== null &&
				typeof result.data.data === "object" &&
				"cancelled" in result.data.data &&
				result.data.data.cancelled === true
			) {
				toast({ variant: "warning", message: t("remote.sessionCancelled") });
				return false;
			}
			if (response && result.data.status === "succeeded")
				dispatch({ type: "dismissApproval", id: command.requestId });
			return true;
		} catch {
			if (operationId.current === id) setError("disconnected");
			return false;
		} finally {
			if (response) approvalInFlight.current.delete(command.requestId);
			else if (operationId.current === id) setSubmitting(false);
		}
	}

	async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		const message = draft.trim();
		if (!canPrompt || !message) return;
		if (await send({ type: "prompt", message })) {
			setDraft(value => (value === draft ? "" : value));
			nearTail.current = true;
		}
	}

	async function listSessions(more = false): Promise<void> {
		if (!connected) return;
		const result = await window.omp.remote.sessions(tabId, more ? (catalog?.cursor ?? undefined) : undefined);
		if (!result.ok) setError(result.code);
		else
			setCatalog(previous => ({
				rows: more && previous ? [...previous.rows, ...result.data.sessions] : result.data.sessions,
				cursor: result.data.cursor,
			}));
	}

	async function changeSession(command: Extract<RemoteActionCommand, { type: "new_session" | "open_session" }>) {
		if (!canWrite || runId) {
			setError(connected ? "busy" : "disconnected");
			return;
		}
		if (await send(command)) {
			setCatalog(null);
			setSelection("");
			setDraft("");
			nearTail.current = true;
			composer.current?.focus();
		}
	}

	const handleSessionControl = useEffectEvent((event: WindowEventMap["omp:remote-session-control"]) => {
		if (event.detail.tabId !== tabId) return;
		if (event.detail.command === "new") void changeSession({ type: "new_session" });
		else if (connected) void listSessions();
		else setError("disconnected");
	});
	useEffect(() => {
		const handle = (event: WindowEventMap["omp:remote-session-control"]) => handleSessionControl(event);
		window.addEventListener("omp:remote-session-control", handle);
		return () => window.removeEventListener("omp:remote-session-control", handle);
	}, []);

	function response(answer: ExtensionUIResponse): void {
		void send({ type: "respond", requestId: answer.id, response: answer });
	}

	const phase = snapshot && connection === "connected" ? snapshot.phase : connection;
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col" data-remote-tab={tabId}>
			<header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--omp-border-muted) px-4 py-2 text-omp-sm">
				<Server aria-hidden size={15} />
				<strong>{t("remote.host", { target: target.target })}</strong>
				<code className="min-w-0 truncate" title={target.workspace}>
					{target.workspace}
				</code>
				<span role="status" className="mr-auto text-(--omp-dim)">
					{t(`remote.phase.${phase}`)}
				</span>
				<Button
					icon={connection === "disconnected" ? <RotateCw size={12} /> : <Cable size={12} />}
					onClick={() => void changeConnection()}
					size="sm"
					variant="ghost"
				>
					{t(connection === "disconnected" ? "remote.reconnect" : "remote.disconnect")}
				</Button>
				<Button
					disabled={!canWrite || !!runId}
					onClick={() => void changeSession({ type: "new_session" })}
					size="sm"
					variant="ghost"
				>
					{t("remote.newSession")}
				</Button>
				<Button
					disabled={!connected}
					onClick={() => (catalog ? setCatalog(null) : void listSessions())}
					size="sm"
					variant="ghost"
				>
					{t("remote.savedSessions")}
				</Button>
			</header>
			{state.status?.restarted && <p className="px-4 pt-2 text-omp-sm text-(--omp-dim)">{t("remote.restarted")}</p>}
			{(error || statusCode) && (
				<p role="alert" className="px-4 pt-2 text-omp-sm text-(--omp-error)">
					{remoteErrorText(t, (error || statusCode)!)}
				</p>
			)}
			{state.unresolved > 0 && (
				<p role="status" className="px-4 pt-2 text-omp-sm text-(--omp-warning)">
					{t("remote.unresolved", { count: state.unresolved })}
				</p>
			)}
			{catalog && (
				<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--omp-border-muted) px-4 py-2 text-omp-sm">
					<label className="min-w-0 flex-1">
						<span className="sr-only">{t("remote.savedSessions")}</span>
						<select
							value={selection}
							onChange={event => setSelection(event.target.value)}
							className="w-full min-w-0 rounded border border-(--omp-border-muted) bg-(--omp-bg) p-1"
						>
							<option value="">
								{t(catalog.rows.length ? "remote.selectSession" : "remote.noSavedSessions")}
							</option>
							{catalog.rows.map(row => (
								<option key={row.sessionId} value={row.sessionId}>
									{row.name ?? row.sessionId} · {new Date(row.updatedAt).toLocaleString()}
								</option>
							))}
						</select>
					</label>
					{catalog.cursor && (
						<Button onClick={() => void listSessions(true)} size="sm" variant="ghost">
							{t("remote.more")}
						</Button>
					)}
					<Button
						disabled={!canWrite || !selection || !!runId}
						onClick={() => void changeSession({ type: "open_session", sessionId: selection })}
						size="sm"
						variant="secondary"
					>
						{t("remote.openSession")}
					</Button>
				</div>
			)}
			<div
				className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
				onScroll={() => {
					const node = transcript.current;
					if (node) nearTail.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
				}}
				ref={transcript}
				role="log"
				aria-live="off"
			>
				<div className="mx-auto max-w-4xl space-y-4">
					{!snapshot && <p className="text-omp-sm text-(--omp-dim)">{t("remote.noSnapshot")}</p>}
					{visibleHistory.map(row => (
						<RemoteMessageRow key={row.key} row={row} tabId={tabId} view={view} openDocument={openDocument} />
					))}
					{history?.view === view && history?.cursor && view && (
						<Button
							disabled={loadingHistory}
							onClick={() => void loadHistory(view, history.cursor ?? undefined)}
							size="sm"
							variant="ghost"
						>
							{t("remote.moreHistory")}
						</Button>
					)}
					{Array.from(state.tools.values(), tool =>
						toolResults.has(`tool:${tool.key}`) || toolResults.has(tool.key) ? null : (
							<RemoteToolCard
								key={tool.key}
								autoLoad={connected && (!tool.done || tool.name === "command_output")}
								label={tool.name === "command_output" ? t("remote.output") : tool.name}
								data={tool.text}
								running={!tool.done}
								failed={tool.failed}
								truncated={tool.truncated}
								outputId={tool.outputId}
								openDocument={openDocument}
								tabId={tabId}
								view={view}
							/>
						),
					)}
					{state.partial && (
						<RemoteMessageRow
							row={state.partial}
							tabId={tabId}
							view={view}
							openDocument={openDocument}
							streaming
						/>
					)}
				</div>
			</div>
			<form
				onSubmit={event => void submit(event)}
				className="flex shrink-0 items-end gap-2 border-t border-(--omp-border-muted) p-3"
			>
				<textarea
					ref={composer}
					className="min-w-0 flex-1 resize-y rounded-md border border-(--omp-border-muted) bg-(--omp-bg-elevated) px-3 py-2 text-omp-md"
					rows={2}
					aria-label={t("remote.prompt")}
					placeholder={t("remote.prompt")}
					value={draft}
					onChange={event => setDraft(event.target.value)}
					onKeyDown={event => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
				/>
				<RemoteModelPicker
					key={`${generation}:${epoch}:${sessionId}`}
					tabId={tabId}
					view={connected ? view : undefined}
					active={active}
					canSelect={!!canPrompt && snapshot.phase === "idle"}
					select={model => send({ type: "set_model", provider: model.provider, modelId: model.id })}
				/>
				{runId && statusCode !== "stale_session" ? (
					<Button
						disabled={!canWrite}
						icon={<CircleStop size={14} />}
						onClick={() => void send({ type: "stop", runId })}
						size="sm"
						variant="secondary"
					>
						{t("remote.stop")}
					</Button>
				) : (
					<Button disabled={!canPrompt || !draft.trim()} type="submit" size="sm" variant="primary">
						{t("remote.send")}
					</Button>
				)}
			</form>
			{active && connected && state.approvals.length > 0 && (
				<RemoteExtensionDialog pending={[...state.approvals]} onResponse={response} />
			)}
			{document &&
				active &&
				document.scope.epoch === epoch &&
				document.scope.sessionId === sessionId &&
				document.generation === generation && (
					<RemoteDocumentPreview
						tabId={tabId}
						target={target}
						scope={document.scope}
						path={document.path}
						read={window.omp.remote.readDocument}
						onClose={() => setDocument(null)}
					/>
				)}
		</div>
	);
}

function RemoteMessageRow({
	row,
	tabId,
	view,
	openDocument,
	streaming,
}: {
	row: RemoteMessage;
	tabId: string;
	view?: string;
	openDocument: (path: string) => void;
	streaming?: boolean;
}) {
	const t = useT();
	if (
		row.role === "toolResult" ||
		row.role === "output" ||
		row.role === "bashExecution" ||
		row.role === "pythonExecution"
	)
		return (
			<RemoteToolCard
				label={row.toolName ?? t("remote.output")}
				data={row.text}
				failed={row.failed}
				truncated={row.truncated}
				outputId={row.outputId}
				openDocument={openDocument}
				tabId={tabId}
				view={view}
			/>
		);
	return (
		<article className={row.role === "user" ? "rounded-lg bg-(--omp-bg-elevated) px-4 py-3" : "px-4 py-2"}>
			<header className="mb-1 text-omp-xs font-medium text-(--omp-dim)">
				{t(row.role === "user" ? "remote.you" : row.role === "assistant" ? "remote.assistant" : "remote.message")}
			</header>
			<MarkdownRenderer
				content={row.text}
				remote
				openRemoteDocument={openDocument}
				streaming={streaming}
				singleDollarTextMath={row.role !== "user"}
			/>
			{row.truncated && <p className="text-omp-xs text-(--omp-dim)">{t("remote.truncated")}</p>}
		</article>
	);
}

function RemoteToolCard({
	autoLoad,
	label,
	data,
	running,
	failed,
	truncated,
	outputId,
	openDocument,
	tabId,
	view,
}: {
	autoLoad?: boolean;
	label: string;
	data: string;
	running?: boolean;
	failed: boolean;
	truncated: boolean;
	outputId?: string;
	openDocument: (path: string) => void;
	tabId: string;
	view?: string;
}) {
	const t = useT();
	const [page, setPage] = useState<{ view: string; data: string; cursor: string | null; truncated: boolean } | null>(
		null,
	);
	const [failure, setFailure] = useState<{ view: string; code: RemoteErrorCode } | null>(null);
	const [loading, setLoading] = useState(false);
	const current = page?.view === view ? page : null;
	const error = failure?.view === view ? failure?.code : undefined;
	const load = useCallback(
		async (cursor?: string): Promise<void> => {
			if (!view || !outputId) return;
			setLoading(true);
			setFailure(null);
			try {
				const result = await window.omp.remote.output(tabId, view, outputId, cursor);
				if (!result.ok) setFailure({ view, code: result.code });
				else
					setPage({ view, data: result.data.data, cursor: result.data.cursor, truncated: result.data.truncated });
			} catch {
				setFailure({ view, code: "disconnected" });
			} finally {
				setLoading(false);
			}
		},
		[tabId, view, outputId],
	);
	useEffect(() => {
		if (!data && autoLoad) void load();
	}, [data, autoLoad, load]);
	const text = current?.data ?? data;
	const documentPaths = useMemo(() => findRemoteDocumentPaths(text), [text]);
	return (
		<div className="rounded-md border border-(--omp-border-muted) bg-(--omp-bg-elevated) px-3 py-2 text-omp-sm">
			<div className="flex flex-wrap items-center gap-2">
				<strong className="font-mono">{label}</strong>
				{running && <span className="text-(--omp-accent)">{t("remote.phase.running")}</span>}
				{failed && <span className="text-(--omp-error)">{t("remote.toolFailed")}</span>}
				{view && outputId && (current === null || current.cursor !== null) && (
					<Button
						disabled={loading}
						onClick={() => void load(current?.cursor ?? undefined)}
						size="sm"
						variant="ghost"
					>
						{t(current ? "remote.moreOutput" : "remote.loadOutput")}
					</Button>
				)}
			</div>
			{text && (
				<pre
					className={`${PREVIEW_SCROLL_LG} my-1 select-text whitespace-pre-wrap break-words font-mono text-omp-xs`}
				>
					<AnsiText links={false} text={text} />
				</pre>
			)}
			{documentPaths.length > 0 && (
				<div aria-label={t("remote.preview.files")} className="flex flex-wrap gap-1">
					{documentPaths.map(path => (
						<Button key={path} onClick={() => openDocument(path)} size="sm" variant="ghost">
							{path}
						</Button>
					))}
				</div>
			)}
			{(current?.truncated ?? truncated) && <p className="text-omp-xs text-(--omp-dim)">{t("remote.truncated")}</p>}
			{error && (
				<p role="alert" className="text-omp-xs text-(--omp-error)">
					{remoteErrorText(t, error)}
				</p>
			)}
		</div>
	);
}
