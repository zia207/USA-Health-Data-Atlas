#!/usr/bin/env python3
"""Embed consolidated CHR county CSVs as loadable JS bundles (works without HTTP server)."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSV_DIR = ROOT / "data" / "county_health_ranking"
OUT_DIR = ROOT / "assets" / "chr_county_data"
YEARS = [2020, 2021, 2022, 2023, 2024, 2025]


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for year in YEARS:
        csv_path = CSV_DIR / f"chr_county_{year}.csv"
        if not csv_path.exists():
            print(f"skip {year}: missing {csv_path}")
            continue
        text = csv_path.read_text(encoding="utf-8")
        key = f"CHR_COUNTY_CSV_{year}"
        js = (
            f"(function(g){{g.{key}={json.dumps(text)};}})"
            f'(typeof window!=="undefined"?window:globalThis);\n'
        )
        out = OUT_DIR / f"chr_county_{year}.js"
        out.write_text(js, encoding="utf-8")
        print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
