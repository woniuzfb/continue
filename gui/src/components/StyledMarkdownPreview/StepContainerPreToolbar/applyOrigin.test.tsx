import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { renderWithProviders } from "../../../util/test/render";
import {
  lookupApplyOrigin,
  resetApplyOrigins,
} from "../../../redux/util/applyOrigins";
import { StepContainerPreToolbar } from "./index";

const STREAM_ID = "codeblock-stream-1";

function toolbar() {
  return (
    <StepContainerPreToolbar
      codeBlockContent="const a = 1;"
      language="typescript"
      codeBlockIndex={0}
      isLastCodeblock={false}
      codeBlockStreamId={STREAM_ID}
    >
      <pre />
    </StepContainerPreToolbar>
  );
}

describe("StepContainerPreToolbar apply", () => {
  beforeEach(() => {
    resetApplyOrigins();
  });

  /**
   * 方案.md §五.21. The IDE echoes the `streamId` we post on every
   * `updateApplyState` it sends back, and those events carry no sessionId. If
   * the Apply button does not record the owning session first, the events are
   * dropped by the fail-safe router and the toolbar never leaves
   * "applying…".
   */
  it("records the code-block apply origin for its own session", async () => {
    const { store, getByTestId } = await renderWithProviders(toolbar());
    const sessionId = (store.getState() as any).sessions.activeSessionId;

    await act(async () => {
      getByTestId("codeblock-toolbar-apply").click();
    });

    expect(lookupApplyOrigin(STREAM_ID)).toEqual({
      kind: "code-block",
      sessionId,
    });
  });
});
