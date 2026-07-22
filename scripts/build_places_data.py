#!/usr/bin/env python3
"""Build assets/places_county_data.js from CDC PLACES + ACS Feature Services
used by the PLACES ArcGIS Experience.
"""
from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "places_county_data.js"
RAW = ROOT / "data" / "places"

PLACES_URL = (
    "https://services3.arcgis.com/ZvidGQkLaDJxRSJ2/arcgis/rest/services/"
    "PLACES_LocalData_for_BetterHealth/FeatureServer/2"
)
ACS_URL = (
    "https://services3.arcgis.com/ZvidGQkLaDJxRSJ2/arcgis/rest/services/"
    "ACS_Social_Determinant_of_Health/FeatureServer/2"
)

INDICATORS = [
    ("ARTHRITIS", "Arthritis", "Health Outcomes", "places"),
    ("BPHIGH", "High blood pressure", "Health Outcomes", "places"),
    ("TEETHLOST", "All teeth lost (age ≥65)", "Health Outcomes", "places"),
    ("STROKE", "Stroke", "Health Outcomes", "places"),
    ("COPD", "COPD", "Health Outcomes", "places"),
    ("DIABETES", "Diabetes", "Health Outcomes", "places"),
    ("HIGHCHOL", "High cholesterol", "Health Outcomes", "places"),
    ("CANCER", "Cancer (non-skin) or melanoma", "Health Outcomes", "places"),
    ("CASTHMA", "Current asthma", "Health Outcomes", "places"),
    ("CHD", "Coronary heart disease", "Health Outcomes", "places"),
    ("DEPRESSION", "Depression", "Health Outcomes", "places"),
    ("OBESITY", "Obesity", "Health Outcomes", "places"),
    ("ACCESS2", "Lack of health insurance (18–64)", "Prevention", "places"),
    ("MAMMOUSE", "Mammography use (women 50–74)", "Prevention", "places"),
    ("DENTAL", "Dental visit (past year)", "Prevention", "places"),
    ("COLON_SCREEN", "Colorectal cancer screening (45–75)", "Prevention", "places"),
    ("CHOLSCREEN", "Cholesterol screening", "Prevention", "places"),
    ("CHECKUP", "Annual checkup", "Prevention", "places"),
    ("BPMED", "Taking BP medication (among with HBP)", "Prevention", "places"),
    ("BINGE", "Binge drinking", "Health Risk Behaviors", "places"),
    ("SLEEP", "Short sleep duration", "Health Risk Behaviors", "places"),
    ("LPA", "Physical inactivity", "Health Risk Behaviors", "places"),
    ("CSMOKING", "Current smoking", "Health Risk Behaviors", "places"),
    ("OBESITY", "Obesity", "Health Risk Behaviors", "places"),
    ("PHLTH", "Frequent physical distress", "Health Status", "places"),
    ("MHLTH", "Frequent mental distress", "Health Status", "places"),
    ("GHLTH", "Fair or poor general health", "Health Status", "places"),
    ("HEARING", "Hearing disability", "Disability", "places"),
    ("VISION", "Vision disability", "Disability", "places"),
    ("DISABILITY", "Any disability", "Disability", "places"),
    ("INDEPLIVE", "Independent living disability", "Disability", "places"),
    ("SELFCARE", "Self-care disability", "Disability", "places"),
    ("COGNITION", "Cognitive disability", "Disability", "places"),
    ("MOBILITY", "Mobility disability", "Disability", "places"),
    ("ISOLATION", "Loneliness", "Health-Related Needs", "places"),
    ("HOUSINSECU", "Housing insecurity", "Health-Related Needs", "places"),
    ("FOODINSECU", "Food insecurity", "Health-Related Needs", "places"),
    ("FOODSTAMP", "Food stamps (past 12 months)", "Health-Related Needs", "places"),
    ("SHUTUTILITY", "Utility services shut-off threat", "Health-Related Needs", "places"),
    ("EMOTIONSPT", "Lack of social & emotional support", "Health-Related Needs", "places"),
    ("LACKTRPT", "Transportation barriers", "Health-Related Needs", "places"),
    ("NOHSDP", "No high school diploma", "Non-Medical Factors", "acs"),
    ("AGE65", "Aged 65 years or older", "Non-Medical Factors", "acs"),
    ("HCOST", "Housing cost burden", "Non-Medical Factors", "acs"),
    ("CROWD", "Crowding", "Non-Medical Factors", "acs"),
    ("BROAD", "No broadband", "Non-Medical Factors", "acs"),
    ("UNEMP", "Unemployment", "Non-Medical Factors", "acs"),
    ("SNGPNT", "Single-parent households", "Non-Medical Factors", "acs"),
    ("REMNRTY", "Racial or ethnic minority status", "Non-Medical Factors", "acs"),
    ("POV150", "Poverty", "Non-Medical Factors", "acs"),
]

