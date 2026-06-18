import { AggregationLevel } from "../../types/contracts";
import { useViewStore } from "../../state/view";

const ORDER: AggregationLevel[] = [
  AggregationLevel.COUNTRY,
  AggregationLevel.STATE,
  AggregationLevel.COUNTY,
  AggregationLevel.CRESTA,
];

export function AggregationLevelSelector() {
  const level = useViewStore((s) => s.aggregationLevel);
  const setLevel = useViewStore((s) => s.setAggregationLevel);
  return (
    <div role="radiogroup" aria-label="Aggregation level" style={{ display: "inline-flex", gap: 4 }}>
      {ORDER.map((l) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={l === level}
          onClick={() => setLevel(l)}
          style={{
            fontSize: "0.78rem",
            padding: "3px 8px",
            border: "1px solid",
            borderColor: l === level ? "#1565c0" : "#ccc",
            background: l === level ? "#e8f0fe" : "#fff",
            color: l === level ? "#0d47a1" : "#333",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
