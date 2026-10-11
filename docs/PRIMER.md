# The math you need, and where it is used

[AUDIO_FIELD.md](AUDIO_FIELD.md) derives the audio field and
[DIFFUSION.md](DIFFUSION.md) argues for its design. Both assume the background
below. Each section gives one idea, a tiny example you can check by hand, and a
pointer to where the idea is used. Nothing here is specific to accents. This is
the toolkit for any "values at places, smooth on a network, inverted with
Bayes" problem — house prices, disease incidence, sensor networks.

| § | idea | used in |
|---|---|---|
| 1 | covariance, positive-definite matrices, Cholesky | everywhere |
| 2 | the Gaussian and how to condition it | §5.3, §7, §8 |
| 3 | Gaussian processes: prediction and marginal likelihood | §6–9 |
| 4 | graphs, the Laplacian, its spectrum, heat diffusion | §3–5 |
| 5 | Bayes' rule on a grid, credible regions | §8 |
| 6 | softmax, cross-entropy, soft labels | §7 |
| 7 | fitting by gradient: log-parameters, autodiff, float64 | §6.4 |
| 8 | proportions on the logit scale | §9 |
| 9 | the sphere: distances, cell areas, means | §3, §8 |
| 10 | phones as feature vectors | §2.1, §9 |

---

## 1. Covariance and positive-definite matrices

For a random vector `x ∈ R^n`, the covariance is `Σ = E[(x − μ)(x − μ)ᵀ]`. Entry
`Σ_ij` says how much `x_i` and `x_j` move together. The correlation is
`Σ_ij / √(Σ_ii Σ_jj)`, which lies in `[−1, 1]`.

A covariance matrix is **symmetric positive semi-definite** (PSD):
`vᵀΣv = Var(vᵀx) ≥ 0` for every `v`. It is **positive definite** (PD) when this is
strictly positive, which means no direction has zero variance. A kernel is any
function that always produces PSD matrices. Whenever the code builds a
covariance, it must stay PD, and that is what the small "jitter" added to the
diagonal is for.

**Cholesky.** A PD matrix factorises as `Σ = LLᵀ` with `L` lower-triangular.
That one factorisation gives you everything:

```
solve Σa = b            two triangular solves with L and Lᵀ
log det Σ               2 Σ_i log L_ii
sample x ~ N(0, Σ)      x = L ε,  ε ~ N(0, I)
whiten x                L⁻¹ x has covariance I
```

Example: `Σ = [[4, 2], [2, 3]]` gives `L = [[2, 0], [1, √2]]`. Then
`det Σ = 12 − 4 = 8`, and `2(log 2 + log √2) = log 8`. ✓

*Used:* every solve and log-determinant in `model.py`, and the whitening in
AUDIO_FIELD.md §2.4.

---

## 2. The Gaussian

### 2.1 Density

```
log N(x; μ, Σ) = −½ (x − μ)ᵀ Σ⁻¹ (x − μ)  −  ½ log|Σ|  −  (n/2) log 2π
                 └──── misfit ─────┘       └ spread ┘
```

The two terms pull in opposite directions. A wide `Σ` makes the misfit small but
pays in `log|Σ|`. This tension is what makes the marginal likelihood (§3.3) choose
sensible variances.

### 2.2 Conditioning in covariance form

Split a jointly Gaussian vector into `a` (unknown) and `b` (observed):

```
[a]      ( [μ_a]   [Σ_aa  Σ_ab] )
[b]  ~ N ( [μ_b] , [Σ_ba  Σ_bb] )

a | b  ~  N( μ_a + Σ_ab Σ_bb⁻¹ (b − μ_b),   Σ_aa − Σ_ab Σ_bb⁻¹ Σ_ba )
```

This is the single most-used identity in the system. The mean moves toward what
was observed, in proportion to the correlation. The variance shrinks by however
much the observation explains, and it never depends on the observed *values*.

Example: two places with prior correlation 0.6 and unit variances. Place 1 is
measured at `1.0` with noise variance `0.1`, so `Σ_bb = 1 + 0.1`. Then

