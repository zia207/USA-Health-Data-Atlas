"""
build_scp_5yr_incidence.py
==========================

Build a REAL county-level cancer-incidence dataframe for the latest 5-year
pooled window (currently 2017-2021) across the contiguous US, from the
authoritative State Cancer Profiles data (NCI + CDC NPCR/SEER).

Source: `seandavi/state-cancer-profile-scraper`, which republishes the full
State Cancer Profiles incidence tables monthly as a GitHub release (long format,
all states/counties). This is the same data the site's CSV export returns, in
bulk. https://github.com/seandavi/state-cancer-profile-scraper

Unlike the modeled annual panel, these are OBSERVED, published figures. The
"year" field in the source is literally "Latest 5-year average" (2017-2021 for
the current incidence release). Age-adjusted rates are per 100,000, standardized
to the 2000 US population, computed in SEER*Stat.

Known, real coverage limits (not pipeline bugs):
  * Kansas releases no county-level incidence -> absent nationwide.
  * DC appears at state level only -> not in the county table.
  * Suppressed county x site cells (<16 cases) are simply absent as rows, so
    rarer sites cover fewer counties than "All Cancer Sites".
"""
from __future__ import annotations

import io
import json
import os
import urllib.request

import numpy as np
import pandas as pd

REPO = "seandavi/state-cancer-profile-scraper"
CONUS_EXCLUDE_ST = {"02", "15", "60", "66", "69", "72", "74", "78"}
COUNTY_REF_LOCAL = "conus_counties.csv"

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
    "fips", "county_name", "state", "state_abbr", "period",
    "cancer_site", "sex", "source",
    "age_adjusted_rate_per_100k", "rate_ci_lower", "rate_ci_upper",
    "average_annual_count", "population_2018",
    "crude_rate_per_100k", "pct_of_population",
    "recent_trend", "recent_5yr_trend_pct", "suppressed", "data_status",
]


def latest_incidence_asset_url() -> str:
    """Resolve the newest release's incidence asset download URL."""
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/releases?per_page=10",
        headers={"Accept": "application/vnd.github+json",
                 "User-Agent": "scp-5yr-builder"})
    with urllib.request.urlopen(req, timeout=60) as r:
        releases = json.load(r)
    for rel in releases:                                # newest first
        for a in rel.get("assets", []):
            if a["name"] == "state_cancer_profiles_incidence.csv.gz":
                return a["browser_download_url"]
    raise RuntimeError("No incidence asset found in recent releases.")


def _num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(
        s.replace({"*": np.nan, "": np.nan, "N/A": np.nan, "3 or fewer": np.nan,
                   "data not available": np.nan, "**": np.nan}), errors="coerce")


def build(local_gz: str | None = None,
          county_ref: str = COUNTY_REF_LOCAL) -> pd.DataFrame:
    """
    Return the tidy CONUS 5-year-pooled county incidence dataframe.

    local_gz: path to a previously downloaded incidence .csv.gz (skips the
              network fetch). If None, the latest release is downloaded.
    """
    src = local_gz or latest_incidence_asset_url()
    cols = ["fips", "age_adjusted_rate_per_100_000", "lower_ci_rate",
            "upper_ci_rate", "average_annual_count", "recent_trend",
            "recent_5_year_trend_in_rate", "sex", "stage", "race", "cancer",
            "age", "state_fips", "locale_type", "locale", "state"]
    df = pd.read_csv(src, usecols=cols, dtype=str, low_memory=False)

    # requested slice: county, all stages/ages/races, meaningful sex per site
    df = df[(df.locale_type == "county") & (df.stage == "All Stages")
            & (df.age == "All Ages")
            & (df.race == "All Races (includes Hispanic)")].copy()
    keep_sex = np.where(df.cancer.isin(FEMALE_SITES), df.sex == "Female",
                np.where(df.cancer.isin(MALE_SITES), df.sex == "Male",
                         df.sex == "Both Sexes"))
    df = df[keep_sex].copy()

    # CONUS + drop aggregate/blank rows
    df = df[~df.state_fips.isin(CONUS_EXCLUDE_ST)]
    df = df[(df.fips.str.len() == 5) & (df.fips.str[2:] != "000")]
    df = df[df.state.notna()].copy()

    for c in ["age_adjusted_rate_per_100_000", "lower_ci_rate", "upper_ci_rate",
              "average_annual_count", "recent_5_year_trend_in_rate"]:
        df[c] = _num(df[c])
    df["suppressed"] = df["age_adjusted_rate_per_100_000"].isna()

    df["state_abbr"] = df["state"].map(STATE_NAME_TO_ABBR)
    df = df[df.state_abbr.notna()].copy()
    df["county_name"] = df["locale"].str.strip() + ", " + df["state_abbr"]

    # population denominators (+ patch VA merged Bedford 51917 -> 51019)
    ref = pd.read_csv(county_ref, dtype={"fips": str})
    ref["fips"] = ref["fips"].str.zfill(5)
    pop = dict(zip(ref["fips"], ref["base_population"]))
    if "51019" in pop:
        pop.setdefault("51917", pop["51019"])
    df["population_2018"] = df["fips"].map(pop)

    df["crude_rate_per_100k"] = (df.average_annual_count
                                 / df.population_2018 * 100_000).round(1)
    df["pct_of_population"] = (df.average_annual_count
                               / df.population_2018 * 100).round(4)
    df["period"] = "2017-2021"
    df["source"] = "StateCancerProfiles"
    df["data_status"] = "released_5yr_pooled"
    df = df.rename(columns={
        "age_adjusted_rate_per_100_000": "age_adjusted_rate_per_100k",
        "lower_ci_rate": "rate_ci_lower", "upper_ci_rate": "rate_ci_upper",
        "recent_5_year_trend_in_rate": "recent_5yr_trend_pct",
        "cancer": "cancer_site"})
    return (df[FINAL_COLUMNS]
            .sort_values(["fips", "cancer_site"]).reset_index(drop=True))


if __name__ == "__main__":
    out = build(local_gz="scp_incidence.csv.gz" if os.path.exists(
        "scp_incidence.csv.gz") else None)
    os.makedirs("/mnt/user-data/outputs", exist_ok=True)
    out.to_parquet("/mnt/user-data/outputs/"
                   "conus_cancer_incidence_2017_2021.parquet", index=False)
    out.to_csv("/mnt/user-data/outputs/"
               "conus_cancer_incidence_2017_2021.csv", index=False)
    print("rows:", len(out), "| counties:", out.fips.nunique(),
          "| sites:", out.cancer_site.nunique(),
          "| states:", out.state_abbr.nunique())
