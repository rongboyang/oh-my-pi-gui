/**
 * Remote omp connection entry (phase 1: macOS).
 *
 * The bar renders a compact "Connect to remote omp" button directly below the
 * tab strip. Its dialog discovers instances over SSH against saved profiles
 * (window.omp.remote.profiles) or a free-form alias/target, and opens a tab on
 * the chosen instance: discovery runs once per attempt (attemptId =
 * crypto.randomUUID, shared by discover/connect so main reuses the one SSH
 * authentication), exactly one instance connects straight through, and more
 * than one demands an explicit pick — omp never chooses an instance for the
 * user. A successful connect returns { tabId } immediately; the tab itself is
 * mounted through the existing GET_TABS reconcile + switchTab path, and the
 * session pane owns syncing its snapshot.
 *
 * Authentication prompts (first-seen host fingerprint, passwords/passphrases)
 * are answered by RemoteAuthDialog, mounted ONCE at App scope — never inside
 * this dialog — so a restore- or manual-triggered reconnect can still ask the
 * user after the connect dialog has closed. Prompts are scoped by
 * attemptId+promptId (each is answered at most once; onAuthClosed dismisses
 * ones main will no longer accept). Trust prompts show the real OpenSSH
 * confirmation text verbatim: yes answers "yes", rejecting answers null.
 * Credential answers go through the password field only. Prompt text and
 * answers live in component state for the length of the exchange — nothing is
 * logged, persisted, or echoed back.
 *
 * remoteErrorText(t, code) is the single error-text contract shared with the
 * remote session pane, so a code renders the same actionable sentence in both
 * surfaces.
 */
import { Loader2, Plug, Server, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteAuthPrompt, RemoteDiscovery, RemoteProfile } from "../../../shared/remote-ipc";
import type { RemoteErrorCode } from "../../../shared/remote-wire";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabsStore } from "../../stores/tabs";
import { Button, Input, Modal } from "../common";

/** Error codes with dedicated, actionable copy; everything else (protocol
 * corners, preview rejections) resolves to the generic line. */
const DEDICATED_ERROR_CODES: Partial<Record<RemoteErrorCode, true>> = {
	host_key_unknown: true,
	host_key_changed: true,
	cli_missing: true,
	no_instance: true,
	identity_mismatch: true,
	protocol_incompatible: true,
	busy: true,
	stale_lease: true,
	stale_epoch: true,
	stale_session: true,
	stale_run: true,
	auth_cancelled: true,
	auth_failed: true,
	timeout: true,
	disconnected: true,
	unknown_result: true,
	unknown_request: true,
	overflow: true,
};

/** One code → one stable, actionable sentence, shared by every remote surface. */
export function remoteErrorText(
	t: (key: string, params?: Record<string, string | number>) => string,
	code: RemoteErrorCode,
): string {
	return t(code in DEDICATED_ERROR_CODES ? `remote.err.${code}` : "remote.err.generic");
}

type ConnectPhase =
	| { kind: "pick" }
	| { kind: "discovering"; attemptId: string; target: string }
	| { kind: "instances"; attemptId: string; discovery: RemoteDiscovery }
	| { kind: "connecting"; attemptId: string; instanceKey: string }
	| { kind: "error"; code: RemoteErrorCode };

