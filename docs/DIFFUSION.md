# The diffusion of accent-sounds over geographic coordinates

This is the design note that drives the rest of the system. Everything else — the schema,
the choice of geometric types, the inference code — falls out of the argument here.

---

## 1. The object we are modelling

An accent, measured acoustically, is a point in a feature space:

```
v ∈ R^k        v = (rhoticity, nPVI_V, %V, ΔC, vowel-space area, GOOSE F2, …)
```

"Accent geolocation" implicitly asserts that there exists a **field**

```
μ : S² → R^k
```

assigning to every point on the earth's surface an expected accent, and that a speaker
from location `x` is a noisy draw `v ~ N(μ(x), Σ(x))`.

That framing splits the problem cleanly into three:

| | question | machinery |
|---|---|---|
| **Forward** | why does `μ` have the shape it has? | diffusion on a spatial interaction graph |
| **Inverse** | given `v`, which `x` produced it? | Gaussian process regression + Bayes |
| **Representation** | how do you store, query and draw `μ` and its level sets? | PostGIS geometry / geography |

The central claim of this document is that **the forward and inverse problems share one
matrix**, and that getting this right is the difference between a dialect map and a
smudge.

---

## 2. Why naive spatial interpolation is wrong

The obvious move is: put reference accents at lat/lon, inverse-distance-weight them,
done. This asserts that linguistic similarity decays with straight-line distance. That is
false, and it is false in *structured*, well-documented ways.

**Barriers.** The Benrath line (*maken/machen*) tracks terrain and long-dead political
boundaries, not distance. The Pennines split Northern English; the Highland Line splits
Scots; the Appalachians split Southern American English from Midland. Two towns 20 km
apart across a ridge are routinely more distant linguistically than towns 200 km apart
along a valley floor.

**Hierarchical (cascade) diffusion.** Trudgill's gravity model: innovations jump *down
the settlement hierarchy* — big city to big city first, then to towns, then finally
filling the rural interstices. London → Norwich → the Norfolk villages, with the villages
in between London and Norwich adopting *last*. An isotropic kernel physically cannot
produce that: it produces concentric rings. Cascade diffusion means the field is
**smooth in network space, not in geographic space**.

**Relic areas.** Isolation preserves. Appalachian and Ozark English, Newfoundland,
Ocracoke, Tangier Island. These are local minima of connectivity, and they appear as
sharp discontinuities in a field that any smooth interpolator will erase.

**Anisotropy.** Diffusion follows corridors — rivers, Roman roads, rail, the Ohio valley,
the M62. The range parameter is direction-dependent.

**Transplant / founder effects.** Australian English is 17,000 km from London and
extremely close to it linguistically. Newfoundland to Waterford. The manifold has
wormholes: an ancestry graph laid over the geography.

Conclusion: **the metric under which the accent field is smooth is not geodesic
distance.** It is an effective distance on a graph. Get the graph right and ordinary
interpolation becomes correct; get it wrong and no amount of kernel tuning saves you.

---

## 3. The interaction graph

Nodes are populated places (`settlement`), each with a population `P` and a point
geography. For an ordered pair `(i, j)` define an **interaction weight**:

```
              P_i^α · P_j^α
    w_ij  =  ───────────────  ·  exp(−Σ_b ρ_b)  ·  exp(+κ·φ_ij)  ·  a_ij
                d_geo(i,j)^γ
              └── gravity ──┘   └─ barriers ─┘   └─ corridors ─┘  └ancestry┘
```

* **Gravity** — Trudgill (1974), after Hägerstrand. `γ ≈ 2`, `α ≈ 0.5`. This term alone
  produces cascade diffusion: big-city pairs dominate the graph regardless of separation.
* **Barriers** — `ρ_b ∈ [0,1]` is the resistance of each barrier line crossed by the
  great-circle segment `i→j`. In SQL this is a one-line `ST_Intersects` against a table
  of `LINESTRING` barriers. Mountain ranges, water, and old political boundaries all live
  in the same table with different resistances.
* **Corridors** — `φ_ij` is the fraction of the segment lying inside a buffer around a
  transport corridor. `ST_Length(ST_Intersection(seg, ST_Buffer(corridor, w))) / ST_Length(seg)`.
  This is what makes diffusion anisotropic without introducing a tensor.
* **Ancestry** — `a_ij ≥ 1` for pairs joined by a settlement/colonial relation. This is
  the wormhole term. It is the only non-geographic term and it is deliberately explicit
  rather than smuggled in, because it is exactly the thing that breaks the
  distance-decay assumption.

