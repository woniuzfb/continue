import { describe, expect, it } from "vitest";
import uiReducer, { DEFAULT_RULE_SETTING, toggleRuleSetting } from "./uiSlice";

type State = ReturnType<typeof uiReducer>;

/**
 * What the Rules switch shows (`RuleCard`):
 *   `state.ui.ruleSettings[rule.name] || DEFAULT_RULE_SETTING`
 *
 * A rule that was never toggled therefore already renders as "on". The toggle
 * used to switch on the **raw** stored value, so its `default` branch wrote the
 * default back into an unset rule: the first click changed nothing and every
 * rule took two clicks to turn off.
 */
const asRendered = (state: State, name: string) =>
  state.ruleSettings[name] || DEFAULT_RULE_SETTING;

const initial = () => uiReducer(undefined, { type: "@@INIT" });

describe("toggleRuleSetting", () => {
  it("turns a never-toggled rule off in a single click", () => {
    const state = initial();
    // Unset already renders as on — the switch is in the "on" position.
    expect(asRendered(state, "my-rule")).toBe("on");

    const clicked = uiReducer(state, toggleRuleSetting("my-rule"));

    // One click must land on the opposite of what the user saw, not on the
    // default it was already implicitly showing.
    expect(asRendered(clicked, "my-rule")).toBe("off");
  });

  it("cycles on → off → on afterwards", () => {
    let state = initial();
    state = uiReducer(state, toggleRuleSetting("my-rule"));
    expect(asRendered(state, "my-rule")).toBe("off");
    state = uiReducer(state, toggleRuleSetting("my-rule"));
    expect(asRendered(state, "my-rule")).toBe("on");
  });

  it("only touches the named rule", () => {
    let state = initial();
    state = uiReducer(state, toggleRuleSetting("rule-a"));

    expect(asRendered(state, "rule-a")).toBe("off");
    expect(asRendered(state, "rule-b")).toBe("on");
  });
});