# Area fractions of legacy CT counties (090xx) within each planning region (091xx).
# Derived from Census 2020 vs 2024 county-equivalent boundaries.
CT_LEGACY_TO_PLANNING = {
    "09110": {"09003": 0.877587, "09005": 1e-05, "09007": 1.4e-05, "09009": 2.9e-05,
              "09011": 1.2e-05, "09013": 0.928427, "09015": 4e-05},
    "09120": {"09001": 0.222283},
    "09130": {"09003": 9e-06, "09007": 0.999947, "09009": 2e-05, "09011": 0.085436},
    "09140": {"09001": 0.04884, "09003": 0.035737, "09005": 0.127404, "09009": 0.391052},
    "09150": {"09011": 0.056857, "09013": 0.071535, "09015": 0.946936},
    "09160": {"09003": 0.086668, "09005": 0.786738},
    "09170": {"09001": 0.0, "09007": 2.2e-05, "09009": 0.608891},
    "09180": {"09007": 1.7e-05, "09011": 0.857694, "09013": 3.8e-05, "09015": 0.053024},
    "09190": {"09001": 0.728876, "09005": 0.085848, "09009": 7e-06},
}
CT_LEGACY_FIPS = frozenset(
    fips for parts in CT_LEGACY_TO_PLANNING.values() for fips in parts
)


def fetch_all(layer_url: str, fields: list[str]) -> list[dict]:
    out: list[dict] = []
    offset = 0
    page = 1000
    field_str = ",".join(fields)
    while True:
        params = urllib.parse.urlencode(
            {
                "where": "1=1",
                "outFields": field_str,
                "returnGeometry": "false",
                "resultOffset": offset,
                "resultRecordCount": page,
                "orderByFields": "OBJECTID",
                "f": "pjson",
            }
        )
        data = json.load(urllib.request.urlopen(layer_url + "/query?" + params, timeout=120))
        feats = data.get("features") or []
        out.extend(f["attributes"] for f in feats)
        print(f"  {layer_url.split('/')[-1]}: {len(out)} (+{len(feats)})", flush=True)
        if len(feats) < page:
            break
        offset += page
    return out


def state_agg(pairs: list[tuple[float, float | None]]) -> float | None:
    weighted = [(v, p) for v, p in pairs if p and p > 0]
    if weighted:
        num = sum(v * p for v, p in weighted)
        den = sum(p for _, p in weighted)
        return round(num / den, 3) if den else None
    vals = [v for v, _ in pairs]
    return round(sum(vals) / len(vals), 3) if vals else None


def ct_planning_pop(pr_fips: str, acs_by: dict) -> float | None:
    fracs = CT_LEGACY_TO_PLANNING.get(pr_fips, {})
    total = 0.0
    for co_fips, frac in fracs.items():
        row = acs_by.get(co_fips, {})
        try:
            pop = float(row.get("TotalPopulation") or 0)
        except Exception:
            pop = 0.0
        total += pop * frac
    return total if total > 0 else None


def ct_acs_values(pr_fips: str, acs_codes: list[str], acs_by: dict) -> dict[str, float | None]:
    fracs = CT_LEGACY_TO_PLANNING.get(pr_fips, {})
    out: dict[str, float | None] = {}
    for code in acs_codes:
        num = 0.0
        den = 0.0
        for co_fips, frac in fracs.items():
            row = acs_by.get(co_fips, {})
            try:
                v = float(row.get(code))
                pop = float(row.get("TotalPopulation") or 0)
            except Exception:
                continue
            if pop <= 0:
                continue
            w = pop * frac
            num += v * w
            den += w
        out[code] = round(num / den, 3) if den else None
    return out