Symmetrised (`W = ½(w + wᵀ)`), row-normalised where needed, this is the whole model.
Everything downstream is a function of `W`.

The graph edges are stored **with their own `LINESTRING` geometry**, so the interaction
network is itself drawable — you can look at the map and see the London–Norwich edge
outweighing the London–Chelmsford edge, which is cascade diffusion made visible.

---

## 4. Forward: how the field forms

### 4.1 Continuous features — the heat equation

For a continuous variable (a formant value, `nPVI`), diffusion is the graph heat
equation with Laplacian `L = D − W`:

```
    dx/dt = −L x          ⇒        x(t) = exp(−tL) · x(0)
```

Sharp initial contrasts blur; the rate of blurring between two sites is governed by
their *effective* connectivity, so barriers preserve contrast and gravity edges destroy it.

### 4.2 Discrete variants — logistic adoption, not the heat equation

For a variant (rhotic vs non-rhotic, TH-fronting present/absent), pure diffusion is the
wrong dynamics: it predicts linear, symmetric spread. Real changes are **S-curved** in
time. Kroch's *constant rate effect* says the change advances linearly in the **logit**,
with the same slope everywhere — only the intercept differs by place and context. So the
update runs in logit space:

```
    exposure_i(t) = Σ_j ŵ_ij · x_j(t)              (ŵ row-normalised)
    z_i(t+1)      = z_i(t) + s·[ λ·exposure_i(t) + π_i − θ_i ]
    x_i(t+1)      = σ(z_i(t+1))
```

* `π_i` — **prestige**. Overt prestige scales with settlement rank; this is the second
  place the hierarchy enters, and it is what makes the innovation *start* in cities
  rather than merely *pass through* them.
* `θ_i` — **local resistance**. Constant `θ` gives you conservative relic areas for free.

### 4.3 Counter-diffusion, which is the interesting case

If `θ_i` is allowed to *grow with outside contact*:

```
    θ_i(t+1) = θ_i(t) + ι · (exposure_i(t) − x_i(t))₊
```

then contact provokes divergence rather than convergence. This is not a curiosity — it is
Labov's Martha's Vineyard: islanders centralised /aɪ/ *more* as summer visitors
increased, as an act of local identity. Ocracoke's "hoi toide" behaves the same way under
tourism. A model that can only converge cannot represent half of observed dialectology,
so the resistance term is dynamic by default and `ι = 0` is the special case.

### 4.4 The four classical regimes are one model

| regime | parameters |
|---|---|
| **wave** (Wellentheorie) — concentric, distance-decay | `α = 0` (population ignored), `γ ≈ 2` |
| **contagion** — spread to contiguous neighbours only | `γ` large, `α = 0` |
| **hierarchical / cascade** — down the settlement ladder | `α ≈ 0.5`, `γ ≈ 2`, prestige ∝ rank |
| **contra-hierarchical** — rural first, urban resists | prestige negated (covert prestige) |

They are the same simulator at different parameter settings, which is the argument that
the parameterisation is the right one.

---

## 5. The unification: the propagator *is* the kernel

Here is the part that matters.

The inverse problem needs a covariance function: how correlated are accents at two
locations? The standard answer is to pick a Matérn or squared-exponential kernel over
geodesic distance — which reintroduces exactly the distance-decay assumption §2 demolished.

But we already know the process that generated the field. If the field evolved as
`x(t) = exp(−tL)x(0)` from a spatially white initial condition, then its covariance is

```
    K = exp(−2tL)
```

the **heat kernel of the interaction graph** (Kondor & Lafferty, 2002). So:

> The covariance you interpolate with should be the propagator of the process that made
> the data.

This is not an aesthetic preference. It means barriers, gravity and corridors are
inherited by the interpolator automatically, instead of being bolted on. Sites separated
by the Pennines are decorrelated because the diffusion that would have correlated them
was blocked.

In practice the matrix exponential is replaced by the **regularised Laplacian kernel**

```
    K = (I + σ²L)^(−1)
```

— the `m = 1` member of the same family, one linear solve, and for a few hundred sites
that is microseconds. Prediction at an off-graph query point `g` attaches `g` to the
graph with its own gravity/barrier weights (Nyström extension) and then it is textbook GP
regression:

```
    μ(g) = k_gᵀ (K + τ²I)⁻¹ V
    σ²(g) = k_gg − k_gᵀ (K + τ²I)⁻¹ k_g
```

`τ²` — the nugget — is doing real work: it is idiolectal variation plus measurement
noise, and it is what stops the model claiming a speaker is from one specific village.

---

## 6. Inverse: geolocation as a posterior over the sphere

