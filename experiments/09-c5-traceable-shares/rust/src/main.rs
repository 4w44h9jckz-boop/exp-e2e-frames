// C5: a reconstruction box traced to the holders who built it.
//
// Shamir secret sharing over BN254's scalar field with a one-way key per holder, as the
// construction with non-imputability in ePrint 2024/405 gives it: holder i has a random point
// x_i, its share y_i = q(x_i), and its key component u_i = keccak256(x_i). The tracer holds the
// key (u_1, ..., u_n) and black-box access to a box; it never sees a share.
//
// Tracing, for a known coalition size f (the paper's Figure 4): N pairs of queries. Each pair is
// t - f - 1 random shares and one share at a random point x' whose value differs between the two
// queries by a random delta. If the box interpolates over the coalition's f shares and the
// query's t - f, its two answers differ by delta times the Lagrange weight of x', so
//     delta / (s' - s) * prod_i x_i / (x_i - x')
// is h(x') for h(X) = prod_j (x*_j - X) / x*_j, whose roots are the coalition's points. The
// evaluations are decoded (Berlekamp-Welch here, in place of the paper's list decoder), h's roots
// found (Cantor-Zassenhaus), and each root w kept if keccak256(w) is some u_i: the paper's Verify.
//
// Writes one JSON record (RECORD): the key, its Merkle root, each trace with its queries and
// evidence, the t-share holder's box, and the calldata of a slashing transaction and of one
// forged against an innocent holder. It holds no share, no secret and no coefficient.
use ark_bn254::Fr;
use ark_ff::{BigInteger, Field, One, PrimeField, UniformRand, Zero};
use ark_std::rand::{Rng, SeedableRng, rngs::StdRng};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::io::Read;
use std::time::Instant;
use tiny_keccak::{Hasher, Keccak};

type Poly = Vec<Fr>;

fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    let mut k = Keccak::v256();
    for p in parts {
        k.update(p);
    }
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    out
}

fn word(x: &Fr) -> [u8; 32] {
    let b = x.into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - b.len()..].copy_from_slice(&b);
    out
}

fn index_word(i: usize) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&(i as u64).to_be_bytes());
    out
}

fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

/// The key component of a holder at point x.
fn key_of(x: &Fr) -> [u8; 32] {
    keccak(&[&word(x)])
}

// ---- polynomials, coefficients from the constant term up ----

fn trim(mut p: Poly) -> Poly {
    while p.last().is_some_and(|c| c.is_zero()) {
        p.pop();
    }
    p
}

fn deg(p: &Poly) -> Option<usize> {
    if p.is_empty() { None } else { Some(p.len() - 1) }
}

fn eval(p: &Poly, x: &Fr) -> Fr {
    p.iter().rev().fold(Fr::zero(), |acc, c| acc * x + c)
}

fn sub(a: &Poly, b: &Poly) -> Poly {
    let mut out = vec![Fr::zero(); a.len().max(b.len())];
    for (i, c) in a.iter().enumerate() {
        out[i] += c;
    }
    for (i, c) in b.iter().enumerate() {
        out[i] -= c;
    }
    trim(out)
}

fn mul(a: &Poly, b: &Poly) -> Poly {
    if a.is_empty() || b.is_empty() {
        return vec![];
    }
    let mut out = vec![Fr::zero(); a.len() + b.len() - 1];
    for (i, x) in a.iter().enumerate() {
        for (j, y) in b.iter().enumerate() {
            out[i + j] += *x * y;
        }
    }
    trim(out)
}

fn divrem(a: &Poly, b: &Poly) -> (Poly, Poly) {
    let b = trim(b.clone());
    let db = deg(&b).expect("division by zero polynomial");
    let mut r = trim(a.clone());
    if r.len() < b.len() {
        return (vec![], r);
    }
    let inv = b[db].inverse().unwrap();
    let mut q = vec![Fr::zero(); r.len() - db];
    while let Some(dr) = deg(&r) {
        if dr < db {
            break;
        }
        let c = r[dr] * inv;
        q[dr - db] = c;
        for (i, bc) in b.iter().enumerate() {
            r[dr - db + i] -= c * bc;
        }
        r = trim(r);
    }
    (trim(q), r)
}

fn monic(p: Poly) -> Poly {
    let p = trim(p);
    match p.last() {
        None => p,
        Some(lead) => {
            let inv = lead.inverse().unwrap();
            p.iter().map(|c| *c * inv).collect()
        }
    }
}

