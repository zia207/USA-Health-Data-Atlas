#!/usr/bin/env python3
"""Build compact JS assets for usa_overdose_mortality.html from live CDC sources."""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "overdose_mortality_rate"
CONUS_COUNTIES = DATA / "conus_counties.csv"
MODEL_CACHE = DATA / "conus_overdose_model_based_cdc.parquet"
PROVISIONAL_CACHE = DATA / "conus_overdose_provisional_cdc.parquet"
OPIOID_CACHE = DATA / "conus_overdose_opioid_cdc.parquet"
OUT = ROOT / "assets"
DOC_MD = "data/overdose_mortality_rate/CONUS_Overdose_Timeseries_Data.md"

CDC_VIZ_URL = "https://www.cdc.gov/nchs/data-visualization/drug-poisoning-mortality/"
CDC_MODEL_DATA_URL = (
    "https://data.cdc.gov/National-Center-for-Health-Statistics/"
    "NCHS-Drug-Poisoning-Mortality-by-County-United-Sta/rpvx-m2md"
)
CDC_PROVISIONAL_DATA_URL = (
    "https://data.cdc.gov/National-Center-for-Health-Statistics/"
    "VSRR-Provisional-County-Level-Drug-Overdose-Death-Counts/gb4e-yj24"
)
CDC_VSRR_OPIOID_URL = (
    "https://data.cdc.gov/National-Center-for-Health-Statistics/"
    "VSRR-Provisional-Drug-Overdose-Death-Counts/xkb8-kh2a"
)

CDC_MODEL_API = "https://data.cdc.gov/resource/rpvx-m2md.json"
CDC_PROVISIONAL_API = "https://data.cdc.gov/resource/gb4e-yj24.json"
CDC_VSRR_OPIOID_API = "https://data.cdc.gov/resource/xkb8-kh2a.json"
OPIOID_INDICATOR = "Opioids (T40.0-T40.4,T40.6)"

MODEL_META = {
    "id": "overdose_model",
    "title": "Drug Overdose — Model-Based Rates",
    "subtitle": "NCHS hierarchical Bayesian county estimates (2003–2021)",
    "doc_md": DOC_MD,
    "source": "NCHS Drug Poisoning Mortality — County Estimates (rpvx-m2md)",
    "source_url": CDC_VIZ_URL,
    "data_url": CDC_MODEL_DATA_URL,
    "category": "drug_overdose_all",
    "category_label": "Drug overdose (all)",
    "rate_label": "Model-based overdose death rate per 100,000",
    "rate_unit": "per 100,000",
    "rate_col": "crude_rate_per_100k",
    "has_year": True,
    "default_year": 2021,
    "table": "overdose_model",
    "caveat": (
        "Observed CDC/NCHS model-based county estimates from hierarchical Bayesian models "
        "(INLA). Rates are posterior medians and may differ from WONDER counts. "
        "Window: 2003–2021 (contiguous U.S. counties)."
    ),
}
MODEL_COLS = [
    "fips", "state_abbr", "county_name", "year", "category",
    "deaths", "population", "crude_rate_per_100k", "pct_of_population",
    "lower95ci", "upper95ci", "urbanrural", "suppressed",
]

PROVISIONAL_META = {
    "id": "overdose_provisional",
    "title": "Drug Overdose — Provisional Counts",
    "subtitle": "NCHS VSRR provisional 12-month-ending county counts (2020→)",
    "doc_md": DOC_MD,
    "source": "NCHS VSRR Provisional County Drug Overdose Death Counts (gb4e-yj24)",
    "source_url": CDC_PROVISIONAL_DATA_URL,
    "category": "drug_overdose_all",
    "category_label": "Drug overdose (all)",
    "rate_label": "Crude overdose death rate per 100,000",
    "rate_unit": "per 100,000",
    "rate_col": "crude_rate_per_100k",
    "has_year": True,
    "default_year": 2024,
    "table": "overdose_provisional",
    "caveat": (
        "Observed CDC/NCHS VSRR provisional 12-month-ending county death counts. "
        "Counts of 1–9 are suppressed per NCHS confidentiality rules — do not sum "
        "suppressed cells for totals. Uses December month-ending values per year."
    ),
}
PROVISIONAL_COLS = [
    "fips", "state_abbr", "county_name", "year", "category",
    "deaths", "population", "crude_rate_per_100k", "pct_of_population", "suppressed",
]

