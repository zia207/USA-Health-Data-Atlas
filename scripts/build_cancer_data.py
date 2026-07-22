#!/usr/bin/env python3
"""Build compact JS assets for usa_cancer_atlas.html from cancer parquet files."""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "cancer"
OUT = ROOT / "assets"

DATASETS = [
    {
        "parquet": DATA / "conus_cancer_incidence_timeseries.parquet",
        "out": OUT / "cancer_incidence_timeseries_data.js",
        "global": "CANCER_INCIDENCE_TS_DATA",
        "meta": {
            "id": "incidence_ts",
            "title": "Cancer Incidence Time Series",
            "subtitle": "Modeled annual county incidence (2020–2025)",
            "doc_md": "data/cancer/CONUS_Cancer_Incidence_timeseries.md",
            "source": "State Cancer Profiles (anchor) + synthetic annual panel",
            "source_url": "https://statecancerprofiles.cancer.gov",
            "rate_label": "Age-adjusted incidence rate per 100,000",
            "rate_unit": "per 100,000",
            "has_year": True,
            "default_site": "All Cancer Sites",
            "default_year": 2022,
            "table": "cancer_incidence_ts",
            "caveat": (
                "Annual county values are synthetic (SYNTHETIC_DEMO). "
                "Use the 2017–2021 pooled incidence dataset for observed rates."
            ),
        },
        "cols": [
            "fips", "state_abbr", "county_name", "year", "cancer_site",
            "age_adjusted_rate_per_100k", "cases", "population",
            "suppressed", "data_status",
        ],
    },
    {
        "parquet": DATA / "conus_cancer_incidence_2017_2021.parquet",
        "out": OUT / "cancer_incidence_2017_2021_data.js",
        "global": "CANCER_INCIDENCE_5YR_DATA",
        "meta": {
            "id": "incidence_5yr",
            "title": "Cancer Incidence (2017–2021)",
            "subtitle": "Observed 5-year pooled county incidence",
            "doc_md": "data/cancer/CONUS_Cancer_Incidence_2017_2021_Data.md",
            "source": "State Cancer Profiles (NCI + CDC NPCR/SEER)",
            "source_url": "https://statecancerprofiles.cancer.gov",
            "rate_label": "Age-adjusted incidence rate per 100,000",
            "rate_unit": "per 100,000",
            "has_year": False,
            "period": "2017-2021",
            "default_site": "All Cancer Sites",
            "table": "cancer_incidence_5yr",
            "caveat": (
                "Pooled 2017–2021 average — not a single year. "
                "Kansas and DC are absent from county incidence."
            ),
        },
        "cols": [
            "fips", "state_abbr", "county_name", "cancer_site",
            "age_adjusted_rate_per_100k", "average_annual_count", "population_2018",
            "recent_trend", "recent_5yr_trend_pct", "data_status",
        ],
    },
    {
        "parquet": DATA / "conus_cancer_mortality_timeseries_2019_2023.parquet",
        "out": OUT / "cancer_mortality_timeseries_data.js",
        "global": "CANCER_MORTALITY_TS_DATA",
        "meta": {
            "id": "mortality_ts",
            "title": "Cancer Mortality Rate",
            "subtitle": "Reconstructed annual county mortality (2019–2023)",
            "doc_md": "data/cancer/CONUS_Cancer_Mortality_Data.md",
            "source": "State Cancer Profiles (pooled rate + APC reconstruction)",
            "source_url": "https://statecancerprofiles.cancer.gov",
            "rate_label": "Age-adjusted mortality rate per 100,000",
            "rate_unit": "per 100,000",
            "has_year": True,
            "default_site": "All Cancer Sites",
            "default_year": 2021,
            "table": "cancer_mortality_ts",
            "caveat": (
                "Annual values are reconstructed from published pooled rates and APC trends — "
                "not observed single-year death counts."
            ),
        },
        "cols": [
            "fips", "state_abbr", "county_name", "year", "cancer_site",
            "age_adjusted_rate_per_100k", "pooled_rate_2019_2023", "modeled_deaths",
            "population_2018", "recent_trend", "data_status",
        ],
    },
]


def _clean_value(v):
    if pd.isna(v):
        return None
    if hasattr(v, "item"):
        return v.item()
    return v


def build_one(spec: dict) -> None:
    df = pd.read_parquet(spec["parquet"])
    cols = spec["cols"]
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise KeyError(f"{spec['parquet'].name}: missing columns {missing}")

    rows = [
        [_clean_value(row[c]) for c in cols]
        for _, row in df[cols].iterrows()
    ]

    meta = dict(spec["meta"])
    if "year" in cols:
        meta["years"] = sorted(int(y) for y in df["year"].dropna().unique())
    meta["sites"] = sorted(df["cancer_site"].dropna().unique().tolist())
    meta["n_rows"] = len(rows)
    meta["n_counties"] = int(df["fips"].nunique())

    payload = {"meta": meta, "cols": cols, "rows": rows}
    OUT.mkdir(parents=True, exist_ok=True)
    js = f"window.{spec['global']} = " + json.dumps(payload, separators=(",", ":")) + ";\n"
    spec["out"].write_text(js, encoding="utf-8")
    print(
        f"Wrote {spec['out']} ({spec['out'].stat().st_size / 1e6:.2f} MB) "
        f"· {len(rows):,} rows · {meta['n_counties']:,} counties"
    )


def main() -> None:
    for spec in DATASETS:
        build_one(spec)


if __name__ == "__main__":
    main()
