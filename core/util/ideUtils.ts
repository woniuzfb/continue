import { IDE } from "..";

import {
  fileUriOrPathToPath,
  joinEncodedUriPathSegmentToUri,
  joinPathsToUri,
  localPathToFileUri,
  pathToUriPathSegment,
} from "./uri";

function toCandidateAbsoluteFileUri(rawPath: string): string | undefined {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("file://")) {
    return trimmed;
  }
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return localPathToFileUri(trimmed);
  }
  return undefined;
}

function stripMatchingWorkspacePrefix(
  rawPath: string,
  dirUri: string,
): string | undefined {
  const absPath = fileUriOrPathToPath(rawPath).replaceAll("\\", "/");
  const dirPath = fileUriOrPathToPath(dirUri)
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  if (dirPath && absPath.startsWith(`${dirPath}/`)) {
    return absPath.slice(dirPath.length + 1);
  }
  return undefined;
}

/*
  This function takes a relative (to workspace) or absolute filepath
  And checks each workspace (plus direct absolute path) for if it exists or not
  Only returns fully resolved URI if it exists
*/
export async function resolveRelativePathInDir(
  path: string,
  ide: IDE,
  dirUriCandidates?: string[],
): Promise<string | undefined> {
  const dirs = dirUriCandidates ?? (await ide.getWorkspaceDirs());
  for (const dirUri of dirs) {
    const stripped = stripMatchingWorkspacePrefix(path, dirUri);
    const fullUri = joinPathsToUri(dirUri, stripped ?? path);
    if (await ide.fileExists(fullUri)) {
      return fullUri;
    }
  }

  const absUri = toCandidateAbsoluteFileUri(path);
  if (absUri && (await ide.fileExists(absUri))) {
    return absUri;
  }

  return undefined;
}

/*
  Same as above but in this case the relative path does not need to exist (e.g. file to be created, etc)
  Checks closes match with the dirs, path segment by segment
  and based on which workspace has the closest matching path, returns resolved URI
  If no meaninful path match just concatenates to first dir's uri
*/
export async function inferResolvedUriFromRelativePath(
  _relativePath: string,
  ide: IDE,
  dirCandidates?: string[],
): Promise<string> {
  const relativePath = _relativePath.trim().replaceAll("\\", "/");
  const dirs = dirCandidates ?? (await ide.getWorkspaceDirs());

  for (const dirUri of dirs) {
    const stripped = stripMatchingWorkspacePrefix(relativePath, dirUri);
    if (stripped !== undefined) {
      return joinPathsToUri(dirUri, stripped);
    }
  }

  const absUri = toCandidateAbsoluteFileUri(relativePath);
  if (absUri) {
    return absUri;
  }

  if (dirs.length === 0) {
    throw new Error("inferResolvedUriFromRelativePath: no dirs provided");
  }

  const segments = pathToUriPathSegment(relativePath).split("/");
  // Generate all possible suffixes from shortest to longest
  const suffixes: string[] = [];
  for (let i = segments.length - 1; i >= 0; i--) {
    suffixes.push(segments.slice(i).join("/"));
  }

  // For each suffix, try to find a unique matching dir/file
  for (const suffix of suffixes) {
    const uris = dirs.map((dir) => ({
      dir,
      partialUri: joinEncodedUriPathSegmentToUri(dir, suffix),
    }));
    const promises = uris.map(async ({ partialUri, dir }) => {
      const exists = await ide.fileExists(partialUri);
      return {
        dir,
        partialUri,
        exists,
      };
    });
    const existenceChecks = await Promise.all(promises);

    const existingUris = existenceChecks.filter(({ exists }) => exists);

    // If exactly one directory matches, use it
    if (existingUris.length === 1) {
      return joinEncodedUriPathSegmentToUri(
        existingUris[0].dir,
        segments.join("/"),
      );
    }
  }

  // Sometimes the model will decide to only output the base name or small number of path parts
  // in which case we shouldn't create a new file if it matches the current file
  const activeFile = await ide.getCurrentFile();
  if (activeFile && activeFile.path.endsWith(relativePath)) {
    return activeFile.path;
  }

  // If no unique match found, use the first directory
  return joinPathsToUri(dirs[0], relativePath);
}
