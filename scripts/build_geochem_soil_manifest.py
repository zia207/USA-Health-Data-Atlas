#!/usr/bin/env python3
"""Build assets/geochem_soil_manifest.js from USGS Geochem_Soil Feature Service."""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "geochem_soil_manifest.js"
SERVICE = (
    "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/"
    "Geochem_features/FeatureServer/2"
)

CENTROIDS = {
    "AL": [32.8, -86.8], "AK": [64.2, -152.5], "AZ": [34.3, -111.7], "AR": [34.9, -92.4],
    "CA": [37.2, -119.5], "CO": [39.0, -105.5], "CT": [41.6, -72.7], "DE": [39.0, -75.5],
    "DC": [38.9, -77.0], "FL": [28.1, -81.7], "GA": [32.7, -83.4], "HI": [20.3, -156.4],
    "ID": [44.4, -114.6], "IL": [40.0, -89.2], "IN": [39.9, -86.3], "IA": [42.1, -93.5],
    "KS": [38.5, -98.3], "KY": [37.5, -85.3], "LA": [31.0, -92.0], "ME": [45.3, -69.2],
    "MD": [39.0, -76.7], "MA": [42.3, -71.8], "MI": [44.3, -85.4], "MN": [46.3, -94.3],
    "MS": [32.7, -89.7], "MO": [38.4, -92.5], "MT": [47.0, -109.6], "NE": [41.5, -99.8],
    "NV": [39.3, -116.6], "NH": [43.7, -71.6], "NJ": [40.2, -74.7], "NM": [34.4, -106.1],
    "NY": [42.9, -75.5], "NC": [35.6, -79.4], "ND": [47.4, -100.5], "OH": [40.3, -82.8],
    "OK": [35.6, -97.5], "OR": [44.0, -120.5], "PA": [40.9, -77.8], "PR": [18.2, -66.4],
    "RI": [41.7, -71.5], "SC": [33.9, -81.0], "SD": [44.4, -100.2], "TN": [35.8, -86.3],
    "TX": [31.5, -99.3], "UT": [39.3, -111.7], "VT": [44.1, -72.7], "VA": [37.5, -78.6],
    "VI": [18.3, -64.8], "WA": [47.4, -120.5], "WV": [38.6, -80.6], "WI": [44.5, -89.5],
    "WY": [43.0, -107.6], "GU": [13.4, 144.8], "MP": [15.2, 145.8], "AS": [-14.3, -170.7],
}

ELEMENTS = [
    {"code": "As_ppm", "label": "Arsenic (As)", "unit": "ppm"},
    {"code": "Pb_ppm", "label": "Lead (Pb)", "unit": "ppm"},
    {"code": "Cd_ppm", "label": "Cadmium (Cd)", "unit": "ppm"},
    {"code": "Cr_ppm", "label": "Chromium (Cr)", "unit": "ppm"},
    {"code": "Cu_ppm", "label": "Copper (Cu)", "unit": "ppm"},
    {"code": "Zn_ppm", "label": "Zinc (Zn)", "unit": "ppm"},
    {"code": "Hg_ppm", "label": "Mercury (Hg)", "unit": "ppm"},
    {"code": "Ni_ppm", "label": "Nickel (Ni)", "unit": "ppm"},
    {"code": "Se_ppm", "label": "Selenium (Se)", "unit": "ppm"},
    {"code": "U_ppm", "label": "Uranium (U)", "unit": "ppm"},
    {"code": "Mn_pct", "label": "Manganese (Mn)", "unit": "%"},
    {"code": "Fe_pct", "label": "Iron (Fe)", "unit": "%"},
    {"code": "Al_pct", "label": "Aluminum (Al)", "unit": "%"},
    {"code": "V_ppm", "label": "Vanadium (V)", "unit": "ppm"},
    {"code": "Mo_ppm", "label": "Molybdenum (Mo)", "unit": "ppm"},
    {"code": "Sb_ppm", "label": "Antimony (Sb)", "unit": "ppm"},
]


def main() -> None:
    q = urllib.parse.urlencode(
        {
            "where": "1=1",
            "groupByFieldsForStatistics": "state",
            "outStatistics": json.dumps(
                [{"statisticType": "count", "onStatisticField": "OBJECTID", "outStatisticFieldName": "n"}]
            ),
            "orderByFields": "state ASC",
            "f": "pjson",
        }
    )
    data = json.load(urllib.request.urlopen(SERVICE + "/query?" + q, timeout=120))
    states = {
        f["attributes"]["state"]: f["attributes"]["n"]
        for f in data.get("features") or []
        if f["attributes"].get("state")
    }
    payload = {
        "meta": {
            "source": "USGS Geochemical Data Portal — soil samples (1962–2023)",
            "portal_url": "https://alaska.usgs.gov/science/geology/geochem_portal/geochem_portal.html",
            "feature_service": SERVICE,
            "layer": "Geochem_Soil",
            "n_samples": sum(states.values()),
            "elements": ELEMENTS,
        },
        "state_counts": states,
        "state_centroids": {k: v for k, v in CENTROIDS.items() if k in states},
    }
    OUT.write_text("window.GEOCHEM_SOIL_META = " + json.dumps(payload, separators=(",", ":")) + ";\n")
    print(f"Wrote {OUT} ({OUT.stat().st_size:,} bytes) — {len(states)} states, {payload['meta']['n_samples']:,} samples")


if __name__ == "__main__":
    main()