export function RemoteConnect() {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [profiles, setProfiles] = useState<readonly RemoteProfile[]>([]);
	const [target, setTarget] = useState("");
	const [phase, setPhase] = useState<ConnectPhase>({ kind: "pick" });
	/** The attempt whose IPC replies are still authoritative; every async
	 * continuation checks it, so a cancel/close cannot resurrect a dead stage. */
	const attemptRef = useRef<string | null>(null);

	// Phase 1 ships the entry on macOS only; older mains (dev mismatch) may not
	// expose the remote bridge at all. Hide instead of half-rendering.
	const supported = window.omp?.platform === "darwin" && typeof window.omp?.remote?.discover === "function";

	useEffect(() => {
		if (!open) return;
		let active = true;
		void window.omp.remote
			.profiles()
			.then(list => {
				if (active) setProfiles(list);
			})
			.catch(() => {
				if (active) setProfiles([]);
			});
		return () => {
			active = false;
		};
	}, [open]);

	// Closing the window must not strand an SSH attempt waiting on prompts.
	useEffect(
		() => () => {
			if (attemptRef.current) void window.omp.remote?.cancelDiscovery?.(attemptRef.current).catch(() => {});
		},
		[],
	);

	const cancelAttempt = useCallback(() => {
		const attemptId = attemptRef.current;
		attemptRef.current = null;
		if (attemptId) void window.omp.remote.cancelDiscovery(attemptId).catch(() => {});
		setPhase({ kind: "pick" });
	}, []);

	const openInstance = useCallback(async (attemptId: string, instanceKey: string) => {
		setPhase({ kind: "connecting", attemptId, instanceKey });
		const result = await window.omp.remote.connect(attemptId, instanceKey).catch(() => null);
		if (attemptRef.current !== attemptId) return;
		attemptRef.current = null;
		if (!result) {
			setPhase({ kind: "error", code: "disconnected" });
			return;
		}
		if (!result.ok) {
			setPhase({ kind: "error", code: result.code });
			return;
		}
		// main minted the tab; GET_TABS reconciliation picks it up (the
		// instance's identity rides the tab descriptor), then a plain switch
		// routes the view. The pane syncs its own snapshot from there.
		setOpen(false);
		setPhase({ kind: "pick" });
		const tabs = useTabsStore.getState();
		await tabs.reconcileTabs();
		if (useTabsStore.getState().tabs.some(tab => tab.id === result.data.tabId))
			await tabs.switchTab(result.data.tabId);
	}, []);

	const discover = useCallback(
		async (rawTarget: string) => {
			const trimmed = rawTarget.trim();
			if (!trimmed) return;
			const attemptId = crypto.randomUUID();
			attemptRef.current = attemptId;
			setTarget(trimmed);
			setPhase({ kind: "discovering", attemptId, target: trimmed });
			const result = await window.omp.remote.discover(trimmed, attemptId).catch(() => null);
			if (attemptRef.current !== attemptId) return;
			if (!result) {
				attemptRef.current = null;
				setPhase({ kind: "error", code: "disconnected" });
				return;
			}
			if (!result.ok) {
				attemptRef.current = null;
				setPhase({ kind: "error", code: result.code });
				return;
			}
			// One instance is unambiguous and connects straight through; several
			// require the user to name one. An empty aggregate is a real error.
			const instances = result.data.instances;
			if (instances.length === 0) {
				attemptRef.current = null;
				setPhase({ kind: "error", code: "no_instance" });
				return;
			}
			if (instances.length === 1) {
				void openInstance(attemptId, instances[0].instanceKey);
				return;
			}
			setPhase({ kind: "instances", attemptId, discovery: result.data });
		},
		[openInstance],
	);

	const close = useCallback(() => {
		cancelAttempt();
		setOpen(false);
	}, [cancelAttempt]);

	if (!supported) return null;
	const busy = phase.kind === "discovering" || phase.kind === "connecting";
	const connectingKey = phase.kind === "connecting" ? phase.instanceKey : null;
	const instanceLabel = (name: string, workspace: string) =>
		name || workspace.replace(/\/+$/, "").split("/").pop() || workspace;

	return (
		<>
			<div className="flex h-6 shrink-0 items-center justify-end border-b border-[var(--omp-border-muted)] bg-[var(--omp-titlebar-bg)] pr-2.5">
				<button
					type="button"
					onClick={() => setOpen(true)}
					title={t("remote.connect")}
					className="no-drag omp-pressable flex h-5 items-center gap-1 rounded-md px-1.5 text-omp-xs font-medium text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
				>
					<Plug size={11} aria-hidden />
					{t("remote.connect")}
				</button>
			</div>
			<Modal open={open} onClose={close} title={t("remote.dialog.title")} size="sm">
				<div className="flex flex-col gap-3">
					<p className="text-omp-md text-[var(--omp-dim)]">{t("remote.dialog.intro")}</p>
					{/* Stable error slot: appears in place, never resizes the stages above it. */}
					<div aria-live="assertive" className={phase.kind === "error" ? "" : "hidden"}>
						{phase.kind === "error" && (
							<div
								role="alert"
								className="rounded-lg border border-[var(--omp-error)] bg-[var(--omp-error-dim)] px-3 py-2"
							>
								<div className="text-omp-md font-semibold text-[var(--omp-error)]">
									{t("remote.error.title")}
								</div>
								<p className="mt-0.5 text-omp-md text-[var(--omp-text)]">{remoteErrorText(t, phase.code)}</p>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="mt-1.5"
									onClick={() => setPhase({ kind: "pick" })}
								>
									{t("remote.action.retry")}
								</Button>
							</div>
						)}
					</div>
					{phase.kind === "instances" ? (
						<div className="flex flex-col gap-2">
							<div className="text-omp-md font-medium text-[var(--omp-text)]">{t("remote.instances.title")}</div>
							<p className="text-omp-md text-[var(--omp-dim)]">
								{t("remote.instances.hint", { count: phase.discovery.instances.length })}
							</p>
							<ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
								{phase.discovery.instances.map(instance => (
									<li
										key={instance.instanceKey}
										className="flex items-center gap-2 rounded-lg border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] px-3 py-2"
									>
										<Server size={13} aria-hidden className="shrink-0 text-[var(--omp-accent)]" />
										<span className="min-w-0 flex-1">
											<span className="block truncate text-omp-md font-medium text-[var(--omp-text)]">
												{instanceLabel(instance.name, instance.workspace)}
											</span>
											<span className="block truncate font-mono text-omp-xs text-[var(--omp-dim)]">
												{instance.workspace}
											</span>
										</span>
										<Button
											type="button"
											variant="primary"
											size="sm"
											disabled={busy}
											loading={connectingKey === instance.instanceKey}
											onClick={() => void openInstance(phase.attemptId, instance.instanceKey)}
										>
											{t("remote.instance.open")}
										</Button>
									</li>
								))}
							</ul>
						</div>
					) : busy ? (
						<div className="flex items-center justify-between gap-3 py-1">
							<span className="flex min-w-0 items-center gap-2 text-omp-md text-[var(--omp-text)]">
								<Loader2 size={14} aria-hidden className="shrink-0 animate-spin text-[var(--omp-accent)]" />
								<span className="truncate">
									{phase.kind === "connecting"
										? t("remote.discovering", { target: target || phase.instanceKey })
										: t("remote.discovering", { target: phase.target })}
								</span>
							</span>
							<Button type="button" variant="ghost" size="sm" onClick={cancelAttempt}>
								{t("common.cancel")}
							</Button>
						</div>
					) : (
						<div className="flex flex-col gap-3">
							<div>
								<div className="mb-1.5 text-omp-md font-medium text-[var(--omp-text-secondary)]">
									{t("remote.profiles.title")}
								</div>
								{profiles.length === 0 ? (
									<p className="text-omp-md text-[var(--omp-dim)]">{t("remote.profiles.empty")}</p>
								) : (
									<ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
										{profiles.map(profile => (
											<li key={profile.id}>
												<button
													type="button"
													onClick={() => void discover(profile.target)}
													className="omp-pressable flex w-full items-center gap-2 rounded-lg border border-[var(--omp-border)] px-3 py-1.5 text-left hover:bg-[var(--omp-selected-bg)]"
												>
													<Server size={12} aria-hidden className="shrink-0 text-[var(--omp-dim)]" />
													<span className="min-w-0 flex-1 truncate font-mono text-omp-md text-[var(--omp-text)]">
														{profile.target}
													</span>
												</button>
											</li>
										))}
									</ul>
								)}
							</div>
							<form
								className="flex items-end gap-2"
								onSubmit={event => {
									event.preventDefault();
									void discover(target);
								}}
							>
								<div className="min-w-0 flex-1">
									<Input
										label={t("remote.alias.label")}
										placeholder={t("remote.alias.placeholder")}
										value={target}
										mono
										maxLength={256}
										onChange={event => setTarget(event.target.value)}
									/>
								</div>
								<Button type="submit" variant="primary" disabled={!target.trim()}>
									{t("remote.action.connect")}
								</Button>
							</form>
						</div>
					)}
				</div>
			</Modal>
		</>
	);
}

