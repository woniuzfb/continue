import { IDE, RangeInFileWithContents } from "../..";
import { PrecalculatedLruCache } from "../../util/LruCache";
import {
  getFullLanguageName,
  getParserForFile,
  getQueryForFile,
} from "../../util/treeSitter";
import { findUriInDirs } from "../../util/uri";

interface FileInfo {
  imports: { [key: string]: RangeInFileWithContents[] };
}

export class ImportDefinitionsService {
  static N = 10;

  private cache: PrecalculatedLruCache<FileInfo> =
    new PrecalculatedLruCache<FileInfo>(
      this._getFileInfo.bind(this),
      ImportDefinitionsService.N,
    );

  constructor(private readonly ide: IDE) {
    ide.onDidChangeActiveTextEditor((filepath) => {
      this.cache
        .initKey(filepath)
        .catch((e) =>
          console.warn(
            `Failed to initialize ImportDefinitionService: ${e.message}`,
          ),
        );
    });
  }

  get(filepath: string): FileInfo | undefined {
    return this.cache.get(filepath);
  }

  private async _getFileInfo(filepath: string): Promise<FileInfo | null> {
    if (filepath.endsWith(".ipynb")) {
      // Commenting out this line was the solution to https://github.com/continuedev/continue/issues/1463
      return null;
    }

    const parser = await getParserForFile(filepath);
    if (!parser) {
      return {
        imports: {},
      };
    }

    let fileContents: string | undefined = undefined;
    try {
      const { foundInDir } = findUriInDirs(
        filepath,
        await this.ide.getWorkspaceDirs(),
      );
      if (!foundInDir) {
        return null;
      } else {
        fileContents = await this.ide.readFile(filepath);
      }
    } catch (err) {
      // File removed
      return null;
    }

    // Parse only the head of the file (imports live at the top), cut at the
    // end of the last complete statement. NEVER let the parser see input that
    // ends mid-expression: an EOF inside e.g. the condition of an `else if`
    // drives tree-sitter's error recovery into an infinite loop (100% CPU,
    // freezing the extension host). Minimal repro against web-tree-sitter
    // 0.21.0: `{ if (a) { b(); } else if (q`
    const parseLimit = Math.min(fileContents.length, 10_000);
    let sliceEnd = parseLimit;
    if (parseLimit < fileContents.length) {
      const stmtEnd = fileContents.lastIndexOf(";\n", parseLimit);
      sliceEnd = stmtEnd >= 0 ? stmtEnd + 2 : 0;
    }
    const ast = parser.parse(fileContents.slice(0, sliceEnd));
    const language = getFullLanguageName(filepath);
    const query = await getQueryForFile(
      filepath,
      `import-queries/${language}.scm`,
    );
    if (!query) {
      return {
        imports: {},
      };
    }

    const matches = query?.matches(ast.rootNode);

    const fileInfo: FileInfo = {
      imports: {},
    };
    for (const match of matches) {
      const startPosition = match.captures[0].node.startPosition;
      const defs = await this.ide.gotoDefinition({
        filepath,
        position: {
          line: startPosition.row,
          character: startPosition.column,
        },
      });
      fileInfo.imports[match.captures[0].node.text] = await Promise.all(
        defs.map(async (def) => ({
          ...def,
          contents: await this.ide.readRangeInFile(def.filepath, def.range),
        })),
      );
    }

    return fileInfo;
  }
}
