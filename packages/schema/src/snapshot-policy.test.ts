import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNAPSHOT_POLICY,
  FORCED_SNAPSHOT_REASONS,
  fastJoinFromSeq,
  isForcedSnapshotReason,
  selectFastJoinSnapshot,
  shouldSnapshot,
  type SnapshotPolicy,
} from "./snapshot-policy.js";
import { checkSeqContiguity } from "./events.js";

describe("shouldSnapshot — forced reasons (D7 pre_archive, D3 recovery)", () => {
  it("pre_archive always snapshots, ignoring thresholds and the floor", () => {
    expect(
      shouldSnapshot({ seqSinceLastSnapshot: 0, bytesSinceLastSnapshot: 0, reason: "pre_archive" }),
    ).toBe(true);
  });

  it("recovery always snapshots, ignoring thresholds and the floor", () => {
    expect(
      shouldSnapshot({ seqSinceLastSnapshot: 0, bytesSinceLastSnapshot: 0, reason: "recovery" }),
    ).toBe(true);
  });

  it("FORCED_SNAPSHOT_REASONS matches isForcedSnapshotReason", () => {
    expect([...FORCED_SNAPSHOT_REASONS]).toEqual(["pre_archive", "recovery"]);
    expect(isForcedSnapshotReason("pre_archive")).toBe(true);
    expect(isForcedSnapshotReason("recovery")).toBe(true);
    expect(isForcedSnapshotReason("periodic")).toBe(false);
  });
});

describe("shouldSnapshot — periodic cadence (default policy)", () => {
  it("does not snapshot below both thresholds", () => {
    expect(shouldSnapshot({ seqSinceLastSnapshot: 10, bytesSinceLastSnapshot: 1024 })).toBe(false);
  });

  it("fires on the seq trigger at the boundary", () => {
    expect(shouldSnapshot({ seqSinceLastSnapshot: 200, bytesSinceLastSnapshot: 0 })).toBe(true);
    expect(shouldSnapshot({ seqSinceLastSnapshot: 199, bytesSinceLastSnapshot: 0 })).toBe(false);
  });

  it("fires on the byte trigger even when the seq count is low", () => {
    // A handful of large tool results cross 256 KiB well before 200 events.
    expect(shouldSnapshot({ seqSinceLastSnapshot: 5, bytesSinceLastSnapshot: 256 * 1024 })).toBe(
      true,
    );
  });

  it("reason 'periodic' behaves the same as omitting it", () => {
    const input = { seqSinceLastSnapshot: 200, bytesSinceLastSnapshot: 0 };
    expect(shouldSnapshot(input)).toBe(shouldSnapshot({ ...input, reason: "periodic" }));
  });
});

describe("shouldSnapshot — floor + disabled triggers", () => {
  it("the minSeqInterval floor blocks a byte-only fire on the same/near seq", () => {
    const policy: SnapshotPolicy = { everySeqInterval: 0, everyByteInterval: 1024, minSeqInterval: 5 };
    // Byte trigger crossed but only 3 seq slots advanced → floor blocks it.
    expect(shouldSnapshot({ seqSinceLastSnapshot: 3, bytesSinceLastSnapshot: 4096 }, policy)).toBe(
      false,
    );
    expect(shouldSnapshot({ seqSinceLastSnapshot: 5, bytesSinceLastSnapshot: 4096 }, policy)).toBe(
      true,
    );
  });

  it("never fires when seqSinceLastSnapshot is 0 (the last event was a snapshot)", () => {
    expect(shouldSnapshot({ seqSinceLastSnapshot: 0, bytesSinceLastSnapshot: 10 ** 9 })).toBe(false);
  });

  it("a disabled trigger (0) does not fire on its own", () => {
    const seqOnly: SnapshotPolicy = { everySeqInterval: 100, everyByteInterval: 0, minSeqInterval: 1 };
    expect(shouldSnapshot({ seqSinceLastSnapshot: 10, bytesSinceLastSnapshot: 10 ** 9 }, seqOnly)).toBe(
      false,
    );
    const byteOnly: SnapshotPolicy = { everySeqInterval: 0, everyByteInterval: 100, minSeqInterval: 1 };
    expect(shouldSnapshot({ seqSinceLastSnapshot: 10 ** 9, bytesSinceLastSnapshot: 10 }, byteOnly)).toBe(
      false,
    );
  });

  it("default policy has sane, replay-bounding thresholds", () => {
    expect(DEFAULT_SNAPSHOT_POLICY.everySeqInterval).toBeGreaterThan(0);
    expect(DEFAULT_SNAPSHOT_POLICY.everyByteInterval).toBeGreaterThan(0);
    expect(DEFAULT_SNAPSHOT_POLICY.minSeqInterval).toBeGreaterThanOrEqual(1);
  });
});

describe("fast-join selection (A5 inclusive contract)", () => {
  it("picks the greatest-seq snapshot", () => {
    const chosen = selectFastJoinSnapshot([{ seq: 0 }, { seq: 240 }, { seq: 120 }]);
    expect(chosen?.seq).toBe(240);
  });

  it("returns null when there are no snapshots (join from seq 0)", () => {
    expect(selectFastJoinSnapshot([])).toBeNull();
    expect(fastJoinFromSeq(null)).toBe(0);
  });

  it("does not exclude a historyHole snapshot — it is a valid join point", () => {
    const chosen = selectFastJoinSnapshot([{ seq: 10 }, { seq: 50, historyHole: true }]);
    expect(chosen?.seq).toBe(50);
    expect(chosen?.historyHole).toBe(true);
  });

  it("fastJoinFromSeq resumes at snapshot.seq + 1 (A5 inclusive)", () => {
    expect(fastJoinFromSeq({ seq: 240 })).toBe(241);
  });

  it("selection + fastJoinFromSeq feed checkSeqContiguity end to end", () => {
    // A client fast-joins from the snapshot at seq 240, then reads 241, 242, 243.
    const snap = selectFastJoinSnapshot([{ seq: 100 }, { seq: 240 }]);
    const from = fastJoinFromSeq(snap);
    expect(from).toBe(241);
    const tail = [{ seq: 241 }, { seq: 242 }, { seq: 243 }];
    expect(checkSeqContiguity(tail, { expectedFirstSeq: from }).ok).toBe(true);
    // A gap after the join point is drift.
    const gapped = [{ seq: 241 }, { seq: 243 }];
    expect(checkSeqContiguity(gapped, { expectedFirstSeq: from }).ok).toBe(false);
  });
});