fn gcd(a: &Poly, b: &Poly) -> Poly {
    let (mut a, mut b) = (trim(a.clone()), trim(b.clone()));
    while !b.is_empty() {
        let (_, r) = divrem(&a, &b);
        a = b;
        b = r;
    }
    monic(a)
}

/// base^e mod m, e given as big-endian bits.
fn powmod(base: &Poly, e: &[bool], m: &Poly) -> Poly {
    let base = divrem(base, m).1;
    let mut acc: Poly = vec![Fr::one()];
    for &bit in e {
        acc = divrem(&mul(&acc, &acc), m).1;
        if bit {
            acc = divrem(&mul(&acc, &base), m).1;
        }
    }
    acc
}

/// Every root in the field of p, which need not split.
fn roots(p: &Poly, rng: &mut StdRng) -> Vec<Fr> {
    let p = monic(p.clone());
    if deg(&p).unwrap_or(0) == 0 {
        return vec![];
    }
    let x: Poly = vec![Fr::zero(), Fr::one()];
    let modulus_bits = Fr::MODULUS.to_bits_be();
    // gcd(p, X^r - X): the product of p's distinct linear factors.
    let g = gcd(&p, &sub(&powmod(&x, &modulus_bits, &p), &x));
    let half: Vec<bool> = Fr::MODULUS_MINUS_ONE_DIV_TWO.to_bits_be();
    let mut out = vec![];
    let mut stack = vec![g];
    while let Some(g) = stack.pop() {
        match deg(&g) {
            None | Some(0) => {}
            Some(1) => out.push(-g[0] * g[1].inverse().unwrap()),
            Some(_) => loop {
                let a = Fr::rand(rng);
                let t = sub(&powmod(&vec![a, Fr::one()], &half, &g), &vec![Fr::one()]);
                let d = gcd(&g, &t);
                if let Some(dd) = deg(&d) {
                    if dd > 0 && dd < deg(&g).unwrap() {
                        let (q, _) = divrem(&g, &d);
                        stack.push(d);
                        stack.push(monic(q));
                        break;
                    }
                }
            },
        }
    }
    out
}

/// Solves A z = b over the field; any solution if there are several, None if there is none.
fn solve(mut a: Vec<Vec<Fr>>, mut b: Vec<Fr>, unknowns: usize) -> Option<Vec<Fr>> {
    let rows = a.len();
    let mut pivots = vec![];
    let mut r = 0;
    for c in 0..unknowns {
        let Some(p) = (r..rows).find(|&i| !a[i][c].is_zero()) else { continue };
        a.swap(r, p);
        b.swap(r, p);
        let inv = a[r][c].inverse().unwrap();
        for k in c..unknowns {
            a[r][k] *= inv;
        }
        b[r] *= inv;
        for i in 0..rows {
            if i != r && !a[i][c].is_zero() {
                let f = a[i][c];
                for k in c..unknowns {
                    let v = a[r][k];
                    a[i][k] -= f * v;
                }
                let v = b[r];
                b[i] -= f * v;
            }
        }
        pivots.push(c);
        r += 1;
        if r == rows {
            break;
        }
    }
    if (r..rows).any(|i| !b[i].is_zero()) {
        return None;
    }
    let mut z = vec![Fr::zero(); unknowns];
    for (row, &c) in pivots.iter().enumerate() {
        z[c] = b[row];
    }
    Some(z)
}

/// Berlekamp-Welch: the polynomial of degree at most k that agrees with all but at most
/// e = floor((m - k - 1) / 2) of the m points, if there is one.
fn berlekamp_welch(points: &[(Fr, Fr)], k: usize) -> Option<Poly> {
    let m = points.len();
    if m < k + 1 {
        return None;
    }
    let e = (m - k - 1) / 2;
    // Unknowns: E's coefficients 0..e (monic, so E_e = 1), then Q's 0..=e+k.
    let unknowns = e + (e + k + 1);
    let mut a = vec![];
    let mut b = vec![];
    for (x, y) in points {
        let mut row = vec![Fr::zero(); unknowns];
        let mut xp = Fr::one();
        for j in 0..e {
            row[j] = *y * xp;
            xp *= x;
        }
        // y x^e from E's leading term moves to the right-hand side.
        let rhs = -*y * xp;
        let mut xq = Fr::one();
        for j in 0..=(e + k) {
            row[e + j] = -xq;
            xq *= x;
        }
        a.push(row);
        b.push(rhs);
    }
    let z = solve(a, b, unknowns)?;
    let mut ep: Poly = z[..e].to_vec();
    ep.push(Fr::one());
    let qp = trim(z[e..].to_vec());
    let (p, r) = divrem(&qp, &ep);
    if !r.is_empty() || deg(&p).is_some_and(|d| d > k) {
        return None;
    }
    let agree = points.iter().filter(|(x, y)| eval(&p, x) == *y).count();
    (agree + e >= m).then_some(p)
}

