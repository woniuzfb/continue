import { act } from "@testing-library/react";
import { registerCodeBlockApplyOrigin } from "../../../redux/util/applyOrigins";
import { renderWithProviders } from "../../../util/test/render";
import {
  getElementByTestId,
  verifyNotPresentByTestId,
  verifyNotPresentByText,
} from "../../../util/test/utils";
import { Chat } from "../Chat";

const STREAM_ID = "12345";

/**
 * 方案.md §五.21: an `updateApplyState` event is routed by its recorded apply
 * origin — the visible tab is never used as a fallback. In production the
 * Apply button records that origin (see the toolbar test); these tests drive
 * the events directly, so they must record it the same way first.
 */
async function renderChatWithApplyOrigin() {
  const rendered = await renderWithProviders(<Chat />);
  const sessionId = (rendered.store.getState() as any).sessions.activeSessionId;
  registerCodeBlockApplyOrigin(STREAM_ID, { sessionId });
  return rendered;
}

test("Chat apply scenarios: handle apply updates and display the accept / reject all buttons", async () => {
  const { ideMessenger } = await renderChatWithApplyOrigin();

  // Use queryByText which returns null when element isn't found
  await verifyNotPresentByText("Accept All");
  await verifyNotPresentByText("Reject All");

  for (let i = 0; i < 5; i++) {
    ideMessenger.mockMessageToWebview("updateApplyState", {
      status: "streaming",
      streamId: STREAM_ID,
    });
  }

  ideMessenger.mockMessageToWebview("updateApplyState", {
    status: "done",
    streamId: STREAM_ID,
  });

  // Wait for the buttons to appear
  await getElementByTestId("accept-reject-all-buttons");

  // IDE sends back message that it is done
  ideMessenger.mockMessageToWebview("updateApplyState", {
    status: "closed",
    streamId: STREAM_ID,
  });

  // Wait for the buttons to disappear
  await verifyNotPresentByTestId("edit-accept-button");
  await verifyNotPresentByTestId("edit-reject-button");
});

test("Chat apply scenarios: show apply cancellation", async () => {
  const { ideMessenger } = await renderChatWithApplyOrigin();

  // Spy on the request method of ideMessenger
  const messengerPostSpy = vi.spyOn(ideMessenger, "post");

  for (let i = 0; i < 5; i++) {
    ideMessenger.mockMessageToWebview("updateApplyState", {
      status: "streaming",
      streamId: STREAM_ID,
    });
  }

  // Wait for applying toolbar to appear
  await getElementByTestId("notch-applying-text");

  await act(async () => {
    const cancelApplyButton = await getElementByTestId(
      "notch-applying-cancel-button",
    );
    cancelApplyButton.click();
  });

  // Verify that rejectDiff message has been posted to ideMessenger
  expect(messengerPostSpy).toHaveBeenCalledWith("rejectDiff", {});

  // Now simulate the IDE sending back a message that the apply state is closed
  ideMessenger.mockMessageToWebview("updateApplyState", {
    status: "closed",
    streamId: STREAM_ID,
  });

  await verifyNotPresentByTestId("notch-applying-text");
  await verifyNotPresentByTestId("notch-applying-cancel-button");

  // Cleanup spy
  messengerPostSpy.mockRestore();
});
