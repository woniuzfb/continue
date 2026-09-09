import { useContext } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { setSessionInlineError } from "../../redux/slices/sessionsSlice";
import { selectActiveSessionId } from "../../redux/selectors/sessionView";
import { selectActiveInlineErrorMessage } from "../../redux/selectors/sessionView";

export type InlineErrorMessageType = "out-of-context";

export default function InlineErrorMessage() {
  const dispatch = useAppDispatch();
  const sessionId = useAppSelector(selectActiveSessionId);
  const ideMessenger = useContext(IdeMessengerContext);
  const inlineErrorMessage = useAppSelector((state) =>
    selectActiveInlineErrorMessage(state),
  );
  if (inlineErrorMessage === "out-of-context") {
    return (
      <div
        className={`border-border relative m-2 flex flex-col rounded-md border border-solid bg-transparent p-4`}
      >
        <p className={`thread-message text-error text-center`}>
          {`Message exceeds context limit.`}
        </p>
        <div className="text-description flex flex-row items-center justify-center gap-1.5 px-3">
          <div
            className="cursor-pointer text-xs hover:underline"
            onClick={() => {
              ideMessenger.post("config/openProfile", {
                profileId: undefined,
              });
            }}
          >
            <span className="xs:flex hidden">Open config</span>
            <span className="xs:hidden">Config</span>
          </div>
          |
          <span
            className="cursor-pointer text-xs hover:underline"
            onClick={() => {
              dispatch(
                setSessionInlineError({
                  sessionId,
                  error: undefined,
                }),
              );
            }}
          >
            Hide
          </span>
        </div>
      </div>
    );
  }
  return null;
}
