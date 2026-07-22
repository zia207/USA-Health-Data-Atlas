"""
county_overdose_timeseries
===========================

Build a tidy (long-format) county-level TIME SERIES of drug-overdose and
opioid-related mortality, harmonised across several public sources.

WHY LONG FORMAT
---------------
`source` and `category` are first-class columns, so the same
(county x year) can carry rows from multiple providers. That lets you compare
sources directly or pivot to wide with a one-liner:

    wide = (df.query("category=='drug_overdose_all'")
              .pivot_table(index=['fips','year'],
                           columns='source', values='age_adjusted_rate_per_100k'))

FINAL SCHEMA (one row = county x year x category x source)
----------------------------------------------------------
    fips                       5-digit county FIPS (str, zero-padded)
    county_name                e.g. "Tompkins County, NY"
    state / state_abbr         "New York" / "NY"
    year                       int
    category                   'drug_overdose_all' | 'opioid'
    source                     provider tag (see SOURCES below)
    deaths                     count (NaN when suppressed / not provided)
    population                 resident population denominator
    crude_rate_per_100k        deaths / population * 100_000
    age_adjusted_rate_per_100k model-based / direct age-adjusted rate when given
    pct_of_population          deaths / population * 100   <-- requested metric
    suppressed                 True if the source suppressed the count (NCHS: 1-9)
    notes                      provenance / caveat string

SOURCES WIRED IN
----------------
  NCHS_County_ModelBased   data.cdc.gov  pbkm-d27e  (drug poisoning, county,
                           1999-2015/2019). Gives POPULATION + a *binned*
                           age-adjusted rate ("4.1-6", ">30"). No raw deaths;
                           an approximate count is derived from the band
                           midpoint x population. category=drug_overdose_all.
  NCHS_Provisional_County  data.cdc.gov  gb4e-yj24  (12-month-ending provisional
                           overdose COUNTS by county of residence, ~2020->).
                           Counts 1-9 suppressed. category=drug_overdose_all.
  NCHS_VSRR_State_Opioid   data.cdc.gov  xkb8-kh2a  (VSRR provisional counts by
                           drug class incl. Opioids T40.0-T40.4,T40.6 -- STATE
                           level). Used as the opioid reference series because
                           there is no clean county-level opioid Socrata feed.
  CDC_WONDER               wonder.cdc.gov Multiple Cause of Death. County-level
                           OPIOID-specific final counts (underlying X40-X44,
                           X60-X64, X85, Y10-Y14 + contributing T40.0-T40.4,
                           T40.6). Heavily suppressed (<10) at county level.
                           Helper documents the query; API is form/XML based.
  Census_ACS               api.census.gov  county population denominators for
                           years/geographies the mortality files don't carry.

OFFLINE / DEMO
--------------
`build_timeseries(use_synthetic=True)` produces a realistic *synthetic* panel
(seeded, reproducible) so you can validate the schema without network access.
Rows are tagged with a "(SYNTHETIC_DEMO)" source suffix so real and demo data
are never confused. Switch to `use_synthetic=False` in an internet-enabled
environment to pull the live sources above.

ICD-10 case definitions
-----------------------
  Drug overdose (all):  underlying X40-X44, X60-X64, X85, Y10-Y14
  Opioid-related:       the above WITH contributing T40.0-T40.4, T40.6
"""
from __future__ import annotations

import io
import time
import warnings
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

try:
    import requests
except ImportError:  # requests only needed for live fetches
    requests = None


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
SODA_BASE = "https://data.cdc.gov/resource/{rid}.json"

RESOURCES = {
    "NCHS_County_ModelBased": "pbkm-d27e",   # county drug-poisoning rates + pop
    "NCHS_Provisional_County": "gb4e-yj24",  # 12mo-ending provisional counts
    "NCHS_VSRR_State_Opioid": "xkb8-kh2a",   # state counts by drug class
}

CATEGORIES = ("drug_overdose_all", "opioid")

# Continental / contiguous US = 48 states + DC. Exclude Alaska (02), Hawaii (15)
# and all territories (>=60). DC (11) is kept.
CONUS_EXCLUDE_ST = {"02", "15", "60", "66", "69", "72", "74", "78"}

