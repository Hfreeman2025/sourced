# sourced.

An interactive calculation pad where every number carries a unit, a source and, if it is uncertain, a cited or assumed spread. The answer is then a distribution, not one number: drag a quantity and 4,096 Monte Carlo runs redraw in the same frame; let go and 100,000 runs and a variance-based (Sobol) sensitivity analysis show which uncertainty actually matters. Sourced is a hand-written TypeScript language with dimensional analysis, provenance DAGs, an interpreter, a JavaScript compiler and a column-wise Monte Carlo evaluator. Everything runs locally in your browser; there are no accounts, uploads, remote models or runtime external requests.

## Try it

Node **22.13 or later** is required. From this folder:

```sh
npm ci --ignore-scripts
npm run dev
```

Open **http://127.0.0.1:4177**. In ten seconds: the commute opens with **70.88 kg** of CO₂ and, under it, the distribution of 100,000 runs: 90% between about 56 and 87 kg. The sentence above the sensitivity table says what matters: knowing your fuel consumption exactly would remove about 81% of the variance, while IPCC’s published uncertainty on its factors accounts for about 4%. Drag the underlined `0.065` and the hatched distribution moves with it, every frame; release and it refines. Then open **Rooftop solar**: with every input at its average, the payback is 9.86 years, but the average payback is longer, because a ratio of uncertain quantities is not the ratio of their averages.

The Adjust select and numeric field are the keyboard alternative. Arrow keys step the selected quantity. While dragging, Alt is 100× finer, Shift is 10× coarser, and Escape cancels. The ends of a range are draggable too. CodeMirror undo/redo remains available; each example keeps its own history. Page numbers, publication years, coverage and round precision are syntax, not data inputs. Edits stay in memory; refreshing restores the examples.

For a production build served locally:

```sh
npm run build
npm run preview -- --port 4177 --strictPort
```

Open http://127.0.0.1:4177. Both servers bind only to loopback. Installation uses the public npm registry. The app needs no network connection once loaded, and fonts come from your operating system.

## The small language

```sourced
source invoice.march = "Example invoice, March 2026", page 2
let usage = 284 kWh @invoice.march
assume tariff = 0.25 £/kWh

fn charge(energy, price) = energy * price
let cost = round(charge(usage, tariff), 2)
print "Electricity: {cost}"
```

This prints `Electricity: £71.00`. Its lineage contains both `@invoice.march` and the explicit `tariff` assumption. `let count = 14200` is an error: add a unit and a declared source, or use `assume`.

Any quantity can also say how uncertain it is, and who says so:

```sourced
let emission = 69300 kg/TJ @ipcc ~ 95% 67500..73000 @ipcc
assume density = 0.74 kg/L ~ ±0.025 kg/L assumed
assume consumption = 0.065 L/km ~ normal(12%) assumed
assume daily = 24 km ~ ±2 km assumed
```

A spread without `@source` or `assumed` is an error, as is one that excludes its own value, uses an incompatible unit or names an undeclared source. `±w` and `low..high` state limits only, so they are uniform: the GUM’s rule when only bounds are known (JCGM 100:2008 §4.3.7). `95% low..high` states a coverage interval, such as a published confidence interval: Sourced draws a two-piece normal whose mode stays at the value and which puts exactly that share of runs between the limits. `normal(sd)`, `lognormal(factor)` (median at the value, geometric standard deviation), `triangular(low, high)` (mode at the value) and `uniform(low, high)` name a shape outright. In `±` and `normal()`, a percentage is relative to the value; elsewhere a bound without a unit uses the quantity’s unit and a bound with a unit is converted.