const promptKey = (prompt: RemoteAuthPrompt) => `${prompt.attemptId}/${prompt.promptId}`;

/**
 * App-scope host-key-trust and credential prompt host. Mounted once in App
 * (outside the connect dialog), so prompts raised by restored or manual
 * reconnects — with no dialog open — still reach the user. Answers are
 * exactly "yes" (trust accepted), the typed credential, or null (reject /
 * cancel); answeredRef pins each attemptId+promptId to one answer, and
 * onAuthClosed drops prompts main has stopped waiting on.
 */
export function RemoteAuthDialog() {
	const [queue, setQueue] = useState<readonly RemoteAuthPrompt[]>([]);
	const answeredRef = useRef(new Set<string>());

	useEffect(() => {
		const remote = window.omp?.remote;
		if (typeof remote?.onAuth !== "function") return;
		const offAuth = remote.onAuth(prompt => {
			const key = promptKey(prompt);
			// Each attempt+prompt pair is answered once; duplicates are event-channel
			// replays and must not stack a second dialog.
			if (answeredRef.current.has(key)) return;
			setQueue(current =>
				current.some(entry => promptKey(entry) === key) ? current : [...current, prompt].slice(-8),
			);
		});
		const offClosed = remote.onAuthClosed(promptId => {
			setQueue(current => current.filter(entry => entry.promptId !== promptId));
		});
		return () => {
			offAuth();
			offClosed();
		};
	}, []);

	const answer = useCallback(async (prompt: RemoteAuthPrompt, value: string | null) => {
		const key = promptKey(prompt);
		if (answeredRef.current.has(key)) return;
		answeredRef.current.add(key);
		if (answeredRef.current.size > 32) {
			const oldest = answeredRef.current.values().next().value;
			if (oldest) answeredRef.current.delete(oldest);
		}
		setQueue(current => current.filter(entry => promptKey(entry) !== key));
		// The prompt leaves the UI before the IPC settles — main treats a
		// never-arriving answer as a cancel anyway, and a second dialog for the
		// same prompt would invite a double submit.
		await window.omp.remote.answerAuth(prompt.attemptId, prompt.promptId, value).catch(() => {});
	}, []);

	const current = queue[0];
	return current ? <RemoteAuthForm key={promptKey(current)} current={current} answer={answer} /> : null;
}

