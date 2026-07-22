#!/usr/bin/env python3
"""Build consolidated CHR county CSVs (2020–2025) and documentation."""

from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CSV_DIR = ROOT / "data" / "county_health_ranking" / "csv"
OUT_DIR = ROOT / "data" / "county_health_ranking"
DOCS_DIR = OUT_DIR / "docs"

YEARS = [2020, 2021, 2022, 2023, 2024, 2025]

YEAR_SHEETS = {
    2020: {
        "rankings": "outcomes_factors_rankings",
        "subrankings": "outcomes_factors_subrankings",
        "measures": "ranked_measure_data",
        "additional": "additional_measure_data",
        "measure_sources": "ranked_measure_sources_years",
        "addtl_sources": "addtl_measure_sources_years",
    },
    2021: {
        "rankings": "outcomes_factors_rankings",
        "subrankings": "outcomes_factors_subrankings",
        "measures": "ranked_measure_data",
        "additional": "additional_measure_data",
        "measure_sources": "ranked_measure_sources_years",
        "addtl_sources": "addtl_measure_sources_years",
    },
    2022: {
        "rankings": "outcomes_factors_rankings",
        "subrankings": "outcomes_factors_subrankings",
        "measures": "ranked_measure_data",
        "additional": "additional_measure_data",
        "measure_sources": "ranked_measure_sources_years",
        "addtl_sources": "addtl_measure_sources_years",
    },
    2023: {
        "rankings": "outcomes_factors_rankings",
        "subrankings": "outcomes_factors_subrankings",
        "measures": "ranked_measure_data",
        "additional": "additional_measure_data",
        "measure_sources": "ranked_measure_sources_years",
        "addtl_sources": "addtl_measure_sources_years",
    },
    2024: {
        "rankings": "health_outcomes_factors",
        "subrankings": None,
        "measures": "select_measure_data",
        "additional": "additional_measure_data",
        "measure_sources": "select_measure_sources_years",
        "addtl_sources": "addtl_measure_sources_years",
    },
    2025: {
        "rankings": "health_groups",
        "subrankings": None,
        "measures": "select_measure_data",
        "additional": "additional_measure_data",
        "measure_sources": "select_measure_sources_years",
        "addtl_sources": "addtl_measure_sources_years",
    },
}

ID_COLS = {"fips", "state_abbr", "county"}
KEEP_ID_COLS = ("year", "fips", "state_abbr", "county")
EXCLUDE_FIELD_RE = re.compile(
    r"95%\s*ci|quartile|unreliable|national z-score|health group range|z-score",
    re.I,
)
RANK_SHEET_TYPES = {"rankings", "subrankings"}

STATE_NAME_TO_ABBR = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
    "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "District Of Columbia": "DC",
    "District of Columbia": "DC", "Florida": "FL", "Georgia": "GA", "Hawaii": "HI",
    "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
    "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA",
    "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO", "Montana": "MT",
    "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ",
    "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND",
    "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI",
    "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX",
    "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA", "West Virginia": "WV",
    "Wisconsin": "WI", "Wyoming": "WY", "Puerto Rico": "PR",
}


def slug(text: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "_", str(text).strip().lower())
    return re.sub(r"_+", "_", s).strip("_") or "col"


def column_slug(group: str, field: str) -> str:
    group_ok = group and not group.lower().startswith("unnamed")
    g = slug(group) if group_ok else ""
    f = slug(field)
    if g and g == f:
        return f
    if g:
        return slug(f"{group}_{field}")
    return f