- Declarations: `source`, `let`, `assume`, `fn`; display results with interpolated `print` strings. Statements end at newlines or semicolons. Comments start with `//`.
- Source metadata: a title and optional `page 2`, `year 2006`, `url "https://…"`. HTTP/HTTPS links are validated, never fetched by the app, and open only when selected.
- Arithmetic: `+ - * /`, unary signs and parentheses. Addition/subtraction convert compatible units; mismatched dimensions are errors. `as` converts a whole expression: `(a * b) as kg`.
- Lists and built-ins: `sum([first, second])`, `sqrt(area)`, `round(total, 2)`. Rounding ties follow JavaScript’s `Math.round` (toward positive infinity). Rounding precision is literal syntax from 0 to 8, not a data input. Other unsourced literals are allowed only inside an explicit `assume` declaration.
- Units: SI base units `m kg s A K mol cd`; `g mg t km mi cm mm min h day year J kJ MJ GJ TJ Wh kWh W kW L mL £ % ratio`, and the multiplicative named SI derived units `Hz N Pa C V F Ω ohm S Wb T H lm lx Bq Gy Sv kat rad sr`. Absolute Celsius requires affine arithmetic and is deliberately excluded; use kelvin. A year is 365.25 days. `ratio` is the explicit dimensionless unit for sourced values.
- Compound units: `kg/kWh`, `£/day`, `kg*m^2/s^2`. Exponents are exact reduced rationals, including `m^(1/2)`; each written exponent numerator is from −32 to 32 and denominator from 1 to 32.
- Functions capture earlier definitions and are unit polymorphic: the body is dimension-checked for each call. Named function calls use the function namespace; parameters are values, not callable function objects. Bindings are immutable. Recursion, control flow, strings as data values, external I/O and imports are intentionally outside the language.

A mismatch is explained at its exact source span:

```text
Units don’t add up at 4:13
4 | let total = energy + mass
                ^^^^^^^^^^^^^
You’re adding kWh to kg.
Did you mean to multiply by an emission factor (kg/kWh)?
```

There is no stale success state: an invalid program clears the previous results. Parser recovery preserves later declarations. The checker suppresses diagnostics caused by an already-failed binding while still reporting independent errors.

## How it works

`src/lang/` contains a hand-written lexer and Pratt/recursive-descent parser, a separate checker, rational dimension algebra, an AST interpreter and a JavaScript emitter. No parser generator, model, server or remote API is involved.

A quantity carries a magnitude, a unit (scale and dimension vector) and a node in an immutable lineage DAG. Operations retain the exact input edges and union their distinct source/assumption dependencies. The technical schematic preserves the calculation DAG, including shared inputs, conversions and rounding, while collapsing transparent aliases. Deep derivations are drawn vertically and can be panned and zoomed. Source nodes point back to declared metadata and the original code spans.

The compiler emits JavaScript against the exported `createRuntime()` operations. It uses generated identifiers and JSON-escaped metadata, and never incorporates user identifiers as JavaScript identifiers. In TypeScript/Node, the backend can be used like this:

```ts
import { parse, compile, createRuntime } from './src/lang';

const body = compile(parse(programText)); // rejects invalid programs
const evaluate = new Function('rt', body); // Node-side only
const result = evaluate(createRuntime());
console.log(result.outputs);
```

The browser **never evaluates generated JavaScript**. “See JavaScript” exposes the emitted code for inspection; the live results use the interpreter. Tests execute the generated backend in Node and compare every output, binding, dependency and lineage node with the interpreter.

The playground uses CodeMirror 6, TypeScript, and plain DOM/SVG rendering. Its identity comes from engineering calculation pads and technical schematics: white, graphite, cobalt traces, orange lower-input scenarios, measured rules and orthogonal wires. See [IDENTITY.md](IDENTITY.md). The served HTML reserves the final pad geometry while the editor and local worker load. The worker is bundled inline to avoid a second startup fetch.

## Answers as distributions

**Monte Carlo propagation** (JCGM 101:2008, the GUM’s Supplement 1). Each run draws every uncertain input from its declared distribution and recomputes the whole program; the spread of answers is the result’s distribution. The page reports P5, P50 and P95 (Hyndman and Fan’s type-7 quantiles, the R and NumPy default), the mean, and the answer from central inputs, all in the result’s own unit.