STATE_NAME = {
    "AL": "Alabama", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia",
    "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
    "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine",
    "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska",
    "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico",
    "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
    "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island",
    "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
    "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}

# County reference (FIPS + name + population) for the synthetic demo. Primary is
# a bundled CSV written next to this module; if absent it is fetched from GitHub.
COUNTY_REF_LOCAL = "conus_counties.csv"
COUNTY_REF_URL = ("https://raw.githubusercontent.com/JieYingWu/"
                  "COVID-19_US_County-level_Summaries/master/data/counties.csv")

FINAL_COLUMNS = [
    "fips", "county_name", "state", "state_abbr", "year",
    "category", "source", "deaths", "population",
    "crude_rate_per_100k", "age_adjusted_rate_per_100k",
    "pct_of_population", "suppressed", "notes",
]


@dataclass
class PipelineConfig:
    states: list[str] | None = None          # e.g. ["NY"]; None = all
    conus_only: bool = True                  # drop AK, HI, territories
    year_min: int = 1999
    year_max: int = 2023
    socrata_app_token: str | None = None     # optional, raises rate limits
    census_api_key: str | None = None
    page_size: int = 50_000
    request_pause: float = 0.2               # be polite to the API
    _headers: dict = field(default_factory=dict, init=False)

    def __post_init__(self):
        if self.socrata_app_token:
            self._headers["X-App-Token"] = self.socrata_app_token


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _band_midpoint(band: str) -> float:
    """Convert an NCHS rate band like '4.1-6' or '>30' to a numeric midpoint."""
    if band is None or (isinstance(band, float) and np.isnan(band)):
        return np.nan
    b = str(band).strip()
    if b.startswith(">"):
        lo = float(b[1:])
        return lo + 1.0                      # open-ended top band, nominal +1
    if b.startswith("<"):
        return float(b[1:]) / 2.0
    if "-" in b:
        lo, hi = b.split("-", 1)
        try:
            return (float(lo) + float(hi)) / 2.0
        except ValueError:
            return np.nan
    try:
        return float(b)
    except ValueError:
        return np.nan


def _finalise(df: pd.DataFrame) -> pd.DataFrame:
    """Compute derived metrics and enforce column order / dtypes."""
    df = df.copy()
    df["fips"] = df["fips"].astype(str).str.zfill(5)
    df["year"] = df["year"].astype("Int64")

    pop = df["population"].astype("float64")
    deaths = df["deaths"].astype("float64")

    # crude rate & pct-of-population from raw deaths where available
    with np.errstate(divide="ignore", invalid="ignore"):
        df["crude_rate_per_100k"] = np.where(
            pop > 0, deaths / pop * 100_000, np.nan)
        df["pct_of_population"] = np.where(
            pop > 0, deaths / pop * 100, np.nan)

    # where only an age-adjusted rate exists, keep it; pct can be back-derived
    aar = df.get("age_adjusted_rate_per_100k")
    if aar is not None:
        need_pct = df["pct_of_population"].isna() & aar.notna()
        df.loc[need_pct, "pct_of_population"] = aar[need_pct] / 100_000 * 100

    for col in FINAL_COLUMNS:
        if col not in df.columns:
            df[col] = pd.NA
    return (df[FINAL_COLUMNS]
            .sort_values(["fips", "category", "source", "year"])
            .reset_index(drop=True))


def _apply_conus_filter(df: pd.DataFrame, cfg: PipelineConfig) -> pd.DataFrame:
    """Restrict to the contiguous US (48 states + DC) when cfg.conus_only."""
    if not cfg.conus_only or df.empty:
        return df
    st = df["fips"].astype(str).str.zfill(5).str[:2]
    keep = ~st.isin(CONUS_EXCLUDE_ST)
    if "state_abbr" in df:  # also honour explicit non-CONUS abbrevs (state rows)
        keep &= ~df["state_abbr"].isin(["AK", "HI", "PR", "GU", "VI", "AS", "MP"])
    return df[keep]


def load_county_reference(cfg: PipelineConfig) -> list[tuple]:
    """
    Return [(fips, county_name, state, state_abbr, base_population), ...] for the
    requested scope. Prefers the bundled CSV; falls back to a GitHub fetch, then
    to the built-in NY table if both are unavailable (fully offline).
    """
    ref = None
    import os
    local = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         COUNTY_REF_LOCAL)
    if os.path.exists(local):
        ref = pd.read_csv(local, dtype={"fips": str})
    elif requests is not None:
        try:
            raw = pd.read_csv(COUNTY_REF_URL, dtype={"FIPS": str},
                              usecols=["FIPS", "State", "Area_Name",
                                       "POP_ESTIMATE_2018"])
            raw["FIPS"] = raw["FIPS"].str.zfill(5)
            raw = raw[(raw["FIPS"].str[2:] != "000")
                      & raw["State"].isin(STATE_NAME)].copy()
            ref = pd.DataFrame({
                "fips": raw["FIPS"],
                "county_name": raw["Area_Name"].str.strip() + ", " + raw["State"],
                "state": raw["State"].map(STATE_NAME),
                "state_abbr": raw["State"],
                "base_population": pd.to_numeric(raw["POP_ESTIMATE_2018"],
                                                 errors="coerce"),
            }).dropna(subset=["base_population"])
        except Exception as exc:
            warnings.warn(f"county reference fetch failed: {exc}")

    if ref is None:                                   # last-resort NY fallback
        ref = pd.DataFrame(
            [(f, n, "New York", "NY", p) for f, n, p in _NY_COUNTIES],
            columns=["fips", "county_name", "state", "state_abbr",
                     "base_population"])

    ref["fips"] = ref["fips"].astype(str).str.zfill(5)
    if cfg.conus_only:
        ref = ref[~ref["fips"].str[:2].isin(CONUS_EXCLUDE_ST)]
    if cfg.states:
        ref = ref[ref["state_abbr"].isin(cfg.states)]
    ref = ref.sort_values("fips").reset_index(drop=True)
    return list(ref[["fips", "county_name", "state", "state_abbr",
                     "base_population"]].itertuples(index=False, name=None))


