import { expect, it } from "vitest";
import { REMOTE_RECEIPT_RETENTION_MS } from "../shared/remote-wire";
import { RemoteJournal } from "./remote-journal";

const target = { profileId: "profile", target: "host-a", instanceKey: "a".repeat(64), workspace: "/work/project" };
const action = { epoch: "epoch-a", sessionId: "session-a" };

it("reopens a receipt identity after a client restart without crossing host or workspace boundaries", () => {
	let saved: unknown;
	const read = () => saved;
	const write = (rows: unknown) => {
		saved = JSON.parse(JSON.stringify(rows));
	};
	const first = new RemoteJournal(read, write);
	const recorded = first.begin(target, action);
	const reopened = new RemoteJournal(read, write);
	const other = { ...target, target: "host-b" };
	expect(reopened.pending(other)).toEqual([]);
	expect(reopened.pending({ ...target, workspace: "/work/elsewhere" })).toEqual([]);
	expect(reopened.pending(target)).toEqual([recorded]);
	reopened.finish(other, recorded.actionId, recorded.epoch);
	reopened.finish(target, recorded.actionId, "new-epoch");
	expect(reopened.pending(target)).toEqual([recorded]);
	reopened.finish(target, recorded.actionId, recorded.epoch);
	expect(new RemoteJournal(read, write).pending(target)).toEqual([]);
});

it("does not allow dispatch when recording the action identity fails, and expires old records", () => {
	let now = 1_000;
	let unavailable = false;
	const journal = new RemoteJournal(
		() => null,
		() => {
			if (unavailable) throw new Error("Preferences not writable");
		},
		() => now,
	);
	const first = journal.begin(target, action);
	unavailable = true;
	expect(() => journal.begin(target, action)).toThrow("Preferences not writable");
	expect(journal.pending(target)).toEqual([first]);
	now += REMOTE_RECEIPT_RETENTION_MS + 1;
	expect(journal.pending(target)).toEqual([]);
});