/// Lagrange interpolation at zero.
fn at_zero(points: &[(Fr, Fr)]) -> Option<Fr> {
    let mut s = Fr::zero();
    for (j, (xj, yj)) in points.iter().enumerate() {
        let mut w = Fr::one();
        for (m, (xm, _)) in points.iter().enumerate() {
            if m != j {
                w *= *xm * (*xm - xj).inverse()?;
            }
        }
        s += w * yj;
    }
    Some(s)
}

// ---- boxes ----

enum Kind {
    /// Interpolates over its f shares and the t - f it is given, answering right with
    /// probability epsilon and with a random value otherwise.
    Coalition { epsilon: f64 },
    /// The same, but it holds the verification key and answers a random value whenever a point
    /// it is given is not some holder's.
    VkAware { keys: BTreeSet<[u8; 32]> },
    /// One holder of t shares: it answers the secret, whatever it is given.
    THolder,
}

struct Reconstructor {
    shares: Vec<(Fr, Fr)>,
    kind: Kind,
    rng: StdRng,
}

impl Reconstructor {
    fn answer(&mut self, given: &[(Fr, Fr)]) -> Fr {
        let mut all = self.shares.clone();
        all.extend_from_slice(given);
        match &self.kind {
            Kind::THolder => at_zero(&self.shares).unwrap(),
            Kind::Coalition { epsilon } => {
                if self.rng.r#gen::<f64>() < *epsilon {
                    at_zero(&all).unwrap_or_else(|| Fr::rand(&mut self.rng))
                } else {
                    Fr::rand(&mut self.rng)
                }
            }
            Kind::VkAware { keys } => {
                if given.iter().all(|(x, _)| keys.contains(&key_of(x))) {
                    at_zero(&all).unwrap_or_else(|| Fr::rand(&mut self.rng))
                } else {
                    Fr::rand(&mut self.rng)
                }
            }
        }
    }
}

struct Traced {
    queries: usize,
    evaluations: usize,
    decoded: bool,
    roots: usize,
    named: Option<Vec<(usize, Fr)>>,
    micros: u128,
}

/// The paper's tracing for a known f, with N pairs of queries.
fn trace(b: &mut Reconstructor, t: usize, f: usize, n_pairs: usize, keys: &[[u8; 32]], rng: &mut StdRng) -> Traced {
    let start = Instant::now();
    let mut points = vec![];
    let mut queries = 0;
    for _ in 0..n_pairs {
        let random: Vec<(Fr, Fr)> = (0..t - f - 1).map(|_| (Fr::rand(rng), Fr::rand(rng))).collect();
        let x1 = Fr::rand(rng);
        let y1 = Fr::rand(rng);
        let delta = loop {
            let d = Fr::rand(rng);
            if !d.is_zero() {
                break d;
            }
        };
        let mut q1 = random.clone();
        q1.push((x1, y1));
        let mut q2 = random.clone();
        q2.push((x1, y1 + delta));
        let s1 = b.answer(&q1);
        let s2 = b.answer(&q2);
        queries += 2;
        if s1 == s2 {
            continue;
        }
        let mut z = delta * (s2 - s1).inverse().unwrap();
        for (x, _) in &random {
            z *= *x * (*x - x1).inverse().unwrap();
        }
        points.push((x1, z));
    }
    let evaluations = points.len();
    let h = berlekamp_welch(&points, f);
    let decoded = h.is_some();
    let (n_roots, named) = match h {
        None => (0, None),
        Some(h) => {
            let rs = roots(&h, rng);
            let named: Vec<(usize, Fr)> = rs
                .iter()
                .filter_map(|w| keys.iter().position(|u| *u == key_of(w)).map(|i| (i, *w)))
                .collect();
            (rs.len(), if named.is_empty() { None } else { Some(named) })
        }
    };
    Traced { queries, evaluations, decoded, roots: n_roots, named, micros: start.elapsed().as_micros() }
}

// ---- the Merkle tree over (i, u_i) ----

struct Tree {
    levels: Vec<Vec<[u8; 32]>>,
}

