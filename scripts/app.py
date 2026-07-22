"""
LBC Mortality Rate — ML Dashboard
Streamlit app · run with:  streamlit run app.py
"""

import warnings
warnings.filterwarnings("ignore")

import streamlit as st
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
import seaborn as sns
from scipy import stats
import io, os, time

# ── sklearn ──────────────────────────────────────────────────────────────────
from sklearn.model_selection import (train_test_split, KFold,
                                     cross_val_predict)
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.linear_model import LinearRegression, Ridge, Lasso, ElasticNet
from sklearn.ensemble import (RandomForestRegressor, GradientBoostingRegressor,
                              BaggingRegressor)
from sklearn.svm import SVR
from sklearn.neighbors import KNeighborsRegressor
from sklearn.neural_network import MLPRegressor
from sklearn.inspection import permutation_importance
from sklearn.metrics import (mean_squared_error, mean_absolute_error,
                              r2_score, median_absolute_error)


def _gradient_boosting_regressor(*, n_estimators=200, learning_rate=0.05, max_depth=4, random_state=None):
    """Gradient boosting regressor with sklearn ≥1.8 keyword-only ``__init__`` (no positional args)."""
    return GradientBoostingRegressor(
        n_estimators=n_estimators,
        learning_rate=learning_rate,
        max_depth=max_depth,
        random_state=random_state,
    )


try:
    from pygam import LinearGAM, s as gam_s
    HAS_GAM = True
except ImportError:
    HAS_GAM = False

try:
    import shap
    HAS_SHAP = True
except ImportError:
    HAS_SHAP = False

