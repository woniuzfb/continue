import { useCallback, useContext, useState } from "react";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { isJetBrains } from "../util";

/**
 * Write `text` to the hidden textarea + `execCommand("copy")` fallback path.
 * Saves and restores the page selection around it so the user's own text
 * selection in the chat is not clobbered.
 */
async function copyViaExecCommand(text: string): Promise<boolean> {
  const selection = window.getSelection();
  const savedRanges: Range[] = [];
  if (selection && selection.rangeCount > 0) {
    for (let i = 0; i < selection.rangeCount; i++) {
      savedRanges.push(selection.getRangeAt(i).cloneRange());
    }
  }

  let ok = false;
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    // Keep it in the DOM but off-screen so selection works in every engine
    // without scrolling the page (fixed + negative offsets).
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.left = "-1000px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
    document.body.removeChild(textarea);
  } catch {
    ok = false;
  }

  if (selection && savedRanges.length > 0) {
    selection.removeAllRanges();
    for (const range of savedRanges) {
      selection.addRange(range);
    }
  }
  return ok;
}

/**
 * Read the clipboard back and check the full payload actually landed.
 * Returns `true`/`false` when readable, or `undefined` when the clipboard
 * cannot be read back in this context (permission/security).
 */
async function verifyClipboardWrite(
  text: string,
): Promise<boolean | undefined> {
  try {
    return (await navigator.clipboard.readText()) === text;
  } catch {
    return undefined;
  }
}

/**
 * Robust clipboard write with verification.
 *
 * The async Clipboard API in Electron / VS Code webviews can resolve
 * successfully while only a PART of a large string ends up on the clipboard
 * (typically the tail), with no error. So we:
 *
 * 1. try `navigator.clipboard.writeText`, then READ BACK and verify the full
 *    text actually landed;
 * 2. on mismatch or rejection, fall back to a hidden textarea +
 *    `execCommand("copy")` (the same path the codebase already uses for
 *    copy in VS Code) and verify again;
 * 3. only report success when a path verifies — or, when the clipboard can't
 *    be read back at all, after the last attempt.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const paths: Array<() => Promise<boolean>> = [
    async () => {
      await navigator.clipboard.writeText(text);
      return true;
    },
    () => copyViaExecCommand(text),
  ];

  let unverifiable = false;
  for (const path of paths) {
    try {
      await path();
      const verified = await verifyClipboardWrite(text);
      if (verified === true) {
        return true;
      }
      if (verified === undefined) {
        unverifiable = true;
        continue;
      }
      console.warn(
        "[useCopy] clipboard write did not verify (truncated?), trying next path",
      );
    } catch (e) {
      console.warn("[useCopy] copy path failed", e);
    }
  }
  // Nothing verified; if the clipboard is simply not readable here, assume
  // the last (execCommand) attempt went through.
  return unverifiable;
}

export default function useCopy(text: string | (() => string)) {
  const [copied, setCopied] = useState<boolean>(false);
  const [copyFailed, setCopyFailed] = useState<boolean>(false);
  const ideMessenger = useContext(IdeMessengerContext);

  const copyText = useCallback(async () => {
    const textVal = typeof text === "string" ? text : text();

    if (isJetBrains()) {
      ideMessenger.post("copyText", { text: textVal });
      setCopied(true);
    } else {
      // Only report success once the write actually went through, so the
      // button can never claim "Copied" while the clipboard still holds
      // stale/partial content.
      const ok = await copyTextToClipboard(textVal);
      if (ok) {
        setCopied(true);
      } else {
        setCopyFailed(true);
      }
    }

    setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, 2000);
  }, [text, ideMessenger]);

  return { copied, copyFailed, copyText };
}