# --------------------------------------------------------------------------- #
# Live fetchers  (used when use_synthetic=False)
# --------------------------------------------------------------------------- #
def _soda_get(rid: str, cfg: PipelineConfig, where: str | None = None,
              select: str | None = None) -> pd.DataFrame:
    """Paginated Socrata SODA pull -> DataFrame."""
    if requests is None:
        raise RuntimeError("`requests` is required for live fetches.")
    url = SODA_BASE.format(rid=rid)
    rows, offset = [], 0
    while True:
        params = {"$limit": cfg.page_size, "$offset": offset, "$order": ":id"}
        if where:
            params["$where"] = where
        if select:
            params["$select"] = select
        r = requests.get(url, params=params, headers=cfg._headers, timeout=60)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        offset += cfg.page_size
        time.sleep(cfg.request_pause)
        if len(batch) < cfg.page_size:
            break
    return pd.DataFrame(rows)


def fetch_nchs_county_modelbased(cfg: PipelineConfig) -> pd.DataFrame:
    """pbkm-d27e -> county drug-overdose (all) age-adjusted rate + population."""
    raw = _soda_get(RESOURCES["NCHS_County_ModelBased"], cfg)
    if raw.empty:
        return raw
    # Socrata lowercases/normalises field names; be tolerant.
    ren = {c: c.lower() for c in raw.columns}
    raw = raw.rename(columns=ren)
    rate_col = next((c for c in raw.columns if "age" in c and "rate" in c),
                    "estimated_age_adjusted_death_rate_16_categories_in_ranges")
    out = pd.DataFrame({
        "fips": raw["fips"],
        "county_name": raw.get("county"),
        "state": raw.get("state"),
        "state_abbr": raw.get("st"),
        "year": pd.to_numeric(raw["year"], errors="coerce"),
        "population": pd.to_numeric(raw["population"], errors="coerce"),
        "age_adjusted_rate_per_100k": raw[rate_col].map(_band_midpoint),
    })
    # derive an approximate death count from the (age-adjusted) rate band
    out["deaths"] = (out["age_adjusted_rate_per_100k"] / 100_000
                     * out["population"]).round()
    out["category"] = "drug_overdose_all"
    out["source"] = "NCHS_County_ModelBased"
    out["suppressed"] = False
    out["notes"] = "model-based age-adjusted rate (binned midpoint); deaths approximated"
    if cfg.states:
        out = out[out["state_abbr"].isin(cfg.states)]
    return out


