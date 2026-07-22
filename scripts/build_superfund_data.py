#!/usr/bin/env python3
"""Download EPA NPL Superfund sites with status into assets/superfund_npl_data.js."""
from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "superfund_npl_data.js"

SERVICE = (
    "https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/"
    + urllib.parse.quote(
        "Superfund_National_Priorities_List_(NPL)_Sites_with_Status_Information",
        safe="",
    )
    + "/FeatureServer/0"
)

CHEM_CATS = {
    "Lead / metals": [
        "lead", "arsenic", "mercury", "chromium", "cadmium", "zinc", "copper",
        "nickel", "barium", "beryllium", "thallium", "selenium", "metal",
    ],
    "PCBs": ["pcb", "polychlorinated"],
    "VOCs / solvents": [
        "tce", "trichloro", "pce", "perchloro", "tetrachloro", "benzene",
        "toluene", "xylene", "vinyl chloride", "solvent", "voc", "dichloro",
        "chloroform", "carbon tetrachloride",
    ],
    "PAHs / petroleum": [
        "pah", "petroleum", "creosote", "coal tar", "oil", "gasoline", "diesel",
        "bunker", "naphthalene", "benzo",
    ],
    "Dioxins / furans": ["dioxin", "furan"],
    "PFAS": ["pfas", "pfoa", "pfos", "fluor"],
    "Asbestos": ["asbestos"],
    "Pesticides": [
        "pesticide", "herbicide", "ddt", "chlordane", "dieldrin", "aldrin", "toxaphene",
    ],
    "Radioactive": ["radioactive", "uranium", "radium", "thorium", "plutonium", "nuclear"],
    "Explosives / munitions": ["munition", "ordnance", "explosive", "tnt", "rdx", "hmx"],
}

STATE_ABBR = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
    "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "District of Columbia": "DC",
    "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL",
    "Indiana": "IN", "Iowa": "IA", "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA",
    "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI",
    "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO", "Montana": "MT",
    "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ",
    "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND",
    "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA",
    "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN",
    "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
    "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY", "Puerto Rico": "PR",
    "Guam": "GU", "American Samoa": "AS", "Northern Mariana Islands": "MP",
    "Virgin Islands": "VI", "Trust Territories": "TT",
}


def profile_url(html_or_url: str | None) -> str | None:
    if not html_or_url:
        return None
    m = re.search(r'href="([^"]+)"', html_or_url)
    return m.group(1) if m else (html_or_url if html_or_url.startswith("http") else None)


def chem_tags(name: str) -> list[str]:
    text = (name or "").lower()
    return [cat for cat, keys in CHEM_CATS.items() if any(k in text for k in keys)]


def fetch_all() -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        q = urllib.parse.urlencode(
            {
                "where": "1=1",
                "outFields": "*",
                "returnGeometry": "true",
                "outSR": 4326,
                "resultOffset": offset,
                "resultRecordCount": 1000,
                "f": "pjson",
            }
        )
        data = json.load(urllib.request.urlopen(SERVICE + "/query?" + q, timeout=90))
        feats = data.get("features") or []
        for f in feats:
            a = f.get("attributes") or {}
            g = f.get("geometry") or {}
            lon = a.get("Longitude") if a.get("Longitude") is not None else g.get("x")
            lat = a.get("Latitude") if a.get("Latitude") is not None else g.get("y")
            if lon is None or lat is None:
                continue
            state_name = a.get("State") or ""
            name = a.get("Site_Name") or "Unknown site"
            rows.append(
                {
                    "id": a.get("Site_EPA_ID") or a.get("SEMS_ID") or a.get("ObjectId2"),
                    "name": name,
                    "epa_id": a.get("Site_EPA_ID"),
                    "sems_id": a.get("SEMS_ID"),
                    "status": a.get("Status") or "Unknown",
                    "state": STATE_ABBR.get(state_name, state_name[:2].upper() if state_name else ""),
                    "state_name": state_name,
                    "city": a.get("City"),
                    "county": a.get("County"),
                    "region": a.get("Region_ID"),
                    "score": a.get("Site_Score"),
                    "lat": round(float(lat), 6),
                    "lon": round(float(lon), 6),
                    "proposed": a.get("Proposed_Date"),
                    "listed": a.get("Listing_Date"),
                    "construction_complete": a.get("Construction_Completion_Date"),
                    "deleted": a.get("Deletion_Date"),
                    "partial_deletion": a.get("Site_has_had_a_Partial_Deletion"),
                    "profile_url": profile_url(a.get("Site_Progress_Profile")),
                    "narrative_url": profile_url(a.get("Site_Listing_Narrative")),
                    "proposed_fr": profile_url(a.get("Proposed_FR_Notice")),
                    "final_fr": profile_url(a.get("Final_FR_Notice")),
                    "deletion_fr": profile_url(a.get("Deletion_FR_Notice")),
                    "chem_tags": chem_tags(name),
                }
            )
        print(f"fetched {len(rows)}", flush=True)
        if len(feats) < 1000:
            break
        offset += 1000
    return rows


def main() -> None:
    rows = fetch_all()
    payload = {
        "meta": {
            "source": "EPA Superfund National Priorities List (NPL) Sites with Status Information",
            "source_url": "https://map22.epa.gov/cimc/superfund",
            "ej_map_url": "https://epa.maps.arcgis.com/apps/webappviewer/index.html?id=33cebcdfdd1b4c3a8b51d416956c41f1",
            "n_sites": len(rows),
            "statuses": sorted({r["status"] for r in rows}),
            "chemical_categories": list(CHEM_CATS.keys()),
            "chemical_note": (
                "Chemical tags are screening labels inferred from site names "
                "(common Superfund contaminant keywords). Confirm contaminants on the EPA site progress profile."
            ),
        },
        "sites": rows,
    }
    OUT.write_text("window.SUPERFUND_NPL = " + json.dumps(payload, separators=(",", ":")) + ";\n")
    print(f"Wrote {OUT} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
