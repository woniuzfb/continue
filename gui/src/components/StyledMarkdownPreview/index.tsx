import { ctxItemToRifWithContents } from "core/commands/util";
import { memo, useEffect, useMemo, useRef } from "react";
import { useRemark } from "react-remark";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import styled from "styled-components";
import { visit } from "unist-util-visit";
import { v4 as uuidv4 } from "uuid";
import {
  defaultBorderRadius,
  vscBackground,
  vscEditorBackground,
  vscForeground,
} from "..";
import useUpdatingRef from "../../hooks/useUpdatingRef";
import { useAppSelector } from "../../redux/hooks";
import { selectUIConfig } from "../../redux/slices/configSlice";
import { getContextItemsFromHistory } from "../../redux/thunks/updateFileSymbols";
import { getFontSize } from "../../util";
import { ToolTip } from "../gui/Tooltip";
import FilenameLink from "./FilenameLink";
import "./katex.css";
import "./markdown.css";
import {
  getMarkdownArtifact,
  setMarkdownArtifact,
} from "./markdownArtifactCache";
import MermaidBlock from "./MermaidBlock";
import { rehypeHighlightPlugin } from "./rehypeHighlightPlugin";
import { SecureImageComponent } from "./SecureImageComponent";
import { StepContainerPreToolbar } from "./StepContainerPreToolbar";
import SymbolLink from "./SymbolLink";
import { SyntaxHighlightedPre } from "./SyntaxHighlightedPre";
import { isSymbolNotRif, matchCodeToSymbolOrFile } from "./utils";
import { fixDoubleDollarNewLineLatex } from "./utils/fixDoubleDollarLatex";
import { patchNestedMarkdown } from "./utils/patchNestedMarkdown";
import { replaceSingleDollarOutsideCode } from "./utils/replaceSingleDollarOutsideCode";
import { remarkTables } from "./utils/remarkTables";

const StyledMarkdown = styled.div<{
  fontSize?: number;
  whiteSpace: string;
  bgColor: string;
}>`
  h1 {
    font-size: 1.25em;
  }

  h2 {
    font-size: 1.15em;
  }

  h3 {
    font-size: 1.05em;
  }

  h4 {
    font-size: 1em;
  }

  h5 {
    font-size: 0.95em;
  }

  h6 {
    font-size: 0.9em;
  }

  pre {
    white-space: ${(props) => props.whiteSpace};
    background-color: ${vscEditorBackground};
    border-radius: ${defaultBorderRadius};

    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;

    padding: 8px;
    box-sizing: border-box;
  }

  code {
    span.line:empty {
      display: none;
    }
    word-wrap: break-word;
    border-radius: 0.3125rem;
    background-color: ${vscEditorBackground};
    font-size: ${getFontSize() - 2}px;
    font-family: var(--vscode-editor-font-family);
  }

  ul ul,
  ul ol,
  ol ul,
  ol ol {
    padding-left: 1.5em;
    margin-top: 1em;
  }

  li {
    margin-bottom: 0.8em;
  }
  li:last-child {
    margin-bottom: 0;
  }

  ul,
  ol {
    padding-left: 2em;
  }

  code:not(pre > code) {
    font-family: var(--vscode-editor-font-family);
  }

  background-color: ${(props) => props.bgColor};
  font-family:
    var(--vscode-font-family),
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Roboto,
    Oxygen,
    Ubuntu,
    Cantarell,
    "Open Sans",
    "Helvetica Neue",
    sans-serif;
  font-size: ${(props) => props.fontSize || getFontSize()}px;
  padding-left: 8px;
  padding-right: 8px;
  color: ${vscForeground};

  p,
  li,
  ol,
  ul {
    line-height: 1.5;
  }

  * {
    word-break: break-word;
  }

  > *:last-child {
    margin-bottom: 0;
  }
`;

interface StyledMarkdownPreviewProps {
  showToolCallStatusIcon?: boolean;
  source?: string;
  className?: string;
  isRenderingInStepContainer?: boolean; // Currently only used to control the rendering of codeblocks
  scrollLocked?: boolean;
  itemIndex?: number;
  useParentBackgroundColor?: boolean;
  disableManualApply?: boolean;
  toolCallId?: string;
  expandCodeblocks?: boolean;
  collapsible?: boolean;
}