def fetch_nchs_provisional_county(cfg: PipelineConfig) -> pd.DataFrame:
    """gb4e-yj24 -> 12-month-ending provisional overdose COUNTS by county."""
    raw = _soda_get(RESOURCES["NCHS_Provisional_County"], cfg)
    if raw.empty:
        return raw
    raw = raw.rename(columns={c: c.lower() for c in raw.columns})
    fips_col = next((c for c in raw.columns if "fips" in c), "countyfips")
    cnt_col = next((c for c in raw.columns
                    if "provisional" in c and "count" in c), None) \
        or next((c for c in raw.columns if c in
                 ("provisional_drug_overdose_deaths", "deaths", "count")), None)
    yr_col = next((c for c in raw.columns if "year" in c), "year")
    deaths = pd.to_numeric(raw.get(cnt_col), errors="coerce")
    out = pd.DataFrame({
        "fips": raw[fips_col].astype(str).str.zfill(5),
        "county_name": raw.get("county"),
        "state_abbr": raw.get("st_abbrev", raw.get("state")),
        "year": pd.to_numeric(raw[yr_col], errors="coerce"),
        "deaths": deaths,
        "population": pd.to_numeric(raw.get("population"), errors="coerce"),
    })
    out["suppressed"] = deaths.isna() & raw.get(cnt_col).notna()
    out["category"] = "drug_overdose_all"
    out["source"] = "NCHS_Provisional_County"
    out["age_adjusted_rate_per_100k"] = np.nan
    out["notes"] = "12-month-ending provisional counts; 1-9 suppressed"
    if cfg.states:
        out = out[out["state_abbr"].isin(cfg.states)]
    return out


def fetch_vsrr_state_opioid(cfg: PipelineConfig) -> pd.DataFrame:
    """xkb8-kh2a -> STATE-level opioid (T40.0-T40.4,T40.6) provisional counts.

    County-level opioid-specific final data is only available via CDC WONDER
    (see `cdc_wonder_county_opioid_query`); this state series is the practical
    opioid reference layer.
    """
    raw = _soda_get(RESOURCES["NCHS_VSRR_State_Opioid"], cfg)
    if raw.empty:
        return raw
    raw = raw.rename(columns={c: c.lower() for c in raw.columns})
    ind = raw.get("indicator", pd.Series(dtype=str)).astype(str)
    mask = ind.str.contains("Opioid", case=False, na=False)
    sub = raw[mask].copy()
    out = pd.DataFrame({
        "fips": pd.NA,
        "county_name": pd.NA,
        "state_abbr": sub.get("state"),
        "year": pd.to_numeric(sub.get("year"), errors="coerce"),
        "deaths": pd.to_numeric(sub.get("data_value"), errors="coerce"),
        "population": np.nan,
    })
    out["category"] = "opioid"
    out["source"] = "NCHS_VSRR_State_Opioid"
    out["age_adjusted_rate_per_100k"] = np.nan
    out["suppressed"] = False
    out["notes"] = "STATE-level provisional opioid counts (T40.0-T40.4,T40.6)"
    if cfg.states:
        out = out[out["state_abbr"].isin(cfg.states)]
    return out


def cdc_wonder_county_opioid_query(state_fips: str, year: int) -> str:
    """
    Return a documented description of the CDC WONDER Multiple Cause of Death
    request needed for county-level OPIOID-specific final counts.

    WONDER's API takes an XML <request-parameters> POST to
    https://wonder.cdc.gov/controller/datarequest/D77 (Detailed Mortality).
    Key parameters:
        Underlying cause of death .... X40-X44, X60-X64, X85, Y10-Y14
        Multiple cause of death ...... T40.0, T40.1, T40.2, T40.3, T40.4, T40.6
        Group-By ..................... County, Year
        Location ..................... state_fips
    Counts < 10 are suppressed; sub-national county queries are additionally
    restricted for the most recent years. Because the XML contract is long and
    changes between WONDER databases, this helper returns guidance rather than
    firing the request automatically.
    """
    return (f"CDC WONDER D77 (Multiple Cause of Death): opioid-related overdose, "
            f"state FIPS {state_fips}, year {year}. Underlying X40-X44/X60-X64/"
            f"X85/Y10-Y14 AND contributing T40.0-T40.4,T40.6; group by County, "
            f"Year; counts <10 suppressed.")


