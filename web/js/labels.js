You are a Senior Manufacturing Data Analyst and Dashboard Engineer. I am attaching an Excel workbook named `Daily Production Summary Report OCT 2026.xlsx` containing October 2026 production data (primarily 02/10/2026 to 31/10/2026 across Shifts A & B and Machines 2 to 14).

Please inspect the sheets in this workbook—especially `OCT 2026`, `DOWENTIME RESSIONS MC`, `DOWENTIME SUMMERY 2`, `REJ SUMMERY 31.10.26`, `REJECTION RESION PERITO `, `PERITO 1 REJECTION `, ` DAILY BASIS OEE & REJ% PER`, `REJECTION SUMMERY TILL DATE `, and `TOP 5 REJ PART WITH REASIONS`—and build a complete, interactive **OEE, Downtime & Rejection Dashboard**.

### Key Requirements & Structure:
1. **Executive KPI Summary Cards:**
   - Total Actual Production (`Actual production` / `PROD`), Total OK Qty (`Total Ok Qty`), Total Rejection Qty (`Rej Qty`), Overall Rejection % (`Rejection %`), Overall PPM (`PPM`), Average/Weighted OEE (`OEE`), and Total Downtime in Minutes (`Total Down Time Summary in Minuts` / `TOTAL DOWENTIME IN MINITS`).
   - Include a clear note distinguishing **Planned / Non-Production Losses** (e.g., `NO Plan`, `No Manpower`, `Lunch/Dinner Break/SNACKS`) from **Equipment / Process / Quality Losses** (e.g., `Machine Problem/CLEANING`, `Mould Problem`, `Mould Change (Min)`, `RM  Problem`, `Box not available`, `Short Mould`, `Start up`, `OVER  flash`, `Set up`).

2. **OEE Analysis Section:**
   - Daily & Shift-wise (`Shift A` vs `Shift B`) OEE trend, Usability %, Performance Ratio %, and Quality Ratio %.
   - Machine-wise (`M/C no.` 2 to 14) OEE and Rejection % comparison.
   - Highlight active production rows vs. zero-production / no-operator rows (`NO OPRATOR` / 0 production) so averages are accurate and transparent.

3. **Downtime Analysis & 80/20 Pareto Section:**
   - Downtime Pareto chart (`DOWENTIME SUMMERY 2` & `REJECTION RESION PERITO ` / `PERITO 1 REJECTION `) showing downtime minutes, individual %, and cumulative % (`COMM%` / `COMM COUNT`).
   - Machine-wise Downtime breakdown (`DOWENTIME RESSIONS MC`) showing top downtime drivers per machine and total minutes.

4. **Rejection & Defect Pareto Section:**
   - Top Rejection Reasons Pareto (e.g., `Short Mould`, `Start up`, `OVER  flash`, `Set up`, `Silver Mark`, `COLD MATERIAL MARK/Weld line`, `Colour Change`, `Black Spot/BLACK SPOT WITH MESH`) with quantity and cumulative %.
   - Top Rejected Parts (`REJ SUMMERY 31.10.26` and `TOP 5 REJ PART WITH REASIONS`) showing `PROD`, `Total Ok Qty`, `Rej Qty`, Rejection %, and main defect drivers per part.

5. **Interactive Filters & Actionable Takeaways:**
   - Add filters for **Date Range**, **Shift (A / B)**, **Machine No.**, and **Part Name / Part Number** (where available in the source sheets).
   - Provide concise plant-floor action items based on the top OEE drags, top downtime minutes, and top rejection defects.

### Output Format:
- Build this as a clean, responsive, single-file interactive dashboard (HTML/JS with Chart.js or Recharts) OR an Excel dashboard workbook—prioritizing an interactive web dashboard if code execution/artifact preview is supported.
- Ensure every number is calculated directly from the attached Excel file without fabricating values, and clearly label any missing/unmapped fields across sheets (such as machine/date granularity in summary sheets vs. daily log sheet `OCT 2026`).
