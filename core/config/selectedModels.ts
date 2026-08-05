import { ModelRole } from "@continuedev/config-yaml";

import { ContinueConfig, ILLM } from "..";
import { LLMConfigurationStatuses } from "../llm/constants";
import {
  GlobalContext,
  GlobalContextModelSelections,
} from "../util/GlobalContext";

export function rectifySelectedModelsFromGlobalContext(
  continueConfig: ContinueConfig,
  profileId: string,
): ContinueConfig {
  const configCopy = { ...continueConfig };

  const globalContext = new GlobalContext();
  const currentSelectedModels = globalContext.get("selectedModelsByProfileId");
  const currentForProfile: GlobalContextModelSelections =
    currentSelectedModels?.[profileId] ?? {};

  // When enabled, the user's previously-chosen model for a role is preserved
  // even if it is not currently available, instead of auto-switching to the
  // first available model. The selection simply becomes null (surfacing an
  // error at use time) and the original choice in GlobalContext is left intact
  // so it auto-recovers once the model is available again.
  const disableAutoSwitch =
    !!globalContext.getSharedConfig().disableModelAutoSwitch;

  let fellBack = false;

  // Roles whose stored selection is intentionally pinned (auto-switch
  // disabled) because the chosen model isn't currently available. For these
  // roles the stored choice in GlobalContext must be preserved as-is rather
  // than overwritten during the fellBack rewrite below.
  const pinnedRoles = new Set<ModelRole>();

  // summarize not implemented yet
  const roles: ModelRole[] = [
    "autocomplete",
    "apply",
    "edit",
    "embed",
    "rerank",
    "chat",
  ];

  for (const role of roles) {
    let newModel: ILLM | null = null;
    const currentSelection = currentForProfile[role] ?? null;

    if (currentSelection) {
      const match = continueConfig.modelsByRole[role].find(
        (m) => m.title === currentSelection,
      );
      if (match) {
        newModel = match;
      }
    }

    // The user's choice couldn't be matched (either the model is missing from
    // the list, or the list is empty because the model failed to load).
    // Normally we fall back to the first available model, but when auto-switch
    // is disabled and the user had previously selected something, we keep the
    // selection as null (error at use time) and leave the stored choice
    // untouched so it auto-recovers once the model is available again.
    // NOTE: this check must happen regardless of whether the list is empty,
    // since Autocomplete/Embed/Rerank may produce an empty list when their
    // model is temporarily unavailable.
    if (!newModel && disableAutoSwitch && currentSelection) {
      pinnedRoles.add(role);
      configCopy.selectedModelByRole[role] = null;
      continue;
    }

    if (!newModel && continueConfig.modelsByRole[role].length > 0) {
      newModel = continueConfig.modelsByRole[role][0];
    }

    if (!(currentSelection === (newModel?.title ?? null))) {
      fellBack = true;
    }

    // Currently only check for configuration status for apply
    if (
      role === "apply" &&
      newModel?.getConfigurationStatus() !== LLMConfigurationStatuses.VALID
    ) {
      continue;
    }

    configCopy.selectedModelByRole[role] = newModel;
  }

  // In the case shared config wasn't respected,
  // Rewrite the shared config
  if (fellBack) {
    globalContext.update("selectedModelsByProfileId", {
      ...currentSelectedModels,
      [profileId]: Object.fromEntries(
        Object.entries(configCopy.selectedModelByRole).map(([key, value]) => [
          key,
          // For pinned roles, preserve the user's original stored choice
          // instead of overwriting it with the null used at runtime.
          pinnedRoles.has(key as ModelRole)
            ? (currentForProfile[key as ModelRole] ?? null)
            : (value?.title ?? null),
        ]),
      ),
    });
  }

  return configCopy;
}