```
E[f_2 | y_1]   = 0.6 / 1.1 × 1.0          = 0.545
Var[f_2 | y_1] = 1 − 0.6² / 1.1           = 0.673
```

### 2.3 Conditioning in precision form

The precision is `Q = Σ⁻¹`. With `Q` split the same way:

```
E[a | b]   = μ_a − Q_aa⁻¹ Q_ab (b − μ_b)
Var[a | b] = Q_aa⁻¹
```

No matrix needs inverting except the small block `Q_aa`. Zeros in `Q` mean
conditional independence: `Q_ij = 0` says that `i` and `j` are independent given
everything else. This makes precision the natural language for graphs (§4), where
`Q` is sparse.

Same example: `Σ = [[1, .6], [.6, 1]]` gives `Q = (1/0.64) [[1, −.6], [−.6, 1]]`.
So `E[a | b] = (0.9375/1.5625) b = 0.6 b` and `Var = 1/1.5625 = 0.64 = 1 − 0.6²`. ✓

*Used:* deriving the off-graph coupling `c = ts/(1+ts)` (AUDIO_FIELD.md §5.3).

---

## 3. Gaussian processes

### 3.1 What a GP is

A Gaussian process is a Gaussian over **function values**. Pick any finite set of
inputs `x_1 … x_n` (here: places) and the values `f(x_1) … f(x_n)` are jointly
Gaussian with covariance `K_ij = k(x_i, x_j)`. The kernel `k` is the whole model,
because it says which places should have similar values. Most GP texts use
`k = exp(−distance²/ℓ²)`. This project's thesis is that, for dialects, `k` should
come from a graph instead (§4).

### 3.2 Prediction

Observe `y = f(X) + noise` with noise variance `τ²`. Prediction at a new input
`x*` is §2.2 with `a = f(x*)` and `b = y`:

```
μ(x*)  = k*ᵀ (K + τ² I)⁻¹ y
σ²(x*) = k(x*, x*) − k*ᵀ (K + τ² I)⁻¹ k*            k* = [k(x*, x_i)]_i
```

The variance of a **new observation** at `x*` adds `τ²` back on. AUDIO_FIELD.md
§7–8 uses this predictive form, because a new speaker is a new noisy draw, not
the place's mean.

When one input has `m` observations, their mean has noise `τ²/m`. That is why
the field's covariance is `K̃ + ρ M⁻¹`.

### 3.3 Marginal likelihood

Integrating `f` out gives `y ~ N(0, K + τ²I)`. Its log density (§2.1) scores the
kernel's hyperparameters by how well they explain the data:

```
log p(y) = −½ yᵀ (K + τ²I)⁻¹ y   −  ½ log|K + τ²I|   −  (n/2) log 2π
           └──── data fit ────┘      └─ complexity ─┘
```

A kernel that is too flexible fits every wiggle but pays in `log|·|`. A kernel
that is too rigid is cheap but fits badly. Maximising the sum is an automatic
Occam's razor, which is why the audio field can *learn* its diffusion time and
gravity exponents rather than having them set by hand.

*Used:* AUDIO_FIELD.md §6 (training) and §9 (the profile likelihood over `ρ`).

---

## 4. Graphs and diffusion

### 4.1 The Laplacian

Nodes `1 … n` and symmetric weights `W_ij ≥ 0` define a graph. Its Laplacian is

```
L = D − W,     D_ii = Σ_j W_ij
```

and its quadratic form is the **Dirichlet energy**:

```
xᵀ L x = ½ Σ_ij W_ij (x_i − x_j)²
```

This measures how much a function `x` on the nodes changes across edges,
weighted by edge strength. It is the graph's notion of "rough".

Example: the path `1 — 2 — 3` with unit weights:

```
L = [[ 1, −1,  0],          eigenvalues   eigenvectors
     [−1,  2, −1],            0           (1, 1, 1)/√3      constant: zero energy
     [ 0, −1,  1]]            1           (1, 0, −1)/√2     one end vs the other
                              3           (1, −2, 1)/√6     the middle vs the ends
```

