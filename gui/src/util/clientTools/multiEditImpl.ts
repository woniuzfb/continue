import { validateMultiEdit } from "core/edit/searchAndReplace/multiEditValidation";
import { executeMultiFindAndReplace } from "core/edit/searchAndReplace/performReplace";
import { validateSearchAndReplaceFilepath } from "core/edit/searchAndReplace/validateArgs";
import { v4 as uuid } from "uuid";
import { applyEditToolChanges } from "../../redux/thunks/sessionApplyState";
import { ClientToolImpl } from "./callClientTool";

export const multiEditImpl: ClientToolImpl = async (
  args,
  toolCallId,
  extras,
) => {
  // Note that this is fully duplicate of what occurs in args preprocessing
  // This is to handle cases where file changes while tool call is pending
  const { edits } = validateMultiEdit(args);
  const fileUri = await validateSearchAndReplaceFilepath(
    args.filepath,
    extras.ideMessenger.ide,
  );

  const editingFileContents = await extras.ideMessenger.ide.readFile(fileUri);
  const newFileContents = executeMultiFindAndReplace(
    editingFileContents,
    edits,
  );

  const streamId = uuid();
  applyEditToolChanges(
    { sessionId: extras.sessionId, dispatch: extras.dispatch },
    {
      streamId,
      toolCallId,
      text: newFileContents,
      filepath: fileUri,
      isSearchAndReplace: true,
    },
  );

  // Return success - applyToFile will handle the completion state
  return {
    respondImmediately: false, // Let apply state handle completion
    output: undefined,
  };
};
