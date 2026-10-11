# The audio field: from raw audio at places to probabilities on a map

[DIFFUSION.md](DIFFUSION.md) argues for the design: accent similarity is smooth on
an interaction graph, not on the map, so the covariance you interpolate with
should be the heat kernel of that graph. This document derives the **learned**
version of that idea, step by step, as `backend/app/field/` implements it:

* **training nodes** sit at places on the earth, each holding raw recordings;
* a model turns each recording into a short vector and learns, from the nodes,
  how that vector varies over the graph;
* it then answers two questions in opposite directions:
  * **§8 — where was this audio produced?** A probability for every cell of the map.
  * **§9 — how likely is this sound to be produced here?** A surface over the map
    for one phone or natural class.

Every equation below is in the code, and the section numbers are the ones its
docstrings cite. If a symbol or a step is unfamiliar, [PRIMER.md](PRIMER.md) covers
the background: Gaussians, Gaussian processes, graph Laplacians, Bayes on a grid.

> **Status.** The deterministic half runs today. Every speaker audio uploaded
> through the speaker map is featurised (§2.1) and stored byte for byte on an
> audio node (`speakers.py` → `field/featurize.py`, `field/store.py`). The learned
> half — `model.py`, `train.py`, `service.py`, in PyTorch — is complete as library
> code but is **not yet wired to an API route**, `torch` is not in
> `backend/requirements.txt`, and nothing in CI exercises it. §11 lists what is
> missing.

---

## 0. Notation

| symbol | meaning | code |
|---|---|---|
| `i, j` | training nodes, `n` of them | `NodeGraph` |
| `m_i` | number of recordings at node `i`; `M = diag(m)` | `cnt` |
| `N` | total recordings | `len(obs.X)` |
| `x ∈ R^70` | a recording's acoustic vector | `featurize.py` |
| `z ∈ R^r` | its whitened embedding, `r = 6` | `model.embed` |
| `P_i` | population at node `i` | `log_pop` |
| `d(i, j)` | effective distance, km | `log_d` |
| `W, L` | edge weights, graph Laplacian `L = D − W` | `model.kernel` |
| `t` | diffusion time | `log_t` |
| `K̃` | unit-diagonal graph kernel | `Kc` |
| `s²_r, ρ_r` | signal variance and noise ratio of embedding dimension `r` | `log_s2`, `log_rho` |
| `g` | a point off the graph — a cell of the map | `attach` |

---

## 1. The setup

A node is a place `(λ_i, φ_i)` with a population. A recording is raw audio
attached to a node. The store keeps the audio exactly as uploaded, because the
featuriser will change and the vectors must be rebuildable from the sound, not
from a lossy summary of it (`store.py`, `FEATURE_VERSION`).

The whole model is four lines:

```
x_ij = Φ(audio_ij)                         deterministic features          §2.1
z_ij = Ω( E_θ(x_ij) )                      learned encoder, then whitened  §2.3–2.4
f_r  ~ GP(0, s²_r K̃)  over the nodes       one field per embedding dim     §3–5
z_ijr = f_r(i) + ε_ijr,   ε ~ N(0, s²_r ρ_r)
```

`f_r(i)` is "the accent of place `i`" along embedding direction `r`. `ε` is
everything that is not place: idiolect, voice, microphone, measurement noise.
The kernel `K̃` encodes the claim that places strongly joined by the
interaction graph have similar accents.

Fitting (§6–7) learns the encoder `θ`, the graph exponents `α, γ`, the diffusion
time `t`, and `s²_r, ρ_r`. Inference (§8) inverts the model with Bayes' rule.

---

## 2. Raw audio → vector → embedding

### 2.1 The deterministic features (`featurize.py`)

The audio is resampled to 16 kHz mono, cut into 25 ms frames every 10 ms, and
run through the same DSP and template phone recogniser the analyser uses.
Four blocks are concatenated into `x ∈ R^70`:

| block | dims | what it is |
|---|---|---|
| cepstral | 24 | mean and SD of MFCC 1–12 over speech frames: the spectral envelope |
| prosody | 4 | f0 SD and 10–90% range in semitones, voiced share, segments per second |
| phonology | 28 | the expected distinctive-feature bundle (below) |
| accent | 14 | the sociophonetic measurements of `accent.py`; `NaN` when reliability < 0.10 |

