import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * 方案.md §五.21 P3: every `updateApplyState` the IDE sends must name the GUI
 * session, because the event itself has none and `streamId` is not unique per
 * session (edit mode uses one fixed id for every session).
 *
 * A behavioural test can only reach the send sites it can construct, and these
 * payloads are written in `onStatusUpdate` closures inside diff-handler
 * options — easy to add and easy to forget. So this is a **static guard over
 * the known sending files** (in the spirit of the GUI's
 * `sessionScopeGate.test.ts`), not a whole-repo guarantee: a new sender in a
 * fourth file would not be scanned. Making it repo-wide means walking the whole
 * `src` tree recursively and skipping test files — worth doing when a fourth
 * sender actually appears, not a blocker today.
 */

/** Project root, from `src/apply/`. */
const ROOT = join(__dirname, "..", "..");

const SEND_SITES = [
  "src/apply/ApplyManager.ts",
  "src/diff/vertical/manager.ts",
  "src/diff/processDiff.ts",
];

/**
 * The payload object of every `updateApplyState` send in a source file.
 *
 * The payloads are flat object literals, so `[^{}]*` is enough — and the
 * caller counts markers vs. matches, so a payload that grows nested braces
 * fails loudly instead of being silently skipped.
 */
function payloadsOf(content: string): string[] {
  const matches = content.matchAll(/"updateApplyState",\s*\{([^{}]*)\}/gs);
  return Array.from(matches, (match) => match[1]);
}

function markerCount(content: string): number {
  return content.split('"updateApplyState"').length - 1;
}

describe("IDE updateApplyState senders", () => {
  it("names the session on every updateApplyState payload", () => {
    const offenders: string[] = [];

    for (const relative of SEND_SITES) {
      const content = readFileSync(join(ROOT, relative), "utf8");
      const payloads = payloadsOf(content);
      expect(payloads.length).toBeGreaterThan(0);
      // No sender may escape the scan (e.g. by nesting braces in its payload).
      expect(payloads.length).toBe(markerCount(content));
      payloads.forEach((payload, index) => {
        if (!/\bsessionId\b/.test(payload)) {
          offenders.push(`${relative} (send #${index + 1})`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("still forwards the sessionId the request carried", () => {
    // The events are useless if the request's sessionId stops at applyToFile:
    // it has to reach the manager methods that emit them.
    const applyManager = readFileSync(
      join(ROOT, "src/apply/ApplyManager.ts"),
      "utf8",
    );
    expect(applyManager).toMatch(/streamDiffLines\([^)]*sessionId/s);
    expect(applyManager).toMatch(/instantApplyDiff\([^)]*sessionId/s);
    expect(applyManager).toMatch(
      /streamEdit\(\{[\s\S]*?sessionId,[\s\S]*?\}\)/,
    );
  });
});