### 4.2 The spectrum as graph Fourier analysis

`L = UΛUᵀ`. The eigenvectors are the graph's vibration modes, ordered from
smooth to rough, and the eigenvalue is the mode's energy. A function on the nodes
is a sum of modes: `x = Σ_k (u_kᵀx) u_k`.

A weak edge, such as one crossing a barrier, makes a mode that changes sign
across it nearly free, so its eigenvalue is near 0. Small eigenvalues mark the
graph's natural cuts.

### 4.3 Diffusion

The heat equation `dx/dt = −Lx` moves every node toward its neighbours, and its
solution is `x(t) = e^(−tL)x(0)`. In modes, each one decays independently:

```
x(t) = Σ_k e^(−t λ_k) (u_kᵀ x(0)) u_k
```

On the path graph at `t = 1`, the three modes are multiplied by `1`, `e^(−1) =
0.37` and `e^(−3) = 0.05`. The rough mode is gone, the end-to-end contrast is
fading, and the mean is untouched (diffusion conserves it).

### 4.4 Kernels from diffusion

If `x(0)` is white noise, the covariance of `x(t)` is `e^(−2tL)`: the **heat
kernel**. More generally, any decreasing function `r(λ)` gives a valid kernel
`U r(Λ) Uᵀ`. The project uses `r(λ) = 1/(1 + tλ)`, i.e. `K = (I + tL)⁻¹`, which
is the covariance of the Gaussian whose precision is `I + tL`. By §2.3, that is
a field where each node is pulled toward zero and toward its neighbours. On the
path graph at `t = 1`, its filter is `1, 0.5, 0.25` against the heat kernel's
`1, 0.14, 0.002`. It is gentler on rough modes, but ranks them the same way.

*Used:* AUDIO_FIELD.md §4–5; DIFFUSION.md §4–5.

---

## 5. Bayes' rule on a grid

To invert "place → audio" into "audio → place", lay a grid of candidate places
`g` and compute

```
P(g | y) = p(y | g) π(g) / Σ_g' p(y | g') π(g')
```

* **Work in logs.** The likelihoods are products of many small numbers. Subtract
  the maximum log-score before exponentiating, then normalise. The constant
  cancels.
* **Prior.** `π(g)` is what you believe before hearing anything. Here it is
  population density times cell area.
* **Credible regions.** Sort cells by probability and take cells until the mass
  reaches 80%. This highest-posterior-density region is the smallest area holding
  80% of the belief. It can be several disconnected pieces, which is correct
  when the evidence fits several places.

Example: five cells with posterior `0.40, 0.30, 0.15, 0.10, 0.05`. The 50%
region is the first two cells (0.70 ≥ 0.50), the 80% region the first three,
and the 95% region the first four.

A single best point throws away the shape. Report the region, and the expected
error, not just the mode.

*Used:* AUDIO_FIELD.md §8.

---

## 6. Softmax, cross-entropy and soft labels

Turning scores `s_j` into probabilities over choices `j` is the softmax:

```
P(j) = exp(s_j) / Σ_k exp(s_k)
```

With log-likelihoods `(−3, −1, −2)`, this gives `(0.09, 0.67, 0.24)`. A softmax
over log-likelihoods is exactly Bayes with a uniform prior (§5).

**Cross-entropy** scores a predicted distribution `P` against a target `q`:
`CE = −Σ_j q_j log P_j`. With a one-hot target, it is `−log P(correct)`. With a
**soft** target — here `q_j ∝ exp(−d(true, j)²/2h²)` — a near miss earns partial
credit. That is right for geography, where answering with the next town is
almost right.

*Used:* AUDIO_FIELD.md §7.

---

## 7. Fitting by gradient

* **Autodiff.** PyTorch differentiates through Cholesky, triangular solves and
  log-determinants. The marginal likelihood is an ordinary differentiable
  function of the encoder weights, `α`, `γ`, `t`, `s²` and `ρ`, and Adam follows
  its gradient.
