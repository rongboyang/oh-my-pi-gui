import { randomUUID } from "node:crypto";
import type { RemoteTabTarget } from "../shared/ipc-types";
import type { RemoteActionScope } from "../shared/remote-ipc";
import { REMOTE_MAX_PATH_LENGTH, REMOTE_MAX_RECEIPTS, REMOTE_RECEIPT_RETENTION_MS } from "../shared/remote-wire";
import { RemoteSshError } from "./remote-ssh";

export interface RemoteJournalEntry extends RemoteActionScope {
	readonly profileId: string;
	readonly target: string;
	readonly instanceKey: string;
	readonly workspace: string;
	readonly actionId: string;
	readonly savedAt: number;
}

type ReadJournal = () => unknown;
type WriteJournal = (entries: readonly RemoteJournalEntry[]) => void;

/** Durable operation identities for querying receipts; command types/bodies are never stored here. */
export class RemoteJournal {
	#entries: RemoteJournalEntry[];

	constructor(
		read: ReadJournal,
		private readonly write: WriteJournal,
		private readonly now: () => number = Date.now,
	) {
		const raw = read();
		this.#entries = Array.isArray(raw)
			? raw.slice(-REMOTE_MAX_RECEIPTS).flatMap(value => {
					const item = entry(value);
					return item ? [item] : [];
				})
			: [];
	}

	begin(target: RemoteTabTarget, scope: RemoteActionScope): RemoteJournalEntry {
		const item: RemoteJournalEntry = {
			profileId: target.profileId,
			target: target.target,
			instanceKey: target.instanceKey,
			workspace: target.workspace,
			epoch: scope.epoch,
			sessionId: scope.sessionId,
			actionId: randomUUID(),
			savedAt: this.now(),
		};
		const entries = this.#retained();
		if (entries.length >= REMOTE_MAX_RECEIPTS) throw new RemoteSshError("overflow");
		entries.push(item);
		this.#save(entries);
		return item;
	}

	pending(target: RemoteTabTarget): readonly RemoteJournalEntry[] {
		return this.#retained().filter(item => matches(item, target));
	}

	finish(target: RemoteTabTarget, actionId: string, epoch: string): void {
		const entries = this.#entries.filter(
			item => !(item.actionId === actionId && item.epoch === epoch && matches(item, target)),
		);
		if (entries.length !== this.#entries.length) this.#save(entries);
	}

	#retained(): RemoteJournalEntry[] {
		const earliest = this.now() - REMOTE_RECEIPT_RETENTION_MS;
		return this.#entries.filter(item => item.savedAt >= earliest);
	}

	#save(entries: RemoteJournalEntry[]): void {
		// Write first: failure must forbid dispatch rather than losing an action identity.
		this.write(entries);
		this.#entries = entries;
	}
}

function matches(item: RemoteJournalEntry, target: RemoteTabTarget): boolean {
	return (
		item.profileId === target.profileId &&
		item.target === target.target &&
		item.instanceKey === target.instanceKey &&
		item.workspace === target.workspace
	);
}

function identifier(raw: unknown, limit = 256): raw is string {
	return typeof raw === "string" && raw.length > 0 && raw.length <= limit && !/[\r\n\0]/.test(raw);
}

function entry(raw: unknown): RemoteJournalEntry | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const { profileId, target, instanceKey, workspace, epoch, sessionId, actionId, savedAt } = raw as Record<
		string,
		unknown
	>;
	if (
		!identifier(profileId) ||
		!identifier(target) ||
		!identifier(instanceKey, 64) ||
		!identifier(workspace, REMOTE_MAX_PATH_LENGTH) ||
		!identifier(epoch) ||
		!identifier(sessionId) ||
		!identifier(actionId) ||
		typeof savedAt !== "number" ||
		!Number.isSafeInteger(savedAt) ||
		savedAt < 0
	)
		return null;
	return { profileId, target, instanceKey, workspace, epoch, sessionId, actionId, savedAt };
}