const HLJS_LANGUAGE_CLASSNAME_PREFIX = "language-";

function getLanguageFromClassName(className: any): string | null {
  if (!className || typeof className !== "string") {
    return null;
  }

  const language = className
    .split(" ")
    .find((word) => word.startsWith(HLJS_LANGUAGE_CLASSNAME_PREFIX))
    ?.split("-")[1];

  return language ?? null;
}

function getCodeChildrenContent(children: any) {
  if (typeof children === "string") {
    return children;
  } else if (
    Array.isArray(children) &&
    children.length > 0 &&
    typeof children[0] === "string"
  ) {
    return children[0];
  }
  return undefined;
}

const StyledMarkdownPreview = memo(function StyledMarkdownPreview(
  props: StyledMarkdownPreviewProps,
) {
  // ── 渲染产物缓存(外层,组件级分支)────────────────────────────
  // 命中缓存时渲染静态产物组件,完全不挂载 useRemark(react-remark 底层
  // 是 solid-js 响应式运行时,即使不喂数据,mount 时的初始化和 unmount
  // 时的 dispose 依然是每条消息几 ms 的硬成本)。分支后:
  //   命中   → 无 hook 管线成本,纯 React 元素 + DOM
  //   未命中 → MarkdownPipeline 完整路径,算完回填缓存
  const uiConfig = useAppSelector(selectUIConfig);
  const renderInlineLatex = uiConfig?.renderInlineLatex ?? false;
  const sessionId = useAppSelector((state) => state.session.id);

  const artifactKey = useMemo(() => {
    // 与 MarkdownPipeline 的 preprocessedSource 保持一致(键的一部分)
    let source = fixDoubleDollarNewLineLatex(
      patchNestedMarkdown(props.source ?? ""),
    );
    if (!renderInlineLatex) {
      source = replaceSingleDollarOutsideCode(source);
    }
    const head = `${sessionId}|${props.itemIndex ?? -1}|${props.isRenderingInStepContainer ? 1 : 0}|${props.showToolCallStatusIcon ? 1 : 0}|${props.toolCallId ?? ""}|${props.expandCodeblocks ? 1 : 0}|${props.disableManualApply ? 1 : 0}|${props.collapsible ? 1 : 0}`;
    return `${head}|${source}`;
  }, [
    sessionId,
    props.itemIndex,
    props.isRenderingInStepContainer,
    props.showToolCallStatusIcon,
    props.toolCallId,
    props.expandCodeblocks,
    props.disableManualApply,
    props.collapsible,
    props.source,
    renderInlineLatex,
  ]);

  const codeWrapState = uiConfig?.codeWrap ? "pre-wrap" : "pre";

  // 空 source 短路:useRemark 对空输入不产出 reactContent,STORE effect 的
  // `!reactContent` 守卫使这类条目永远无法回填缓存 → 每次切回都 miss 并
  // 挂载完整管线(solid-js 运行时初始化 + symbols 变更时全量 rerender,
  // 实测 36 条空占位贡献了切回后 ~700ms effects 和后续余震)。空内容直接
  // 渲染空容器,视觉与管线输出一致,且不进缓存计数(消除 md MISS 噪音)。
  if (!props.source || !props.source.trim()) {
    return (
      <StyledMarkdown
        fontSize={getFontSize()}
        whiteSpace={codeWrapState}
        bgColor={props.useParentBackgroundColor ? "" : vscBackground}
      />
    );
  }

  const cachedArtifact = getMarkdownArtifact(artifactKey);

  if (cachedArtifact !== undefined) {
    return (
      <StyledMarkdown
        fontSize={getFontSize()}
        whiteSpace={codeWrapState}
        bgColor={props.useParentBackgroundColor ? "" : vscBackground}
      >
        {cachedArtifact}
      </StyledMarkdown>
    );
  }

  return (
    <MarkdownPipeline
      {...props}
      artifactKey={artifactKey}
      renderInlineLatex={renderInlineLatex}
      codeWrapState={codeWrapState}
    />
  );
});

