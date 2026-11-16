import { IDE } from "../..";
import { ContinueError, ContinueErrorReason } from "../../util/errors";
import { resolveRelativePathInDir } from "../../util/ideUtils";
import { localPathToFileUri } from "../../util/uri";

export async function validateSearchAndReplaceFilepath(
  filepath: unknown,
  ide: IDE,
) {
  if (!filepath || typeof filepath !== "string") {
    throw new ContinueError(
      ContinueErrorReason.FindAndReplaceMissingFilepath,
      "filepath (string) is required",
    );
  }
  const resolvedFilepath = await resolveRelativePathInDir(filepath, ide);
  if (!resolvedFilepath) {
    const trimmed = filepath.trim();
    if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
      const absUri = localPathToFileUri(trimmed);
      if (await ide.fileExists(absUri)) {
        return absUri;
      }
    }
    throw new ContinueError(
      ContinueErrorReason.FileNotFound,
      `File ${filepath} does not exist`,
    );
  }
  return resolvedFilepath;
}
