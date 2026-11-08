# Design QA — Usage Evidence Explorer

**Findings**

No actionable P0, P1 or P2 visual mismatch remains in the selected 1280 × 545 implementation. The selected design is an illustrative concept; the implementation deliberately substitutes exact captured-response rows, real selection controls, scope/coverage and provider-freshness language for invented interval descriptions. It retains the existing product shell, identity, type and palette.

**Comparison target and state**

- Selected source: `C:/Blackvalley/Codex-Control/output/usage-design-audit-20261107/direction-2-revised.png`, independently generated Option 2, 1922 × 818 pixels. User selected Option 2 and requested corrected source labels and claims.
- Rendered target: `C:/Blackvalley/Codex-Control/output/usage-workspace-20261107/qa-1280.jpg`, 1280 × 545 pixels at 1280 × 545 CSS pixels, device pixel ratio 1, dark mode, the Usage route, last 24 hours, all scope, last hourly interval selected. Values are TEST_ONLY synthetic data; the final capture deliberately displays stale provider quota and unavailable sampled burn as such.
- Normalization: source downsampled to 1280 × 545 with high-quality bicubic interpolation; implementation is already 1:1. Full, same-image comparison: `C:/Blackvalley/Codex-Control/output/usage-workspace-20261107/design-comparison-final.png`. Focused chart/table/inspector comparison: `C:/Blackvalley/Codex-Control/output/usage-workspace-20261107/design-comparison-focus.png`. Both were opened and visually reviewed together. The generated visual's selected interval is an illustrative wider band; the final is a selected one-hour interval. Values, freshness, account, selection width and content differ by design, so this is not a pixel-exact data comparison.

**Resolved comparison findings**

- [P2, resolved] At the first comparison the table began below the short viewport and phone context displaced the chart. The workspace now uses a compact height-specific chart and spacing, a concise inline interval control, an accessible table caption and horizontal-scroll hint; phone context is a disclosure. See retained pre-fix `qa-1280-before-table-adjustment.jpg` and post-fix `qa-1280.jpg` / `qa-phone.jpg` in the output directory.
- [P2, resolved] The initial short-height row was partially below the fold and test worker/project labels broke mid-word; the column header also did not align with its values. Compact spacing and a 200px minimum worker/project column preserve readable text, allow intentional horizontal table scrolling and align header/body. Final 1280 capture shows the complete first synthetic row; measured row bounds 474.8–542.2 CSS px and both second-column left edges at 452.0 px. Earlier evidence is `qa-1280-before-spacing.jpg`; final full and focused comparisons above show the fix. Screen-height reductions did not shrink text or touch controls.
- [P2, resolved] Earlier chart axis labels were small. Axis/time labels were increased to 0.86rem (about 12.04 CSS px at the tested base size); the select remains 1rem. See `qa-1280-before-type-refinement.jpg` and final `qa-1280.jpg`.

**Five fidelity surfaces**

1. **Fonts and typography.** Existing app/system font stack, weights and base sizing are preserved; numerical fields are legible and text has not been compressed to fit. The implementation's actual copy is necessarily denser than the illustrative target. Very long values wrap inside a deliberately wider table column and the row remains scrollable.
2. **Spacing and layout.** The same dark three-column context/chart/inspector hierarchy and compact shell are maintained at desktop. At 1280 × 545, the 45px shell leaves 500px for the workspace; chart, selected interval, inspector and first complete record are visible. The selected mock's three short illustrative interval rows are replaced by larger exact response records, so additional records require ordinary page scrolling.
3. **Colors and tokens.** Existing semantic gold input, coral output and teal cached-input tokens are retained with text labels, dashed/dotted line patterns and explicit selection. A chart gap does not assert a collection outage. No generated neon or decorative effects were introduced.
4. **Image and asset quality.** The actual existing ARGELLAN app artwork and navigation assets remain in place; no mock logo or new brand substitute is introduced. The chart is a data-driven SVG visualization, not a replacement illustration. Source is normalized only for review; JPEG captures have normal compression.
5. **Copy and content.** Provider quota is current wall-clock evidence and historical response records use their selected source window; the inspector names the distinction. Stale/unavailable, receipt fallback, row limits, unknown attribution, comparable totals, and the legacy export's separate scope are explicit. No cost, savings, producing-model attribution, causation or completeness is invented.

**Responsive and interaction evidence**

- Final-source captures: `qa-1366.jpg` (1366 × 620), `qa-1280x600.jpg`, `qa-desktop.jpg` (1920 × 1080); `qa-scaling.jpg` (1024 × 600 CSS), `qa-tablet.jpg` (768 × 1024 CSS), and `qa-phone.jpg` (390 × 844 CSS). The capture surface cropped the last three to 1009 × 591, 753 × 1004 and 375 × 812 pixels respectively; DOM viewport dimensions were independently read. No page-wide horizontal overflow was measured. These are emulated browser viewports, not hardware qualification.
- Browser checks included period and contributor selection, interval and exact-record inspection, Back/Forward, reload, the legacy details/export preview, mobile navigation, skip link and keyboard-addressable intervals. Current preview origin had no console error entries at the final check. Stale, error, unavailable and race cases have focused automated coverage; assistive technology, real touch and full accessibility audit are not claimed.
- The source image does not define loading, stale, missing, auth loss or error states. The implementation addresses them separately; these states were tested rather than copied from the image.

**Open questions and follow-up polish**

- [P3] At compact width the table intentionally needs horizontal scrolling to preserve readable source fields; the visible hint and accessible region name identify this. Further density refinements may be evaluated with real operators.
- Native display scaling, actual browser zoom, physical HP ProBook, phone/tablet devices and screen-reader behavior remain unqualified. The large synthetic payload exceeds the existing gzip admission threshold; performance qualification is separate from this visual pass.

**Implementation checklist**

- [x] Correct source/time and subset labels, surface scope and coverage, preserve provider quota separation.
- [x] Restore a full readable first evidence row and align table headers at 1280 × 545.
- [x] Compare final source and implementation together at full and focused scales; retain exact and prior captures.
- [x] Check responsive layouts, core interactions, keyboard entry points and current-origin console.
- [ ] Complete physical-device, assistive-technology and full performance/release qualification under the applicable separate gates.

final result: passed
