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

  const pushed = useLiveStormStore((s) => s.pushedToDetail);
  const on = open || !!activeId || pushed;
  // Chip toggles the chrome only. Overlays stay until ✕ on the panel.
  // Closing used to clear the storm, which made "get this off the map"
  // also wipe the track — that's why Collapse / → detail exist now.
  const handleClick = () => {
    const s = useLiveStormStore.getState();
    if (s.pushedToDetail) {
      s.popFromDetail();
      return;
    }
    if (s.pickerOpen) {
      s.setPickerOpen(false);
    } else {
      s.setCollapsed(false);
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
      title={
        pushed
          ? "Live storm is in the Detail rail — click to float it back on the map"
          : activeId
            ? "Show or hide the live-storm panel. Overlays stay until you press ✕."
            : "Live + replay hurricane overlay"
      }
    >
      <span aria-hidden>🌀</span>
      {activeId && name ? `Live: ${name}` : "Live storm"}
    </button>
  );
}
