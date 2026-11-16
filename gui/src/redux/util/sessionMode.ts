import { MessageModes } from "core";

export function normalizeSessionMode(mode: unknown): MessageModes {
  if (mode === "agent-full" || mode === "agent" || mode === "background") {
    return mode;
  }
  return "plan";
}