The phonology block is the bridge to `phonemescape`. Let the recogniser give a
posterior `P(p | t)` over inventory phones `p` at each frame `t`. Let
`F ∈ {−1, 0, +1}^(phones × 28)` be the inventory's distinctive-feature matrix
(Hayes 2009). Then

```
E[f | t]  =  Σ_p  P(p | t) · F[p, :]          (silence removed, mass renormalised)
phon      =  mean over speech frames of E[f | t]
```

This describes the audio phonologically without requiring the recogniser to
pick the right phone — only that it spread its mass over similar ones. Mixing
[s] and [ʃ] still yields `+strident, −voice`.

Every recording is decoded with the **language-neutral** phonotactic model. The
analyser re-decodes under the identified language because that measures better.
Here consistency matters more, because an embedding that changed with a
language decision would feed language-ID errors straight into the geography.

The same text should be read everywhere. The Speech Accent Archive's "Please
call Stella" paragraph is a fixed passage. A fixed passage means that differences
between recordings come from how something is said, not what is said. Without it,
the cepstral and phonology blocks would mostly measure content.

### 2.2 Standardise

```
x̃_d = (x_d − mean_d) / sd_d          over the training recordings
x̃_d = 0  where x_d is NaN             (impute the training mean)
```

### 2.3 Encode

```
e = W_θ x̃          W_θ ∈ R^(r × 70), no bias, r = 6       (or a one-hidden-layer MLP)
```

The linear encoder is initialised at the leading principal directions of `x̃`.
So epoch 0 is already a sensible embedding, and training only has to rotate it
toward the directions that vary with geography.

### 2.4 Whiten

```
Σ_e = cov(e) + 10⁻⁴ I  =  L_e L_eᵀ           (Cholesky)
z   = L_e⁻¹ (e − ē)                           ⇒  cov(z) = I
```

During training, the whitening is recomputed from the current batch at every
step. Afterwards it is frozen on all recordings (`z_mean`, `z_white`), so inference
applies one fixed transform. §6.3 explains why the whitening is not optional.

---

## 3. The graph (`graph.py`)

**Effective distance.** Great-circle distance, inflated by the barriers that the
segment between the two places crosses:

```
d(i, j) = d_gc(i, j) · (1 + Σ_b ρ_b · 1[segment i–j crosses barrier b])
d       ← max( (d + dᵀ)/2 , 5 km )
```

`ρ_b` is the barrier's resistance from the `barrier` table. The crossing test is
the four-orientation test of `geomath.barrier_resistance`, the same predicate
`ST_Intersects` uses. It runs in the lon/lat plane, which is accurate for
barriers of regional length and not for ones spanning tens of degrees.

**Edge weights.** These are the gravity model in log form, plus ancestry links:

```
log w_ij = α (log P_i + log P_j) − γ log d(i, j) + log a_ij,      w_ii = 0
W        = w / max_ij w_ij                                        (strongest edge = 1)
```

* `P_i` is the node's own population. Failing that, it is the population of the
  nearest settlement within 30 km. Failing that, it is 50 000. This is what makes
  the graph hierarchical rather than a lattice: recordings from a city are better
  connected than recordings from a hamlet.
* `a_ij ≥ 1` joins nodes that are linked by migration. This is the wormhole term.
* `α` and `γ` are **learned**. They are parameterised as logs and clamped to
  `α ∈ [0.02, 2]` and `γ ∈ [0.2, 5]`. They start at the reference model's
  `α = 0.5, γ = 2`.
* The corridor term `φ_ij` of DIFFUSION.md §3 is not in the field graph yet.

Distances and populations are geography, computed once in numpy. The model
learns only how to weight them.

---

## 4. Diffusion on the graph

### 4.1 The Laplacian

```
L = D − W,     D = diag(Σ_j W_ij)
```

The property everything rests on is

```
xᵀ L x = ½ Σ_ij W_ij (x_i − x_j)²   ≥ 0
```

`xᵀLx` is the **Dirichlet energy** of a function `x` on the nodes. It is small
when `x` changes little across strong edges and large when it jumps across them.
A jump across a weak edge, such as a barrier, costs almost nothing. `L` is
symmetric and positive semi-definite, and `L·1 = 0`.

### 4.2 The heat equation

Let `x(t)` be a continuous feature spreading by contact. Each node moves toward
its neighbours at a rate set by the edge weight:

