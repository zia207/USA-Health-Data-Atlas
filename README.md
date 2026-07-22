# USA-Health Data Atlas

An open, browser-based dashboard for exploring U.S. county and state health, demographic, and contextual data — interactive maps, SQL summarization, trend charts, and a cross-dataset modeling workbench, all joined on county FIPS.

**Live site:** [https://zia207.github.io/USA-Health-Data-Atlas/](https://zia207.github.io/USA-Health-Data-Atlas/)

## Explorers

| Explorer | Description |
|----------|-------------|
| [County Health Rankings](usa_county_health_rankings.html) | CHR outcomes, factors, and measures (2020–2025) |
| [Place-based Health Experience](usa_health_experience.html) | CDC PLACES model-based estimates |
| [Social Vulnerability Index](usa_svi.html) | CDC/ATSDR SVI (state, county, tract) |
| [USA Cancer Atlas](usa_cancer_atlas.html) | NCI State Cancer Profiles incidence & mortality |
| [Overdose Mortality](usa_overdose_mortality.html) | CDC/NCHS county overdose layers |
| [USA Mortality Data](usa_mortality_data.html) | NIMHD HDPulse age-adjusted mortality |
| [Census Demography](usa_census_demograpy.html) | U.S. Census PEP population estimates |
| [Religion Census](usa_religion_census.html) | RCMS / U.S. Religion Census (2010 & 2020) |
| [Presidential Elections](usa_presidential_election_data.html) | County presidential returns (2004–2024) |
| [EDA & Model Development](eda_model_development.html) | Cross-layer SQL, spatial stats, and ML workbench |

## Run locally

```bash
python3 -m http.server 8080
```

Open [http://localhost:8080/](http://localhost:8080/).

## GitHub Pages deployment

This repository deploys automatically to GitHub Pages on every push to `main` via [`.github/workflows/pages.yml`](.github/workflows/pages.yml).

**First-time setup on GitHub:**

1. Create a repository named `USA-Health-Data-Atlas` under your account.
2. Push this project to `main`.
3. In the repo, go to **Settings → Pages**.
4. Under **Build and deployment**, set **Source** to **GitHub Actions**.
5. After the workflow completes, the site will be available at  
   `https://<username>.github.io/USA-Health-Data-Atlas/`.

## Rebuild bundled data assets

Large datasets are pre-bundled as JavaScript in `assets/`. To regenerate from raw CSVs in `data/`:

```bash
pip install -r requirements.txt
python3 scripts/build_chr_county_js.py
# … see scripts/ for other dataset builders
```

## Author

**[Zia Ahmed](https://github.com/zia207)** · University at Buffalo · [zia207@gmail.com](mailto:zia207@gmail.com)

Maintained by [Upatta Data Analytics](https://github.com/zia207).
