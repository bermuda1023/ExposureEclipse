/**
 * Saffir-Simpson colours for hurricane track segments.
 * Matches the NHC's "wind speed probability" palette closely:
 *  TD  → slate, TS → cyan, Cat 1 → yellow, 2 → orange,
 *  3 → red, 4 → dark red, 5 → magenta.
 */
export const SAFFIR_SIMPSON_COLORS: Record<number, string> = {
  [-1]: "#94a3b8", // TD
  [0]: "#06b6d4",  // TS
  [1]: "#facc15",  // Cat 1
  [2]: "#fb923c",  // Cat 2
  [3]: "#ef4444",  // Cat 3
  [4]: "#b91c1c",  // Cat 4
  [5]: "#c026d3",  // Cat 5
};

export const SAFFIR_SIMPSON_LABEL: Record<number, string> = {
  [-2]: "No landfall",
  [-1]: "Tropical Depression",
  [0]: "Tropical Storm",
  [1]: "Cat 1",
  [2]: "Cat 2",
  [3]: "Cat 3",
  [4]: "Cat 4",
  [5]: "Cat 5",
};