```
dx/dt = −L x      ⇒      x(t) = e^(−tL) x(0)
```

Write `L = U Λ Uᵀ` with eigenpairs `(λ_k, u_k)`, where `0 = λ_1 ≤ λ_2 ≤ …`. Then

```
x(t) = Σ_k e^(−t λ_k) (u_kᵀ x(0)) u_k
```

The eigenvectors are the graph's "Fourier modes". `λ_k` is the Dirichlet energy
of mode `k`. Diffusion damps each mode by `e^(−tλ_k)`. Rough modes (large `λ`)
vanish quickly, and smooth modes (small `λ`) survive. A mode that is `+1` on one
side of a barrier and `−1` on the other has small `λ` because the barrier edges
are weak, so it survives. That surviving contrast is a dialect boundary.

### 4.3 From the process to a covariance

Suppose the field started as spatially white noise, `x(0) ~ N(0, I)`. Then

```
Cov x(t) = e^(−tL) e^(−tL)ᵀ = e^(−2tL)
```

This is the **heat kernel** (Kondor & Lafferty 2002). It is the covariance of the
field the diffusion leaves behind. It is the right covariance for interpolating
the field, because it is the propagator of the process that made the data.

---

## 5. The kernel actually used

### 5.1 The regularised Laplacian

```
K = (I + t L)⁻¹ = Σ_k  1/(1 + t λ_k) · u_k u_kᵀ
```

There are three ways to read this.

* **As a spectral filter.** The heat kernel damps mode `k` by `e^(−2tλ_k)`; this
  kernel damps it by `1/(1+tλ_k)`. Both equal 1 on the constant mode and decrease
  in `λ`. For small `tλ`, `1/(1+tλ) ≈ 1 − tλ`, which is the heat kernel at half
  the time, `e^(−2(t/2)λ)`. So `t` here plays the role of `t/2` there. For large
  `λ`, the resolvent decays like `1/tλ` rather than exponentially. Rough modes
  keep more variance, and distant nodes decorrelate less aggressively.
* **As a Gaussian Markov random field.** `K⁻¹ = I + tL` is the precision, so the
  prior density is

  ```
  p(f) ∝ exp( −½ Σ_i f_i²  −  (t/4) Σ_ij W_ij (f_i − f_j)² )
  ```

  Each node is pulled toward zero and toward its strongly-weighted neighbours.
  `t` trades one pull against the other. `t → 0` gives independent nodes, and
  `t → ∞` gives one value per connected component.
* **As a cost.** It needs one Cholesky factorisation of an `n × n` matrix, where
  `n` is the number of nodes, not recordings. It is computed in float64
  throughout; `DTYPE` in `model.py` says why.

### 5.2 Unit diagonal

`K_ii` depends on connectivity: hubs have small `K_ii` and isolated nodes have
`K_ii ≈ 1`. Left alone, this would mean the prior *variance* of a place's accent
depends on how well-connected it is. The model normalises it away so that
connectivity controls only *correlation*:

```
K̃ = diag(K)^(−½) · K · diag(K)^(−½)          K̃_ii = 1, still positive definite
```

`s²_r` is then the prior variance of the field along dimension `r` at every node.

This is a choice, and it has a cost. DIFFUSION.md §2 notes that relic areas —
poorly connected places — tend to be extreme. The un-normalised kernel would
encode that, and `K̃` does not. Their decorrelation from everything else survives
normalisation, so an isolated node can still sit far from its neighbours.

### 5.2.1 A worked example

Three nodes: city A (9 million people), town B (150 000 people) 160 km away,
and village C (2 000 people) 80 km from each. With `α = 0.5`, `γ = 2`, `t = 0.8`:

```
                   W (strongest = 1)        K̃
                   A      B      C          A      B      C
no barrier    A    ·    1.000  0.462      1.000  0.415  0.243
              B  1.000    ·    0.060      0.415  1.000  0.127
              C  0.462  0.060    ·        0.243  0.127  1.000

a barrier     A    ·    1.000  0.115      1.000  0.433  0.075
(ρ = 1)       B  1.000    ·    0.015      0.433  1.000  0.040
around C      C  0.115  0.015    ·        0.075  0.040  1.000
```

Two things show.

