"""
cancer_incidence_timeseries
===========================

Build a tidy (long-format) county-level ANNUAL cancer-incidence time series
(2020-2025) across multiple cancer sites for the contiguous US.

READ THIS FIRST -- what "annual 2020-2025 county incidence" really is
--------------------------------------------------------------------
Authoritative US county incidence (NCI State Cancer Profiles, built on CDC
NPCR + NCI SEER) is published as a *latest 5-year pooled* age-adjusted rate
(currently 2017-2021), NOT as a single-year county series -- single-year county
counts are too small/unstable and are suppressed under 16 cases. Registry data
also lags ~2-4 years, so the newest national data is ~2022; 2023-2025 county
incidence is not yet released.

Therefore a genuine ANNUAL 2020-2025 county panel is necessarily a MODELED
construct. This module:
  * ships real connectors to the actual sources (State Cancer Profiles CSV
    export; a documented CDC WONDER / USCS hook), which return the real
    5-year-pooled county rates, and
  * generates a reproducible SYNTHETIC annual panel that fills the exact target
    schema for every CONUS county x year x site, tagged so it is never confused
    with released data. A `data_status` column marks each year as
    released / preliminary / projected_not_released to encode the real lag.

FINAL SCHEMA (one row = county x year x cancer_site x sex x source)
------------------------------------------------------------------
    fips, county_name, state, state_abbr, year,
    cancer_site, sex, source,
    cases, population,
    crude_rate_per_100k, age_adjusted_rate_per_100k,
    pct_of_population,          # cases / population * 100  (requested metric)
    suppressed,                 # True if count < 16 (registry standard)
    data_status, notes

SOURCES WIRED IN
----------------
  StateCancerProfiles  statecancerprofiles.cancer.gov/incidencerates -- real CSV
                       export, county age-adjusted rate + average annual count +
                       CI, per site/sex. 5-YEAR POOLED (latest window).
  CDC_WONDER_USCS      wonder.cdc.gov United States Cancer Statistics (Incidence)
                       -- annual counts by site; county-level heavily suppressed.
                       Helper documents the XML request.
  Census_ACS           county population denominators.

Switch build_timeseries(use_synthetic=False) in an internet-enabled environment
to pull the live State Cancer Profiles data.
"""
from __future__ import annotations

import io
import os
import time
import warnings

import numpy as np
import pandas as pd

try:
    import requests
except ImportError:
    requests = None


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
CONUS_EXCLUDE_ST = {"02", "15", "60", "66", "69", "72", "74", "78"}
COUNTY_REF_LOCAL = "conus_counties.csv"           # written by the overdose build

FINAL_COLUMNS = [
    "fips", "county_name", "state", "state_abbr", "year",
    "cancer_site", "sex", "source", "cases", "population",
    "crude_rate_per_100k", "age_adjusted_rate_per_100k",
    "pct_of_population", "suppressed", "data_status", "notes",
]

# Sex share of population used for sex-specific denominators.
SEX_POP_FRACTION = {"Both sexes": 1.0, "Female": 0.508, "Male": 0.492}

# Representative cancer sites: (label, sex, approx US age-adjusted rate /100k).
# Rates are ballpark USCS figures used only to shape the synthetic demo.
CANCER_SITES: list[tuple[str, str, float]] = [
    ("All Cancer Sites",       "Both sexes", 442.0),
    ("Lung & Bronchus",        "Both sexes",  54.0),
    ("Colon & Rectum",         "Both sexes",  37.0),
    ("Female Breast",          "Female",     130.0),
    ("Prostate",               "Male",       112.0),
    ("Melanoma of the Skin",   "Both sexes",  22.0),
    ("Bladder",                "Both sexes",  19.0),
    ("Non-Hodgkin Lymphoma",   "Both sexes",  19.0),
    ("Kidney & Renal Pelvis",  "Both sexes",  17.0),
    ("Uterus (Corpus)",        "Female",      28.0),
    ("Leukemia",               "Both sexes",  14.0),
    ("Pancreas",               "Both sexes",  13.0),
    ("Thyroid",                "Both sexes",  13.0),
    ("Liver & Bile Duct",      "Both sexes",   9.0),
    ("Ovary",                  "Female",      10.0),
]