# --------------------------------------------------------------------------- #
# Synthetic demo panel  (used when use_synthetic=True)
# --------------------------------------------------------------------------- #
# Offline fallback only. The demo normally loads the full CONUS reference via
# load_county_reference(); this NY table is used solely when no CSV/network is
# available so the pipeline still runs. (fips, name, approx 2020 population)
_NY_COUNTIES = [
    ("36001", "Albany County, NY", 314848), ("36003", "Allegany County, NY", 46456),
    ("36005", "Bronx County, NY", 1472654), ("36007", "Broome County, NY", 198683),
    ("36009", "Cattaraugus County, NY", 77042), ("36011", "Cayuga County, NY", 76248),
    ("36013", "Chautauqua County, NY", 127657), ("36015", "Chemung County, NY", 84254),
    ("36017", "Chenango County, NY", 47220), ("36019", "Clinton County, NY", 79843),
    ("36021", "Columbia County, NY", 61570), ("36023", "Cortland County, NY", 46809),
    ("36025", "Delaware County, NY", 44135), ("36027", "Dutchess County, NY", 295911),
    ("36029", "Erie County, NY", 954236), ("36031", "Essex County, NY", 37381),
    ("36033", "Franklin County, NY", 47555), ("36035", "Fulton County, NY", 53324),
    ("36037", "Genesee County, NY", 58388), ("36039", "Greene County, NY", 47931),
    ("36041", "Hamilton County, NY", 5107), ("36043", "Herkimer County, NY", 60139),
    ("36045", "Jefferson County, NY", 116721), ("36047", "Kings County, NY", 2736074),
    ("36049", "Lewis County, NY", 26582), ("36051", "Livingston County, NY", 61834),
    ("36053", "Madison County, NY", 68016), ("36055", "Monroe County, NY", 759443),
    ("36057", "Montgomery County, NY", 49221), ("36059", "Nassau County, NY", 1395774),
    ("36061", "New York County, NY", 1694251), ("36063", "Niagara County, NY", 212666),
    ("36065", "Oneida County, NY", 232125), ("36067", "Onondaga County, NY", 476516),
    ("36069", "Ontario County, NY", 112458), ("36071", "Orange County, NY", 401310),
    ("36073", "Orleans County, NY", 40343), ("36075", "Oswego County, NY", 117124),
    ("36077", "Otsego County, NY", 58524), ("36079", "Putnam County, NY", 97668),
    ("36081", "Queens County, NY", 2405464), ("36083", "Rensselaer County, NY", 161130),
    ("36085", "Richmond County, NY", 495747), ("36087", "Rockland County, NY", 338329),
    ("36089", "St. Lawrence County, NY", 108505), ("36091", "Saratoga County, NY", 235509),
    ("36093", "Schenectady County, NY", 158061), ("36095", "Schoharie County, NY", 29714),
    ("36097", "Schuyler County, NY", 17898), ("36099", "Seneca County, NY", 33814),
    ("36101", "Steuben County, NY", 93584), ("36103", "Suffolk County, NY", 1525920),
    ("36105", "Sullivan County, NY", 78624), ("36107", "Tioga County, NY", 48455),
    ("36109", "Tompkins County, NY", 105740), ("36111", "Ulster County, NY", 181851),
    ("36113", "Warren County, NY", 65737), ("36115", "Washington County, NY", 61302),
    ("36117", "Wayne County, NY", 91283), ("36119", "Westchester County, NY", 1004456),
    ("36121", "Wyoming County, NY", 40531), ("36123", "Yates County, NY", 24774),
]


def _epidemic_curve(year: int) -> float:
    """National-ish overdose intensity multiplier by year (rising, fentanyl era)."""
    base = 0.00006 + 0.0000045 * max(0, year - 1999)      # steady rise
    if year >= 2013:                                       # fentanyl acceleration
        base += 0.0000075 * (year - 2013)
    if year >= 2020:                                       # pandemic bump
        base += 0.000012 * (year - 2020)
    return base


