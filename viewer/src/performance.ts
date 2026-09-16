export function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  return {
    samples: values.length,
    mean,
    p50: q(0.5),
    p95: q(0.95),
    max: sorted.at(-1) ?? 0,
    min: sorted[0] ?? 0,
  };
}
export function latencyStatus(ms: number) {
  return ms <= 400 ? "PASS" : ms <= 800 ? "PASS_WITH_LIMITATIONS" : "FAIL";
}
export function downloadReport(value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "benchmark-report.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