* **Gravity.** The village is equidistant from both, yet it correlates twice as
  strongly with the city (0.243) as with the town (0.127).
* **Barriers.** A barrier that doubles the effective distance to the village cuts
  each of its correlations by about a factor of three. The city–town correlation
  even rises slightly, because less of the diffusion leaks away through C.

An isotropic distance kernel can show neither effect.

### 5.3 Points off the graph

To put a probability on a map cell `g`, the model needs the cell's covariance
with the nodes. It treats `g` as one more node, joined to the graph by gravity
edges. The cell's own population is unknown, so the median node population `P̃`
stands in for it:

```
w_gj = P̃^α P_j^α / max(d(g, j), 8 km)^γ / max_ij w_ij          (same units as W)
s    = Σ_j w_gj         ŵ_j = w_gj / s
```

**The derivation of the coupling.** Add `g` to the graph. The precision of the
augmented field is `Q = I + tL'`, and its row for `g` is

```
Q_gg = 1 + t s,        Q_gj = −t w_gj
```

For any Gaussian, `E[f_g | f_G] = −Q_gg⁻¹ Q_gG f_G` and `Var[f_g | f_G] = Q_gg⁻¹`.
(PRIMER.md §2.3 covers conditioning in precision form.) So

```
f_g = c · ŵᵀ f_G + e,        c = t s / (1 + t s),        e ~ N(0, 1/(1 + t s))
```

Exactly, `Cov(f_g, f_G) = c · ŵᵀ Σ'_GG`, where `Σ'_GG` is the nodes' covariance
*with `g` attached*. The model makes one approximation: attaching a single query
point does not rewire the graph, so `Σ'_GG ≈ K̃` and `Var f_g ≈ 1`. That gives

```
k_g = c · ŵᵀ K̃                                           model.attach, predict_points
```

`c` measures how connected the point is at all.

* **Far from every node,** `s → 0`, so `c → 0`, `k_g → 0`, and the field
  reverts to its prior, as it should.
* **Deep inside the graph,** `c → 1`, and this becomes the row-normalised Nyström
  extension that `geo.py` uses for the reference field (with `c = 1` always).

On 12 random nodes, the exact correlation (from inverting the augmented
precision) and `c · ŵᵀK̃` differ by at most 0.009 for a weakly attached point,
0.036 for a point 40 km from a node, and 0.048 for a point 3 km from one.

For speed, only each cell's 16 strongest neighbours enter `ŵ` (`TOP_K`). `c` uses
the full connection strength `s`.

---

## 6. Fitting: the marginal likelihood (`model.log_marginal`)

### 6.1 One node, sufficient statistics

Fix a dimension `r` and drop the index. Node `i` has recordings
`z_i1 … z_im = f_i + ε_ij` with noise variance `v = s²ρ`. Let `z̄_i` be their
mean and `SS_i = Σ_j (z_ij − z̄_i)²` their scatter. Completing the square gives

```
Π_j N(z_ij; f_i, v)  =  N(z̄_i; f_i, v/m_i)  ×  m_i^(−½) (2πv)^(−(m_i−1)/2) exp(−SS_i / 2v)
                        └ depends on f ─┘       └──────── does not depend on f ──────────┘
```

The field sees a node only through its mean. The scatter around the mean
measures the noise alone.

### 6.2 All nodes

Integrate out `f ~ N(0, s²K̃)`:

```
z̄ ~ N( 0,  C ),        C = s² ( K̃ + ρ M⁻¹ ),      M = diag(m_1 … m_n)

log p(Z) = Σ_r [ −½ ( z̄_rᵀ C_r⁻¹ z̄_r + log|C_r| + n log 2π )                 between nodes
               −½ ( Σ_i (m_i − 1) · log(2π s²_r ρ_r) + Σ_i SS_ir / (s²_r ρ_r) ) ]   within nodes
```

The constant `Σ log m_i^(−½)` is dropped. `C_r` is factorised by Cholesky, which
gives both `C⁻¹z̄` and `log|C| = 2 Σ log diag(chol)`. A jitter of `10⁻⁶ I` keeps it
positive definite when `ρ` is small.

Embedding dimensions are modelled as independent GPs. That is an assumption,
and whitening makes it a reasonable one: it decorrelates the dimensions
marginally, though not node by node.

The ratio `ρ` has a direct reading. The prior variance of one recording is
`s² + s²ρ`, so