* **Log-parameters.** A variance must stay positive. Optimise `log s²` instead of
  `s²`: any real number is then valid, and the steps are multiplicative, which
  suits scale parameters.
* **Clamps** keep parameters where the matrices stay well-conditioned.
* **float64.** `(I + tL)⁻¹` and `K̃ + ρM⁻¹` with small `ρ` are ill-conditioned. In
  float32, the Cholesky factorisation fails or the log-determinant is noise.
* **Hold out by group.** When rows come in groups (recordings at a place),
  split the groups, not the rows. Otherwise the validation score measures
  recognising a place you trained on, not locating a new one.

*Used:* AUDIO_FIELD.md §6.4 and §7.

---

## 8. Proportions on the logit scale

A rate `π ∈ (0, 1)` lives on a bounded scale where Gaussian assumptions break
near the ends. The logit maps it to the whole real line:

```
logit π = log( π / (1 − π) )            σ(η) = 1 / (1 + e^(−η))    (its inverse)
```

For example, `π = 0.10` gives `logit = −2.20`. Model the logit as Gaussian, then
map results back with `σ`. Two consequences follow:

* `σ(mean of η)` is the **median** of the back-transformed rate, not its mean.
* A symmetric interval in `η` becomes an asymmetric one in `π`, which is what
  you want near 0 and 1.

*Used:* AUDIO_FIELD.md §9.

---

## 9. The sphere

* **Distance.** Use the great-circle distance (haversine), not Euclidean
  distance on lon/lat.

  ```
  a = sin²(Δφ/2) + cos φ₁ cos φ₂ sin²(Δλ/2),      d = 2R · asin(√a),      R = 6371 km
  ```

* **Cell area.** A cell of `Δλ × Δφ` degrees has area proportional to `cos φ`.
  A 1° cell at 60° latitude is half the area of one at the equator
  (`cos 60° = 0.5`). A prior over equal-angle cells must include `log cos φ`, or
  it over-weights the poles.
* **Averaging positions.** Averaging longitudes fails across ±180°: the mean of
  179° and −179° is 0°, on the other side of the world. Instead, convert to 3-D
  unit vectors, average them, and convert back.

*Used:* `geomath.py`; AUDIO_FIELD.md §3 and §8.

---

## 10. Phones as feature vectors

Distinctive features (Hayes 2009) describe each sound as values in
`{+, −, 0}` for about 28 binary properties: `voice`, `strident`, `round`, `high`
and so on. Encoded as `+1 / −1 / 0`, a phone is a point in `R^28`. This buys two
things:

* **Natural classes** become simple filters. `+strident, −voice` picks out
  `s, ʃ` and whatever else in the inventory matches.
* **Uncertainty averages meaningfully.** If a recogniser is unsure between
  [s] and [ʃ], the posterior-weighted feature vector is still `+strident, −voice`,
  differing only in the features where s and ʃ differ.

*Used:* `field/phonology.py`; AUDIO_FIELD.md §2.1 and §9; the `phonemescape`
library (`libs/phonemescape`).

---

## Reading list, in order

1. **Rasmussen & Williams, *Gaussian Processes for Machine Learning* (2006),
   ch. 2 and 5.** Prediction and marginal likelihood. Free online.
2. **Kondor & Lafferty, "Diffusion kernels on graphs and other discrete
   structures" (2002).** The heat kernel as a GP covariance.
3. **Smola & Kondor, "Kernels and regularization on graphs" (2003).** The
   regularised Laplacian and other spectral filters.
4. **Rue & Held, *Gaussian Markov Random Fields* (2005), ch. 2.** Precision
   matrices and conditioning on graphs.
5. **Spielman, *Spectral and Algebraic Graph Theory* (lecture notes).** The
   Laplacian's spectrum, from first principles.
6. **Hayes, *Introductory Phonology* (2009), ch. 4.** Distinctive features.
