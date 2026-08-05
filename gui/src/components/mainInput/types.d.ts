import { ContextProviderDescription, SlashCommandSource } from "core";

/**
 * Metadata for a file attached to a user message via the "Upload File" (+)
 * button. Stored on `message.metadata.attachments` so the UI can render file
 * chips on already-sent messages without leaking the file content into the
 * editorState (which is what the UI echoes back). The actual file content is
 * injected into `message.content` as a `<file_content path="...">` text part
 * at send time, so the LLM still sees it.
 */
export interface AttachmentMeta {
  name: string;
  path: string;
}

/**
 * An attached file in flight at send time. Carries the file `content` so the
 * LLM payload (`message.content`) can be built; only `name`/`path` are
 * persisted to `message.metadata.attachments` as {@link AttachmentMeta}.
 */
export interface AttachedFile extends AttachmentMeta {
  content: string;
}

export type ComboBoxItemType =
  | "contextProvider"
  | "slashCommand"
  | "file"
  | "query"
  | "folder"
  | "action";

export interface ComboBoxSubAction {
  label: string;
  icon: string;
  action: (item: ComboBoxItem) => void;
}

export interface ComboBoxItem {
  title: string;
  description: string;
  id?: string;
  content?: string;
  type: ComboBoxItemType;
  contextProvider?: ContextProviderDescription;
  query?: string;
  label?: string;
  icon?: string;
  action?: () => void;
  subActions?: ComboBoxSubAction[];
  slashCommandSource?: SlashCommandSource;
}