function RemoteAuthForm({
	current,
	answer,
}: {
	current: RemoteAuthPrompt;
	answer: (prompt: RemoteAuthPrompt, value: string | null) => Promise<void>;
}) {
	const t = useT();
	const [draft, setDraft] = useState("");
	const trusting = current.confirm;
	return (
		<Modal
			open
			onClose={() => void answer(current, null)}
			title={trusting ? t("remote.auth.trustTitle") : t("remote.auth.title")}
			size="sm"
		>
			<form
				className="flex flex-col gap-3"
				onSubmit={event => {
					event.preventDefault();
					// Enter only commits a typed credential; trust needs a deliberate
					// click on Yes — a stray Return must never accept a host key.
					if (!trusting && draft) void answer(current, draft);
				}}
			>
				<div className="truncate font-mono text-omp-md text-[var(--omp-dim)]">{current.target}</div>
				{trusting ? (
					<p
						data-host-key-prompt=""
						className="select-text whitespace-pre-wrap rounded-lg border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] px-3 py-2 font-mono text-omp-md text-[var(--omp-text)]"
					>
						{current.prompt}
					</p>
				) : (
					<div>
						<Input
							label={current.prompt}
							type="password"
							value={draft}
							autoFocus
							onChange={event => setDraft(event.target.value)}
							hint={t("remote.auth.secretHint")}
						/>
					</div>
				)}
				<div className={cx("flex justify-end gap-2", trusting && "justify-between")}>
					{trusting ? (
						<Button type="button" variant="danger" onClick={() => void answer(current, null)}>
							{t("remote.auth.no")}
						</Button>
					) : (
						<Button type="button" variant="ghost" onClick={() => void answer(current, null)}>
							{t("common.cancel")}
						</Button>
					)}
					{trusting ? (
						<Button
							type="button"
							variant="primary"
							icon={<ShieldCheck size={13} aria-hidden />}
							onClick={() => void answer(current, "yes")}
						>
							{t("remote.auth.yes")}
						</Button>
					) : (
						<Button type="submit" variant="primary" disabled={!draft}>
							{t("remote.auth.answer")}
						</Button>
					)}
				</div>
			</form>
		</Modal>
	);
}