# State Cancer Profiles internal cancer codes for the LIVE connector.
# NOTE: SCP's numeric codes are idiosyncratic -- VERIFY each against the site's
# "Cancer:" dropdown before trusting a live pull. Left partial on purpose.
SCP_CANCER_CODES = {
    "All Cancer Sites": "001",
    "Lung & Bronchus": "047",
    "Colon & Rectum": "020",
    "Female Breast": "055",
    "Prostate": "066",
    "Melanoma of the Skin": "053",
    "Bladder": "071",
    "Non-Hodgkin Lymphoma": "086",
    "Kidney & Renal Pelvis": "072",
    "Uterus (Corpus)": "058",
    "Leukemia": "090",
    "Pancreas": "003",
    "Thyroid": "080",
    "Liver & Bile Duct": "035",
    "Ovary": "061",
}
SCP_SEX_CODE = {"Both sexes": "0", "Male": "1", "Female": "2"}
SCP_ENDPOINT = "https://statecancerprofiles.cancer.gov/incidencerates/index.php"


class PipelineConfig:
    def __init__(self, states=None, conus_only=True,
                 year_min=2020, year_max=2025, sites=None,
                 request_pause=0.3):
        self.states = states
        self.conus_only = conus_only
        self.year_min = year_min
        self.year_max = year_max
        self.sites = sites or [s[0] for s in CANCER_SITES]
        self.request_pause = request_pause


# --------------------------------------------------------------------------- #
# County reference
# --------------------------------------------------------------------------- #
def load_county_reference(cfg: PipelineConfig) -> pd.DataFrame:
    """Load the CONUS county table (fips, name, state, abbr, base_population)."""
    local = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         COUNTY_REF_LOCAL)
    if not os.path.exists(local):
        raise FileNotFoundError(
            f"{COUNTY_REF_LOCAL} not found next to this module. It is produced "
            "by the overdose pipeline's CONUS build; copy it alongside this file.")
    ref = pd.read_csv(local, dtype={"fips": str})
    ref["fips"] = ref["fips"].str.zfill(5)
    if cfg.conus_only:
        ref = ref[~ref["fips"].str[:2].isin(CONUS_EXCLUDE_ST)]
    if cfg.states:
        ref = ref[ref["state_abbr"].isin(cfg.states)]
    return ref.sort_values("fips").reset_index(drop=True)