def generate_synthetic_panel(cfg: PipelineConfig, seed: int = 207) -> pd.DataFrame:
    """Reproducible synthetic multi-source panel matching the real schema."""
    rng = np.random.default_rng(seed)
    counties = load_county_reference(cfg)          # CONUS by default
    years = range(cfg.year_min, cfg.year_max + 1)
    recs: list[dict] = []

    for fips, name, state, abbr, pop2020 in counties:
        # slowly varying population around the population anchor
        for year in years:
            drift = 1.0 + 0.004 * (year - 2020) + rng.normal(0, 0.006)
            pop = max(500, int(pop2020 * drift))
            intensity = _epidemic_curve(year)
            county_effect = rng.lognormal(0, 0.35)          # place heterogeneity
            exp_total = pop * intensity * county_effect
            total_deaths = int(rng.poisson(max(0.0, exp_total)))
            # opioid share of overdose deaths grows over time
            opioid_share = np.clip(0.45 + 0.02 * (year - 1999)
                                   + (0.10 if year >= 2015 else 0)
                                   + rng.normal(0, 0.04), 0.30, 0.90)
            opioid_deaths = int(round(total_deaths * opioid_share))

            def _rows(cat, deaths):
                supp = 1 <= deaths <= 9                      # NCHS 1-9 suppression
                # 1) model-based age-adjusted rate + population (all overdose only)
                if cat == "drug_overdose_all":
                    aar = deaths / pop * 100_000 * rng.lognormal(0, 0.08)
                    recs.append(dict(
                        fips=fips, county_name=name, state=state, state_abbr=abbr,
                        year=year, category=cat,
                        source="NCHS_County_ModelBased (SYNTHETIC_DEMO)",
                        deaths=round(aar / 100_000 * pop), population=pop,
                        age_adjusted_rate_per_100k=round(aar, 1), suppressed=False,
                        notes="synthetic; model-based rate + derived count"))
                # 2) provisional county counts (suppress 1-9)
                recs.append(dict(
                    fips=fips, county_name=name, state=state, state_abbr=abbr,
                    year=year, category=cat,
                    source=("NCHS_Provisional_County (SYNTHETIC_DEMO)"
                            if cat == "drug_overdose_all"
                            else "CDC_WONDER (SYNTHETIC_DEMO)"),
                    deaths=(np.nan if supp else deaths), population=pop,
                    age_adjusted_rate_per_100k=np.nan, suppressed=supp,
                    notes=("synthetic; provisional 12mo-ending, 1-9 suppressed"
                           if cat == "drug_overdose_all"
                           else "synthetic; WONDER county opioid, <10 suppressed")))

            _rows("drug_overdose_all", total_deaths)
            _rows("opioid", opioid_deaths)

    df = pd.DataFrame(recs)
    if cfg.states:
        df = df[df["state_abbr"].isin(cfg.states)]
    return df


# --------------------------------------------------------------------------- #
# Orchestrator
# --------------------------------------------------------------------------- #
def build_timeseries(cfg: PipelineConfig | None = None,
                     use_synthetic: bool = False) -> pd.DataFrame:
    """
    Assemble the harmonised county-level overdose/opioid time series.

    use_synthetic=True  -> offline reproducible demo panel (NY counties).
    use_synthetic=False -> live pull from data.cdc.gov (needs internet); each
                           source degrades gracefully if it fails.
    """
    cfg = cfg or PipelineConfig()

    if use_synthetic:
        return _finalise(generate_synthetic_panel(cfg))

    frames: list[pd.DataFrame] = []
    live = {
        "NCHS_County_ModelBased": fetch_nchs_county_modelbased,
        "NCHS_Provisional_County": fetch_nchs_provisional_county,
        "NCHS_VSRR_State_Opioid": fetch_vsrr_state_opioid,
    }
    for name, fn in live.items():
        try:
            part = fn(cfg)
            if part is not None and not part.empty:
                frames.append(part)
                print(f"[ok]   {name}: {len(part):,} rows")
            else:
                print(f"[warn] {name}: no rows returned")
        except Exception as exc:                         # network / schema drift
            warnings.warn(f"{name} failed: {exc}")
            print(f"[fail] {name}: {exc}")

    if not frames:
        raise RuntimeError(
            "No live source succeeded. In a sandbox without outbound internet "
            "call build_timeseries(use_synthetic=True).")
    combined = pd.concat(frames, ignore_index=True)
    combined = combined[(combined["year"] >= cfg.year_min)
                        & (combined["year"] <= cfg.year_max)]
    combined = _apply_conus_filter(combined, cfg)
    return _finalise(combined)


if __name__ == "__main__":
    # Full contiguous US (48 states + DC): states=None, conus_only=True
    cfg = PipelineConfig(states=None, conus_only=True,
                         year_min=1999, year_max=2023)
    ts = build_timeseries(cfg, use_synthetic=True)
    print(ts.head(8).to_string(index=False))
    print("\nshape:", ts.shape,
          "| counties:", ts["fips"].nunique(),
          "| states:", ts["state_abbr"].nunique())