def main() -> None:
    codes: list[str] = []
    seen: set[str] = set()
    for code, *_ in INDICATORS:
        if code not in seen:
            seen.add(code)
            codes.append(code)
    code_index = {c: i for i, c in enumerate(codes)}
    places_codes = list(dict.fromkeys(c for c, _, _, s in INDICATORS if s == "places"))
    acs_codes = list(dict.fromkeys(c for c, _, _, s in INDICATORS if s == "acs"))

    places_fields = [
        "CountyFIPS",
        "StateAbbr",
        "StateName",
        "CountyName",
        "CountyFullName",
    ] + [f"{c}_CrudePrev" for c in places_codes]
    acs_fields = ["CountyFIPS", "StateAbbr", "CountyName", "TotalPopulation"] + acs_codes

    print("Downloading PLACES counties...")
    places = fetch_all(PLACES_URL, places_fields)
    print("Downloading ACS counties...")
    acs = fetch_all(ACS_URL, acs_fields)

    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / "places_counties.json").write_text(json.dumps(places))
    (RAW / "acs_counties.json").write_text(json.dumps(acs))

    acs_by = {
        str(r.get("CountyFIPS") or "").zfill(5): r for r in acs if r.get("CountyFIPS")
    }

    county_rows: list = []
    state_buckets: dict = {}
    for r in places:
        fips = str(r.get("CountyFIPS") or "").zfill(5)
        if len(fips) != 5:
            continue
        st = r.get("StateAbbr") or ""
        name = r.get("CountyFullName") or r.get("CountyName") or fips
        is_ct_planning = st == "CT" and fips in CT_LEGACY_TO_PLANNING
        a = acs_by.get(fips, {})
        if is_ct_planning:
            pop = ct_planning_pop(fips, acs_by)
            ct_acs = ct_acs_values(fips, acs_codes, acs_by)
        else:
            pop = a.get("TotalPopulation")
            try:
                pop = float(pop) if pop is not None else None
            except Exception:
                pop = None
            ct_acs = None
        vals = [None] * len(codes)
        for code in places_codes:
            v = r.get(f"{code}_CrudePrev")
            try:
                v = float(v) if v is not None else None
            except Exception:
                v = None
            if v is None or (isinstance(v, float) and math.isnan(v)):
                continue
            vals[code_index[code]] = round(v, 3)
            state_buckets.setdefault(st, {}).setdefault(code, []).append((v, pop))
        for code in acs_codes:
            if ct_acs is not None:
                v = ct_acs.get(code)
            else:
                v = a.get(code)
            try:
                v = float(v) if v is not None else None
            except Exception:
                v = None
            if v is None or (isinstance(v, float) and math.isnan(v)):
                continue
            vals[code_index[code]] = round(v, 3)
            state_buckets.setdefault(st, {}).setdefault(code, []).append((v, pop))
        county_rows.append([fips, st, name, vals])

    state_rows = []
    for st in sorted(state_buckets):
        n = sum(1 for row in county_rows if row[1] == st)
        vals = [None] * len(codes)
        for code in codes:
            vals[code_index[code]] = state_agg(state_buckets[st].get(code) or [])
        state_rows.append([st, n, vals])

    payload = {
        "meta": {
            "source": "CDC PLACES: Local Data for Better Health (ArcGIS Experience)",
            "source_url": "https://experience.arcgis.com/experience/22c7182a162d45788dd52a2362f8ed65",
            "places_url": "https://www.cdc.gov/places",
            "data_note": (
                "County crude prevalence (%) from CDC PLACES; Non-Medical Factors from ACS "
                "SDOH layers used by the Experience. Connecticut uses 2022+ planning-region "
                "FIPS (091xx). ACS non-medical values for CT are population-weighted from legacy "
                "county ACS where needed. State values are population-weighted county means."
            ),
            "value_type": "crude_prevalence_percent",
            "geographies": ["states", "counties"],
            "codes": codes,
            "indicators": [
                {"code": c, "label": l, "group": g, "source": s, "unit": "%"}
                for c, l, g, s in INDICATORS
            ],
            "n_counties": len(county_rows),
            "n_states": len(state_rows),
        },
        "county_rows": county_rows,
        "state_rows": state_rows,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("window.PLACES_DATA = " + json.dumps(payload, separators=(",", ":")) + ";\n")
    print(f"Wrote {OUT} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