OPIOID_META = {
    "id": "overdose_opioid",
    "title": "Opioid-Involved Overdose — VSRR (county-estimated)",
    "subtitle": "State VSRR opioid counts allocated to counties (2020→)",
    "doc_md": DOC_MD,
    "source": "NCHS VSRR state opioid counts (xkb8-kh2a) + county provisional allocation",
    "source_url": CDC_VSRR_OPIOID_URL,
    "category": "opioid",
    "category_label": "Opioid-involved overdose",
    "rate_label": "Estimated crude opioid overdose death rate per 100,000",
    "rate_unit": "per 100,000",
    "rate_col": "crude_rate_per_100k",
    "has_year": True,
    "default_year": 2024,
    "table": "overdose_opioid",
    "caveat": (
        "County values are estimated by allocating each state's VSRR provisional opioid "
        "death total to counties in proportion to county provisional all-drug overdose "
        "counts. Observed county opioid counts exist only via CDC WONDER (not available "
        "through the public API). Use for relative county patterns, not exact counts."
    ),
}
OPIOID_COLS = PROVISIONAL_COLS


def _clean_value(v):
    if pd.isna(v):
        return None
    if hasattr(v, "item"):
        return v.item()
    return v


def _load_conus() -> pd.DataFrame:
    conus = pd.read_csv(CONUS_COUNTIES, dtype={"fips": str})
    conus["fips"] = conus["fips"].str.zfill(5)
    return conus


