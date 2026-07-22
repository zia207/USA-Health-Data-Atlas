"""
build_scp_mortality_timeseries.py
=================================

Build an ANNUAL county-level cancer MORTALITY time series (2019-2023) for the
contiguous US, by cancer type, anchored to real State Cancer Profiles data
(NCI + CDC NPCR / NVSS), sourced in bulk from
`seandavi/state-cancer-profile-scraper` GitHub releases.

WHAT THIS IS (and how the time series is derived)
-------------------------------------------------
State Cancer Profiles publishes county mortality as a single "Latest 5-year
average" (2019-2023) age-adjusted rate PLUS a published recent annual percent
change (APC) from joinpoint regression. There is no observed single-year county
series in the bulk data -- that exists only in CDC WONDER (Underlying Cause of
Death, ICD-10 C00-C97, annual, county, counts <10 suppressed), which is a
documented connector below.

This module reconstructs a yearly series from TWO real published quantities per
county x site:

    rate(year)   = pooled_rate * (1 + APC/100) ** (year - 2021)     # 2021 = window midpoint
    deaths(year) = average_annual_count * (1 + APC/100) ** (year - 2021)

So the LEVEL (pooled rate) and the TREND (APC) are both real; the annual points
are a transparent interpolation whose geometric center equals the published
pooled rate. Counties without a published APC (~18%) are held flat and flagged.
These are reconstructed values, NOT observed annual death counts.

Real coverage facts (not bugs): Kansas releases no county data; DC is state-level
only; county x site cells with too few deaths are suppressed and therefore absent
as rows (rarer sites cover fewer counties).
"""
from __future__ import annotations

import json
import os
import urllib.request

import numpy as np
import pandas as pd

REPO = "seandavi/state-cancer-profile-scraper"
ASSET = "state_cancer_profiles_mortality.csv.gz"
CONUS_EXCLUDE_ST = {"02", "15", "60", "66", "69", "72", "74", "78"}
COUNTY_REF_LOCAL = "conus_counties.csv"
YEARS = [2019, 2020, 2021, 2022, 2023]
MIDPOINT = 2021

STATE_NAME_TO_ABBR = {
    "Alabama": "AL", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
    "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE",
    "District of Columbia": "DC", "Florida": "FL", "Georgia": "GA",
    "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA",
    "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME",
    "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN",
    "Mississippi": "MS", "Missouri": "MO", "Montana": "MT", "Nebraska": "NE",
    "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM",
    "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH",
    "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI",
    "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN",
    "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA",
    "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
}
FEMALE_SITES = {"Breast (Female)", "Breast (Female in situ)", "Cervix", "Ovary",
                "Uterus (Corpus & Uterus, NOS)"}
MALE_SITES = {"Prostate"}

FINAL_COLUMNS = [
    "fips", "county_name", "state", "state_abbr", "year",
    "cancer_site", "sex", "source",
    "age_adjusted_rate_per_100k",            # reconstructed for this year
    "pooled_rate_2019_2023",                 # real published level
    "rate_ci_lower", "rate_ci_upper",        # real (applies to pooled)
    "recent_trend", "recent_5yr_trend_pct",  # real published trend
    "modeled_deaths", "average_annual_count",
    "population_2018", "crude_rate_per_100k", "pct_of_population",
    "suppressed", "data_status", "notes",
]


def latest_asset_url(asset: str = ASSET) -> str:
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/releases?per_page=10",
        headers={"Accept": "application/vnd.github+json",
                 "User-Agent": "scp-mortality-builder"})
    with urllib.request.urlopen(req, timeout=60) as r:
        releases = json.load(r)
    for rel in releases:
        for a in rel.get("assets", []):
            if a["name"] == asset:
                return a["browser_download_url"]
    raise RuntimeError("No mortality asset found in recent releases.")


def _num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(
        s.replace({"*": np.nan, "": np.nan, "N/A": np.nan, "3 or fewer": np.nan,
                   "data not available": np.nan, "**": np.nan}), errors="coerce")