```
geographic share of dimension r  =  s²_r / (s²_r + s²_r ρ_r)  =  1 / (1 + ρ_r)
```

`train.hyperparameters` reports this share for each dimension.

### 6.3 Why the embedding must be whitened

The encoder produces the data that the likelihood scores. Scale the embedding by
`a` and let `s²` follow by `a²`. The density changes by the Jacobian:

```
p(a·Z; a² s²) = a^(−N r) · p(Z; s²)    →  ∞   as a → 0
```

So an unconstrained encoder maximises the likelihood by shrinking every
recording to the same point. Whitening pins `cov(z) = I`. With the scale and the
correlations fixed, the only freedom left is *which* `r`-dimensional subspace of
`x̃` the encoder picks. The likelihood is highest for subspaces where most
variance is between nodes and smooth on the graph (small `ρ`), rather than
within nodes. This is the logic of Fisher's discriminant, with "classes" replaced
by "places, correlated through `K̃`".

`log p(Z)` is a density of the whitened embedding, not of the audio, and no
Jacobian of the whitening enters. Treat it as a training criterion, not as a
likelihood you could compare across encoders.

### 6.4 Optimisation

* Every positive parameter is a log (`log_alpha`, `log_t`, …).
* The clamps after each step keep the graph in a sane regime: `t ∈ [10⁻³, 10³]`
  and `ρ ∈ [10⁻³, 10³]`.
* The optimiser is Adam with learning rate 0.03. Weight decay of 10⁻³ applies to
  the encoder only.
* `α, γ, t` start at the reference model's values, so training starts from the
  hand-tuned field and moves only as far as the data asks.
* The marginal-likelihood term is divided by `N·r`, so it is on the same scale
  as the cross-entropy below.

---

## 7. Fitting: the geolocation cross-entropy (`train.geo_scores`)

The marginal likelihood fits a generative story. The task, though, is
discriminative: pick the right place. So the loss also includes the task itself,
made differentiable.

At each step, a random 25% of the training nodes is held out as `H`, and the GP
is conditioned on the rest, `C`. A held-out node must not condition on its own
recordings: if it did, its predicted mean would be `≈ z̄_i` and the task would be
trivial.

**Predictive distribution at a candidate node `j`.** This is standard Gaussian
conditioning (PRIMER.md §3.2) with cross-covariance `s² K̃_jC`:

```
A_r   = ( K̃_CC + ρ_r M_C⁻¹ )⁻¹,          α_r = A_r z̄_C,r
μ_jr  = K̃_jC α_r
v_jr  = s²_r (1 − K̃_jC A_r K̃_Cj)  +  s²_r ρ_r          (field uncertainty + a new recording's noise)
```

**Score each held-out recording `y` against every candidate,** with a uniform
prior over candidates:

```
log P(j | y) = log softmax_j  Σ_r log N(y_r; μ_jr, v_jr)
```

**Soft labels.** A near miss is partly right:

```
q(j | i) ∝ exp( −d_gc(i, j)² / 2h² ),      h = max(50 km, 2 × median nearest-neighbour distance)
CE      = − mean over held-out recordings of Σ_j q(j | i) log P(j | y)
```

**The loss:**

```
loss = −log p(Z) / (N r)  +  λ · CE,          λ = 1
```

Each term covers a weakness of the other. With few nodes, the cross-entropy
alone overfits, because it can memorise which recording goes where. The
marginal likelihood alone prefers directions that are smooth on the graph, but
smooth is not the same as discriminative.

**Validation.** When there are at least 10 nodes, 20% of nodes (not recordings)
are set aside, so no validation speaker's location is ever conditioned on.
Validation cross-entropy drives early stopping (patience 60 epochs). The report
gives:

* the median and mean error in km of the posterior mode;
* the expected error under the posterior, which penalises confident wrong answers;
* top-1 accuracy;
* the share of answers within `h`;
* two baselines that know nothing about the audio: a random training node, and
  the geographic medoid.

The final model conditions on every node.

---

## 8. Inference: P(place | audio) (`service.locate`)

**The grid.** About 3 000 cells cover the nodes' bounding box, padded by 15%
(at least 1°), optionally clipped to land. The field is only identified near
data. Past the padding, the posterior would just be the prior.