def _paginate_soda(api_url: str, order: str = "fips,year") -> list[dict]:
    rows: list[dict] = []
    offset = 0
    page_size = 50_000
    while True:
        resp = requests.get(
            api_url,
            params={"$limit": page_size, "$offset": offset, "$order": order},
            timeout=180,
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        rows.extend(batch)
        offset += page_size
        time.sleep(0.2)
        if len(batch) < page_size:
            break
    return rows


def _pick_annual_month(group: pd.DataFrame) -> pd.DataFrame:
    g = group.copy()
    g["month"] = pd.to_numeric(g["month"], errors="coerce")
    dec = g[g["month"] == 12]
    if not dec.empty:
        return dec.iloc[[-1]]
    return g.loc[[g["month"].idxmax()]]


def _add_rates(df: pd.DataFrame) -> pd.DataFrame:
    pop = pd.to_numeric(df["population"], errors="coerce")
    deaths = pd.to_numeric(df["deaths"], errors="coerce")
    df = df.copy()
    df["crude_rate_per_100k"] = (deaths / pop * 100_000).where(pop > 0)
    df["pct_of_population"] = (deaths / pop * 100).where(pop > 0)
    return df


def fetch_cdc_model_based(refresh: bool = False) -> pd.DataFrame:
    if MODEL_CACHE.exists() and not refresh:
        print(f"Loading cached model-based data from {MODEL_CACHE}")
        return pd.read_parquet(MODEL_CACHE)

    print(f"Fetching CDC model-based county estimates from {CDC_MODEL_API} …")
    raw = pd.DataFrame(_paginate_soda(CDC_MODEL_API))
    conus = _load_conus()

    rate = pd.to_numeric(raw["model_based_death_rate"], errors="coerce")
    pop = pd.to_numeric(raw["population"], errors="coerce")
    out = pd.DataFrame({
        "fips": raw["fips"].astype(str).str.zfill(5),
        "county_name": raw["county"],
        "year": pd.to_numeric(raw["year"], errors="coerce").astype("Int64"),
        "category": "drug_overdose_all",
        "population": pop.astype("Int64"),
        "crude_rate_per_100k": rate,
        "lower95ci": pd.to_numeric(raw.get("lower95ci"), errors="coerce"),
        "upper95ci": pd.to_numeric(raw.get("upper95ci"), errors="coerce"),
        "urbanrural": raw.get("urbanrural"),
        "deaths": (rate / 100_000 * pop).round(1),
        "pct_of_population": rate / 1000.0,
        "suppressed": False,
    })
    out = out.merge(conus[["fips", "state_abbr"]], on="fips", how="inner")
    out = out.sort_values(["fips", "year"]).reset_index(drop=True)

    DATA.mkdir(parents=True, exist_ok=True)
    out.to_parquet(MODEL_CACHE, index=False)
    print(f"Cached {len(out):,} rows to {MODEL_CACHE}")
    return out


def fetch_cdc_provisional(refresh: bool = False) -> pd.DataFrame:
    if PROVISIONAL_CACHE.exists() and not refresh:
        print(f"Loading cached provisional data from {PROVISIONAL_CACHE}")
        return pd.read_parquet(PROVISIONAL_CACHE)

    print(f"Fetching CDC provisional county counts from {CDC_PROVISIONAL_API} …")
    raw = pd.DataFrame(_paginate_soda(CDC_PROVISIONAL_API, order="fips,year,month"))
    conus = _load_conus()

    raw["fips"] = raw["fips"].astype(str).str.zfill(5)
    raw["year"] = pd.to_numeric(raw["year"], errors="coerce").astype("Int64")
    annual = (
        raw.groupby(["fips", "year"], group_keys=False)
        .apply(_pick_annual_month, include_groups=False)
        .reset_index(drop=True)
    )

    deaths = pd.to_numeric(annual.get("provisional_drug_overdose"), errors="coerce")
    footnote = annual.get("footnote", pd.Series("", index=annual.index)).fillna("")
    suppressed = footnote.str.contains("suppressed", case=False, na=False) | deaths.isna()

    out = pd.DataFrame({
        "fips": annual["fips"],
        "year": annual["year"],
        "category": "drug_overdose_all",
        "deaths": deaths,
        "suppressed": suppressed,
    })
    out = out.merge(
        conus[["fips", "state_abbr", "county_name", "base_population"]],
        on="fips",
        how="inner",
    )
    out = out.rename(columns={"base_population": "population"})
    out["population"] = pd.to_numeric(out["population"], errors="coerce").astype("Int64")
    out.loc[out["suppressed"], "deaths"] = pd.NA
    out = _add_rates(out)
    out = out.sort_values(["fips", "year"]).reset_index(drop=True)

    DATA.mkdir(parents=True, exist_ok=True)
    out.to_parquet(PROVISIONAL_CACHE, index=False)
    print(f"Cached {len(out):,} rows to {PROVISIONAL_CACHE}")
    return out


def fetch_cdc_opioid_estimated(refresh: bool = False) -> pd.DataFrame:
    if OPIOID_CACHE.exists() and not refresh:
        print(f"Loading cached opioid data from {OPIOID_CACHE}")
        return pd.read_parquet(OPIOID_CACHE)

    print(f"Fetching CDC VSRR state opioid counts from {CDC_VSRR_OPIOID_API} …")
    prov = fetch_cdc_provisional(refresh=False)
    params = {
        "$where": f"indicator = '{OPIOID_INDICATOR}'",
        "$limit": 100_000,
        "$order": "state,year,month",
    }
    resp = requests.get(CDC_VSRR_OPIOID_API, params=params, timeout=180)
    resp.raise_for_status()
    raw = pd.DataFrame(resp.json())
    if raw.empty:
        raise RuntimeError("No VSRR opioid rows returned from CDC.")

    raw["year"] = pd.to_numeric(raw["year"], errors="coerce").astype("Int64")
    raw["month_num"] = pd.to_numeric(
        raw["month"].map({
            "January": 1, "February": 2, "March": 3, "April": 4,
            "May": 5, "June": 6, "July": 7, "August": 8,
            "September": 9, "October": 10, "November": 11, "December": 12,
        }),
        errors="coerce",
    )
    state_annual = (
        raw.groupby(["state", "year"], group_keys=False)
        .apply(lambda g: g.loc[[g["month_num"].idxmax()]], include_groups=False)
        .reset_index(drop=True)
    )
    state_annual["state_opioid_deaths"] = pd.to_numeric(
        state_annual["data_value"], errors="coerce"
    )
    state_annual = state_annual.dropna(subset=["state_opioid_deaths"])

    county_base = prov.loc[~prov["suppressed"]].copy()
    county_base["deaths"] = pd.to_numeric(county_base["deaths"], errors="coerce")
    county_base = county_base.dropna(subset=["deaths"])
    state_totals = (
        county_base.groupby(["state_abbr", "year"], as_index=False)["deaths"]
        .sum()
        .rename(columns={"deaths": "state_provisional_deaths"})
    )
    county_base = county_base.merge(state_totals, on=["state_abbr", "year"], how="left")
    county_base["share"] = county_base["deaths"] / county_base["state_provisional_deaths"]

    state_opioid = state_annual.rename(columns={"state": "state_abbr"})[
        ["state_abbr", "year", "state_opioid_deaths"]
    ]
    county_base = county_base.merge(state_opioid, on=["state_abbr", "year"], how="inner")
    county_base["opioid_deaths"] = (
        county_base["state_opioid_deaths"] * county_base["share"]
    ).round(1)

    out = pd.DataFrame({
        "fips": county_base["fips"],
        "state_abbr": county_base["state_abbr"],
        "county_name": county_base["county_name"],
        "year": county_base["year"],
        "category": "opioid",
        "deaths": county_base["opioid_deaths"],
        "population": county_base["population"],
        "suppressed": False,
    })
    out = _add_rates(out)
    out = out.sort_values(["fips", "year"]).reset_index(drop=True)

    DATA.mkdir(parents=True, exist_ok=True)
    out.to_parquet(OPIOID_CACHE, index=False)
    print(f"Cached {len(out):,} rows to {OPIOID_CACHE}")
    return out


def write_js(spec: dict, df: pd.DataFrame) -> None:
    cols = spec["cols"]
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise KeyError(f"{spec.get('global', '?')}: missing columns {missing}")

    rows = [
        [_clean_value(row[c]) for c in cols]
        for _, row in df[cols].iterrows()
    ]

    meta = dict(spec["meta"])
    if "year" in cols:
        meta["years"] = sorted(int(y) for y in df["year"].dropna().unique())
    meta["n_rows"] = len(rows)
    meta["n_counties"] = int(df["fips"].nunique())

    payload = {"meta": meta, "cols": cols, "rows": rows}
    OUT.mkdir(parents=True, exist_ok=True)
    out_path = spec["out"]
    js = f"window.{spec['global']} = " + json.dumps(payload, separators=(",", ":")) + ";\n"
    out_path.write_text(js, encoding="utf-8")
    print(
        f"Wrote {out_path} ({out_path.stat().st_size / 1e6:.2f} MB) "
        f"· {len(rows):,} rows · {meta['n_counties']:,} counties"
    )


def build_model_based(refresh: bool = False) -> None:
    df = fetch_cdc_model_based(refresh=refresh)
    write_js(
        {
            "out": OUT / "overdose_model_based_data.js",
            "global": "OVERDOSE_MODEL_DATA",
            "meta": MODEL_META,
            "cols": MODEL_COLS,
        },
        df,
    )


def build_provisional(refresh: bool = False) -> None:
    df = fetch_cdc_provisional(refresh=refresh)
    write_js(
        {
            "out": OUT / "overdose_provisional_data.js",
            "global": "OVERDOSE_PROVISIONAL_DATA",
            "meta": PROVISIONAL_META,
            "cols": PROVISIONAL_COLS,
        },
        df,
    )


def build_opioid(refresh: bool = False) -> None:
    df = fetch_cdc_opioid_estimated(refresh=refresh)
    write_js(
        {
            "out": OUT / "overdose_opioid_wonder_data.js",
            "global": "OVERDOSE_OPIOID_DATA",
            "meta": OPIOID_META,
            "cols": OPIOID_COLS,
        },
        df,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Build overdose mortality JS assets.")
    parser.add_argument(
        "--refresh-cdc",
        action="store_true",
        help="Re-download all live CDC/NCHS source tables.",
    )
    args = parser.parse_args()
    refresh = args.refresh_cdc
    build_model_based(refresh=refresh)
    build_provisional(refresh=refresh)
    build_opioid(refresh=refresh)


if __name__ == "__main__":
    main()