The trick that makes 100,000 runs cheap is that units are static. The checker has already proven every dimension, so `src/analysis/columns.ts` evaluates the checked syntax tree **once per operation over a whole column** of runs (Float64Arrays), resolving each unit conversion once instead of 100,000 times. It mirrors the interpreter’s arithmetic in the same order, and a test proves it reproduces the scalar interpreter **bit for bit** on every example, including decimal rounding (a fast path defers to the interpreter’s exact routine near ties). A run that divides by zero or takes a negative square root is counted as undefined and excluded, never folded into the answer. One literal is one random variable, even when a function uses it twice.

**Seeds.** Uniforms come from xoshiro128** (Blackman and Vigna) seeded by splitmix32, one named stream per literal, mapped through inverse CDFs (Acklam’s inverse normal). The same seed always gives the same runs. Because each quantity keeps its own stream, dragging one number reuses everyone’s random numbers (common random numbers), so the shape moves instead of flickering. Small programs draw a 4,096-run preview in the same animation frame as the number under the pointer; the worker then refines to 100,000 runs, and the preview’s runs are exactly the first 4,096 of the refined pass. A worker request is coalesced: a newer drag frame supersedes unfinished refinement before any work starts.

**Variance-based sensitivity** (Sobol′ 2001; Saltelli et al. 2010; Jansen 1999). The tornado nudges one input at a time by ±5, 10 or 20%. The variance share asks a different question: how much of the result’s spread comes from each input’s *declared* uncertainty. With two independent sample matrices A and B and, for each input i, A with column i taken from B, the first-order index `Sᵢ = mean(f(B)·(f(A_Bⁱ) − f(A)))/V` (Saltelli 2010) is the share of variance that knowing input i exactly would remove; the total index `Sₜᵢ = mean((f(A) − f(A_Bⁱ))²)/2V` (Jansen 1999) adds every interaction it takes part in. The hatched gap between them is interaction. Outputs are centred first, as Sobol′ recommends; intervals are 95% percentile bootstraps over 100 resamples. The design costs (k + 2) × 16,384 runs for k uncertain inputs. Fixed inputs say “fixed”: they have no variance to share. A rule-written sentence above the table states the finding from the numbers on screen.

**What is live and what is recorded.** Everything is live: no run, distribution or index on the page is precomputed. Nothing is downloaded. The limits of the method are stated on the page: inputs are sampled **independently** (correlations are not modelled), and a distribution is only as good as the spreads declared, which are labelled cited or assumed wherever they appear.

### Measured

The tests check the engine against closed forms rather than against itself: a sum of normals in mixed units (km + mi) reproduces its analytic P5/P50/P95 within the quantile standard error; a product of lognormals reproduces its analytic quantiles and mean within 1%; Sobol indices recover an additive model (S = T = ⅕, ⅘, 0) and the product X₁·X₂ of normals, whose interaction is exact (S₁ = 0.889, S₂ = 0.056, T₁ = 0.944, T₂ = 0.111), within 0.03; every distribution reproduces its exact mean and variance; the two-piece normal puts 95% of 200,000 draws between its limits (binomial tolerance); and the xoshiro128** outputs for state (1, 2, 3, 4) match hand-derived reference values.

On the bundled examples (100,000 runs, seed 1): the commute’s 90% interval is 55.6–86.7 kg around the 70.88 kg central answer; consumption explains 81% of the variance alone, distance 13%, IPCC’s emission factor 2%, density 2% and IPCC’s calorific value 1%. The solar payback is 9.86 years at central inputs, with a mean of 10.2 and a 90% interval of 7.6–13.6 years; interactions carry about 6% of its variance. Performance is reported in [DONE v3](docs/V3-REPORT.md).

## Scrubbing, sensitivity and tracing