impl Tree {
    fn new(keys: &[[u8; 32]]) -> Tree {
        let depth = (keys.len() as f64).log2().ceil().max(1.0) as u32;
        let mut level: Vec<[u8; 32]> =
            (0..1usize << depth).map(|i| if i < keys.len() { keccak(&[&index_word(i), &keys[i]]) } else { [0u8; 32] }).collect();
        let mut levels = vec![level.clone()];
        while level.len() > 1 {
            level = level.chunks(2).map(|c| keccak(&[&c[0], &c[1]])).collect();
            levels.push(level.clone());
        }
        Tree { levels }
    }
    fn root(&self) -> [u8; 32] {
        self.levels.last().unwrap()[0]
    }
    fn depth(&self) -> usize {
        self.levels.len() - 1
    }
    fn path(&self, i: usize) -> Vec<[u8; 32]> {
        (0..self.depth()).map(|d| self.levels[d][(i >> d) ^ 1]).collect()
    }
}

/// count || (i || w || path) for each convicted holder: the staking contract's calldata.
fn slash_calldata(tree: &Tree, evidence: &[(usize, Fr)]) -> Vec<u8> {
    let mut out = index_word(evidence.len()).to_vec();
    for (i, w) in evidence {
        out.extend_from_slice(&index_word(*i));
        out.extend_from_slice(&word(w));
        for s in tree.path(*i) {
            out.extend_from_slice(&s);
        }
    }
    out
}

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn main() {
    let n: usize = env("HOLDERS", "16").parse().unwrap();
    let t: usize = env("THRESHOLD", "7").parse().unwrap();
    let record = std::env::var("RECORD").expect("RECORD: where to write the record");
    let mut seed = [0u8; 32];
    std::fs::File::open("/dev/urandom").unwrap().read_exact(&mut seed).unwrap();
    let mut rng = StdRng::from_seed(seed);

    // The dealer: q of degree t - 1 with q(0) = s, a random distinct point for each holder.
    let q: Poly = (0..t).map(|_| Fr::rand(&mut rng)).collect();
    let s = q[0];
    let mut xs: Vec<Fr> = vec![];
    while xs.len() < n {
        let x = Fr::rand(&mut rng);
        if !x.is_zero() && !xs.contains(&x) {
            xs.push(x);
        }
    }
    let shares: Vec<(Fr, Fr)> = xs.iter().map(|x| (*x, eval(&q, x))).collect();
    let keys: Vec<[u8; 32]> = xs.iter().map(key_of).collect();
    let tree = Tree::new(&keys);

    // One innocent holder, outside every coalition, for the forged evidence.
    let innocent = rng.gen_range(0..n);
    let others: Vec<usize> = (0..n).filter(|i| *i != innocent).collect();
    let pick = |f: usize, rng: &mut StdRng| -> Vec<usize> {
        let mut pool = others.clone();
        let mut out = vec![];
        for _ in 0..f {
            out.push(pool.swap_remove(rng.gen_range(0..pool.len())));
        }
        out.sort();
        out
    };

    let plans: Vec<(&str, usize, Kind, usize)> = vec![
        ("perfect", t - 1, Kind::Coalition { epsilon: 1.0 }, t),
        ("smaller", (t - 1) / 2, Kind::Coalition { epsilon: 1.0 }, t),
        ("noisy", t - 1, Kind::Coalition { epsilon: 0.9 }, 64),
        ("vk-aware", t - 1, Kind::VkAware { keys: keys.iter().copied().collect() }, 64),
    ];
    let mut traces = vec![];
    let mut evidence_for_slash = None;
    for (label, f, kind, n_pairs) in plans {
        let coalition = pick(f, &mut rng);
        let epsilon = match &kind {
            Kind::Coalition { epsilon } => *epsilon,
            _ => 1.0,
        };
        let box_name = match &kind {
            Kind::Coalition { epsilon } if *epsilon < 1.0 => "noisy",
            Kind::Coalition { .. } => "coalition",
            Kind::VkAware { .. } => "vk-aware",
            Kind::THolder => unreachable!(),
        };
        let mut b = Reconstructor {
            shares: coalition.iter().map(|i| shares[*i]).collect(),
            kind,
            rng: StdRng::from_seed(rng.r#gen()),
        };
        // The buyer: t - f genuine shares from holders outside the coalition.
        let mut buyer_ok = 0;
        let buyer_trials = 20;
        for _ in 0..buyer_trials {
            let outside: Vec<usize> = (0..n).filter(|i| !coalition.contains(i)).collect();
            let mut pool = outside.clone();
            let given: Vec<(Fr, Fr)> =
                (0..t - f).map(|_| shares[pool.swap_remove(rng.gen_range(0..pool.len()))]).collect();
            if b.answer(&given) == s {
                buyer_ok += 1;
            }
        }
        let tr = trace(&mut b, t, f, n_pairs, &keys, &mut rng);
        let named: Option<Vec<usize>> = tr.named.as_ref().map(|v| {
            let mut ix: Vec<usize> = v.iter().map(|(i, _)| *i).collect();
            ix.sort();
            ix
        });
        let evidence: Vec<Value> = tr
            .named
            .iter()
            .flatten()
            .map(|(i, w)| {
                json!({ "i": i, "w": hex0x(&word(w)), "path": tree.path(*i).iter().map(|p| hex0x(p)).collect::<Vec<_>>() })
            })
            .collect();
        println!(
            "{label}: f {f}, N {n_pairs}, {} queries, {} evaluations, decoded {}, {} roots, named {:?} of {:?}, buyer {buyer_ok}/{buyer_trials}, {} ms",
            tr.queries,
            tr.evaluations,
            tr.decoded,
            tr.roots,
            named,
            coalition,
            tr.micros / 1000
        );
        if label == "perfect" {
            evidence_for_slash = tr.named.clone();
        }
        traces.push(json!({
            "label": label,
            "box": box_name,
            "f": f,
            "coalition": coalition,
            "epsilon": epsilon,
            "N": n_pairs,
            "queries": tr.queries,
            "evaluations": tr.evaluations,
            "decoded": tr.decoded,
            "roots": tr.roots,
            "named": named,
            "evidence": evidence,
            "buyer": { "trials": buyer_trials, "answeredTheSecret": buyer_ok },
            "traceMicros": tr.micros,
        }));
    }

    // One holder of t shares: its box needs no shares from anyone.
    let holder: Vec<usize> = pick(t, &mut rng);
    let mut tb = Reconstructor {
        shares: holder.iter().map(|i| shares[*i]).collect(),
        kind: Kind::THolder,
        rng: StdRng::from_seed(rng.r#gen()),
    };
    let mut answers = vec![];
    for _ in 0..8 {
        let f = t - 1;
        let given: Vec<(Fr, Fr)> = (0..t - f).map(|_| (Fr::rand(&mut rng), Fr::rand(&mut rng))).collect();
        answers.push(hex0x(&keccak(&[&word(&tb.answer(&given))])));
    }
    let tt = trace(&mut tb, t, t - 1, 64, &keys, &mut rng);
    println!("t-share holder: {} queries, {} evaluations, decoded {}, named {:?}", tt.queries, tt.evaluations, tt.decoded, tt.named.as_ref().map(|v| v.len()));

    let slash = evidence_for_slash.expect("the perfect box's trace named no one");
    let slash_data = slash_calldata(&tree, &slash);
    // A forger who does not know the innocent holder's point: a random w, the true path.
    let forged_data = slash_calldata(&tree, &[(innocent, Fr::rand(&mut rng))]);

    let out = json!({
        "scheme": {
            "construction": "Shamir secret sharing with non-imputability, ePrint 2024/405",
            "field": "BN254 scalar field",
            "modulus": hex0x(&Fr::MODULUS.to_bytes_be()),
            "oneWay": "keccak256 of the point as a 32-byte big-endian word",
            "decoder": "Berlekamp-Welch",
            "n": n,
            "t": t,
            "holders": keys.iter().enumerate().map(|(i, u)| json!({ "i": i, "u": hex0x(u) })).collect::<Vec<_>>(),
            "root": hex0x(&tree.root()),
            "depth": tree.depth(),
        },
        "traces": traces,
        "tHolder": {
            "holders": holder,
            "answers": answers,
            "answersAre": "keccak256 of each answer, for queries of random shares",
            "queries": tt.queries,
            "evaluations": tt.evaluations,
            "decoded": tt.decoded,
            "named": tt.named.map(|v| v.iter().map(|(i, _)| *i).collect::<Vec<_>>()),
        },
        "slash": { "trace": "perfect", "indices": slash.iter().map(|(i, _)| *i).collect::<Vec<_>>(), "calldata": hex0x(&slash_data) },
        "forged": { "innocent": innocent, "calldata": hex0x(&forged_data) },
    });
    std::fs::write(&record, serde_json::to_string_pretty(&out).unwrap()).unwrap();
}