For a measured vector `v` with per-feature reliability `r_k` (the DSP knows when it could
not measure F3 cleanly), the log-posterior on a grid of candidate origins:

```
    log P(x | v) = Σ_k  r_k · [ −(v_k − μ_k(x))² / (2(σ²_k(x) + τ²_k))  −  ½ log(σ²_k(x) + τ²_k) ]
                 + log prior(x)
```

The prior is **population density** — speakers come from where people are — which is the
gravity model appearing for the third time, now as an occupancy prior.

**The posterior is broad and frequently multimodal, and this is the honest answer, not a
failure.** A rhotic speaker with a fronted GOOSE and a small vowel-space area is
consistent with General American, with Irish English, and with parts of the South West of
England. Reporting a single lat/lon would be a lie about the information content of 14
acoustic numbers. Reporting a `MULTIPOLYGON` with three lobes is the truth, and it is why
this system's output type is a geometry rather than a coordinate pair.

---

## 7. Geometry as the output type

This is where the spatial database stops being storage and becomes the model.

**Voronoi tessellation.** `ST_VoronoiPolygons` over the reference sites, clipped to the
study area with `ST_Intersection`. Every site owns a cell. This is the dialectologist's
own construction, mechanised.

**Isogloss.** The boundary between the union of cells holding variant A and the union
holding variant B:

```sql
ST_Intersection(
  ST_Boundary(ST_Union(cell) FILTER (WHERE has_variant)),
  ST_Boundary(ST_Union(cell) FILTER (WHERE NOT has_variant))
)
```

A `MULTILINESTRING`, derived rather than drawn. Change the threshold, get a different
isogloss, for free.

**Isogloss bundles = dialect boundaries.** Bloomfield's definition: a dialect boundary is
where *many* isoglosses run together. Buffer every isogloss, union the buffers, count
overlaps — bundle density is a scalar field over the study area whose ridges are the real
dialect boundaries. This is computed, not asserted, and it is a good demonstration that
"dialect region" is an emergent object.

**Dialect regions.** Cluster sites in feature space under the effective metric, union
their Voronoi cells, `ST_SimplifyPreserveTopology` + `ST_ChaikinSmoothing`. Goebl-style
dialectometry: regions come out of the data instead of being hand-drawn onto it.

**Credible regions.** Threshold the posterior grid, `ST_MakeEnvelope` each surviving
cell, `ST_Union`, simplify, smooth → 50 / 80 / 95 % `MULTIPOLYGON`s. Multimodality is
represented natively.

**Diffusion wavefronts.** Snapshot the adopter set at each timestep, take the boundary of
the union of adopter cells → an isogloss per timestep. Animate them and you watch the
cascade: the line does not sweep, it *appears around cities first and then joins up*.
That is the signature of hierarchical diffusion and it is visible in the geometry.

---

## 8. What this cannot do, stated plainly

* **14 acoustic dimensions cannot localise to a town.** Expect country/major-region
  resolution at best. The posterior polygons are wide on purpose.
* **The reference field is expert-approximated, not measured.** Values are hand-authored
  from the published descriptive literature (Wells' lexical sets, the *Atlas of North
  American English*, the Survey of English Dialects, rhythm-metric literature). A
  production system replaces `accent_site` with real survey data; the schema and the
  mathematics do not change.
* **L2 accent is a different axis from L1 dialect geography.** A Spanish-accented English
  speaker is not "from" anywhere on the English dialect continuum. The model carries an
  explicit L1-interference score and refuses to geolocate when it dominates.
* **Channel destroys features.** Telephone-band audio (< 4 kHz) removes F3, which removes
  rhoticity, which is the single most informative English feature. The pipeline estimates
  effective bandwidth and down-weights features it could not measure, rather than
  silently reporting a confident wrong answer.
* **Age, sex and style are confounds.** Vocal-tract length is normalised away
  (Lobanov z-scoring within speaker); style-shifting is not, and cannot be from one clip.

---

## 9. Sources of the ideas

Hägerstrand (spatial diffusion) · Trudgill 1974 (gravity model, cascade diffusion) ·
Bloomfield (isogloss bundles) · Labov 1963 (Martha's Vineyard, counter-diffusion),
*Atlas of North American English* · Kroch 1989 (constant rate effect) · Wells 1982
(lexical sets) · Goebl (dialectometry) · Ramus/Grabe & Low (rhythm metrics, nPVI) ·
Zissman 1996 (PPRLM language identification) · Kondor & Lafferty 2002 (diffusion kernels
on graphs) · Nerbonne (Levenshtein dialectometry, continuum vs boundary).
