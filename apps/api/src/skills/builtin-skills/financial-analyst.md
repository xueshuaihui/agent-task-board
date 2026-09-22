> 本技能由千问工作台技能降级迁移，原平台专属能力不可用。

# Financial Analyst Skill

## Overview

Production-ready financial analysis toolkit providing ratio analysis, DCF valuation, budget variance analysis, and rolling forecast construction. Designed for financial modeling, forecasting & budgeting, management reporting, business performance analysis, and investment analysis.

## 5-Phase Workflow

### Phase 1: Scoping
- Define analysis objectives and stakeholder requirements
- Identify data sources and time periods
- Establish materiality thresholds and accuracy targets
- Select appropriate analytical frameworks

### Phase 2: Data Analysis & Modeling
- Collect and validate financial data (income statement, balance sheet, cash flow)
- **Validate input data completeness** before running ratio calculations (check for missing fields, nulls, or implausible values)
- Calculate financial ratios across 5 categories (profitability, liquidity, leverage, efficiency, valuation)
- Build DCF models with WACC and terminal value calculations; **cross-check DCF outputs against sanity bounds** (e.g., implied multiples vs. comparables)
- Construct budget variance analyses with favorable/unfavorable classification
- Develop driver-based forecasts with scenario modeling

### Phase 3: Insight Generation
- Interpret ratio trends and benchmark against industry standards
- Identify material variances and root causes
- Assess valuation ranges through sensitivity analysis
- Evaluate forecast scenarios (base/bull/bear) for decision support

### Phase 4: Reporting
- Generate executive summaries with key findings
- Produce detailed variance reports by department and category
- Deliver DCF valuation reports with sensitivity tables
- Present rolling forecasts with trend analysis

### Phase 5: Follow-up
- Track forecast accuracy (target: +/-5% revenue, +/-3% expenses)
- Monitor report delivery timeliness (target: 100% on time)
- Update models with actuals as they become available
- Refine assumptions based on variance analysis

## Tools


Calculate and interpret financial ratios from financial statement data.

**Ratio Categories:**
- **Profitability:** ROE, ROA, Gross Margin, Operating Margin, Net Margin
- **Liquidity:** Current Ratio, Quick Ratio, Cash Ratio
- **Leverage:** Debt-to-Equity, Interest Coverage, DSCR
- **Efficiency:** Asset Turnover, Inventory Turnover, Receivables Turnover, DSO
- **Valuation:** P/E, P/B, P/S, EV/EBITDA, PEG Ratio

```bash
```


Discounted Cash Flow enterprise and equity valuation with sensitivity analysis.

**Features:**
- WACC calculation via CAPM
- Revenue and free cash flow projections (5-year default)
- Terminal value via perpetuity growth and exit multiple methods
- Enterprise value and equity value derivation
- Two-way sensitivity analysis (discount rate vs growth rate)

```bash
```


Analyze actual vs budget vs prior year performance with materiality filtering.

**Features:**
- Dollar and percentage variance calculation
- Materiality threshold filtering (default: 10% or $50K)
- Favorable/unfavorable classification with revenue/expense logic
- Department and category breakdown
- Executive summary generation

```bash
```


Driver-based revenue forecasting with rolling cash flow projection and scenario modeling.

**Features:**
- Driver-based revenue forecast model
- 13-week rolling cash flow projection
- Scenario modeling (base/bull/bear cases)
- Trend analysis using simple linear regression (standard library)

```bash
```

## Knowledge Bases

| Reference | Purpose |
|-----------|---------|

## Templates

| Template | Purpose |
|----------|---------|
| `assets/variance_report_template.md` | Budget variance report template |
| `assets/dcf_analysis_template.md` | DCF valuation analysis template |
| `assets/forecast_report_template.md` | Revenue forecast report template |

## Key Metrics & Targets

| Metric | Target |
|--------|--------|
| Forecast accuracy (revenue) | +/-5% |
| Forecast accuracy (expenses) | +/-3% |
| Report delivery | 100% on time |
| Model documentation | Complete for all assumptions |
| Variance explanation | 100% of material variances |

## Input Data Format

All scripts accept JSON input files in either of two shapes:

1. **Flat** — the tool's expected keys at the top level (e.g., `income_statement` / `balance_sheet` for the ratio calculator, `historical` / `assumptions` for DCF, `line_items` for variance, `historical_periods` / `drivers` / `assumptions` / `cash_flow_inputs` for forecasting).
2. **Nested (bundled)** — inputs for all four tools in one file, nested under per-tool keys: `ratio_analysis`, `dcf_valuation`, `budget_variance`, `forecast`. See `assets/sample_financial_data.json` for the complete bundled schema; every quick-start command above runs directly against it.

Each script auto-detects the shape (flat keys win if present) and exits non-zero with a clear error if neither shape yields usable data.

## Dependencies

**None** - All scripts use Python standard library only (`math`, `statistics`, `json`, `argparse`, `datetime`). No numpy, pandas, or scipy required.
