import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PendingSubmissionItem } from "./PendingSubmissionItem";
import type { PendingSubmission } from "../../redux/slices/sessionsSlice";

/**
 * The pending draft row (workflow "submit latency and retry boundary", step 3).
 *
 * It is the only feedback during the window between Enter and the committed turn, so what
 * it shows matters: the text the user typed, the attachment **names** (never payloads),
 * and an explicit "not sent yet" — an uncommitted draft must never look like a sent
 * message.
 */
const draft = (
  overrides: Partial<PendingSubmission> = {},
): PendingSubmission => ({
  submissionId: "sub-1",
  insertion: { kind: "append" },
  displayContent: "hello world",
  startedAt: Date.now(),
  ...overrides,
});

describe("PendingSubmissionItem", () => {
  it("shows the typed text and marks it as not sent yet", () => {
    const { container } = render(<PendingSubmissionItem pending={draft()} />);

    expect(screen.getByText("hello world")).toBeTruthy();
    expect(container.textContent).toContain("Preparing");
    expect(container.textContent).toContain("not sent yet");
    expect(
      container.querySelector("[data-pending-submission='sub-1']"),
    ).not.toBeNull();
  });

  it("renders attachment names without their contents", () => {
    const { container } = render(
      <PendingSubmissionItem
        pending={draft({
          attachmentMeta: [
            { name: "a.ts", path: "file:///a.ts" },
            { name: "b.ts", path: "file:///b.ts" },
          ],
        })}
      />,
    );

    expect(container.textContent).toContain("a.ts");
    expect(container.textContent).toContain("b.ts");
  });

  it("renders a draft with no text (attachments only) without crashing", () => {
    const { container } = render(
      <PendingSubmissionItem
        pending={draft({
          displayContent: [],
          attachmentMeta: [{ name: "only.ts", path: "file:///only.ts" }],
        })}
      />,
    );

    expect(container.textContent).toContain("only.ts");
    expect(container.textContent).toContain("Preparing");
  });

  it("does not require the store or a session scope", () => {
    // Deliberately rendered without providers: the row is decorative and must not be able
    // to read the session tree (that is how a draft stays out of the content graph).
    expect(() =>
      render(<PendingSubmissionItem pending={draft()} />),
    ).not.toThrow();
  });
});