- Only a numeric token changes during a scrub. Units, sources and the rest of the program stay intact. Signed, underscored and scientific-notation literals work. Manual numeric edits retain the requested finite IEEE-754 value.
- Sensitivity reruns the actual interpreter twice per contributing literal, one input at a time, at ±5%, ±10% or ±20%. All other inputs stay fixed. Negative inputs use the magnitude of the perturbation; a zero input uses one numeric step. Rounded results may have zero change. Undefined perturbations stay labelled.
- Inputs are distinct literal sites, not source names: two tariffs from one document remain two inputs. A literal in a function is perturbed once at its definition and affects every use. Unrelated inputs are excluded by the selected result's reachable graph.
- Every contributing input is analysed. Small programs (up to 1,000 characters, 100 AST nodes, eight calls and two function declarations) get one interpreter pass per animation frame for immediate numeric feedback. Larger programs and all sensitivity scans run in a dedicated worker. Both paths use the same interpreter; stale worker replies are discarded. Charts initially show the top 48 ranked inputs; “Show all” exposes the complete ranking. Progress counts are explicit for larger programs. The main thread stays available for editing.
- Hover or focus a result to highlight the actual derivation tokens, including source declarations and function definitions. Sensitivity rows locate individual inputs. The schematic collapses transparent aliases, retains provenance-changing assumptions, and draws every operation. Drawings reflow across the available width, wrapping inputs on narrow screens. Ordinary Derivation panels grow to show the whole calculation at readable size. Text stays at least 11px even when zooming out; genuinely large derivations use an explicit scroll hint.
- Edits to a bundled example are labelled **what-if scenarios** and compared with its original numeric result when applicable. They do not revise the cited document or imply that a different scientific factor was published.
- The tornado probes a value without that literal’s own spread, so a ±10% nudge past a cited interval still measures the value’s effect. Dragging a value past its declared interval is an explicit error, because the declared uncertainty no longer describes it.
- An exact result says so and offers one undoable click to add an assumed ±10% spread to its most influential input. Uncertain terminals in the schematic carry a small drawing of their input distribution’s shape: cobalt for cited, orange for assumed. Selecting one names the spread, its shape and its provenance.

No UI framework, hosted fonts or decorative image assets are used. Keyboard paths, visible focus, modal focus management and reduced-motion preferences are supported. Inside the editor Tab indents; Escape releases focus so Tab can reach the next control. Offline status stays visible; calculations continue offline after loading. An unavailable worker produces an explicit uncomputed state, retains the code, and offers a reference or retry action.

Bounds keep a local mistake local: 30,000 characters, 128 syntax/AST nesting levels, 32 function-call levels, 10,000 checking steps and 10,000 generated calculation nodes. Dimension exponents remain exact within safe-integer rational representation; out-of-range dimensions and unit scales produce explicit errors. Arithmetic uses finite IEEE-754 numbers rather than arbitrary precision or decimal accounting. Currency display uses at least two and up to six decimals, retaining sub-penny amounts; very small or large values use scientific notation; use `round` to record rounding as an actual derivation step.

## Checks and measurements

```sh
npm run check      # strict typecheck, Biome lint, tests, production build, licence check
npm audit --audit-level=moderate --registry=https://registry.npmjs.org
npm run measure    # 200 runs per example, after 20 warmups; writes shots/core-performance.json
```

The tests cover lexer/parser recovery, precise diagnostics (including escaped-string offsets and every uncertainty error), unit algebra and conversions, lineage propagation, failures and limits, compiler hygiene, and interpreter/JavaScript agreement on all five examples, including uncertain lineage. Deterministic property checks exercise 4,000 scale round trips, 600 round trips through the actual interpreter with provenance intact, 120,000 column-rounding cases against the interpreter’s exact rounding, and bit-for-bit agreement of the column evaluator with the interpreter on 200 perturbed runs across every example. `tests/stats.test.ts` and `tests/uncertainty.test.ts` hold the analytic Monte Carlo and Sobol checks described above.