**The field on the grid.** Conditioning on *all* nodes, with `k_g = c ŵᵀK̃` from
§5.3, gives for each cell `g` and dimension `r`:

```
μ_r(g) = k_gᵀ α_r
v_r(g) = s²_r (1 − k_gᵀ A_r k_g)  +  s²_r ρ_r
       = s²_r (1 − c² ŵᵀ (K̃ A_r K̃) ŵ)  +  s²_r ρ_r       (only the 16 neighbours enter)
```

**Bayes.** For a new recording with embedding `y = z(audio)`:

```
log P(g | y) = Σ_r log N( y_r ; μ_r(g), v_r(g) )  +  log π(g)  −  log Z
```

**The prior** says speakers come from where people are, and equal-angle cells
are not equal areas:

```
log π(g) = 0.30 · log( 1000 + Σ_s P_s exp(−d(g, s)² / (2 · 90²)) )  +  log cos φ_g
```

The sum runs over settlements, with a 90 km kernel. The exponent 0.30 tempers
the prior so that it guides rather than dominates. Like the reference model's
prior, it is a heuristic. The `cos φ` term is exact: a 1° cell at 60°N is half
the area of one at the equator.

**The answer** is a distribution, not a point:

| output | definition |
|---|---|
| `map` | the cell of highest posterior |
| `mean` | the posterior mean on the sphere: average the 3-D unit vectors, then project back (so a posterior straddling ±180° is not averaged into the wrong hemisphere) |
| `spread_km` | RMS great-circle distance from that mean |
| credible regions | sort cells by `P`; the 50/80/95% region is the smallest set whose mass reaches the level (highest posterior density); returned as cell sets, which `geo.region_geometry` can union into polygons |
| `nodes` | the same likelihood evaluated at the nodes, softmaxed: "which training places does it sound like" |

The posterior is often multimodal, and that is the honest answer (DIFFUSION.md
§6).

**Two speeds of learning.** Ingesting a recording changes `z̄` and `M`, so the
next query re-conditions (re-solves `A`). The field updates instantly, with
nothing retrained. Training — the encoder and `α, γ, t, s², ρ` — needs
re-running only when the *shape* of the field should move, not just its values.

---

## 9. Sound-production surfaces: P(sound | place) (`service.production`)

§8 asks where a recording comes from. This section asks the converse: across
the map, how much of the speech is a given sound?

**Target.** The target is one IPA symbol (`θ`) or a natural class written in
distinctive features (`+strident,-voice`). It resolves to a set `T` of inventory
phones through phonemescape (`phonology.target_indices`).

**Per recording.** The production rate is the recogniser's posterior mass on
`T`, averaged over speech frames, then mapped to the logit scale:

```
π   = mean over speech frames t of Σ_{p ∈ T} P(p | t)
y   = log( π / (1 − π) )             π clipped to [10⁻³, 1 − 10⁻³]
ȳ_i = mean of y over node i's recordings
```

**Model.** This uses the same graph as the trained field (its `α, γ, t`, so the
same `K̃`). It has its own constant mean, signal and noise:

```
ȳ ~ N( m₀ 1,  s² (K̃ + ρ M⁻¹) )
```

**Fitting by profile likelihood.** For fixed `ρ`, write `C = K̃ + ρM⁻¹`. Then
`m₀` and `s²` have closed forms:

```
m₀ = 1ᵀ C⁻¹ ȳ / 1ᵀ C⁻¹ 1                 (generalised least squares)
s² = (ȳ − m₀1)ᵀ C⁻¹ (ȳ − m₀1) / n
ℓ(ρ) = −(n/2) log s² − ½ log|C|           (+ const)
```

`ρ` is chosen by maximising `ℓ` over 17 values from 10⁻² to 10².

**The surface.** For each cell `g`:

```
η(g)  = m₀ + k_gᵀ C⁻¹ (ȳ − m₀ 1)
sd(g) = sqrt( s² (1 − k_gᵀ C⁻¹ k_g) )
p(g)  = σ(η(g)),     90% band  σ(η ± 1.645 sd)
```

How to read it:

* `p(g)` is the expected share of speech frames that are `[T]` at that place.
  It is a rate, not "the probability a speaker there uses the variant".
* `σ(η)` is the **median** of the logit-normal, not its mean. With a symmetric
  band, the median is the honest centre.