# ── Page config ───────────────────────────────────────────────────────────────
st.set_page_config(
    page_title="LBC ML Dashboard",
    page_icon="🫁",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ── Shared style ──────────────────────────────────────────────────────────────
st.markdown("""
<style>
[data-testid="stSidebar"] { min-width: 280px; max-width: 340px; }
.metric-row { display:flex; gap:12px; margin-bottom:1rem; }
.kpi { background:#f0f2f6; border-radius:8px; padding:.75rem 1rem; flex:1; }
.kpi .val { font-size:1.6rem; font-weight:600; color:#0e1117; }
.kpi .lbl { font-size:.75rem; color:#6c757d; margin-top:2px; }
.section-tag { font-size:.7rem; font-weight:600; letter-spacing:.08em;
               text-transform:uppercase; color:#6c757d; margin-bottom:.5rem; }
div[data-testid="stExpander"] summary { font-weight:600; }
/* Year filter pills — beige row + brown selected state (main toolbar; single pills widget in app) */
.year-filter-toolbar-label {
    font-weight:600; font-size:1rem; color:#5c4033; margin:0 0 4px 0;
}
.year-filter-toolbar-hint {
    font-size:0.8rem; color:#6c757d; margin:0 0 10px 0;
}
[data-testid="stPills"] button {
    border-radius:999px !important;
    border:1px solid #c9b896 !important;
    background:#fffefb !important;
    color:#3d3429 !important;
    font-size:0.8125rem !important;
    padding:0.28rem 0.65rem !important;
    line-height:1.35 !important;
}
[data-testid="stPills"] button[data-selected="true"],
[data-testid="stPills"] button[aria-checked="true"] {
    background:#5c4033 !important;
    color:#ffffff !important;
    border-color:#5c4033 !important;
}
[data-testid="stPills"] button:focus-visible {
    box-shadow:0 0 0 2px rgba(92,64,51,0.35) !important;
}
/* Main tabs — larger labels & hit targets */
[data-testid="stTabs"] [role="tab"],
[data-testid="stTabs"] button[data-baseweb="tab"],
.stTabs [data-baseweb="tab"] {
    font-size: 1.125rem !important;
    line-height: 1.4 !important;
    padding: 0.7rem 1.05rem !important;
    min-height: 3rem !important;
}
[data-testid="stTabs"] [role="tab"] *,
[data-testid="stTabs"] button[data-baseweb="tab"] *,
.stTabs [data-baseweb="tab"] p {
    font-size: 1.125rem !important;
}
[data-testid="stTabs"] [data-baseweb="tab-list"],
.stTabs [data-baseweb="tab-list"] {
    gap: 0.25rem 0.5rem !important;
}
</style>
""", unsafe_allow_html=True)

SEED = 42

# ─── Helpers (Explanation) ────────────────────────────────────────────────────
# The helpers below provide utility functions and mappings used throughout the app.

# RMSE: Calculates root mean squared error - a standard regression metric.
def rmse(y, p):
    """Return the Root Mean Squared Error (RMSE) between y and predictions p."""
    return float(np.sqrt(mean_squared_error(y, p)))

# MAPE: Calculates mean absolute percentage error, handling divide-by-zero.
def mape_safe(y, p):
    """Return the Mean Absolute Percentage Error (MAPE); skips cases where the true value is zero."""
    m = np.array(y) != 0
    return float(np.mean(np.abs((np.array(y)[m] - np.array(p)[m]) / np.array(y)[m])) * 100)

# Mapping from metric name to their corresponding Python function.
METRIC_FNS = {
    "RMSE":  rmse,
    "MAE":   lambda y, p: float(mean_absolute_error(y, p)),
    "R²":    lambda y, p: float(r2_score(y, p)),
    "MAPE":  mape_safe,
    "MedAE": lambda y, p: float(median_absolute_error(y, p)),
}

# Evaluate a set of selected metric names on true/predicted values. Rounds results to 4 decimals.
def evaluate(y_true, y_pred, metrics):
    """Return a dict mapping metric names to their scores for y_true/y_pred."""
    return {m: round(METRIC_FNS[m](y_true, y_pred), 4) for m in metrics}

# Construct a sklearn pipeline with scaling and a chosen regression model.
def make_pipe(name):
    """
    Given a string `name`, return a sklearn Pipeline with a StandardScaler and the
    corresponding regression model.
    """
    reg_map = {
        "OLS":              LinearRegression(),
        "Ridge":            Ridge(alpha=1.0, random_state=SEED),
        "Lasso":            Lasso(alpha=0.1, max_iter=5000, random_state=SEED),
        "ElasticNet":       ElasticNet(alpha=0.1, l1_ratio=0.5, random_state=SEED),
        "Random Forest":    RandomForestRegressor(n_estimators=200, random_state=SEED, n_jobs=-1),
        "Gradient Boosting": _gradient_boosting_regressor(random_state=SEED),
        "SVR":              SVR(kernel="rbf", C=10, epsilon=0.5),
        "k-NN":             KNeighborsRegressor(n_neighbors=10, weights="distance"),
        "Neural Net":       MLPRegressor(hidden_layer_sizes=(128,64), max_iter=500,
                                         random_state=SEED, early_stopping=True),
    }
    reg = reg_map[name]
    return Pipeline([("scaler", StandardScaler()), ("model", reg)])

# Lookup dictionaries for coloring and categorizing variables (used for plotting/presentation).

VAR_COLORS = {
    "SMOKING": "#185FA5",
    "POVERTY": "#185FA5",
    "PM25": "#3B6D11",
    "NO2": "#3B6D11",
    "SO2": "#3B6D11",
    "Year": "#854F0B",
    "X": "#5F5E5A",
    "Y": "#5F5E5A",
}
VAR_CATEGORY = {
    "SMOKING": "Socioeconomic",
    "POVERTY": "Socioeconomic",
    "PM25": "Environmental",
    "NO2": "Environmental",
    "SO2": "Environmental",
    "Year": "Temporal",
    "X": "Spatial",
    "Y": "Spatial",
}
SHAP_SIGN = {
    "SMOKING": 1,
    "POVERTY": 1,
    "PM25": 1,
    "NO2": 1,
    "SO2": 1,
    "Year": -1,
    "X": -1,
    "Y": 1
}

# Matplotlib styling for consistent, clean visualizations.
plt.rcParams.update({
    "figure.dpi": 120,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "axes.grid": True,
    "grid.alpha": 0.3
})
                

# ─── Sidebar: data & global settings ─────────────────────────────────────────
# This block builds the sidebar interface using Streamlit to configure the dataset and modeling options.
with st.sidebar:
    # Display the dashboard title and subtitle at the top of the sidebar.
    st.title("🫁 LBC Dashboard")
    st.caption("Lung & Bronchus Cancer mortality rate prediction")
    st.divider()

    # --- Data source file upload/input ---
    st.markdown("**📂 Data source**")
    # File uploader widget for CSV files, with helpful instructions in the tooltip.
    uploaded = st.file_uploader("Upload CSV", type=["csv"],
                                help="Must contain RATE column + feature columns")
    if uploaded:
        # If a file is uploaded, read the CSV into a Pandas DataFrame.
        df_raw = pd.read_csv(uploaded)
        # Show a success message with shape of the loaded data.
        st.success(f"Loaded {df_raw.shape[0]:,} rows × {df_raw.shape[1]} cols")
    else:
        # If no file uploaded, look for the default CSV file.
        default_path = "data_1998_2010_long_lbc.csv"
        if os.path.exists(default_path):
            # If default file exists, use it and display a message.
            df_raw = pd.read_csv(default_path)
            st.info(f"Using default: `{default_path}`")
        else:
            # Otherwise, ask the user to upload a file and stop further execution of the app.
            st.warning("Upload a CSV to begin.")
            st.stop()

    # --- Target, ID, temporal, and feature selection ---
    st.divider()
    st.markdown("**🎯 Target & features**")
    # Get all columns present in the data.
    all_cols = list(df_raw.columns)

    # User selects the target column (for supervised learning).
    target = st.selectbox("Target column", all_cols,
                          index=all_cols.index("RATE") if "RATE" in all_cols else 0)

    # User selects ID columns (usually dropped before modeling, often things like FIPS code).
    id_cols_default = ["FIPS"] if "FIPS" in all_cols else []
    id_cols = st.multiselect("ID columns (drop before modelling)",
                              all_cols, default=id_cols_default)
                              
    # User selects a temporal (time) column, or "None" if not present.
    temporal_col = st.selectbox("Temporal column (None = absent)",
                                 ["None"] + all_cols,
                                 index=all_cols.index("Year")+1 if "Year" in all_cols else 0)
    temporal_col = None if temporal_col == "None" else temporal_col

    # Candidate feature columns are all except selected IDs and the target.
    candidate_feats = [c for c in all_cols if c not in id_cols + [target]]
    # Preferred default features (if present).
    default_feats = [c for c in ["SMOKING","POVERTY","PM25","NO2","SO2","Year"]
                     if c in candidate_feats]
    # User selects feature columns for modeling (with a reasonable default selection).
    features = st.multiselect("Feature columns", candidate_feats,
                               default=default_feats or candidate_feats[:6])

    # --- Global settings (random seed, plot DPI) ---
    st.divider()
    st.markdown("**⚙️ Global**")
    # User can set the random seed (for reproducibility in results).
    rand_seed = st.number_input("Random seed", value=42, step=1)
    SEED = int(rand_seed)
    # Plot DPI can be adjusted for quality of matplotlib figures.
    fig_dpi = st.slider("Plot DPI", 80, 200, 120, step=20)
    plt.rcParams["figure.dpi"] = fig_dpi

# ─── Year filter: lets user pick which "year" of data to analyze across all dashboard tabs ───
# If a temporal (year) column is specified and exists, provide year filtering options:
#   - "All years": use all data as-is
#   - "Mean of all years": aggregate by ID columns, taking averages over years
#   - One option per unique year present in the data (e.g. "2005", "2010", etc)
# If not present, only "All years" is available.
if temporal_col and temporal_col in df_raw.columns:
    # Collect unique years from the temporal column
    year_opts = ["All years", "Mean of all years"] + \
                [str(y) for y in sorted(df_raw[temporal_col].unique())]
else:
    year_opts = ["All years"]

# Store user's filter choice in session state (so it persists across reruns)
_year_key = "lbc_year_filter_choice"
if _year_key not in st.session_state or st.session_state[_year_key] not in year_opts:
    st.session_state[_year_key] = year_opts[0]

# Render a toolbar-like container for year selection
with st.container(border=True):
    # Show the filter label and help text (via Markdown/HTML)
    st.markdown(
        '<p class="year-filter-toolbar-label">Year filter</p>'
        '<p class="year-filter-toolbar-hint">Applies across EDA, modelling, and variable importance tabs.</p>',
        unsafe_allow_html=True,
    )
    # Prefer using Streamlit's "pills" widget if available (modern look), otherwise fall back to a dropdown
    if hasattr(st, "pills"):
        year_filter = st.pills(
            "year_filter_main",
            year_opts,
            selection_mode="single",
            key=_year_key,
            label_visibility="collapsed",
        )
    else:
        year_filter = st.selectbox("Filter", year_opts, key=_year_key)
    # If no selection, default to first option
    if year_filter is None:
        year_filter = year_opts[0]
 

# ─── Explanation: Applying Year Filter ────────────────────────────────────────
# This block applies the user's chosen year filter to the data, affecting all downstream analysis.
# There are three possible user choices:
#
#   1. "All years":      Use the raw dataframe (df_raw) unchanged, which contains all years.
#   2. "Mean of all years": Aggregate the data so each unique ID (e.g., county) gets its mean values across years.
#      - The grouping columns are: all user-specified ID columns plus "X", "Y" if both are present.
#      - After grouping, mean is taken for all numeric columns. If there are no ID columns, use a single-row mean.
#      - Any temporal column is dropped, and it is removed from the features list if present.
#   3. A specific year (e.g., "2008"): Filter the data to just that year using the temporal column.
#      - If there's no temporal column, leave the dataframe unchanged.

if year_filter == "All years":
    # Keep the data as-is (all years in view)
    df = df_raw.copy()
    filter_label = "All years"
elif year_filter == "Mean of all years":
    # Prepare group-by keys for aggregation: IDs plus X/Y if both present
    grp = [
        c for c in id_cols + (["X", "Y"] if all(c in df_raw.columns for c in ["X", "Y"]) else [])
        if c in df_raw.columns
    ]
    # Compute means across years, grouped by those keys (or over all rows if no keys)
    if grp:
        df = df_raw.groupby(grp, as_index=False).mean(numeric_only=True)
    else:
        df = df_raw.mean(numeric_only=True).to_frame().T
    # If a temporal column is present, drop it and remove it from features
    if temporal_col and temporal_col in df.columns:
        df = df.drop(columns=[temporal_col])
        if temporal_col in features:
            features = [f for f in features if f != temporal_col]
    filter_label = "Per-county means (all years)"
else:
    # Interpret year as integer and filter dataset to rows with matching year
    yr = int(year_filter)
    if temporal_col:
        df = df_raw[df_raw[temporal_col] == yr].copy()
    else:
        df = df_raw.copy()
    filter_label = f"Year = {yr}"

# After filtering: select active features and target subset, dropping any rows with NA in the features
active_features = [f for f in features if f in df.columns]
X_full = df[active_features].dropna()
y_full = df.loc[X_full.index, target]

# ─── Navigation ──────────────────────────────────────────────────────────────
tabs = st.tabs(["📊 EDA", "✂️ Data split", "🔢 Covariates",
                "🤖 Models", "📏 Metrics", "🚀 Train & compare",
                "🌟 Variable importance"])

# ══════════════════════════════════════════════════════════════════════════════
# TAB 1 — EDA
# ══════════════════════════════════════════════════════════════════════════════
# This code constructs the "EDA" (Exploratory Data Analysis) tab in a Streamlit dashboard.
with tabs[0]:
    # Heading and subtitle showing the current data filtering context and number of rows/features in view
    st.header("Exploratory data analysis")
    st.caption(f"Filter: **{filter_label}** · {len(df):,} rows · {len(active_features)} features")

    # Display Key Performance Indicators (KPIs) in a four-column layout
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Records in view", f"{len(df):,}")
    c2.metric(f"Mean {target}", f"{y_full.mean():.1f}")
    c3.metric(f"Std {target}", f"{y_full.std():.1f}")
    c4.metric("Features", len(active_features))
    st.divider()

    # Split the main EDA area into two columns for different kinds of charts
    col_left, col_right = st.columns(2)

    # --- Left column: target distribution visualization ---
    with col_left:
        st.subheader(f"{target} distribution")
        # Let user choose how they want to view the target's distribution
        chart_type = st.radio("Chart type", ["Histogram", "Density", "Box plot"],
                              horizontal=True, key="eda_chart")
        fig, ax = plt.subplots(figsize=(5,3))
        if chart_type == "Histogram":
            # Plot a histogram of the target variable
            ax.hist(y_full.dropna(), bins=40, color="#378ADD", alpha=0.85,
                    edgecolor="white", linewidth=0.4)
            ax.set_xlabel(target)
            ax.set_ylabel("Count")
        elif chart_type == "Density":
            # Plot a kernel density estimate (smooth distribution)
            y_full.dropna().plot.kde(ax=ax, color="#378ADD", linewidth=2)
            ax.fill_between(ax.lines[0].get_xdata(), ax.lines[0].get_ydata(),
                            alpha=0.15, color="#378ADD")
            ax.set_xlabel(target)
        else:
            # Plot a boxplot for the target variable
            ax.boxplot(y_full.dropna(), vert=False, patch_artist=True,
                       boxprops=dict(facecolor="#B5D4F4", color="#185FA5"),
                       medianprops=dict(color="#185FA5", linewidth=2))
            ax.set_xlabel(target)
            ax.set_yticks([])
        ax.set_title(f"Distribution of {target}")
        st.pyplot(fig, width="stretch")
        plt.close(fig)

    # --- Right column: correlation of features with target ---
    with col_right:
        st.subheader(f"Correlation with {target}")
        # Find which features are numeric and in the current dataframe
        corr_feats = [f for f in active_features if df[f].dtype in [float, int] and f in df.columns]
        # Compute the Pearson correlation of each feature with the target
        corrs = df[corr_feats + [target]].corr()[target].drop(target).sort_values()
        fig, ax = plt.subplots(figsize=(5,3))
        # Color bars green (positive), red (negative)
        colors = ["#3B6D11" if v > 0 else "#A32D2D" for v in corrs]
        ax.barh(corrs.index, corrs.values, color=colors)
        ax.axvline(0, color="black", linewidth=0.6)
        ax.set_title(f"Pearson r with {target}")
        ax.set_xlabel("Correlation")
        st.pyplot(fig, width="stretch")
        plt.close(fig)

    # --- Optional time-series plot if temporal column is present ---
    if temporal_col and temporal_col in df.columns:
        st.subheader(f"{target} over time")
        # Calculate the average target per time period (e.g., year)
        trend = df.groupby(temporal_col)[target].mean().reset_index()
        fig, ax = plt.subplots(figsize=(10,3))
        ax.plot(trend[temporal_col], trend[target], marker="o",
                color="#185FA5", linewidth=2, markersize=4)
        ax.fill_between(trend[temporal_col], trend[target], alpha=0.1, color="#185FA5")
        ax.set_xlabel(temporal_col)
        ax.set_ylabel(f"Mean {target}")
        ax.set_title(f"Mean {target} by {temporal_col}")
        st.pyplot(fig, width="stretch")
        plt.close(fig)

    # --- Scatterplot: Explore the relationship between any feature and the target ---
    st.subheader("Scatter: covariate vs target")
    sc1, sc2, sc3 = st.columns([2,2,1])
    x_feat = sc1.selectbox("X axis", active_features, key="scatter_x")
    n_samp = sc3.select_slider("Sample", [200, 500, 1000, 2000, 5000], value=500)
    # Subsample the data for performance if it's large
    sample = df[[x_feat, target]].dropna().sample(min(n_samp, len(df)), random_state=SEED)
    fig, ax = plt.subplots(figsize=(9,3.5))
    # Scatterplot colored blue
    ax.scatter(sample[x_feat], sample[target], alpha=0.3, s=10, color="#378ADD")
    # Fit and plot linear regression line & correlation coefficient
    m, b, r, *_ = stats.linregress(sample[x_feat], sample[target])
    xl = np.linspace(sample[x_feat].min(), sample[x_feat].max(), 100)
    ax.plot(xl, m*xl+b, color="#E24B4A", linewidth=1.5, linestyle="--",
            label=f"r = {r:.2f}")
    ax.legend(frameon=False)
    ax.set_xlabel(x_feat)
    ax.set_ylabel(target)
    ax.set_title(f"{x_feat} vs {target}  (n={len(sample):,})")
    st.pyplot(fig, width="stretch")
    plt.close(fig)

    # --- Descriptive statistics summary for features and target ---
    st.subheader("Descriptive statistics")
    desc = df[active_features + [target]].describe().T.round(3)
    st.dataframe(desc, width="stretch")

    # --- Correlation heatmap (full pairwise matrix) in an expand/collapse box ---
    with st.expander("Correlation heatmap"):
        # Compute full correlation matrix for selected features and target
        corr_mat = df[active_features + [target]].corr()
        fig, ax = plt.subplots(figsize=(8,6))
        # Only show lower triangle of the matrix
        mask = np.triu(np.ones_like(corr_mat, dtype=bool))
        sns.heatmap(corr_mat, mask=mask, annot=True, fmt=".2f",
                    cmap="RdBu_r", center=0, vmin=-1, vmax=1,
                    ax=ax, linewidths=0.4, cbar_kws={"shrink":0.8})
        ax.set_title("Correlation matrix")
        st.pyplot(fig, width="stretch")
        plt.close(fig)

# ══════════════════════════════════════════════════════════════════════════════
# TAB 2 — DATA SPLIT
# ══════════════════════════════════════════════════════════════════════════════
with tabs[1]:
    st.header("Data splitting strategy")

    sp1, sp2 = st.columns([1,2])
    with sp1:
        strategy = st.radio("Strategy",
                            ["Random","Temporal","Spatial","K-Fold CV"],
                            help="Temporal avoids leakage by ordering by time.")
        train_f = st.slider("Train %", 50, 85, 70, 5) / 100
        val_f   = st.slider("Validation %", 5, 25, 15, 5) / 100
        test_f  = round(1 - train_f - val_f, 2)
        if strategy == "K-Fold CV":
            n_folds = st.slider("K folds", 3, 10, 5)
        st.metric("Test %", f"{test_f:.0%}")
        if test_f < 0:
            st.error("Train + Val > 100% — reduce sliders.")

    with sp2:
        n = len(X_full)
        n_tr = int(n * train_f)
        n_va = int(n * val_f)
        n_te = n - n_tr - n_va

        c1,c2,c3 = st.columns(3)
        c1.metric("Train records", f"{n_tr:,}", f"{train_f:.0%}")
        c2.metric("Validation records", f"{n_va:,}", f"{val_f:.0%}")
        c3.metric("Test records", f"{n_te:,}", f"{test_f:.0%}")

        # Visual split bar
        bar_html = f"""
        <div style="display:flex;height:28px;border-radius:6px;overflow:hidden;font-size:12px;font-weight:600;color:white">
          <div style="width:{train_f*100:.0f}%;background:#3B6D11;display:flex;align-items:center;justify-content:center">Train {train_f:.0%}</div>
          <div style="width:{val_f*100:.0f}%;background:#BA7517;display:flex;align-items:center;justify-content:center">Val {val_f:.0%}</div>
          <div style="width:{test_f*100:.0f}%;background:#E24B4A;display:flex;align-items:center;justify-content:center">Test {test_f:.0%}</div>
        </div>"""
        st.markdown(bar_html, unsafe_allow_html=True)
        st.caption("")

        # Temporal visualisation
        if temporal_col and temporal_col in df.columns and strategy == "Temporal":
            years_s = sorted(df[temporal_col].unique())
            n_yr = len(years_s)
            tr_cut = years_s[int(n_yr * train_f)]
            va_cut = years_s[int(n_yr * (train_f + val_f))]
            trend  = df.groupby(temporal_col)[target].mean().reset_index()
            fig, ax = plt.subplots(figsize=(8,3))
            for _, row in trend.iterrows():
                yr = row[temporal_col]
                c = "#3B6D11" if yr < tr_cut else "#BA7517" if yr < va_cut else "#E24B4A"
                ax.bar(yr, row[target], color=c, width=0.8)
            from matplotlib.patches import Patch
            ax.legend(handles=[Patch(color="#3B6D11",label="Train"),
                                Patch(color="#BA7517",label="Val"),
                                Patch(color="#E24B4A",label="Test")], frameon=False)
            ax.set_xlabel(temporal_col); ax.set_ylabel(f"Mean {target}")
            ax.set_title(f"Mean {target} by year — temporal split")
            st.pyplot(fig, width="stretch"); plt.close(fig)
        elif temporal_col and temporal_col in df.columns:
            trend = df.groupby(temporal_col)[target].mean().reset_index()
            fig, ax = plt.subplots(figsize=(8,3))
            ax.bar(trend[temporal_col], trend[target], color="#B5D4F4", width=0.8)
            ax.set_xlabel(temporal_col); ax.set_ylabel(f"Mean {target}")
            ax.set_title(f"Mean {target} by {temporal_col}")
            st.pyplot(fig, width="stretch"); plt.close(fig)

    # Store split config in session state
    st.session_state["split_cfg"] = dict(strategy=strategy, train_f=train_f,
                                          val_f=val_f, test_f=test_f,
                                          n_folds=n_folds if strategy=="K-Fold CV" else 5)

# ══════════════════════════════════════════════════════════════════════════════
# TAB 3 — COVARIATES
# ══════════════════════════════════════════════════════════════════════════════
# TAB 3 — COVARIATES (EXPLANATION)
# This block forms the Covariates tab in the dashboard, where the user chooses which features (covariates) to use for modeling.

with tabs[2]:
    st.header("Covariate selection")  # Section header at the top of the tab

    # Split the tab into two columns: left for presets/selection, right for info and visualizations
    cv1, cv2 = st.columns([1,2])

    # ---- LEFT COLUMN: Preset and custom feature selectors ----
    with cv1:
        # Radio buttons for quickly picking a preset set of features
        preset = st.radio(
            "Quick preset",
            ["Custom", "All", "Environmental", "Socioeconomic", "No spatial"]
        )

        # Define available groups of features (if present in the currently active features list)
        env_feats = [f for f in ["PM25", "NO2", "SO2"] if f in active_features]
        socio_feats = [f for f in ["SMOKING", "POVERTY"] if f in active_features]
        spatial_feats = [f for f in ["X", "Y"] if f in active_features]

        # Set which features will be selected by default according to the chosen preset
        if preset == "All":
            default_sel = active_features
        elif preset == "Environmental":
            default_sel = env_feats
        elif preset == "Socioeconomic":
            default_sel = socio_feats
        elif preset == "No spatial":
            default_sel = [f for f in active_features if f not in spatial_feats]
        else:
            # Custom: allow manual selection, default to all active features
            default_sel = active_features

        # Multiselect widget for the user to pick specific covariates from active features
        sel_features = st.multiselect("Select covariates", active_features, default=default_sel, key="cov_sel")

    # ---- RIGHT COLUMN: Selected types, feature stats, and visualization ----
    with cv2:
        # List which "types" of features are represented in the current selection
        types = []
        if any(f in sel_features for f in socio_feats):
            types.append("Socioeconomic")
        if any(f in sel_features for f in env_feats):
            types.append("Environmental")
        if any(f in sel_features for f in spatial_feats):
            types.append("Spatial")
        if "Year" in sel_features:
            types.append("Temporal")

        # Two columns for summary metrics
        m1, m2 = st.columns(2)
        m1.metric("Selected features", len(sel_features))  # Show how many features selected
        m2.metric("Feature types", " + ".join(types) if types else "none")  # Show what types those are

        if sel_features:
            # Calculate the absolute Pearson correlation between each selected feature and the target
            corr_sel = (
                df[sel_features + [target]]  # Get only the selected features + target
                .corr()[target]              # Correlations vs target
                .drop(target)                # Drop target itself
                .abs().sort_values(ascending=True)  # Sort by absolute correlation ascending
            )

            # Plot a horizontal bar chart showing the absolute correlation for each feature
            fig, ax = plt.subplots(figsize=(6, max(2.5, len(sel_features)*0.4)))
            colors = [VAR_COLORS.get(f, "#888780") for f in corr_sel.index]  # Color by category if defined
            ax.barh(corr_sel.index, corr_sel.values, color=colors)
            ax.set_xlim(0,1)
            ax.set_xlabel("|Pearson r| with target")
            ax.set_title("Variable importance (bivariate correlation)")
            st.pyplot(fig, width="stretch")
            plt.close(fig)

            # Pairplot: for ≤5 selected features, show scatterplots and KDEs for all pairs
            st.subheader("Pair-plot sample")
            n_pairs = min(500, len(df))
            # Take up to 500 random rows (just for visual speed)
            pair_sample = df[sel_features + [target]].dropna().sample(n_pairs, random_state=SEED)
            if len(sel_features) <= 5:
                fig = sns.pairplot(
                    pair_sample,
                    diag_kind="kde",
                    plot_kws={"alpha": 0.3, "s": 6},
                    diag_kws={"color": "#378ADD"},
                    corner=True
                ).fig
                st.pyplot(fig, width="stretch")
                plt.close(fig)
            else:
                st.info("Pair-plot shown for ≤5 features. Reduce selection to enable.")

    # Save the currently selected features to Streamlit session state for use in other tabs
    st.session_state["sel_features"] = sel_features

# ══════════════════════════════════════════════════════════════════════════════
# TAB 4 — MODELS
# ══════════════════════════════════════════════════════════════════════════════
with tabs[3]:
    st.header("Model selection")

    BASE_MODELS = ["OLS","Ridge","Lasso","ElasticNet",
                   "Random Forest","Gradient Boosting",
                   "SVR","k-NN","Neural Net"] + (["GAM"] if HAS_GAM else [])

    st.subheader("Base models")
    cols = st.columns(3)
    selected_models = []
    for i, m in enumerate(BASE_MODELS):
        with cols[i % 3]:
            badge = {"OLS":"🟢 Fast","Ridge":"🟢 Fast","Lasso":"🟢 Fast",
                     "ElasticNet":"🟢 Fast","Random Forest":"🟡 Med",
                     "Gradient Boosting":"🔴 Slow","SVR":"🔴 Slow",
                     "k-NN":"🟡 Med","Neural Net":"🔴 Slow","GAM":"🟡 Med"}.get(m,"")
            if st.checkbox(f"{m}  {badge}", value=m in ["OLS","Ridge"], key=f"mdl_{m}"):
                selected_models.append(m)

    st.session_state["selected_models"] = selected_models
    st.caption(f"Selected: **{', '.join(selected_models) or 'none'}**")
    st.divider()

    # ── Ensemble builder (EXPLANATION) ─────────────────────────────────────
    # This section creates the "Ensemble model builder" in the dashboard.
    # An ensemble combines multiple models to improve prediction. 
    st.subheader("🔮 Ensemble model builder")
    # User can enable or disable ensemble stacking via toggle.
    ens_enabled = st.toggle("Enable ensemble stacking", value=False)

    if ens_enabled:
        # When enabled, two columns are presented for ensemble config:
        e1, e2 = st.columns(2)

        # --- LEFT COLUMN: Main stacking settings
        with e1:
            # Choose ensemble strategy (method for combination of models)
            ens_strategy = st.selectbox(
                "Strategy",
                ["Stacking", "Blending", "Weighted averaging", "Bagging", "Boosting chain"]
            )
            # Show explanation caption for the selected strategy
            st.caption({
                "Stacking": "Meta-learner trained on out-of-fold predictions (most flexible).",
                "Blending": "Meta-learner trained on held-out validation set (faster).",
                "Weighted averaging": "Fixed weighted mean of base model outputs.",
                "Bagging": "Bootstrap aggregation — reduces variance.",
                "Boosting chain": "Each model corrects residuals of the previous.",
            }[ens_strategy])

            # User selects which models will constitute base learners for the ensemble
            base_for_ens = st.multiselect(
                "Base learners (≥2)",
                BASE_MODELS,
                default=["Ridge", "Random Forest", "Gradient Boosting"],
                key="ens_base"
            )
            # Warn if fewer than 2 models selected (ensemble requires at least two)
            if len(base_for_ens) < 2:
                st.warning("Select at least 2 base learners.")

        # --- RIGHT COLUMN: Meta-learner and other config
        with e2:
            # List of possible meta-learners (models to combine base predictions)
            META_LEARNERS = [
                "Linear Regression", "Ridge", "Lasso", "ElasticNet",
                "Random Forest", "Gradient Boosting", "Simple averaging"
            ]
            # Show meta-learner selectbox unless strategy doesn't require it
            meta_learner = st.selectbox(
                "Meta-learner",
                META_LEARNERS if ens_strategy not in ["Weighted averaging", "Bagging"]
                else ["N/A — no meta-learner"]
            )
            # For "Stacking" or "Blending", let user adjust cross-validation folds
            if ens_strategy in ["Stacking", "Blending"]:
                cv_folds_ens = st.slider("CV folds (OOF)", 3, 10, 5, key="ens_cv")
                # Optionally pass base input features to meta-learner
                use_orig_feats = st.toggle("Pass original features to meta-learner", True)
            # For "Weighted averaging", let user set weights for each selected model
            if ens_strategy == "Weighted averaging":
                st.markdown("**Model weights**")
                weights = {}
                for bm in base_for_ens:
                    weights[bm] = st.slider(
                        bm, 0, 100, 100 // max(len(base_for_ens), 1),
                        key=f"w_{bm}"
                    )

        # --- Visual summary diagram of the ensemble architecture
        if base_for_ens:
            diag_lines = ["```", "Input features"]
            # Show each base learner graphically
            diag_lines += [f"  → [{b}]" for b in base_for_ens]
            # If using a meta-learner (not just averaging/bagging), also show meta-learner
            if ens_strategy not in ["Weighted averaging", "Bagging"]:
                diag_lines += [f"      → [{meta_learner} meta-learner]"]
            else:
                agg = "Weighted avg" if ens_strategy == "Weighted averaging" else "Bootstrap avg"
                diag_lines += [f"      → [{agg}]"]
            diag_lines += ["          → RATE prediction", "```"]
            st.code("\n".join(diag_lines), language=None)

        # Save all ensemble builder settings to Streamlit's session state for use elsewhere
        st.session_state["ens_cfg"] = dict(
            enabled=True,
            strategy=ens_strategy,
            base_learners=base_for_ens,
            meta_learner=meta_learner,
            cv_folds=cv_folds_ens if ens_strategy in ["Stacking", "Blending"] else 5,
            use_orig=use_orig_feats if ens_strategy in ["Stacking", "Blending"] else False,
            weights=weights if ens_strategy == "Weighted averaging" else None,
        )
    else:
        # If ensemble is disabled, record so in session state
        st.session_state["ens_cfg"] = {"enabled": False}

    # Separator line for visual clarity
    st.divider()
    # Hyperparameter tuning section lets user select and configure search strategies for model tuning
    st.subheader("Hyperparameter tuning")
    hp_strat = st.selectbox(
        "HP strategy",
        ["Default (no tuning)", "Grid search", "Random search", "Bayesian opt."]
    )
    # If not "Default," let the user set number of search iterations
    if hp_strat != "Default (no tuning)":
        hp_iter = st.slider("Search iterations", 10, 100, 20, 10)

# ══════════════════════════════════════════════════════════════════════════════
# TAB 5 — METRICS
# ══════════════════════════════════════════════════════════════════════════════
# This section defines the logic for the Metrics tab, where users select performance metrics.
with tabs[4]:
    st.header("Validation metrics")

    # Layout: two columns for metrics selection and settings
    m1, m2 = st.columns(2)
    with m1:
        st.markdown("**Select metrics to compute**")
        # User can select which metrics to compute using checkboxes
        use_rmse  = st.checkbox("RMSE — root mean squared error", True)
        use_mae   = st.checkbox("MAE — mean absolute error", True)
        use_r2    = st.checkbox("R² — coefficient of determination", True)
        use_mape  = st.checkbox("MAPE — mean absolute percentage error")
        use_medae = st.checkbox("MedAE — median absolute error")
    with m2:
        # User selects a single metric to rank models by
        rank_by = st.radio("Primary ranking metric", ["RMSE", "MAE", "R²", "MAPE", "MedAE"], index=0)
        # User selects whether to evaluate on validation or test set
        eval_set = st.radio("Evaluate on", ["Validation set", "Test set"])

    # Compose a list of selected metrics
    chosen_metrics = [
        m for m, v in [
            ("RMSE", use_rmse), ("MAE", use_mae),
            ("R²", use_r2), ("MAPE", use_mape), ("MedAE", use_medae)
        ] if v
    ]
    # Store metric config in Streamlit session state
    st.session_state["metrics_cfg"] = dict(metrics=chosen_metrics, rank_by=rank_by, eval_set=eval_set)

    st.divider()
    st.subheader("Metric descriptions")
    # Description for each metric
    metric_info = {
        "RMSE": "Penalises large errors heavily. Same units as the target. Lower = better.",
        "MAE":  "Average absolute error. Robust to outliers. Lower = better.",
        "R²":   "Proportion of variance explained. 1.0 = perfect fit. Higher = better.",
        "MAPE": "Scale-independent percentage error. Lower = better. Undefined if target = 0.",
        "MedAE":"Median absolute error. Very robust to outliers. Lower = better.",
    }
    # Show info only for selected metrics
    for m, desc in metric_info.items():
        if m in chosen_metrics:
            st.markdown(f"**{m}** — {desc}")

# ══════════════════════════════════════════════════════════════════════════════
# TAB 6 — TRAIN & COMPARE
# ══════════════════════════════════════════════════════════════════════════════
# This section implements the model training and comparison logic.
with tabs[5]:
    st.header("Train & compare models")

    # Load various configuration settings from session state
    split_cfg   = st.session_state.get("split_cfg", {"strategy":"Random","train_f":0.7,"val_f":0.15,"test_f":0.15,"n_folds":5})
    ens_cfg     = st.session_state.get("ens_cfg",   {"enabled":False})
    metrics_cfg = st.session_state.get("metrics_cfg", {"metrics":["RMSE","MAE","R²"],"rank_by":"RMSE","eval_set":"Validation set"})
    sel_features_train = st.session_state.get("sel_features", active_features)
    sel_models  = st.session_state.get("selected_models", ["OLS","Ridge"])

    # Prepare the feature matrix and target vector for training
    Xt = df[sel_features_train].dropna()
    yt = df.loc[Xt.index, target]

    # Display general info (number of records, features, models, ensemble status)
    st.info(f"**{filter_label}** · {len(Xt):,} records · {len(sel_features_train)} features · {len(sel_models)} base model(s)" +
            (" + Ensemble" if ens_cfg.get("enabled") else ""))

    # If no models or features are selected, show a warning
    if not sel_models:
        st.warning("Go to **Models** tab and select at least one model.")
    elif not sel_features_train:
        st.warning("Go to **Covariates** tab and select at least one feature.")
    # If user clicks the 'Run selected models' button, start training
    elif st.button("▶  Run selected models", type="primary", width="stretch"):

        # ── Build train/val/test splits ─────────────────────────────────────
        strat = split_cfg["strategy"]
        tf, vf = split_cfg["train_f"], split_cfg["val_f"]

        if strat == "Temporal" and temporal_col and temporal_col in df.columns:
            # Temporal split: partitions data by years to avoid leakage
            years_all = sorted(df.loc[Xt.index, temporal_col].unique())
            ny = len(years_all)
            tr_cut = years_all[int(ny*tf)]
            va_cut = years_all[int(ny*(tf+vf))]
            idx = Xt.index
            yr_ser = df.loc[idx, temporal_col]
            # Define train/val/test indices based on year thresholds
            tr_i = idx[yr_ser < tr_cut]
            va_i = idx[(yr_ser >= tr_cut) & (yr_ser < va_cut)]
            te_i = idx[yr_ser >= va_cut]
            X_train, y_train = Xt.loc[tr_i], yt.loc[tr_i]
            X_val,   y_val   = Xt.loc[va_i], yt.loc[va_i]
            X_test,  y_test  = Xt.loc[te_i], yt.loc[te_i]
        elif strat == "K-Fold CV":
            # K-Fold CV: holds out a test set; trains/validates on remaining data
            X_rest, X_test, y_rest, y_test = train_test_split(
                Xt, yt, test_size=0.2, random_state=SEED)
            X_train, X_val, y_train, y_val = X_rest, X_rest, y_rest, y_rest
        else:
            # Default: random split into train/val/test as per user fractions
            X_tv, X_test, y_tv, y_test = train_test_split(
                Xt, yt, test_size=split_cfg["test_f"], random_state=SEED)
            vs = vf / (tf + vf)
            X_train, X_val, y_train, y_val = train_test_split(
                X_tv, y_tv, test_size=vs, random_state=SEED)

        # Choose which split (val or test) to use for evaluation based on user setting
        eval_X = X_val if metrics_cfg["eval_set"] == "Validation set" else X_test
        eval_y = y_val if metrics_cfg["eval_set"] == "Validation set" else y_test

        # ── Train models ─────────────────────────────────────────────────────
        results, trained = {}, {}
        prog = st.progress(0, text="Training models…")
        n_total = len(sel_models) + (1 if ens_cfg.get("enabled") else 0)

        for i, mname in enumerate(sel_models):
            prog.progress((i+0.5)/n_total, text=f"Training {mname}…")
            if mname == "GAM":
                # Special handling for Generalized Additive Model (needs PyGAM)
                if not HAS_GAM:
                    st.warning("PyGAM not installed — skipping GAM."); continue
                sc = StandardScaler()
                Xt_tr = sc.fit_transform(X_train)
                terms = sum(gam_s(j) for j in range(Xt_tr.shape[1]))
                mdl = LinearGAM(terms).fit(Xt_tr, y_train)
                class _W:
                    def __init__(self,g,s): self.g,self.s=g,s
                    def predict(self,X): return self.g.predict(self.s.transform(X))
                trained[mname] = _W(mdl, sc)
            else:
                # For other models, use a pipeline
                pipe = make_pipe(mname)
                pipe.fit(X_train, y_train)
                trained[mname] = pipe

            # Model predictions and metric evaluation
            preds = trained[mname].predict(eval_X)
            results[mname] = evaluate(eval_y, preds, metrics_cfg["metrics"])
            prog.progress((i+1)/n_total, text=f"{mname} done.")

        # ── Ensemble modeling ────────────────────────────────────────────────
        ens_name = None
        if ens_cfg.get("enabled") and len(ens_cfg.get("base_learners", [])) >= 2:
            prog.progress((n_total-0.5)/n_total, text="Building ensemble…")
            bl = [b for b in ens_cfg["base_learners"] if b in trained]
            estrat = ens_cfg["strategy"]

            if estrat in ("Stacking", "Blending"):
                # Stacking or Blending: meta-learner is trained on predictions of base models
                if estrat == "Stacking":
                    kf_e = KFold(n_splits=ens_cfg["cv_folds"], shuffle=True, random_state=SEED)
                    meta_tr = np.zeros((len(X_train), len(bl)))
                    for j, bn in enumerate(bl):
                        meta_tr[:, j] = cross_val_predict(make_pipe(bn), X_train, y_train, cv=kf_e, n_jobs=-1)
                    y_meta = y_train.values
                else:
                    # Blending: meta-learner fits base models' predictions on validation set
                    meta_tr = np.column_stack([trained[b].predict(X_val) for b in bl])
                    y_meta = y_val.values

                # Optionally use original features for stacking/blending meta-learner
                if ens_cfg.get("use_orig"):
                    sc_orig = StandardScaler()
                    orig_tr = sc_orig.fit_transform(X_train if estrat == "Stacking" else X_val)
                    meta_tr = np.hstack([meta_tr, orig_tr])

                # Map of supported meta-learners
                meta_map = {
                    "Linear Regression": LinearRegression(),
                    "Ridge": Ridge(alpha=1.0, random_state=SEED),
                    "Lasso": Lasso(alpha=0.05, max_iter=5000, random_state=SEED),
                    "ElasticNet": ElasticNet(alpha=0.05, l1_ratio=0.5, random_state=SEED),
                    "Random Forest": RandomForestRegressor(n_estimators=100, random_state=SEED),
                    "Gradient Boosting": _gradient_boosting_regressor(random_state=SEED),
                    "Simple averaging": None,
                }
                meta_reg = meta_map.get(
                    ens_cfg.get("meta_learner", "Ridge"),
                    Ridge(alpha=1.0, random_state=SEED),
                )
                if meta_reg is not None:
                    meta_reg.fit(meta_tr, y_meta)

                # Define ensemble prediction function
                def ens_pred(X_in):
                    bp = np.column_stack([trained[b].predict(X_in) for b in bl])
                    if ens_cfg.get("use_orig"): bp=np.hstack([bp, sc_orig.transform(X_in)])
                    return meta_reg.predict(bp) if meta_reg else bp.mean(1)

            elif estrat == "Weighted averaging":
                # Weighted average: user supplies weights for models
                w = ens_cfg.get("weights") or {b: 1 for b in bl}
                wsum = sum(w.get(b, 1) for b in bl) or 1

                def ens_pred(X_in):
                    return sum(w.get(b, 1) * trained[b].predict(X_in) for b in bl) / wsum
            elif estrat == "Bagging":
                # Bagging: wrap the base model in a BaggingRegressor
                base_pipe = make_pipe(bl[0])
                bag = BaggingRegressor(estimator=base_pipe.named_steps["model"], n_estimators=30, random_state=SEED, n_jobs=-1)
                sc_bag = StandardScaler()
                bag.fit(sc_bag.fit_transform(X_train), y_train)

                def ens_pred(X_in):
                    return bag.predict(sc_bag.transform(X_in))
            else:
                # Simple mean prediction from base learners
                def ens_pred(X_in):
                    return np.mean([trained[b].predict(X_in) for b in bl], axis=0)

            ens_name = f"Ensemble ({estrat})"
            ens_preds = ens_pred(eval_X)
            results[ens_name] = evaluate(eval_y, ens_preds, metrics_cfg["metrics"])
            trained[ens_name] = type("EnsModel", (object,), {"predict": staticmethod(ens_pred)})()
            prog.progress(1.0, text="Ensemble done.")

        # Save results and trained models in session state for later use/tabs
        prog.empty()
        st.session_state["train_results"] = results
        st.session_state["trained_models"] = trained
        st.session_state["eval_data"] = (eval_X, eval_y)
        st.session_state["ens_name"] = ens_name

        st.success(f"✅ Trained {len(results)} model(s) successfully.")

    # ── Results viewing ──────────────────────────────────────────────────────
    if "train_results" in st.session_state:
        results = st.session_state["train_results"]
        trained = st.session_state["trained_models"]
        eval_X, eval_y = st.session_state["eval_data"]
        ens_name = st.session_state.get("ens_name")
        rank_by = metrics_cfg["rank_by"]
        metrics = metrics_cfg["metrics"]

        # Prepare the results dataframe for display
        res_df = pd.DataFrame(results).T.reset_index().rename(columns={"index": "Model"})
        asc = rank_by != "R²"
        res_sorted = res_df.sort_values(rank_by, ascending=asc).reset_index(drop=True)
        best_name = res_sorted.iloc[0]["Model"]

        # Key Performance Indicators (KPIs) summary row at the top
        c1, c2, c3, c4 = st.columns(4)
        c1.metric("Best model", best_name)
        if rank_by in res_sorted.columns:
            c2.metric(f"Best {rank_by}", f"{res_sorted.iloc[0][rank_by]:.4f}")
        c3.metric("Models trained", len(results))
        # KPI for ensemble relative to best base model
        if ens_name and ens_name in results:
            best_base = res_sorted[~res_sorted["Model"].str.startswith("Ensemble")].iloc[0]
            diff = results[ens_name].get(rank_by, 0) - best_base.get(rank_by, 0)
            c4.metric(
                "Ensemble vs best base",
                f"{abs(diff):.4f}",
                delta=f"{'↓' if (diff<0 and asc) or (diff>0 and not asc) else '↑'} {'better' if (diff<0 and asc) or (diff>0 and not asc) else 'worse'}"
            )

        st.divider()

        # Barplots for RMSE and R^2 for all models
        col_l, col_r = st.columns(2)
        with col_l:
            st.subheader("RMSE comparison")
            if "RMSE" in res_sorted.columns:
                sub = res_sorted.sort_values("RMSE")
                colors = [
                    "#534AB7" if "Ensemble" in str(m)
                    else "#3B6D11" if i == 0 else "#B5D4F4"
                    for i, m in enumerate(sub["Model"])
                ]
                fig, ax = plt.subplots(figsize=(5, max(3, len(sub) * 0.4)))
                ax.barh(sub["Model"], sub["RMSE"], color=colors)
                ax.set_xlabel("RMSE")
                ax.set_title("RMSE (lower = better)")
                ax.invert_yaxis()
                st.pyplot(fig, width="stretch"); plt.close(fig)

        with col_r:
            st.subheader("R² comparison")
            if "R²" in res_sorted.columns:
                sub = res_sorted.sort_values("R²", ascending=False)
                colors = [
                    "#534AB7" if "Ensemble" in str(m)
                    else "#3B6D11" if i == 0 else "#B5D4F4"
                    for i, m in enumerate(sub["Model"])
                ]
                fig, ax = plt.subplots(figsize=(5, max(3, len(sub) * 0.4)))
                ax.barh(sub["Model"], sub["R²"], color=colors)
                ax.set_xlabel("R²")
                ax.set_title("R² (higher = better)")
                ax.set_xlim(max(0, res_sorted["R²"].min() - 0.05), 1.01)
                ax.invert_yaxis()
                st.pyplot(fig, width="stretch"); plt.close(fig)

        # Full model metrics table, highlighting best/worst
        st.subheader("Full results table")
        styled = res_sorted.set_index("Model")
        st.dataframe(
            styled.style.format("{:.4f}").highlight_min(
                subset=[c for c in metrics if c != "R²"], color="#EAF3DE"
            ).highlight_max(
                subset=[c for c in metrics if c == "R²"], color="#EAF3DE"
            ),
            width="stretch"
        )

        # Scatter and histogram for predicted vs actual for best model
        st.subheader(f"Predicted vs actual — {best_name}")
        best_preds = trained[best_name].predict(eval_X)
        residuals  = eval_y.values - best_preds
        fig, axes = plt.subplots(1, 2, figsize=(11, 4))
        lo = min(eval_y.min(), best_preds.min())
        hi = max(eval_y.max(), best_preds.max())
        # Scatter plot: predicted vs actual
        axes[0].scatter(eval_y, best_preds, alpha=0.3, s=8, color="#378ADD")
        axes[0].plot([lo, hi], [lo, hi], "r--", linewidth=1.2, label="Perfect fit")
        axes[0].set_xlabel(f"Actual {target}")
        axes[0].set_ylabel(f"Predicted {target}")
        axes[0].set_title("Predicted vs actual")
        axes[0].legend(frameon=False)
        # Histogram: residuals
        axes[1].hist(residuals, bins=50, color="#378ADD", alpha=0.8, edgecolor="white", linewidth=0.3)
        axes[1].axvline(0, color="#E24B4A", linewidth=1.5, linestyle="--")
        axes[1].set_xlabel("Residual")
        axes[1].set_ylabel("Count")
        axes[1].set_title("Residual distribution")
        plt.tight_layout()
        st.pyplot(fig, width="stretch"); plt.close(fig)

        st.caption(f"Bias (mean residual): {residuals.mean():.3f} · Std: {residuals.std():.3f}")

        # Download CSV button for results
        csv_buf = io.StringIO()
        res_sorted.to_csv(csv_buf, index=False)
        st.download_button("⬇  Download results CSV", csv_buf.getvalue(),
                           "model_results.csv", "text/csv")

# ══════════════════════════════════════════════════════════════════════════════
# TAB 7 — VARIABLE IMPORTANCE
# ══════════════════════════════════════════════════════════════════════════════
# This tab calculates and displays variable (feature) importance using several methods.
with tabs[6]:
    st.header("Variable importance")

    # Retrieve trained models and evaluation data from session state
    trained   = st.session_state.get("trained_models", {})
    eval_data = st.session_state.get("eval_data", (None, None))
    eval_X_vi, eval_y_vi = eval_data

    # If no models or eval data, prompt user to first train some models
    if not trained or eval_X_vi is None:
        st.info("Run models first in **Train & compare** to unlock all importance methods.")

    # Sidebar: user selects method, model, and sort option
    vi1, vi2, vi3 = st.columns(3)
    vi_method = vi1.selectbox(
        "Method",
        ["Pearson |r|", "Permutation importance", "Coefficient magnitude", "Gini / impurity", "SHAP values"]
    )
    vi_model  = vi2.selectbox(
        "Model",
        ["Best model"] + list(trained.keys()) if trained else ["Best model"]
    )
    vi_sort   = vi3.selectbox("Sort", ["By importance", "Alphabetical", "By category"])

    # Resolve the actual model to use (e.g., the best model if "Best model" was chosen)
    if trained:
        results = st.session_state.get("train_results", {})
        rank_by_vi = st.session_state.get("metrics_cfg", {}).get("rank_by", "RMSE")
        asc_vi = rank_by_vi != "R²"
        if vi_model == "Best model" and results:
            best_vi = sorted(results, key=lambda m: results[m].get(rank_by_vi, 0), reverse=not asc_vi)[0]
            vi_model_resolved = best_vi
        else:
            vi_model_resolved = vi_model
    else:
        vi_model_resolved = None

    # Which features to compute importance for
    feat_cols_vi = eval_X_vi.columns.tolist() if eval_X_vi is not None else active_features

    # ── Compute importance ────────────────────────────────────────────────────
    imp_series = None

    # Each block below computes feature importances via a selected method
    if vi_method == "Pearson |r|":
        # Pearson correlation: computes |correlation| between each feature and target
        imp_values = {}
        for f in feat_cols_vi:
            mask_ = df[f].notna() & df[target].notna()
            if mask_.sum() > 5:
                r_, _ = stats.pearsonr(df.loc[mask_, f], df.loc[mask_, target])
                imp_values[f] = abs(r_)
        imp_series = pd.Series(imp_values, name="Importance")

    elif vi_method == "Permutation importance" and vi_model_resolved and vi_model_resolved in trained:
        # Permutation importance (sklearn): measures decrease in score when each feature is randomized
        with st.spinner("Computing permutation importance…"):
            pipe_vi = trained[vi_model_resolved]
            perm = permutation_importance(pipe_vi, eval_X_vi, eval_y_vi, n_repeats=10, random_state=SEED, n_jobs=-1)
        imp_series = pd.Series(perm.importances_mean, index=feat_cols_vi, name="Importance")

    elif vi_method == "Coefficient magnitude" and vi_model_resolved and vi_model_resolved in trained:
        # For linear models, use absolute value of coefficients
        pipe_vi = trained[vi_model_resolved]
        if hasattr(pipe_vi, "named_steps") and hasattr(pipe_vi.named_steps.get("model", ""), "coef_"):
            coef = np.abs(pipe_vi.named_steps["model"].coef_)
            imp_series = pd.Series(coef, index=feat_cols_vi, name="Importance")
        else:
            st.warning(f"{vi_model_resolved} has no linear coefficients. Try a linear model.")

    elif vi_method == "Gini / impurity" and vi_model_resolved and vi_model_resolved in trained:
        # For tree models, use scikit-learn's feature_importances_ attribute
        pipe_vi = trained[vi_model_resolved]
        if hasattr(pipe_vi, "named_steps") and hasattr(pipe_vi.named_steps.get("model", ""), "feature_importances_"):
            fi = pipe_vi.named_steps["model"].feature_importances_
            imp_series = pd.Series(fi, index=feat_cols_vi, name="Importance")
        else:
            st.warning(f"{vi_model_resolved} is not a tree model. Try Random Forest or GBM.")

    elif vi_method == "SHAP values" and vi_model_resolved and vi_model_resolved in trained:
        # SHAP values: model-agnostic/explainable AI approach, if SHAP installed
        if not HAS_SHAP:
            st.warning("Install SHAP: `pip install shap`")
        else:
            with st.spinner("Computing SHAP values…"):
                pipe_vi = trained[vi_model_resolved]
                if hasattr(pipe_vi, "named_steps"):
                    Xt_shap = pipe_vi.named_steps["scaler"].transform(eval_X_vi)
                    inner   = pipe_vi.named_steps["model"]
                    try:
                        if isinstance(inner, (RandomForestRegressor, GradientBoostingRegressor)):
                            explainer = shap.TreeExplainer(inner)
                        else:
                            explainer = shap.LinearExplainer(inner, Xt_shap)
                        shap_vals = explainer.shap_values(Xt_shap)
                        imp_series = pd.Series(np.abs(shap_vals).mean(0), index=feat_cols_vi, name="Importance")
                        st.subheader("SHAP summary plot")
                        fig2, ax2 = plt.subplots(figsize=(8, 4))
                        shap.summary_plot(shap_vals, Xt_shap, feature_names=feat_cols_vi, show=False, plot_size=None, ax=ax2)
                        st.pyplot(fig2, width="stretch"); plt.close(fig2)
                    except Exception as e:
                        st.error(f"SHAP failed: {e}")

    # ── Plot variable importance and comparison visualizations ───────────────
    if imp_series is not None:
        imp_series = imp_series.dropna()  # drop any missing
        # Sorting of features according to user selection
        if vi_sort == "By importance":
            imp_sorted = imp_series.sort_values(ascending=True)
        elif vi_sort == "Alphabetical":
            imp_sorted = imp_series.sort_index()
        else:
            # By category: use VAR_CATEGORY mapping if available
            order = sorted(imp_series.index, key=lambda f: (VAR_CATEGORY.get(f, "z"), f))
            imp_sorted = imp_series.loc[order]

        # Plot: horizontal bar chart of variable importance
        fig, ax = plt.subplots(figsize=(8, max(3, len(imp_sorted) * 0.4)))
        colors = [VAR_COLORS.get(f, "#888780") for f in imp_sorted.index]
        bars = ax.barh(imp_sorted.index, imp_sorted.values, color=colors)
        ax.set_xlabel("Importance")
        ax.set_title(f"Variable importance — {vi_method}")

        # Add category legend
        from matplotlib.patches import Patch
        legend_els = [Patch(color=v, label=k) for k, v in {
            "Socioeconomic": "#185FA5", "Environmental": "#3B6D11", "Temporal": "#854F0B", "Spatial": "#5F5E5A"
        }.items() if any(VAR_COLORS.get(f) == v for f in imp_sorted.index)]
        if legend_els:
            ax.legend(handles=legend_els, frameon=False, loc="lower right", fontsize=9)
        st.pyplot(fig, width="stretch")
        plt.close(fig)

        # SHAP-style "directional effects" bar display (shows if feature increases/decreases target)
        st.subheader("Directional effects (SHAP-style)")
        imp_desc = imp_sorted.sort_values(ascending=False)
        max_val  = imp_desc.max() or 1
        mid_px   = 140  # width scaling
        rows_html = ""
        for feat, val in imp_desc.items():
            direction = SHAP_SIGN.get(feat, 1)  # Use 1 if no sign given
            bar_w = int(val / max_val * mid_px)
            shap_val_disp = f"{direction*val*0.3:+.3f}"
            color = "#97C459" if direction > 0 else "#F09595"
            arrow = "↑ increases target" if direction > 0 else "↓ decreases target"
            cat_color = VAR_COLORS.get(feat, "#888780")
            if direction > 0:
                bar_html_d = f'<div style="width:{mid_px}px"></div><div style="width:1px;background:#ddd;height:18px"></div><div style="width:{bar_w}px;background:{color};border-radius:3px 0 0 3px;display:flex;align-items:center;padding-left:4px"><span style="font-size:11px;font-weight:600;color:white">{shap_val_disp}</span></div>'
            else:
                bar_html_d = f'<div style="width:{mid_px-bar_w}px"></div><div style="width:{bar_w}px;background:{color};border-radius:0 3px 3px 0;display:flex;align-items:center;justify-content:flex-end;padding-right:4px"><span style="font-size:11px;font-weight:600;color:white">{shap_val_disp}</span></div><div style="width:1px;background:#ddd;height:18px"></div>'
            rows_html += (
                f'<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'
                f'<span style="min-width:80px;font-size:13px;font-weight:500;text-align:right">{feat}</span>'
                f'<div style="display:flex;align-items:center;gap:0">{bar_html_d}</div>'
                f'<span style="font-size:11px;color:#888;margin-left:8px">{arrow}</span>'
                f'<span style="width:8px;height:8px;border-radius:50%;background:{cat_color};display:inline-block;margin-left:auto"></span>'
                f'</div>'
            )
        st.markdown(rows_html, unsafe_allow_html=True)

        # Heatmap: compare importance across models (if at least 2 models are available)
        if len(trained) >= 2:
            st.subheader("Importance comparison across models")
            heat_data = {}
            for mname, mpipe in list(trained.items())[:6]:  # limit to 6 models for space
                if vi_method == "Pearson |r|":
                    heat_data[mname] = imp_series
                elif vi_method == "Permutation importance":
                    try:
                        pr = permutation_importance(mpipe, eval_X_vi, eval_y_vi, n_repeats=5, random_state=SEED, n_jobs=-1)
                        heat_data[mname] = pd.Series(pr.importances_mean, index=feat_cols_vi)
                    except:
                        pass
                elif vi_method in ("Coefficient magnitude", "Gini / impurity"):
                    if hasattr(mpipe, "named_steps"):
                        inner = mpipe.named_steps.get("model", "")
                        attr = "coef_" if vi_method == "Coefficient magnitude" else "feature_importances_"
                        if hasattr(inner, attr):
                            heat_data[mname] = pd.Series(np.abs(getattr(inner, attr)), index=feat_cols_vi)
            if heat_data:
                heat_df = pd.DataFrame(heat_data).fillna(0)
                fig, ax = plt.subplots(
                    figsize=(min(12, len(heat_df.columns) * 1.8), max(3, len(feat_cols_vi) * 0.5))
                )
                sns.heatmap(
                    heat_df, annot=True, fmt=".3f", cmap="Blues",
                    ax=ax, linewidths=0.3, cbar_kws={"shrink": 0.7}
                )
                ax.set_title("Feature importance heatmap across models")
                st.pyplot(fig, width="stretch"); plt.close(fig)

    # ── Year-by-year importance stability visualization ──────────────────────
    # This section lets the user track the stability of a variable's importance over time (if temporal_col exists)
    if temporal_col and temporal_col in df_raw.columns:
        st.divider()
        st.subheader("Importance stability across years")
        stab_feat = st.selectbox("Feature to track", feat_cols_vi, key="stab_feat")
        yr_corrs = {}
        for yr in sorted(df_raw[temporal_col].unique()):
            sub = df_raw[df_raw[temporal_col] == yr]
            mask_ = sub[stab_feat].notna() & sub[target].notna()
            if mask_.sum() > 5:
                r_, _ = stats.pearsonr(sub.loc[mask_, stab_feat], sub.loc[mask_, target])
                yr_corrs[yr] = abs(r_)
        if yr_corrs:
            stab_s = pd.Series(yr_corrs)
            fig, ax = plt.subplots(figsize=(10, 3))
            ax.plot(
                stab_s.index, stab_s.values, marker="o",
                color=VAR_COLORS.get(stab_feat, "#378ADD"), linewidth=2, markersize=5
            )
            ax.fill_between(stab_s.index, stab_s.values, alpha=0.12, color=VAR_COLORS.get(stab_feat, "#378ADD"))
            ax.set_ylim(0, 1)
            ax.set_xlabel(temporal_col)
            ax.set_ylabel("|Pearson r|")
            ax.set_title(f"Importance of {stab_feat} over time")
            st.pyplot(fig, width="stretch")
            plt.close(fig)