/**
 * 完整 remark → rehype → highlight 管线(未命中缓存时挂载)。
 * 原有逻辑原样保留,新增:计算完成后回填产物缓存(非流式时)。
 */
const MarkdownPipeline = memo(function MarkdownPipeline(
  props: StyledMarkdownPreviewProps & {
    artifactKey: string;
    renderInlineLatex: boolean;
    codeWrapState: string;
  },
) {
  // The refs are a workaround because rehype options are stored on initiation
  // So they won't use the most up-to-date state values
  // So in this case we just put them in refs

  // The logic here is to get file names from
  // 1. Context items found in past messages
  // 2. Toolbar Codeblocks found in past messages
  const history = useAppSelector((state) => state.session.history);
  const allSymbols = useAppSelector((state) => state.session.symbols);
  const pastFileInfo = useMemo(() => {
    const index = props.itemIndex;
    if (index === undefined) {
      return {
        symbols: [],
        rifs: [],
      };
    }
    const pastContextItems = getContextItemsFromHistory(history, index);
    const rifs = pastContextItems.map((item) =>
      ctxItemToRifWithContents(item, true),
    );
    const symbols = Object.entries(allSymbols)
      .filter((e) => pastContextItems.find((item) => item.uri!.value === e[0]))
      .map((f) => f[1])
      .flat();

    return {
      symbols,
      rifs,
    };
  }, [props.itemIndex, history, allSymbols]);
  const pastFileInfoRef = useUpdatingRef(pastFileInfo);
  const itemIndexRef = useUpdatingRef(props.itemIndex);

  const codeblockStreamIds = useRef<string[]>([]);

  // When inline LaTeX is disabled, replace single $ delimiters with
  // fullwidth dollar signs (＄). They look identical but remark-math
  // won't parse them, so the text is displayed as-is without KaTeX.
  // The replacement skips code spans/fences: remark-math never parses math
  // inside code nodes, so `$` in code must stay verbatim (replacing them
  // corrupted displayed code, e.g. `echo $1 $2`).
  const preprocessedSource = useMemo(() => {
    let source = fixDoubleDollarNewLineLatex(
      patchNestedMarkdown(props.source ?? ""),
    );
    if (!props.renderInlineLatex) {
      source = replaceSingleDollarOutsideCode(source);
    }
    return source;
  }, [props.source, props.renderInlineLatex]);

  const isSessionStreaming = useAppSelector(
    (state) => state.session.isStreaming,
  );

  const [reactContent, setMarkdownSource] = useRemark({
    remarkPlugins: [
      remarkTables,
      [
        remarkMath,
        {
          singleDollarTextMath: true,
        },
      ],
      () => (tree: any) => {
        const lastNode = tree.children[tree.children.length - 1];
        const lastCodeNode = lastNode.type === "code" ? lastNode : null;

        visit(tree, "code", (node: any) => {
          if (!node.lang) {
            node.lang = "";
          } else if (node.lang.includes(".")) {
            node.lang = node.lang.split(".").slice(-1)[0];
          }

          node.data = node.data || {};
          node.data.hProperties = node.data.hProperties || {};

          node.data.hProperties["data-islastcodeblock"] = lastCodeNode === node;
          node.data.hProperties["data-codeblockcontent"] = node.value;

          if (node.meta) {
            let meta = node.meta.split(" ");
            node.data.hProperties["data-relativefilepath"] = meta[0];
            node.data.hProperties.range = meta[1];
          }
        });
      },
    ],
    rehypePlugins: [
      rehypeKatex as any,
      {},
      rehypeHighlightPlugin(),
      // Note: An empty obj is the default behavior, but leaving this here for scaffolding to
      // add unsupported languages in the future. We will need to install the `lowlight` package
      // to use the `common` language set in addition to unsupported languages.
      // https://github.com/highlightjs/highlight.js/blob/main/SUPPORTED_LANGUAGES.md
      () => {
        let codeBlockIndex = 0;
        return (tree) => {
          visit(tree, { tagName: "pre" }, (node: any) => {
            // Add an index (0, 1, 2, etc...) to each code block.
            node.properties = { "data-codeblockindex": codeBlockIndex };
            codeBlockIndex++;
          });
        };
      },
      {},
    ],
    rehypeReactOptions: {
      components: {
        a: ({ ...aProps }) => {
          const href = aProps.href ?? "";
          // 超长链接（如带签名/大文件的下载链接）在 tooltip 里全部展示会
          // 撑爆聊天区：中间截断，只展示首尾，点击仍打开完整 URL。
          const tooltipHref =
            href.length > 120
              ? `${href.slice(0, 80)}...${href.slice(-40)}`
              : href;
          return (
            <ToolTip place="top" className="m-0 p-0" content={tooltipHref}>
              <a href={href} target="_blank" className="hover:underline">
                {aProps.children}
              </a>
            </ToolTip>
          );
        },
        pre: ({ ...preProps }) => {
          const codeBlockIndex = preProps["data-codeblockindex"];

          const preChildProps = preProps?.children?.[0]?.props ?? {};
          const { className, range } = preChildProps;

          const relativeFilePath = preChildProps["data-relativefilepath"];
          const codeBlockContent = preChildProps["data-codeblockcontent"];

          if (!props.isRenderingInStepContainer) {
            return <SyntaxHighlightedPre {...preProps} />;
          }

          const language = getLanguageFromClassName(className);

          const isLastCodeblock = preChildProps["data-islastcodeblock"];

          if (codeblockStreamIds.current[codeBlockIndex] === undefined) {
            codeblockStreamIds.current[codeBlockIndex] = uuidv4();
          }

          return (
            <StepContainerPreToolbar
              showToolCallStatusIcon={props.showToolCallStatusIcon}
              codeBlockContent={codeBlockContent}
              itemIndex={itemIndexRef.current}
              codeBlockIndex={codeBlockIndex}
              language={language}
              relativeFilepath={relativeFilePath}
              isLastCodeblock={isLastCodeblock}
              range={range}
              codeBlockStreamId={codeblockStreamIds.current[codeBlockIndex]} // ignored if toolCallId stream state is found
              forceToolCallId={props.toolCallId}
              expanded={props.expandCodeblocks}
              disableManualApply={props.disableManualApply}
              collapsible={props.collapsible}
            >
              <SyntaxHighlightedPre {...preProps} />
            </StepContainerPreToolbar>
          );
        },
        code: ({ ...codeProps }) => {
          const content = getCodeChildrenContent(codeProps.children);

          if (content) {
            const { symbols, rifs } = pastFileInfoRef.current;

            const matchedSymbolOrFile = matchCodeToSymbolOrFile(
              content,
              symbols,
              rifs,
            );
            if (matchedSymbolOrFile) {
              if (isSymbolNotRif(matchedSymbolOrFile)) {
                return (
                  <SymbolLink content={content} symbol={matchedSymbolOrFile} />
                );
              } else {
                return <FilenameLink rif={matchedSymbolOrFile} />;
              }
            }
          }
          if (codeProps.className?.includes("language-mermaid")) {
            const codeText = String(codeProps.children || "");
            return <MermaidBlock code={codeText} />;
          }
          return <code {...codeProps}>{codeProps.children}</code>;
        },
        img: ({ ...imgProps }) => {
          return (
            <SecureImageComponent
              src={imgProps.src}
              alt={imgProps.alt}
              title={imgProps.title}
              className={imgProps.className}
            />
          );
        },
      },
    },
  });

  useEffect(() => {
    setMarkdownSource(preprocessedSource);
  }, [preprocessedSource]);

  useEffect(() => {
    // 回填缓存:仅在非流式时写入。流式期间 source 每个 chunk 一变,而
    // reactContent 是异步更新的,此时无法保证 reactContent 对应当前
    // source,写入会把过期产物污染进缓存。
    if (!reactContent) {
      return;
    }
    if (isSessionStreaming) {
      return;
    }
    setMarkdownArtifact(props.artifactKey, reactContent);
  }, [reactContent, isSessionStreaming, props.artifactKey]);

  return (
    <StyledMarkdown
      fontSize={getFontSize()}
      whiteSpace={props.codeWrapState}
      bgColor={props.useParentBackgroundColor ? "" : vscBackground}
    >
      {reactContent}
    </StyledMarkdown>
  );
});

export default StyledMarkdownPreview;
