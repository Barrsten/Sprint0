import type { SbzhData, SbzhRecord, SbzhRow, Span } from "./types";

const number = (digits: number) =>
  new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const n3 = number(3),
  n2 = number(2),
  n0 = number(0);

export const fmt = (value: number | null | undefined, digits = 3) =>
  value === null || value === undefined
    ? "—"
    : (digits === 3 ? n3 : digits === 2 ? n2 : n0).format(value);

export function span(value: Span | null | undefined, digits = 3) {
  if (!value) return "—";
  const lo = fmt(value.min, digits),
    hi = fmt(value.max, digits);
  return lo === hi ? lo : `${lo}…${hi}`;
}

export const rowKey = (row: SbzhRow) => `${row.model ?? ""}::${row.mark}`;

export function concrete(r: {
  concreteGrade?: string | null;
  waterResistance?: string | null;
  frostResistance?: string | null;
}) {
  return (
    [r.concreteGrade, r.waterResistance, r.frostResistance]
      .filter(Boolean)
      .join(" ") || "—"
  );
}

export interface SbzhSet {
  rows: SbzhRow[];
  totals: { marks: number; products: number; volumeM3: number; massT: number };
  densityTPerM3: number;
}

export function combine(parts: SbzhData[]): SbzhSet {
  const rows = parts.flatMap((p) =>
    p.rows.map((r) => ({ ...r, model: r.model ?? p.model })),
  );
  return {
    rows,
    densityTPerM3: parts[0]?.densityTPerM3 ?? 2.5,
    totals: {
      marks: rows.length,
      products: rows.reduce((n, r) => n + r.count, 0),
      volumeM3: rows.reduce((n, r) => n + r.volumeTotalM3, 0),
      massT: rows.reduce((n, r) => n + r.massTotalT, 0),
    },
  };
}

/** Excel-friendly CSV, same layout as the converter's sbzh.csv. */
export function toCsv(data: SbzhSet) {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const num = (v: number | null | undefined) =>
    v === null || v === undefined ? "" : v.toFixed(3).replace(".", ",");
  const sp = (v: Span | null) => {
    if (!v) return "";
    const lo = num(v.min),
      hi = num(v.max);
    return lo === hi ? lo : `${lo}…${hi}`;
  };
  const lines = [
    [
      "№",
      "Модель",
      "Марка",
      "Наименование",
      "Вид",
      "Класс IFC",
      "Бетон",
      "W",
      "F",
      "Арматура",
      "Код ЭЛ",
      "Кол-во, шт",
      "Объём ед., м³",
      "Объём всего, м³",
      "Масса ед. (расч.), т",
      "Масса всего (расч.), т",
    ],
    ...data.rows.map((r, i) => [
      i + 1,
      r.model,
      r.mark,
      r.name,
      r.kind,
      r.ifcType,
      r.concreteGrade,
      r.waterResistance,
      r.frostResistance,
      r.reinforcementClass,
      r.elementCode,
      r.count,
      sp(r.unitVolumeM3),
      num(r.volumeTotalM3),
      sp(r.unitMassT),
      num(r.massTotalT),
    ]),
    [
      "",
      "",
      "Итого",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      data.totals.products,
      "",
      num(data.totals.volumeM3),
      "",
      num(data.totals.massT),
    ],
  ];
  return "﻿" + lines.map((l) => l.map(cell).join(";")).join("\r\n");
}

export function downloadCsv(data: SbzhSet, filename: string) {
  const url = URL.createObjectURL(
    new Blob([toCsv(data)], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Inspector rows for a single precast product. */
export function recordRows(r: SbzhRecord): [string, string][] {
  return [
    ["Марка", r.mark],
    ["Наименование", r.name ?? "—"],
    ["Вид", r.kind ?? "—"],
    ["Бетон", concrete(r)],
    ["Арматура", r.reinforcementClass ?? "—"],
    ["Код ЭЛ", r.elementCode ?? "—"],
    ["Объём", r.volumeM3 === null ? "—" : `${fmt(r.volumeM3)} м³`],
    ["Масса (расч.)", r.massT === null ? "—" : `${fmt(r.massT)} т`],
  ];
}