Browser verification uses the public Playwright installation named in the brief through `createRequire` for Chromium, plus this project's pinned Playwright for WebKit and Firefox. Browser binaries are test tools and are not redistributed with the app. The v2 brief explicitly permits installing WebKit/Firefox:

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/browsers" node node_modules/playwright/cli.js install webkit firefox
npm run test:browser
npm run test:layout
npm run test:contrast
npm run measure:browser
```

Keep the server running. The default test URL is http://127.0.0.1:4177. Set `SOURCED_URL` to test a separately served production build; `node scripts/serve-built.mjs` starts an isolated production preview on an OS-assigned loopback port and records its own PID/URL in `shots/v3/preview-process.json`. It does not stop the existing dev server. For another machine, set `SOURCED_PLAYWRIGHT_PACKAGE="$PWD/package.json"` and use an installed Chrome with `SOURCED_BROWSER_CHANNEL=chrome`, or install that pinned Playwright's Chromium separately.

The browser suite runs the complete state and interaction contracts in Chromium, WebKit and Firefox, at 1440×900 and 390×844. For v3 it opens on the commute and asserts the 100,000-run distribution brackets the central answer, the cited/assumed spread receipt, the variance finding, `fixed` inputs and the opening-screen position of the distribution; it drags consumption and requires the preview distribution to be drawn **in the same frame** as the number with **no layout shift**, then refinement on release and one-step undo; it drags the upper end of IPCC’s interval and requires P95 to move; it reseeds; it reads a terminal’s spread detail; it checks the exact state and its one-click spread, an invalid spread’s explicit error, and recovery without a stale hint. The v2 contracts follow unchanged: live scrubbing before release, cancellation, keyboard adjustment, dependency tracing, result-specific sensitivity, source inspection, every example, unit errors, empty/long content, undefined scenarios, 60-input ranking, offline operation and dialogs. Slow-load and unsupported-worker fixtures exercise explicit uncomputed states. Browser test scripts assert zero console errors/warnings and no external requests. The layout suite measures actual SVG text bounds through every zoom step for all three outputs of all five examples, and requires every input-distribution glyph to stay clear of every annotation. It checks the complete opening view at both sizes, including the phone tab reveal, a measured 11px minimum text size, width use, panel growth, readable large-diagram scrolling, and native text size when there is sufficient room. It also checks selected-result lineage and scenario comparisons. Ordinary drawings fit their width and grow vertically instead of shrinking into an unreadable overview. Large drawings preserve readable text with a visible scrolling hint. Any scaling still transforms the complete SVG, preserving its native text layout. v3 evidence lives in `shots/v3/` (baseline, pass-1, pass-2, performance, contrast, social preview) and its two design critiques in [docs/V3-CRITIQUE.md](docs/V3-CRITIQUE.md). Earlier evidence remains in `shots/v2/`, `shots/v2.1/`, `shots/v2.2/` and `shots/v2.3/`, with [docs/V2-CRITIQUE.md](docs/V2-CRITIQUE.md).

`npm run measure:browser` records application-marked meaningful paint, the time to the opener’s preview, refined distribution and Sobol shares (with the worker’s own compute time), total gzipped main+worker JavaScript, and frame timing while dragging the commute with its distribution redrawing every frame, alongside idle timing and host load on the same machine. Meaningful paint is the frame after real results are rendered, measured from navigation start; it is an application timing marker, not the retired browser FMP metric. `npm run measure` records core execution over 200 runs per example after 20 warmups. Contrast checks measure the playground and reference against AA text thresholds; they are not a full accessibility audit. Hosted CI remains unrun in this local-only build.

The existing dev server may retain a transform when file events are missed. [vite.config.ts](vite.config.ts) enables polling on future starts. `node scripts/refresh-dev.mjs` uses Vite's own HMR client to refresh this project's served modules without killing a process or changing its port. Production screenshots are taken against the isolated built preview, and the public dev URL is checked separately.

## Data and credits

Household bills, tariffs, route lengths, pump prices and the original pancake recipe are **illustrative**, labelled as such in both source declarations and the UI. They are not current prices, client records or live data.

The commute example quotes these public numerical facts from the **IPCC 2006 Guidelines for National Greenhouse Gas Inventories, Volume 2 (Energy)**:

- Chapter 3, Table 3.2.1: motor gasoline default CO₂ emission factor **69,300 kg CO₂/TJ**, with published lower and upper values **67,500** and **73,000**.
- Chapter 1, Table 1.2: motor gasoline default net calorific value **44.3 TJ/Gg**, equivalent to **44.3 MJ/kg**, with published lower and upper values **42.5** and **44.8**.

Volume 2, Chapter 1 presents these lower and upper values as the limits of 95% confidence intervals; the commute cites them as `95%` spreads. The two-piece normal that keeps the default as the mode is Sourced’s modelling choice, not IPCC’s. These intervals were transcribed from the published tables; this build had no network access to re-read them, so they deserve a spot check against the PDF before reuse.

Source: [IPCC 2006 Guidelines · Volume 2](https://www.ipcc-nggip.iges.or.jp/public/2006gl/vol2.html). These are attributed numerical facts; no copyrighted source tables or text are bundled. The example explicitly assumes density (0.74 kg/L, assumed ±0.025 kg/L), consumption (0.065 L/km, assumed 12% standard deviation), distance (24 km/day, assumed ±2 km) and a fixed 20 workdays. The rooftop-solar quote, tariff, generation and every one of its spreads are illustrative assumptions. It estimates combustion **CO₂ only**: it excludes fuel production, vehicle manufacture, CH₄ and N₂O. It is neither a current reporting factor nor a complete carbon footprint. Sources are references, not live API feeds. No third-party dataset is fetched or redistributed.

CodeMirror and Lezer are MIT; TypeScript is Apache-2.0; Vite, Rollup, esbuild and tsx are MIT; Playwright is Apache-2.0; Biome is MIT OR Apache-2.0 (MIT selected). System fonts are used without redistribution. Original code, copy and line drawings © 2026 Harry Freeman, released under [MIT](LICENSE). Full dependency inventory: [docs/dependency-licenses.json](docs/dependency-licenses.json).

### Methods

- JCGM 101:2008, *Evaluation of measurement data — Supplement 1 to the GUM: Propagation of distributions using a Monte Carlo method*; JCGM 100:2008 (GUM) §4.3.7. [BIPM JCGM publications](https://www.bipm.org/en/committees/jc/jcgm/publications).
- I. M. Sobol′ (2001), Global sensitivity indices for nonlinear mathematical models and their Monte Carlo estimates. *Mathematics and Computers in Simulation* 55, 271–280. [doi:10.1016/S0378-4754(00)00270-6](https://doi.org/10.1016/S0378-4754(00)00270-6).
- A. Saltelli, P. Annoni, I. Azzini, F. Campolongo, M. Ratto, S. Tarantola (2010), Variance based sensitivity analysis of model output. Design and estimator for the total sensitivity index. *Computer Physics Communications* 181(2), 259–270. [doi:10.1016/j.cpc.2009.09.018](https://doi.org/10.1016/j.cpc.2009.09.018).
- M. J. W. Jansen (1999), Analysis of variance designs for model output. *Computer Physics Communications* 117, 35–43. [doi:10.1016/S0010-4655(98)00154-4](https://doi.org/10.1016/S0010-4655(98)00154-4).
- D. Blackman, S. Vigna (2021), Scrambled linear pseudorandom number generators. *ACM Transactions on Mathematical Software* 47(4). [doi:10.1145/3460772](https://doi.org/10.1145/3460772); [prng.di.unimi.it](https://prng.di.unimi.it/).
- P. J. Acklam (2003), An algorithm for computing the inverse normal cumulative distribution function (relative error below 1.15 × 10⁻⁹; verified against published quantiles in the tests).
- R. J. Hyndman, Y. Fan (1996), Sample quantiles in statistical packages. *The American Statistician* 50(4), 361–365. [doi:10.2307/2684934](https://doi.org/10.2307/2684934).

These are citations for the methods as implemented; no code or text from them is bundled. The links were written from the published references and were not fetched by this build.

## State of this build

Implemented and checked locally. No private data was used. No commits, pushes, accounts, deployments or publishing were performed. Local browser evidence is separate from unrun hosted CI and from Harry’s own review.

The coordinator's layout corrections and their current evidence are in [DONE v2.1](docs/V2.1-REPORT.md).

The opening-view fit correction and its evidence are in [DONE v2.2](docs/V2.2-REPORT.md).

The readable-layout correction and its evidence are in [DONE v2.3](docs/V2.3-REPORT.md).

Answers as distributions, with measurements, browser results and limits, are in [DONE v3](docs/V3-REPORT.md).
