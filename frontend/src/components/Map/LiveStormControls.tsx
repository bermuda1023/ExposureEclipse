/**
 * Toolbar chip: opens/closes the live-storm picker panel. Lives up in the
 * toolbar with the other overlay controls so the panel no longer collides
 * with the wildfire panel on the right.
 */

import { useLiveStormStore } from "../../state/liveStorm";

export function LiveStormControls() {
  const open = useLiveStormStore((s) => s.pickerOpen);
  const activeId = useLiveStormStore((s) => s.activeStormId);
  const name = useLiveStormStore((s) => s.data?.storm.name);

  const on = open || !!activeId;
  // Clicking the toolbar chip toggles the picker panel. When the user
  // "clicks out" (closing the panel while a storm is active), also clear
  // the storm so its overlays disappear — otherwise the panel closes but
  // the tracks / envelopes / strike-prob circles stay painted with no
  // obvious way to remove them. Opens are always additive.
  const handleClick = () => {
    const s = useLiveStormStore.getState();
    if (s.pickerOpen) {
      if (s.activeStormId) s.clear();
      s.setPickerOpen(false);
    } else {
      s.setPickerOpen(true);
    }
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      style={{
        all: "unset",
        cursor: "pointer",
        padding: "3px 10px",
        borderRadius: 999,
        fontWeight: 600,
        fontSize: "0.66rem",
        color: on ? "white" : "var(--ink-700)",
        background: on ? "#0891b2" : "var(--ink-50)",
        border: `1px solid ${on ? "#0891b2" : "var(--ink-200)"}`,
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
      }}
      title="Live + replay hurricane overlay"
    >
      <span aria-hidden>🌀</span>
      {activeId && name ? `Live: ${name}` : "Live storm"}
    </button>
  );
}
