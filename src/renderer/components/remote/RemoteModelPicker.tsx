import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RemoteErrorCode, RemoteModel, RemoteModels } from "../../../shared/remote-wire";
import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { Button, Input, Modal } from "../common";
import { remoteErrorText } from "./RemoteConnect";

export function RemoteModelPicker({
	tabId,
	view,
	active,
	canSelect,
	select,
}: {
	tabId: string;
	view?: string;
	active: boolean;
	canSelect: boolean;
	select(model: RemoteModel): Promise<boolean>;
}) {
	const t = useT();
	const open = useUiStore(state => state.modelPickerOpen) && active;
	const [query, setQuery] = useState("");
	const [catalog, setCatalog] = useState<RemoteModels>();
	const [error, setError] = useState<RemoteErrorCode>();
	const [selectionFailed, setSelectionFailed] = useState(false);
	const close = () => {
		useUiStore.getState().closeModelPicker();
	};
	useEffect(() => {
		if (view === undefined || !active) return;
		if (open) {
			setQuery("");
			setSelectionFailed(false);
		}
		let current = true;
		void window.omp.remote.models(tabId, view).then(
			result => {
				if (!current) return;
				if (result.ok) setCatalog(result.data);
				setError(result.ok ? undefined : result.code);
			},
			() => {
				if (current) setError("disconnected");
			},
		);
		return () => {
			current = false;
		};
		// Re-read when opening (remote discovery may have completed) and after a confirmed selection closes it.
	}, [active, open, tabId, view]);

	const matches = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return (catalog?.models ?? []).filter(model =>
			`${model.provider} ${model.name} ${model.id}`.toLowerCase().includes(needle),
		);
	}, [catalog, query]);
	const selected = catalog?.current;
	return (
		<>
			<Button
				type="button"
				size="sm"
				variant="secondary"
				aria-label={t("remote.model.select")}
				aria-haspopup="dialog"
				aria-expanded={open}
				disabled={!view}
				onClick={() => useUiStore.getState().openModelPicker()}
			>
				<span className="max-w-36 truncate" title={selected ? `${selected.provider}/${selected.id}` : undefined}>
					{selected?.name ?? t("remote.model.select")}
				</span>
				<ChevronDown size={12} aria-hidden />
			</Button>
			<Modal open={open} onClose={close} title={t("remote.model.select")} size="sm">
				{!view || error ? (
					<p role="alert">
						{error === "unsupported" ? t("remote.model.upgrade") : remoteErrorText(t, error ?? "disconnected")}
					</p>
				) : !catalog ? (
					<p role="status">{t("remote.model.loading")}</p>
				) : (
					<div className="flex flex-col gap-2">
						<Input
							label={t("remote.model.search")}
							value={query}
							onChange={event => setQuery(event.target.value)}
						/>
						{selectionFailed && <p role="alert">{t("remote.model.changeFailed")}</p>}
						{matches.length === 0 && <p role="status">{t("remote.model.empty")}</p>}
						<ul className="max-h-72 space-y-1 overflow-y-auto">
							{matches.map(model => {
								const current = selected?.provider === model.provider && selected.id === model.id;
								return (
									<li key={JSON.stringify([model.provider, model.id])}>
										<Button
											type="button"
											variant={current ? "secondary" : "ghost"}
											aria-pressed={current}
											disabled={!canSelect}
											className="h-auto w-full justify-start break-all px-2 py-1.5 text-left"
											onClick={() => {
												if (current) {
													close();
													return;
												}
												setSelectionFailed(false);
												void select(model).then(ok => {
													if (ok) close();
													else setSelectionFailed(true);
												});
											}}
										>
											<span>
												{model.name}{" "}
												<span className="text-(--omp-muted)">
													{model.provider}/{model.id}
												</span>
											</span>
										</Button>
									</li>
								);
							})}
						</ul>
					</div>
				)}
			</Modal>
		</>
	);
}
