"""Professional CHR county column names and display labels."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "county_health_ranking"
ASSETS_DIR = ROOT / "assets"
YEARS = [2020, 2021, 2022, 2023, 2024, 2025]

ID_COLS = {"year", "fips", "state_abbr", "county"}

EXACT_RENAMES: dict[str, str] = {
    "of_ranked_counties": "n_ranked_counties",
    "number_of_counties_included_in_health_groups": "n_counties_in_health_groups",
    "premature_death_deaths": "premature_death_count",
    "premature_age_adjusted_mortality_deaths": "premature_mortality_count",
    "child_mortality_deaths": "child_mortality_count",
    "infant_mortality_deaths": "infant_mortality_count",
    "suicides_deaths": "suicide_count",
    "injury_deaths": "injury_death_count",
    "motor_vehicle_crash_deaths_motor_vehicle_deaths": "motor_vehicle_death_count",
    "sexually_transmitted_infections_chlamydia_cases": "chlamydia_case_count",
    "covid_19_age_adjusted_mortality_deaths_due_to_covid_19_during_2020": "covid19_death_count_2020",
    "food_insecure": "food_insecurity_pct",
    "food_insecurity_food_insecure": "food_insecure_population",
    "limited_access_to_healthy_foods_limited_access": "limited_healthy_food_access_pct",
    "uninsured_adults_uninsured": "uninsured_adults_count",
    "uninsured_children_uninsured": "uninsured_children_count",
    "children_in_single_parent_households_single_parent_households": "single_parent_household_pct",
    "children_eligible_for_free_or_reduced_price_lunch_enrolled_in_free_or_reduced_lunch": "free_reduced_lunch_pct",
    "below_18_years_of_age_less_than_18_years_of_age": "population_under_18_pct",
    "broadband_access_households_with_broadband_access": "broadband_access_pct",
    "severe_housing_cost_burden_households_with_severe_cost_burden": "severe_housing_cost_burden_pct",
    "homeownership_homeowners": "homeownership_pct",
    "unemployment_unemployed": "unemployment_pct",
    "social_associations_associations": "social_association_count",
    "other_primary_care_providers_other_primary_care_provider_rate": "other_primary_care_provider_rate",
    "preventable_hospital_stays_preventable_hospitalization_rate": "preventable_hospitalization_rate",
    "violent_crime_annual_average_violent_crimes": "violent_crime_count",
    "teen_births_teen_birth_rate": "teen_birth_rate",
    "homicides_homicide_rate": "homicide_rate",
    "hiv_prevalence_hiv_cases": "hiv_case_count",
    "juvenile_arrests_non_petitioned_cases": "juvenile_arrest_count",
    "child_care_cost_burden_household_income_required_for_child_care_expenses": "childcare_cost_burden_pct",
    "childcare_cost_burden_household_income_required_for_childcare_expenses": "childcare_cost_burden_pct",
    "long_commute_driving_alone_workers_who_drive_alone": "long_commute_drive_alone_pct",
    "driving_deaths_with_alcohol_involvement": "alcohol_involved_driving_death_pct",
    "income_inequality_80th_percentile_income": "income_80th_percentile",
    "gender_pay_gap_women_s_median_earnings": "gender_pay_gap_ratio",
    "men_s_median_earnings": "mens_median_earnings",
    "females_female": "female_population_pct",
    "demographics_population": "total_population",
    "population_1": "population_pct",
    "non_hispanic_black_black": "nh_black_population_pct",
    "american_indian_or_alaska_native": "nh_aian_population_pct",
    "native_hawaiian_or_other_pacific_islander": "nh_nhopi_population_pct",
    "health_group_1": "health_group_range",
    "low_birthweight": "low_birthweight_pct",
    "low_birth_weight": "low_birthweight_pct",
    "county_value": "measure_value",
}

REDUNDANT_SUFFIXES: list[tuple[str, str]] = [
    (r"_adults_with_obesity$", "_pct"),
    (r"_adults_reporting_currently_smoking$", "_pct"),
    (r"_smokers$", "_pct"),
    (r"_fair_or_poor_health$", "_pct"),
    (r"_average_number_of_physically_unhealthy_days$", ""),
    (r"_average_number_of_mentally_unhealthy_days$", ""),
    (r"_with_access_to_exercise_opportunities$", "_pct"),
    (r"_with_access_to_parks$", "_pct"),
    (r"_physically_inactive$", "_pct"),
    (r"_drive_alone_to_work$", "_pct"),
    (r"_completed_high_school$", "_pct"),
    (r"_with_disability$", "_pct"),
    (r"_with_annual_mammogram$", "_pct"),
    (r"_feeling_lonely$", "_pct"),
    (r"_lacking_support$", "_pct"),
    (r"_rural_residents$", "_pct"),
    (r"_spending_per_pupil$", ""),
    (r"_average_traffic_volume_per_meter_of_major_roadways$", ""),
    (r"_visits_per_service_area_population$", ""),
]

DEMO_REPLACEMENTS = [
    ("non_hispanic_native_hawaiian_and_other_pacific_islander", "nh_nhopi"),
    ("native_hawaiian_other_pacific_islander", "nh_nhopi"),
    ("non_hispanic_2_races", "nh_multiracial"),
    ("hispanic_all_races", "hispanic_all"),
    ("non_hispanic_aian", "nh_aian"),
    ("non_hispanic_asian", "nh_asian"),
    ("non_hispanic_black", "nh_black"),
    ("non_hispanic_white", "nh_white"),
    ("american_indian_alaska_native", "nh_aian"),
]

LABEL_OVERRIDES: dict[str, str] = {
    "n_ranked_counties": "Number of Ranked Counties",
    "n_counties_in_health_groups": "Counties in Health Groups",
    "health_outcomes_rank": "Health Outcomes Rank",
    "health_factors_rank": "Health Factors Rank",
    "length_of_life_rank": "Length of Life Rank",
    "quality_of_life_rank": "Quality of Life Rank",
    "health_behaviors_rank": "Health Behaviors Rank",
    "clinical_care_rank": "Clinical Care Rank",
    "social_economic_factors_rank": "Social & Economic Factors Rank",
    "physical_environment_rank": "Physical Environment Rank",
    "health_group": "Health Group",
    "health_group_range": "Health Group Range",
    "years_of_potential_life_lost_rate": "Years of Potential Life Lost Rate",
    "food_environment_index": "Food Environment Index",
    "adult_obesity_pct": "Adult Obesity (%)",
    "adult_smoking_pct": "Adult Smoking (%)",
    "physical_inactivity_pct": "Physical Inactivity (%)",
    "excessive_drinking_pct": "Excessive Drinking (%)",
    "poor_or_fair_health_pct": "Poor or Fair Health (%)",
    "poor_physical_health_days": "Poor Physical Health Days",
    "poor_mental_health_days": "Poor Mental Health Days",
    "low_birthweight_pct": "Low Birthweight (%)",
    "food_insecurity_pct": "Food Insecurity (%)",
    "food_insecure_population": "Food Insecure Population",
    "limited_healthy_food_access_pct": "Limited Access to Healthy Foods (%)",
    "uninsured_pct": "Uninsured (%)",
    "uninsured_count": "Uninsured Population",
    "primary_care_physician_rate": "Primary Care Physician Rate",
    "dentist_rate": "Dentist Rate",
    "mental_health_provider_rate": "Mental Health Provider Rate",
}


def dedupe_slug_name(col: str) -> str:
    parts = col.split("_")
    for n in range(len(parts) // 2, 0, -1):
        if parts[:n] == parts[n : 2 * n] and len(parts) == 2 * n:
            return "_".join(parts[:n])
    return col


def strip_redundant_suffix(col: str) -> str:
    out = col
    for pattern, replacement in REDUNDANT_SUFFIXES:
        if re.search(pattern, out):
            base = re.sub(pattern, "", out)
            if replacement == "_pct" and not base.endswith("_pct"):
                out = f"{base}{replacement}"
            else:
                out = base
            break
    return out


def standardize_demographics(col: str) -> str:
    out = col
    for old, new in DEMO_REPLACEMENTS:
        out = out.replace(old, new)
    return out


def professional_column_name(col: str) -> str:
    if col in ID_COLS:
        return col
    if col in EXACT_RENAMES:
        return EXACT_RENAMES[col]
    out = dedupe_slug_name(col)
    out = strip_redundant_suffix(out)
    out = standardize_demographics(out)
    out = re.sub(r"_+", "_", out).strip("_")
    if out.endswith("_rate_rate"):
        out = out.replace("_rate_rate", "_rate")
    if out in EXACT_RENAMES:
        out = EXACT_RENAMES[out]
    return out


def _title_words(text: str) -> str:
    small = {"and", "or", "of", "to", "in", "per", "the", "a", "an", "for", "with", "by"}
    words = text.split("_")
    out = []
    for i, w in enumerate(words):
        if not w:
            continue
        if w in {"pct", "nh", "aian", "nhopi", "ypll", "lbw", "mv", "hiv", "pm2_5"}:
            label = w.upper() if w != "pm2_5" else "PM2.5"
        elif w.isdigit():
            label = w
        elif i > 0 and w in small:
            label = w
        else:
            label = w.capitalize()
        out.append(label)
    return " ".join(out)


def column_display_label(col: str) -> str:
    if col in LABEL_OVERRIDES:
        return LABEL_OVERRIDES[col]
    base = col[:-4] if col.endswith("_pct") else col[:-6] if col.endswith("_count") else col
    label = _title_words(base)
    label = label.replace("Nh ", "Non-Hispanic ")
    label = label.replace("Aian", "AIAN").replace("Nhopi", "NH/OPI")
    label = label.replace("Ypll", "YPLL").replace("Lbw", "LBW")
    label = label.replace("Mv ", "Motor Vehicle ")
    label = label.replace("Hiv", "HIV")
    label = label.replace("Pm2 5", "PM2.5")
    if col.endswith("_pct"):
        return f"{label} (%)"
    if col.endswith("_count"):
        return f"{label} (count)"
    if col.endswith("_rank"):
        return f"{label} Rank" if not label.endswith("Rank") else label
    return label


def infer_count_pct_pairs(df: pd.DataFrame, renames: dict[str, str]) -> dict[str, str]:
    extra: dict[str, str] = {}
    cols = list(df.columns)
    for col in cols:
        if not col.endswith("_1"):
            continue
        base = col[:-2]
        if base not in cols:
            continue
        base_prof = renames.get(base, professional_column_name(base))
        suff_prof = renames.get(col, professional_column_name(col))
        if base_prof == suff_prof:
            continue
        s = pd.to_numeric(df[col], errors="coerce")
        b = pd.to_numeric(df[base], errors="coerce")
        if s.max(skipna=True) is not None and b.max(skipna=True) is not None:
            if s.max(skipna=True) <= 100 and b.max(skipna=True) > 100:
                extra[base] = f"{base_prof}_count"
                extra[col] = f"{base_prof}_pct"
            elif b.max(skipna=True) <= 100 and s.max(skipna=True) > 100:
                extra[base] = f"{base_prof}_pct"
                extra[col] = f"{base_prof}_count"
    return extra


def build_rename_map(df: pd.DataFrame) -> dict[str, str]:
    renames = {col: professional_column_name(col) for col in df.columns}
    renames.update(infer_count_pct_pairs(df, renames))
    # resolve collisions after rename
    seen: dict[str, str] = {}
    final: dict[str, str] = {}
    for old, new in renames.items():
        if old in ID_COLS:
            final[old] = old
            continue
        target = new
        if target in seen.values() and seen.get(target) != old:
            n = 2
            while f"{target}_{n}" in seen.values():
                n += 1
            target = f"{target}_{n}"
        final[old] = target
        seen[old] = target
    return final


def rename_dataframe(df: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, str]]:
    mapping = build_rename_map(df)
    out = df.rename(columns=mapping)
    out = out.loc[:, ~out.columns.duplicated()]
    return out, mapping


def labels_for_mapping(mapping: dict[str, str]) -> dict[str, str]:
  labels = {}
  for old, new in mapping.items():
    if new not in labels:
      labels[new] = column_display_label(new)
  return labels


def write_column_dictionary(all_labels: dict[str, str]) -> None:
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    path = ASSETS_DIR / "chr_column_dictionary.json"
    path.write_text(json.dumps(all_labels, indent=2, sort_keys=True), encoding="utf-8")
    js = (
        "(function(g){g.CHR_COLUMN_LABELS="
        + json.dumps(all_labels, separators=(",", ":"), sort_keys=True)
        + ";})(typeof window!=='undefined'?window:globalThis);\n"
    )
    (ASSETS_DIR / "chr_column_dictionary.js").write_text(js, encoding="utf-8")


def append_column_dictionary_md(year: int, mapping: dict[str, str], labels: dict[str, str]) -> None:
    doc_path = OUT_DIR / "docs" / f"CHR_County_Data_{year}.md"
    if not doc_path.exists():
        return
    text = doc_path.read_text(encoding="utf-8")
    if "## Column dictionary" in text:
        text = text.split("## Column dictionary")[0].rstrip() + "\n"
    rows = []
    for _old, new in sorted({v: v for v in mapping.values()}.items()):
        if new in ID_COLS:
            continue
        rows.append(f"| `{new}` | {labels.get(new, column_display_label(new))} |")
    section = [
        "",
        "## Column dictionary",
        "",
        f"Standardized column names and display labels for `chr_county_{year}.csv`.",
        "",
        "| Column | Label |",
        "|---|---|",
        *rows,
        "",
    ]
    doc_path.write_text(text + "\n".join(section), encoding="utf-8")


def process_all() -> None:
    all_labels: dict[str, str] = {
        "year": "Release Year",
        "fips": "County FIPS",
        "state_abbr": "State Abbreviation",
        "county": "County Name",
    }
    panel_parts: list[pd.DataFrame] = []

    for year in YEARS:
        path = OUT_DIR / f"chr_county_{year}.csv"
        if not path.exists():
            continue
        df = pd.read_csv(path, low_memory=False)
        renamed, mapping = rename_dataframe(df)
        labels = labels_for_mapping(mapping)
        all_labels.update(labels)
        renamed.to_csv(path, index=False)
        panel_parts.append(renamed)
        append_column_dictionary_md(year, mapping, labels)
        print(f"{year}: {len(df.columns)} -> {len(renamed.columns)} cols")

    if panel_parts:
        panel = pd.concat(panel_parts, ignore_index=True, sort=False)
        panel = panel.loc[:, ~panel.columns.duplicated()]
        panel_path = OUT_DIR / "chr_county_panel_2020_2025.csv"
        panel.to_csv(panel_path, index=False)
        print(f"panel: {len(panel.columns)} cols")

    write_column_dictionary(all_labels)
    print(f"dictionary: {len(all_labels)} labels -> assets/chr_column_dictionary.json")


if __name__ == "__main__":
    process_all()
