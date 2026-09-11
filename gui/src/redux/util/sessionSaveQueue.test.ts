import { describe, expect, it } from "vitest";
import {
  deletePendingSave,
  getPendingSave,
  resetSessionSaveQueues,
  setPendingSave,
} from "./sessionSaveQueue";
import { NO_MEASUREMENT, mergeMeasurementIntent } from "./sessionSaveIntent";

/**
 * Stage 2D 收口：保存队列 coalescing 时必须合并 measurement intent。
 *
 * 每个 session 只有一个 pending 槽位，入队是 last-write-wins —— 但**计量义务不能被
 * 后来的簿记保存吞掉**，否则「terminal 建立的内容版本」会静默失去权威计量
 * （方案.md §五.16.4）。
 */

const version = (revision: number) =>
  ({ kind: "conversation-version", conversationRevision: revision }) as const;

describe("mergeMeasurementIntent", () => {
  it("keeps a pending conversation version when a `none` save coalesces into it", () => {
    expect(mergeMeasurementIntent(version(12), NO_MEASUREMENT)).toEqual(
      version(12),
    );
  });

  it("takes the newer conversation version", () => {
    expect(mergeMeasurementIntent(NO_MEASUREMENT, version(12))).toEqual(
      version(12),
    );
    expect(mergeMeasurementIntent(version(12), version(13))).toEqual(
      version(13),
    );
  });

  it("stays `none` when neither side measures", () => {
    expect(mergeMeasurementIntent(NO_MEASUREMENT, NO_MEASUREMENT)).toEqual(
      NO_MEASUREMENT,
    );
  });
});

describe("setPendingSave coalescing", () => {
  it("keeps the newest persistence entry but the merged measurement intent", () => {
    resetSessionSaveQueues();

    setPendingSave("s1", {
      revision: 12,
      reason: "STREAM_COMPLETED",
      measurementIntent: version(12),
    });
    // A later bookkeeping save coalesces into the same slot: its persistence
    // revision/reason win, its `none` intent does not erase the obligation.
    setPendingSave("s1", {
      revision: 13,
      reason: "STREAM_CHECKPOINT:regular",
      measurementIntent: NO_MEASUREMENT,
    });

    expect(getPendingSave("s1")).toEqual({
      revision: 13,
      reason: "STREAM_CHECKPOINT:regular",
      measurementIntent: version(12),
    });

    // ...and a newer content version still replaces the older obligation.
    setPendingSave("s1", {
      revision: 14,
      reason: "STREAM_COMPLETED",
      measurementIntent: version(14),
    });
    expect(getPendingSave("s1")).toEqual({
      revision: 14,
      reason: "STREAM_COMPLETED",
      measurementIntent: version(14),
    });

    deletePendingSave("s1");
    expect(getPendingSave("s1")).toBeUndefined();
  });
});