def _load_pooled(src: str, county_ref: str) -> pd.DataFrame:
    """Real 2019-2023 pooled county mortality (one row per county x site)."""
    cols = ["fips", "age_adjusted_rate_per_100_000", "lower_ci_rate",
            "upper_ci_rate", "average_annual_count", "recent_trend",
            "recent_5_year_trend_in_rate", "sex", "stage", "race", "cancer",
            "age", "state_fips", "locale_type", "locale", "state"]
    df = pd.read_csv(src, usecols=cols, dtype=str, low_memory=False)
    df = df[(df.locale_type == "county") & (df.stage == "All Stages")
            & (df.age == "All Ages")
            & (df.race == "All Races (includes Hispanic)")].copy()
    keep_sex = np.where(df.cancer.isin(FEMALE_SITES), df.sex == "Female",
                np.where(df.cancer.isin(MALE_SITES), df.sex == "Male",
                         df.sex == "Both Sexes"))
    df = df[keep_sex]
    df = df[~df.state_fips.isin(CONUS_EXCLUDE_ST)]
    df = df[(df.fips.str.len() == 5) & (df.fips.str[2:] != "000")]
    df = df[df.state.notna()].copy()

    df["pooled_rate"] = _num(df.age_adjusted_rate_per_100_000)
    df["rate_ci_lower"] = _num(df.lower_ci_rate)
    df["rate_ci_upper"] = _num(df.upper_ci_rate)
    df["avg_count"] = _num(df.average_annual_count)
    df["apc"] = _num(df.recent_5_year_trend_in_rate)
    df = df[df.pooled_rate.notna()].copy()

    df["state_abbr"] = df.state.map(STATE_NAME_TO_ABBR)
    df = df[df.state_abbr.notna()].copy()
    df["county_name"] = df.locale.str.strip() + ", " + df.state_abbr

    ref = pd.read_csv(county_ref, dtype={"fips": str})
    ref["fips"] = ref.fips.str.zfill(5)
    pop = dict(zip(ref.fips, ref.base_population))
    pop.setdefault("51917", pop.get("51019"))            # VA Bedford merge
    df["population_2018"] = df.fips.map(pop)
    return df


def build(local_gz: str | None = None,
          county_ref: str = COUNTY_REF_LOCAL) -> pd.DataFrame:
    """Return the tidy annual (2019-2023) CONUS county mortality time series."""
    src = local_gz or latest_asset_url()
    pooled = _load_pooled(src, county_ref)

    frames = []
    for year in YEARS:
        has_apc = pooled.apc.notna()
        factor = np.where(has_apc,
                          (1 + pooled.apc.fillna(0) / 100.0) ** (year - MIDPOINT),
                          1.0)
        rec = pd.DataFrame({
            "fips": pooled.fips.values,
            "county_name": pooled.county_name.values,
            "state": pooled.state.values,
            "state_abbr": pooled.state_abbr.values,
            "year": year,
            "cancer_site": pooled.cancer.values,
            "sex": pooled.sex.values,
            "source": "StateCancerProfiles (pooled rate + APC reconstruction)",
            "age_adjusted_rate_per_100k": (pooled.pooled_rate.values * factor).round(1),
            "pooled_rate_2019_2023": pooled.pooled_rate.values,
            "rate_ci_lower": pooled.rate_ci_lower.values,
            "rate_ci_upper": pooled.rate_ci_upper.values,
            "recent_trend": pooled.recent_trend.values,
            "recent_5yr_trend_pct": pooled.apc.values,
            "modeled_deaths": (pooled.avg_count.values * factor).round(0),
            "average_annual_count": pooled.avg_count.values,
            "population_2018": pooled.population_2018.values,
            "suppressed": False,
            "data_status": np.where(has_apc, "reconstructed_trended",
                                    "reconstructed_flat"),
        })
        frames.append(rec)

    ts = pd.concat(frames, ignore_index=True)
    ts["crude_rate_per_100k"] = (ts.modeled_deaths
                                 / ts.population_2018 * 100_000).round(1)
    ts["pct_of_population"] = (ts.modeled_deaths
                              / ts.population_2018 * 100).round(4)
    ts["notes"] = ("annual rate reconstructed from real 2019-2023 pooled rate + "
                   "published APC; not observed annual counts")
    return (ts[FINAL_COLUMNS]
            .sort_values(["fips", "cancer_site", "year"])
            .reset_index(drop=True))


def cdc_wonder_county_cancer_mortality(state_fips: str, year: int,
                                       icd10: str = "C00-C97") -> str:
    """Describe the CDC WONDER request for OBSERVED annual county cancer deaths."""
    return (f"CDC WONDER Underlying Cause of Death: ICD-10 {icd10}, state FIPS "
            f"{state_fips}, year {year}, group by County; counts <10 suppressed. "
            f"Use for observed annual county cancer mortality.")


if __name__ == "__main__":
    ts = build(local_gz="scp_mortality.csv.gz"
               if os.path.exists("scp_mortality.csv.gz") else None)
    os.makedirs("/mnt/user-data/outputs", exist_ok=True)
    ts.to_parquet("/mnt/user-data/outputs/"
                  "conus_cancer_mortality_timeseries_2019_2023.parquet", index=False)
    ts.to_csv("/mnt/user-data/outputs/"
              "conus_cancer_mortality_timeseries_2019_2023.csv", index=False)
    print("rows:", len(ts), "| counties:", ts.fips.nunique(),
          "| sites:", ts.cancer_site.nunique(),
          "| states:", ts.state_abbr.nunique(),
          "| years:", sorted(ts.year.unique()))