def dedupe_slug_name(col: str) -> str:
    parts = col.split("_")
    for n in range(len(parts) // 2, 0, -1):
        if parts[:n] == parts[n : 2 * n] and len(parts) == 2 * n:
            return "_".join(parts[:n])
    return col


def find_sheet(year: int, key: str) -> Path | None:
    pattern = YEAR_SHEETS[year].get(key)
    if not pattern:
        return None
    matches = sorted((CSV_DIR / str(year)).glob(f"{year}_{pattern}.csv"))
    return matches[0] if matches else None


def make_unique(names: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    out: list[str] = []
    for name in names:
        base = name or "col"
        if base not in seen:
            seen[base] = 0
            out.append(base)
            continue
        seen[base] += 1
        out.append(f"{base}_{seen[base]}")
    return out


def build_names(row0: pd.Series, row1: pd.Series, sheet_type: str) -> list[str]:
    groups = row0.ffill()
    names: list[str] = []
    for i in range(len(row1)):
        group = str(groups.iloc[i]).strip() if pd.notna(groups.iloc[i]) else ""
        field = str(row1.iloc[i]).strip() if pd.notna(row1.iloc[i]) else ""
        field_l = field.lower()

        if field_l == "fips":
            names.append("fips")
            continue
        if field_l == "state":
            names.append("state_abbr")
            continue
        if field_l == "county":
            names.append("county")
            continue
        if not field or field.startswith("Unnamed"):
            names.append(f"col_{i}")
            continue

        if sheet_type in RANK_SHEET_TYPES:
            if EXCLUDE_FIELD_RE.search(field):
                names.append(f"__skip_{i}")
                continue
            if field_l in {"rank", "quartile"} and group and not group.lower().startswith("unnamed"):
                names.append(column_slug(group, field))
            elif field_l.startswith("# of"):
                names.append(slug(field))
            else:
                names.append(column_slug(group, field) if group and not group.lower().startswith("unnamed") else slug(field))
            continue

        if EXCLUDE_FIELD_RE.search(field):
            names.append(f"__skip_{i}")
            continue

        names.append(column_slug(group, field))
    return make_unique(names)


def read_chr_sheet(path: Path, sheet_type: str) -> pd.DataFrame:
    raw = pd.read_csv(path, header=None, dtype=str)
    if len(raw) < 3:
        return pd.DataFrame()
    names = build_names(raw.iloc[0], raw.iloc[1], sheet_type)
    data = raw.iloc[2:].copy()
    data.columns = names

    drop = [c for c in data.columns if c.startswith("__skip_") or c.startswith("col_")]
    data = data.drop(columns=drop, errors="ignore")

    keep_cols = [c for c in data.columns if c in ID_COLS or not c.startswith("unnamed")]
    data = data[keep_cols]

    for c in data.columns:
        if c in ID_COLS:
            data[c] = data[c].astype(str).str.strip()
            continue
        data[c] = pd.to_numeric(data[c], errors="coerce")

    data = data[data["fips"].notna() & (data["fips"] != "")]
    data["fips"] = data["fips"].str.replace(r"\D", "", regex=True).str.zfill(5)
    data = data[data["fips"].str.len() == 5]
    data = data[data["county"].notna() & (data["county"] != "nan")]
    return data.reset_index(drop=True)


def merge_frames(frames: list[pd.DataFrame]) -> pd.DataFrame:
    if not frames:
        return pd.DataFrame()
    out = frames[0]
    for nxt in frames[1:]:
        overlap = (set(out.columns) & set(nxt.columns)) - ID_COLS
        if not overlap:
            out = out.merge(nxt, on=list(ID_COLS), how="outer")
            continue
        # Collapse duplicates by arithmetic mean of numeric values per county
        merged = out.merge(nxt, on=list(ID_COLS), how="outer", suffixes=("", "__r"))
        for col in overlap:
            left = merged[col]
            right = merged[f"{col}__r"]
            merged[col] = pd.concat([left, right], axis=1).mean(axis=1, skipna=True)
            merged = merged.drop(columns=[f"{col}__r"])
        out = merged
    return out


def normalize_state_abbr(df: pd.DataFrame) -> pd.DataFrame:
    if "state_abbr" not in df.columns:
        return df
    out = df.copy()

    def to_abbr(value: object) -> str:
        raw = str(value).strip()
        if not raw or raw.lower() == "nan":
            return raw
        if len(raw) == 2 and raw.isalpha():
            return raw.upper()
        return STATE_NAME_TO_ABBR.get(raw, STATE_NAME_TO_ABBR.get(raw.title(), raw))

    out["state_abbr"] = out["state_abbr"].map(to_abbr)
    return out


def collapse_duplicate_column_names(df: pd.DataFrame) -> pd.DataFrame:
    if df.columns.is_unique:
        return df
    grouped: dict[str, list[str]] = {}
    for col in df.columns:
        grouped.setdefault(col, []).append(col)
    pieces = []
    for name, cols in grouped.items():
        block = df.loc[:, cols]
        pieces.append(block.mean(axis=1, skipna=True).rename(name) if len(cols) > 1 else block.iloc[:, 0].rename(name))
    return pd.concat(pieces, axis=1)


def rename_repeated_slug_columns(df: pd.DataFrame) -> pd.DataFrame:
    renames = {col: dedupe_slug_name(col) for col in df.columns if dedupe_slug_name(col) != col}
    if not renames:
        return df
    out = df.rename(columns=renames)
    return collapse_duplicate_column_names(out)


def drop_empty_columns(df: pd.DataFrame) -> pd.DataFrame:
    keep = list(KEEP_ID_COLS)
    drop: list[str] = []
    for col in df.columns:
        if col in ID_COLS or col == "year":
            continue
        if df[col].isna().all():
            drop.append(col)
    return df.drop(columns=drop, errors="ignore")


def drop_identical_columns(df: pd.DataFrame) -> pd.DataFrame:
    cols = [c for c in df.columns if c not in KEEP_ID_COLS]
    drop: set[str] = set()
    for i, left in enumerate(cols):
        if left in drop:
            continue
        for right in cols[i + 1 :]:
            if right in drop:
                continue
            if df[left].equals(df[right]):
                drop.add(right)
    return df.drop(columns=list(drop), errors="ignore")


def clean_frame(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    out = rename_repeated_slug_columns(df)
    out = collapse_duplicate_column_names(out)
    out = drop_empty_columns(out)
    out = drop_identical_columns(out)
    out = normalize_state_abbr(out)
    out = out.loc[:, ~out.columns.duplicated()]
    try:
        from chr_column_names import rename_dataframe

        out, _ = rename_dataframe(out)
    except ImportError:
        pass
    return out


def build_year(year: int) -> pd.DataFrame:
    cfg = YEAR_SHEETS[year]
    frames: list[pd.DataFrame] = []
    for key in ("rankings", "subrankings", "measures", "additional"):
        sheet_key = cfg.get(key)
        if not sheet_key:
            continue
        path = find_sheet(year, key)
        if path is None:
            continue
        sheet_type = key if key in RANK_SHEET_TYPES else "measures"
        df = read_chr_sheet(path, sheet_type)
        if df.empty:
            continue
        frames.append(df)
    merged = merge_frames(frames)
    if merged.empty:
        return merged
    merged.insert(0, "year", year)
    merged["fips"] = merged["fips"].astype(str).str.zfill(5)
    return clean_frame(merged)


def read_introduction(year: int) -> list[str]:
    path = CSV_DIR / str(year) / f"{year}_introduction.csv"
    if not path.exists():
        return []
    lines: list[str] = []
    raw = pd.read_csv(path, header=None, dtype=str)
    for _, row in raw.iterrows():
        text = " ".join(str(v).strip() for v in row if pd.notna(v) and str(v).strip())
        if text and text.lower() != "nan":
            lines.append(text)
    return lines


def read_sources_table(year: int, key: str) -> pd.DataFrame:
    path = find_sheet(year, key)
    if path is None:
        return pd.DataFrame()
    return pd.read_csv(path, dtype=str)


def write_year_doc(year: int) -> None:
    intro = read_introduction(year)
    ranked_src = read_sources_table(year, "measure_sources")
    addtl_src = read_sources_table(year, "addtl_sources")

    lines = [
        f"# CHR County Data — {year}",
        "",
        f"Consolidated county-level **mean / primary value** measures from the "
        f"[County Health Rankings {year} release]"
        f"(https://www.countyhealthrankings.org/health-data/methodology-and-sources/data-documentation).",
        "",
        "## Output file",
        "",
        f"- `chr_county_{year}.csv` — one row per county; ranks from outcomes/subrankings sheets; "
        "primary measure values from ranked/select and additional measure sheets.",
        "",
        "## Introduction (from CHR release)",
        "",
    ]
    for para in intro[:25]:
        lines.append(f"- {para}")
    if len(intro) > 25:
        lines.append(f"- … ({len(intro) - 25} more lines in source introduction)")

    lines.extend(["", "## Ranked / select measure sources", ""])
    if not ranked_src.empty:
        lines.append("| Focus Area | Measure | Description | Source | Year(s) |")
        lines.append("|---|---|---|---|---|")
        for _, r in ranked_src.iterrows():
            measure = str(r.get("Measure", "")).strip()
            if not measure or measure.lower() == "nan":
                continue
            lines.append(
                "| {focus} | {measure} | {desc} | {src} | {yrs} |".format(
                    focus=str(r.get("Focus Area", "")).replace("|", "/"),
                    measure=measure.replace("|", "/"),
                    desc=str(r.get("Description", "")).replace("|", "/")[:120],
                    src=str(r.get("Source", "")).replace("|", "/"),
                    yrs=str(r.get("Year(s)", "")).replace("|", "/"),
                )
            )
    else:
        lines.append("_No ranked/select sources file for this year._")

    lines.extend(["", "## Additional measure sources", ""])
    if not addtl_src.empty:
        cols = list(addtl_src.columns)
        lines.append("| " + " | ".join(cols) + " |")
        lines.append("|" + "|".join(["---"] * len(cols)) + "|")
        for _, r in addtl_src.head(40).iterrows():
            lines.append("| " + " | ".join(str(r[c]).replace("|", "/") for c in cols) + " |")
        if len(addtl_src) > 40:
            lines.append(f"\n_… {len(addtl_src) - 40} more rows in source file._")
    else:
        lines.append("_No additional sources file for this year._")

    lines.extend([
        "",
        "## Processing notes",
        "",
        "- Merged sheets: outcomes/rankings, subrankings (2020–2023), ranked or select measure data, additional measure data.",
        "- Excluded auxiliary fields: 95% CI, quartiles, unreliable flags, z-scores (measure sheets).",
        "- Overlapping columns across sheets are collapsed with the **arithmetic mean** when both values exist.",
        "- Repeated group/field labels are collapsed to a single column slug (e.g. `food_environment_index`).",
        "- All-null and byte-identical duplicate columns are removed after merge.",
        "- `state_abbr` is stored as a two-letter USPS code.",
        "- Column names are standardized with `scripts/chr_column_names.py` (see Column dictionary).",
        "",
    ])

    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    (DOCS_DIR / f"CHR_County_Data_{year}.md").write_text("\n".join(lines), encoding="utf-8")


def write_master_doc(year_stats: list[tuple[int, int, int]]) -> None:
    lines = [
        "# CONUS County Health Rankings — Consolidated County Data (2020–2025)",
        "",
        "County-level measures from the [County Health Rankings & Roadmaps](https://www.countyhealthrankings.org/health-data/county-health-rankings-measures) "
        "national releases, merged into analysis-ready CSV files.",
        "",
        "## Files",
        "",
        "| File | Description |",
        "|---|---|",
        "| `chr_county_panel_2020_2025.csv` | All years stacked (`year` + `fips` + measures) |",
    ]
    for year, n_rows, n_cols in year_stats:
        lines.append(f"| `chr_county_{year}.csv` | {year} release · {n_rows:,} counties · {n_cols} columns |")
    lines.extend([
        "",
        "## Source workbooks",
        "",
        "Raw Excel exports live in `data/county_health_ranking/` and per-sheet CSVs in `csv/{year}/`.",
        "Official documentation: [CHR Data & Documentation](https://www.countyhealthrankings.org/health-data/methodology-and-sources/data-documentation).",
        "",
        "## Year-specific documentation",
        "",
    ])
    for year, _, _ in year_stats:
        lines.append(f"- [`docs/CHR_County_Data_{year}.md`](docs/CHR_County_Data_{year}.md)")
    lines.extend([
        "",
        "## Build",
        "",
        "```bash",
        "python scripts/build_chr_county_csv.py",
        "```",
        "",
        "## Processing rules",
        "",
        "1. **Rankings / subrankings** (2020–2023): within-state ranks and quartiles retained.",
        "2. **2024–2025**: `health_outcomes_factors` / `health_groups` replace legacy rankings sheets.",
        "3. **Measure values**: primary rates, counts, and percentages only (no CI / quartile / unreliable / z-score on measure sheets).",
        "4. **Duplicates**: overlapping county columns averaged; repeated slugs collapsed; empty/identical columns dropped.",
        "5. **State codes**: `state_abbr` normalized to two-letter abbreviations.",
        "",
    ])
    (OUT_DIR / "CONUS_CHR_County_Data.md").write_text("\n".join(lines), encoding="utf-8")


def clean_existing_outputs() -> list[tuple[int, int, int]]:
    year_stats: list[tuple[int, int, int]] = []
    panel_parts: list[pd.DataFrame] = []

    for year in YEARS:
        path = OUT_DIR / f"chr_county_{year}.csv"
        if not path.exists():
            print(f"{year}: missing {path.name}")
            continue
        df = pd.read_csv(path, low_memory=False)
        before = len(df.columns)
        df = clean_frame(df)
        df.to_csv(path, index=False)
        year_stats.append((year, len(df), len(df.columns)))
        panel_parts.append(df)
        print(f"{year}: cleaned {before} -> {len(df.columns)} cols -> {path.name}")

    panel_path = OUT_DIR / "chr_county_panel_2020_2025.csv"
    if panel_parts:
        panel = pd.concat(panel_parts, ignore_index=True, sort=False)
        before = len(panel.columns)
        panel = clean_frame(panel)
        panel.to_csv(panel_path, index=False)
        print(f"panel: cleaned {before} -> {len(panel.columns)} cols -> {panel_path.name}")
    elif panel_path.exists():
        panel = pd.read_csv(panel_path, low_memory=False)
        before = len(panel.columns)
        panel = clean_frame(panel)
        panel.to_csv(panel_path, index=False)
        print(f"panel: cleaned {before} -> {len(panel.columns)} cols -> {panel_path.name}")

    return year_stats


def main() -> None:
    year_stats: list[tuple[int, int, int]] = []
    panel_parts: list[pd.DataFrame] = []
    built_any = False

    for year in YEARS:
        df = build_year(year)
        if df.empty:
            continue
        built_any = True
        out_path = OUT_DIR / f"chr_county_{year}.csv"
        df.to_csv(out_path, index=False)
        year_stats.append((year, len(df), len(df.columns)))
        panel_parts.append(df)
        write_year_doc(year)
        print(f"{year}: {len(df):,} rows × {len(df.columns)} cols -> {out_path.name}")

    if not built_any:
        print("Source sheets not found — cleaning existing consolidated CSVs.")
        year_stats = clean_existing_outputs()
    elif panel_parts:
        panel = pd.concat(panel_parts, ignore_index=True, sort=False)
        panel = clean_frame(panel)
        panel_path = OUT_DIR / "chr_county_panel_2020_2025.csv"
        panel.to_csv(panel_path, index=False)
        print(f"panel: {len(panel):,} rows × {len(panel.columns)} cols -> {panel_path.name}")

    if year_stats:
        write_master_doc(year_stats)
        print(f"docs: {DOCS_DIR} + CONUS_CHR_County_Data.md")


if __name__ == "__main__":
    main()