# --------------------------------------------------------------------------- #
# Derived-metric helper / finaliser
# --------------------------------------------------------------------------- #
def _finalise(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["fips"] = df["fips"].astype(str).str.zfill(5)
    df["year"] = df["year"].astype("Int64")
    pop = df["population"].astype("float64")
    cases = df["cases"].astype("float64")
    with np.errstate(divide="ignore", invalid="ignore"):
        df["crude_rate_per_100k"] = np.where(pop > 0, cases / pop * 100_000, np.nan)
        df["pct_of_population"] = np.where(pop > 0, cases / pop * 100, np.nan)
    for col in FINAL_COLUMNS:
        if col not in df.columns:
            df[col] = pd.NA
    return (df[FINAL_COLUMNS]
            .sort_values(["fips", "cancer_site", "year"])
            .reset_index(drop=True))


# --------------------------------------------------------------------------- #
# LIVE connector: State Cancer Profiles (5-year pooled county rates)
# --------------------------------------------------------------------------- #
def fetch_scp_county_incidence(site: str, cfg: PipelineConfig) -> pd.DataFrame:
    """
    Pull real county age-adjusted incidence (latest 5-year pooled) for one site
    from State Cancer Profiles, looping the requested states.

    Returns one row per county with the pooled rate + average annual count; the
    5-year window is recorded in `data_status`. This is the real-world anchor
    the synthetic annual panel is calibrated to resemble.
    """
    if requests is None:
        raise RuntimeError("`requests` required for live fetches.")
    label, sex, _ = next(s for s in CANCER_SITES if s[0] == site)
    ccode = SCP_CANCER_CODES.get(site)
    if ccode is None:
        raise ValueError(f"No SCP code mapped for '{site}' (add + verify).")

    ref = load_county_reference(cfg)
    state_fips = sorted(ref["fips"].str[:2].unique())
    frames = []
    for sf in state_fips:
        params = {
            "stateFIPS": sf, "areatype": "county", "cancer": ccode,
            "race": "00", "sex": SCP_SEX_CODE[sex], "age": "001",
            "stage": "211", "year": "0", "type": "incd",
            "sortVariableName": "name", "sortOrder": "asc", "output": "1",
        }
        try:
            r = requests.get(SCP_ENDPOINT, params=params, timeout=60)
            r.raise_for_status()
            frames.append(_parse_scp_csv(r.text, site, sex))
        except Exception as exc:
            warnings.warn(f"SCP {site} state {sf} failed: {exc}")
        time.sleep(cfg.request_pause)
    if not frames:
        return pd.DataFrame()
    out = pd.concat(frames, ignore_index=True)
    return out[out["fips"].str[:2].isin(state_fips)]


def _parse_scp_csv(text: str, site: str, sex: str) -> pd.DataFrame:
    """Parse the quirky SCP CSV: skip prose header/footer, handle '*' / suppress."""
    lines = [ln for ln in text.splitlines() if "," in ln]
    # data rows start once we see a 5-digit FIPS in the 2nd field
    rows = []
    for ln in lines:
        parts = next(csv_reader(ln))
        if len(parts) < 4:
            continue
        fips = parts[1].strip()
        if not (fips.isdigit() and len(fips) == 5 and fips[2:] != "000"):
            continue
        rate = _num(parts[3])
        cnt = _num(parts[10]) if len(parts) > 10 else np.nan
        name = parts[0].strip().strip('"')
        # SCP appends registry footnotes like "(6)" to county names
        name = name.split("(")[0].strip()
        rows.append(dict(fips=fips, county_name=name,
                         age_adjusted_rate_per_100k=rate, cases=cnt))
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["cancer_site"] = site
    df["sex"] = sex
    df["source"] = "StateCancerProfiles"
    df["suppressed"] = df["cases"].isna()
    df["data_status"] = "released_5yr_pooled"
    df["notes"] = "real; latest 5-yr pooled age-adjusted rate + avg annual count"
    return df


def csv_reader(line: str):
    import csv
    return csv.reader([line])


def _num(x: str) -> float:
    x = (x or "").strip().strip('"')
    if x in ("", "*", "N/A", "NA", "3 or fewer", "data not available", "**"):
        return np.nan
    try:
        return float(x.replace(",", ""))
    except ValueError:
        return np.nan


def cdc_wonder_uscs_query(state_fips: str, year: int, site: str) -> str:
    """
    Describe the CDC WONDER United States Cancer Statistics (Incidence) request
    for annual county counts. WONDER's D175/USCS databases take an XML
    <request-parameters> POST; county-year-site cells under 16 are suppressed
    and the most recent years are unavailable at county level.
    """
    return (f"CDC WONDER USCS Incidence: site='{site}', state FIPS {state_fips}, "
            f"year {year}; group by County; counts <16 suppressed; recent years "
            f"unavailable at county level.")


# --------------------------------------------------------------------------- #
# Synthetic annual panel (2020-2025)
# --------------------------------------------------------------------------- #
def _covid_dip(year: int) -> float:
    """Documented pandemic disruption to cancer diagnosis (screening drop)."""
    return {2020: 0.90, 2021: 0.97}.get(year, 1.0)


def _site_year_drift(site: str, year: int) -> float:
    """Small site-specific secular trend, centred on 2022."""
    drift = {
        "Lung & Bronchus": -0.010, "Colon & Rectum": -0.006,
        "Melanoma of the Skin": 0.012, "Thyroid": 0.010,
        "Liver & Bile Duct": 0.008, "Pancreas": 0.004,
    }.get(site, 0.0)
    return 1.0 + drift * (year - 2022)


def _data_status(year: int) -> str:
    if year <= 2022:
        return "released"                     # realistically published
    if year == 2023:
        return "preliminary"                  # partial / early release
    return "projected_not_released"           # 2024-2025 not yet available


def generate_synthetic_panel(cfg: PipelineConfig, seed: int = 207) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    ref = load_county_reference(cfg)
    sites = [s for s in CANCER_SITES if s[0] in cfg.sites]
    years = range(cfg.year_min, cfg.year_max + 1)
    recs: list[dict] = []

    # a persistent per-county multiplier per site (geographic heterogeneity)
    for row in ref.itertuples(index=False):
        fips, name, state, abbr = (row.fips, row.county_name, row.state,
                                   row.state_abbr)
        pop_total_2018 = float(row.base_population)
        for site, sex, base_rate in sites:
            county_effect = rng.lognormal(0, 0.18)     # site-specific place effect
            for year in years:
                pop_drift = 1.0 + 0.004 * (year - 2020) + rng.normal(0, 0.005)
                pop_total = max(300, int(pop_total_2018 * pop_drift))
                pop_sex = int(pop_total * SEX_POP_FRACTION[sex])
                lam = (base_rate / 100_000 * pop_sex * county_effect
                       * _site_year_drift(site, year) * _covid_dip(year))
                cases = int(rng.poisson(max(0.0, lam)))
                supp = 1 <= cases <= 15                 # registry <16 suppression
                # age-adjusted rate: coherent with cases, mild standardisation noise
                aar = (cases / pop_sex * 100_000 * rng.lognormal(0, 0.05)
                       if pop_sex else np.nan)
                recs.append(dict(
                    fips=fips, county_name=name, state=state, state_abbr=abbr,
                    year=year, cancer_site=site, sex=sex,
                    source="USCS_Modeled_Annual (SYNTHETIC_DEMO)",
                    cases=(np.nan if supp else cases),
                    population=pop_sex,
                    age_adjusted_rate_per_100k=(np.nan if supp else round(aar, 1)),
                    suppressed=supp,
                    data_status=_data_status(year),
                    notes="synthetic; modeled annual county incidence "
                          "(real county data is 5-yr pooled, lags ~2-4y)"))
    return pd.DataFrame(recs)


# --------------------------------------------------------------------------- #
# Orchestrator
# --------------------------------------------------------------------------- #
def build_timeseries(cfg: PipelineConfig | None = None,
                     use_synthetic: bool = False) -> pd.DataFrame:
    cfg = cfg or PipelineConfig()
    if use_synthetic:
        return _finalise(generate_synthetic_panel(cfg))

    frames = []
    for site in cfg.sites:
        try:
            part = fetch_scp_county_incidence(site, cfg)
            if part is not None and not part.empty:
                frames.append(part)
                print(f"[ok]   SCP {site}: {len(part):,} counties")
            else:
                print(f"[warn] SCP {site}: no rows")
        except Exception as exc:
            print(f"[fail] SCP {site}: {exc}")
    if not frames:
        raise RuntimeError("No live source succeeded; use use_synthetic=True.")
    combined = pd.concat(frames, ignore_index=True)
    combined["population"] = np.nan          # join Census ACS denominators here
    return _finalise(combined)


if __name__ == "__main__":
    cfg = PipelineConfig(states=None, conus_only=True, year_min=2020, year_max=2025)
    ts = build_timeseries(cfg, use_synthetic=True)
    print(ts.head(10).to_string(index=False))
    print("\nshape:", ts.shape,
          "| counties:", ts["fips"].nunique(),
          "| sites:", ts["cancer_site"].nunique(),
          "| years:", sorted(ts["year"].dropna().unique().tolist()))
