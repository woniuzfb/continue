import { AppShell } from "../../components/AppShell";

/**
 * Route entry (方案.md §九.0). The shell itself lives in `components/AppShell`
 * so the boundary is explicit and statically testable.
 */
export default function GUI() {
  return <AppShell />;
}