* The band is for the place's rate surface, not for a single new speaker. A new
  speaker would add `s²ρ`.
* Rates depend on what was said. Only a fixed passage, as in the Speech Accent
  Archive, makes them comparable between places.
* `geographic_share = 1/(1+ρ)` is reported as before. A share near 0 means the
  sound's rate does not vary with place in this data.

§8 and §9 are the two conditionals of one joint model, `P(place | sound)` and
`P(sound | place)`, linked by Bayes' rule. Geolocating from a single sound
would be `P(g | y) ∝ N(y; η(g), sd(g)² + s²ρ) · π(g)`. That is not exposed,
because the full embedding of §8 carries strictly more information.

---

## 10. Relation to the reference field (`geo.py`)

| | reference field (`geo.py`) | audio field (`field/`) |
|---|---|---|
| data | 14 hand-authored features per reference site | raw recordings at nodes |
| what is interpolated | each feature, separately | a learned 6-dim whitened embedding |
| graph | gravity + barriers + ancestry, `α = 0.5, γ = 2` fixed | the same, with `α, γ` learned |
| kernel | `(I + σ²L)⁻¹`, `σ² = 0.8` fixed | `(I + tL)⁻¹` with `t` learned, unit diagonal |
| noise | per-feature nugget + `τ² = 0.05` | per-dim `s²ρ`, fitted |
| off-graph | row-normalised Nyström (`c = 1`) | the same with coupling `c = ts/(1+ts)` |
| prior on place | population density + area | the same |
| measurement reliability | weights each feature's log-likelihood | unmeasured features are imputed at the mean |

The reference field is the audio field with the encoder replaced by a human
reading the literature, and the hyperparameters set by hand. That is why the
audio field is initialised at the reference field's values.

---

## 11. What is not done, and what to expect

**Not wired.**

* `service.FieldService` has no API route; its error message names
  `POST /api/field/train`, which does not exist yet.
* `torch` is not in `backend/requirements.txt`. The code was developed against
  torch 2.12 on CPU, and any recent 2.x should do.
* No CI job trains a field.

**Synthetic results prove plumbing, not accuracy.** `synthworld.py` places
synthesised speakers at the reference varieties. It exercises every line from
raw audio to a posterior with the true location known, so a wrong answer there
is a bug. But the accents are generated by the same assumptions the analyser
measures with, so a good score is internal consistency, not evidence about real
speakers.

**The Speech Accent Archive is the right real data, with three caveats.**

* *One recording per speaker.* If nodes are speakers, `m_i = 1`. The
  within-node term then has no degrees of freedom, and `ρ` is identified only
  through the between-node term and the cross-entropy. Pooling speakers by
  geocoded birthplace (the speaker map already geocodes them) gives `m_i > 1`
  at the cities that matter.
* *Mostly L2 English.* The archive's speakers are mostly non-native, and a
  Spanish speaker's English is not "from" Spain on the English dialect
  continuum. Train one field per native language, or restrict to native English
  speakers (658, of whom 620 geocode to a city), before reading the map as
  dialect geography.
* *Coverage.* The posterior is only identified near nodes. Where there are no
  speakers, the map shows the prior, and the grid's padding stops it there.

**Scale.** The cost is `O(n³)` in nodes, per step and per re-conditioning, which
is fine up to a few thousand nodes. Beyond that, use the sparse precision
`I + tL` directly (it is sparse once `W` is truncated to near neighbours) instead
of the dense inverse.

**Calibration.** Treat the posterior's 80% region as an 80% region only after
checking that about 80% of held-out real speakers fall inside it. The
validation report gives the inputs; the coverage check itself is not written.

---

## 12. Sources

Kondor & Lafferty 2002 (diffusion kernels on graphs) · Smola & Kondor 2003
(kernels and regularisation on graphs; the regularised Laplacian) · Rasmussen &
Williams 2006, *Gaussian Processes for Machine Learning*, ch. 2 and 5
(prediction, marginal likelihood) · Rue & Held 2005, *Gaussian Markov Random
Fields* (conditioning in precision form) · Williams & Seeger 2001 (the Nyström
method) · Fisher 1936 (discriminant analysis) · Hayes 2009, *Introductory
Phonology* (distinctive features) · Weinberger, *Speech Accent Archive* ·
Trudgill 1974 (the gravity model). DIFFUSION.md §9 has the dialectology.
