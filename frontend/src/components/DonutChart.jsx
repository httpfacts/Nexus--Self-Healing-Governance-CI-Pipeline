// Small dependency-free ring chart -- stacked stroke-dasharray arcs on a
// single circle, rotated to start at 12 o'clock. Good enough for a two- or
// three-way split; not meant to replace a real charting library.
export default function DonutChart({ segments, size = 120, strokeWidth = 16 }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border)" strokeWidth={strokeWidth} />
      {total > 0 &&
        segments
          .filter((s) => s.value > 0)
          .map((s, i) => {
            const dash = (s.value / total) * circumference;
            const el = (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={s.color}
                strokeWidth={strokeWidth}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              />
            );
            offset += dash;
            return el;
          })}
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" className="donut-center-label">
        {total}
      </text>
    </svg>
  );
}
