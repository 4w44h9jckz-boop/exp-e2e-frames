//! A three-party committee that proves the Tornado Cash withdrawal circuit with TACEO's
//! co-snarks, so that the proof is the one the wallet would have made: same proving key, same
//! verifier, unchanged.
//!
//! The circuit is circom v1 and its proving key is in the websnark format the wallet proves
//! with (`kohaku-tornadocash-circuit`). co-circom compiles circom 2, so the committee does not
//! extend the witness. The client does, as co-circom's own `split-witness` command expects, and
//! hands each member one replicated share of it ([`share_witness`]). The members then run
//! co-groth16's REP3 prover over that key, with [`WebsnarkReduction`] in place of co-groth16's
//! two reductions, because websnark's key carries the quotient's coefficients and neither of
//! those produces them.

use std::sync::atomic::{AtomicUsize, Ordering};

use ark_bn254::{Bn254, Fr, G1Affine, G2Affine};
use ark_ec::pairing::Pairing;
use ark_ff::{BigInteger, Field, PrimeField};
use ark_groth16::{PreparedVerifyingKey, Proof, ProvingKey, VerifyingKey};
use co_circom_types::{CompressedRep3SharedWitness, Compression, Rep3SharedWitness, SharedWitness};
use co_groth16::{CircomGroth16Prover, ConstraintMatrices, R1CSToQAP, Rep3CoGroth16};
use mpc_core::MpcState;
use mpc_net::{ConnectionStats, Network};
use rand::{CryptoRng, Rng};
use taceo_ark_algebra::fft::{Domain, bit_reverse};

/// The number of committee members. REP3 is three parties, secure against one semi-honest one.
pub const MEMBERS: usize = 3;

const VERIFICATION_KEY_BR: &[u8] = include_bytes!("../data/verification_key.bin.br");

/// The withdrawal circuit's proving key, in the shapes co-groth16 takes.
pub struct WithdrawKey {
    /// websnark's A, B and C queries and its quotient bases, as an arkworks key.
    pub pk: ProvingKey<Bn254>,
    /// websnark's `polsA` and `polsB` as rows of the evaluation domain: row `j` holds the
    /// coefficients of every variable at the domain's `j`-th point. `C` is empty: websnark's
    /// quotient needs only `A` and `B`.
    pub matrices: ConstraintMatrices<Fr>,
    /// The size of websnark's evaluation domain.
    pub domain_size: usize,
}

impl WithdrawKey {
    /// The key the wallet proves with, from `kohaku-tornadocash-circuit`'s embedded artifacts.
    pub fn load() -> Self {
        Self::from_websnark(kohaku_tornadocash_circuit::artifacts::proving_key(), &verifying_key())
    }

    /// Maps websnark's key onto arkworks'. websnark computes
    /// `C = sum_{i > nPublic} w_i C_i + sum_j h_j hExps_j + s A + r B1 - rs delta`, which is
    /// arkworks' `C` with `l_query = C[nPublic + 1..]` and `h_query = hExps`. `A` and `B` keep
    /// every variable, the constant `1` at index 0 included, as arkworks' queries do.
    pub fn from_websnark(pk: &websnark_rs::proving_key::ProvingKey, vk: &VerifyingKey<Bn254>) -> Self {
        let n_inst = pk.n_public + 1;
        let m = pk.domain_size;
        let mut a = vec![Vec::new(); m];
        let mut b = vec![Vec::new(); m];
        for (var, pol) in pk.pols_a.iter().enumerate() {
            for (&row, &coeff) in pol {
                a[row].push((coeff, var));
            }
        }
        for (var, pol) in pk.pols_b.iter().enumerate() {
            for (&row, &coeff) in pol {
                b[row].push((coeff, var));
            }
        }
        for row in a.iter_mut().chain(b.iter_mut()) {
            row.sort_by_key(|&(_, var)| var);
        }
        let a_num_non_zero = a.iter().map(Vec::len).sum();
        let b_num_non_zero = b.iter().map(Vec::len).sum();
        let matrices = ConstraintMatrices {
            num_instance_variables: n_inst,
            num_witness_variables: pk.n_vars - n_inst,
            num_constraints: m,
            a_num_non_zero,
            b_num_non_zero,
            c_num_non_zero: 0,
            a,
            b,
            c: vec![Vec::new(); m],
        };
        let pk = ProvingKey {
            vk: vk.clone(),
            beta_g1: pk.vk_beta_g1,
            delta_g1: pk.vk_delta_g1,
            a_query: pk.a.clone(),
            b_g1_query: pk.b_g1.clone(),
            b_g2_query: pk.b_g2.clone(),
            h_query: pk.h_exps.clone(),
            l_query: pk.c[n_inst..pk.n_vars].to_vec(),
        };
        Self { pk, matrices, domain_size: m }
    }

    /// The number of public values the circuit takes, with the constant `1` first.
    pub fn num_instance_variables(&self) -> usize {
        self.matrices.num_instance_variables
    }
}

/// The verifying key the pool's verifier holds, from `kohaku-tornadocash-circuit`'s data
/// (`data/verification_key.bin.br`, copied byte for byte from that crate at the pinned commit).
pub fn verifying_key() -> VerifyingKey<Bn254> {
    let mut raw = Vec::new();
    brotli::BrotliDecompress(&mut &VERIFICATION_KEY_BR[..], &mut raw).expect("embedded key is brotli");
    let vk: websnark_rs::verifying_key::VerifyingKey =
        postcard::from_bytes(&raw).expect("embedded key is a websnark verifying key");
    VerifyingKey {
        alpha_g1: vk.alpha,
        beta_g2: vk.beta,
        gamma_g2: vk.gamma,
        delta_g2: vk.delta,
        gamma_abc_g1: vk.ic,
    }
}

/// Checks a proof against the pool's verifying key and the six public inputs, in the circuit's
/// order: root, nullifier hash, recipient, relayer, fee, refund.
pub fn verify(proof: &Proof<Bn254>, public_inputs: &[Fr]) -> bool {
    let pvk = PreparedVerifyingKey::from(verifying_key());
    ark_groth16::Groth16::<Bn254>::verify_proof(&pvk, proof, public_inputs).unwrap_or(false)
}

/// The full witness of the withdrawal circuit, extended by the client from its inputs with
/// websnark, as the wallet does before it proves. Index 0 is the constant `1`, then the six
/// public inputs, then every private signal.
pub fn extend_witness(inputs: &kohaku_tornadocash_circuit::CircuitInputs) -> anyhow::Result<Vec<Fr>> {
    let signals = inputs.as_signals()?;
    let witness = kohaku_tornadocash_circuit::artifacts::circuit()
        .witness(signals)
        .map_err(|e| anyhow::anyhow!("witness: {e}"))?;
    Ok(witness.to_vec())
}

/// Splits a full witness into the three members' shares: REP3 replicated shares of every
/// private value, the public values in the clear. Each share is co-circom's own `split-witness`
/// output, a `CompressedRep3SharedWitness<ark_bn254::Fr>` serialized with bincode 1, so the
/// shares a client makes here and the ones `co-circom split-witness` makes are read the same
/// way by a member.
pub fn share_witness<R: Rng + CryptoRng>(
    witness: &[Fr],
    num_instance_variables: usize,
    compression: Compression,
    rng: &mut R,
) -> anyhow::Result<[Vec<u8>; MEMBERS]> {
    let witness = circom_types::Witness { values: witness.to_vec() };
    let shares =
        CompressedRep3SharedWitness::share_rep3(witness, num_instance_variables, rng, compression);
    let mut out: [Vec<u8>; MEMBERS] = Default::default();
    for (slot, share) in out.iter_mut().zip(shares.iter()) {
        *slot = bincode::serialize(share)?;
    }
    Ok(out)
}

/// Reads one member's share, in the format [`share_witness`] writes. A replicated share is
/// taken as it is, and a seeded one is expanded locally. An additive (half) share is refused:
/// replicating it would add a round between the members, which the format leaves out.
pub fn read_share(bytes: &[u8]) -> anyhow::Result<Rep3SharedWitness<Fr>> {
    use mpc_core::protocols::rep3::Rep3ShareVecType;
    let share: CompressedRep3SharedWitness<Fr> = bincode::deserialize(bytes)?;
    let witness = match share.witness {
        Rep3ShareVecType::Replicated(w) => w,
        Rep3ShareVecType::SeededReplicated(seeded) => {
            seeded.expand_vec().map_err(|e| anyhow::anyhow!("seeded share: {e}"))?
        }
        Rep3ShareVecType::Additive(_) | Rep3ShareVecType::SeededAdditive(_) => {
            anyhow::bail!("an additive share needs a resharing round; send a replicated one")
        }
    };
    Ok(SharedWitness { public_inputs: share.public_inputs, witness })
}

/// The recipient's index among a shared witness's public inputs, the constant `1` at index 0
/// included.
pub const RECIPIENT: usize = 3;
/// The full-witness index of the circuit's `recipient * recipient` wire: the one private value
/// the recipient changes (`tests::the_recipient_moves_one_private_wire`).
pub const RECIPIENT_SQUARE: usize = 28_296;

/// Sets the recipient of member `id`'s shared witness to `recipient`: the public input in the
/// clear, and its square, the one private wire it changes, as a trivial share of that public
/// value. Every member sets the same recipient, each with its own id, so a committee can bind its
/// proof to data chosen after the witness was shared, without learning anything private.
pub fn set_recipient(share: &mut Rep3SharedWitness<Fr>, id: usize, recipient: Fr) -> anyhow::Result<()> {
    use mpc_core::protocols::rep3::{Rep3PrimeFieldShare, id::PartyID};
    let party = PartyID::try_from(id).map_err(|e| anyhow::anyhow!("member id: {e:?}"))?;
    let n = share.public_inputs.len();
    anyhow::ensure!(n > RECIPIENT && RECIPIENT_SQUARE >= n, "not the withdrawal circuit's witness");
    let wire = share
        .witness
        .get_mut(RECIPIENT_SQUARE - n)
        .ok_or_else(|| anyhow::anyhow!("not the withdrawal circuit's witness"))?;
    share.public_inputs[RECIPIENT] = recipient;
    *wire = Rep3PrimeFieldShare::promote_from_trivial(&(recipient * recipient), party);
    Ok(())
}

/// One member's part of the proof: all three members call this at once over `net`, each with
/// its own share, and all three return the same proof.
pub fn prove<N: Network>(
    net: &N,
    key: &WithdrawKey,
    share: Rep3SharedWitness<Fr>,
) -> anyhow::Result<Proof<Bn254>> {
    Rep3CoGroth16::<Bn254>::prove::<N, WebsnarkReduction>(net, &key.pk, &key.matrices, share)
        .map_err(|e| anyhow::anyhow!("co-groth16: {e:?}"))
}

/// The proof as the pool's verifier takes it: eight 32-byte words, `B`'s coordinates in the
/// order Solidity's pairing precompile reads them, as `kohaku-tornadocash` encodes it.
pub fn solidity_proof(proof: &Proof<Bn254>) -> [u8; 256] {
    let a: G1Affine = proof.a;
    let b: G2Affine = proof.b;
    let c: G1Affine = proof.c;
    let words = [a.x, a.y, b.x.c1, b.x.c0, b.y.c1, b.y.c0, c.x, c.y];
    let mut out = [0u8; 256];
    for (chunk, w) in out.chunks_mut(32).zip(words) {
        let bytes = w.into_bigint().to_bytes_be();
        chunk[32 - bytes.len()..].copy_from_slice(&bytes);
    }
    out
}

/// The witness map websnark's key expects: the coefficients of `H = (A B - C) / Z`, the upper
/// half of the coefficients of `A B` over the domain of twice the size.
///
/// websnark evaluates `A` and `B` over the domain of size `m` (whose rows already hold the
/// public inputs' rows), moves them onto the coset shifted by the generator of the domain of
/// size `2m`, multiplies pointwise on both, and interpolates `A B` over the domain of size
/// `2m`. `C` has degree below `m`, so the upper `m` coefficients of `A B` are `H`'s. Its domain's
/// generator is snarkjs' first one: `7^((r - 1) / 2^28)`, not arkworks' `5^((r - 1) / 2^28)`.
///
/// Every step is linear in the shares except the pointwise products, which co-groth16's
/// `local_mul_vec` turns into additive half shares with no communication, as its own two
/// reductions do.
pub struct WebsnarkReduction;

/// The generator of the multiplicative subgroup of size `2^log` that websnark's domains use.
pub fn websnark_root_of_unity(log: u32) -> Fr {
    let two_adic_root = Fr::from(7u64).pow(<Fr as PrimeField>::TRACE);
    two_adic_root.pow([1u64 << (<Fr as ark_ff::FftField>::TWO_ADICITY - log)])
}

fn bit_reversed_powers(base: Fr, size: usize) -> Vec<Fr> {
    let mut table = taceo_ark_algebra::fft::powers(base, size);
    bit_reverse(&mut table);
    table
}

impl R1CSToQAP for WebsnarkReduction {
    fn witness_map_from_matrices<P: Pairing, T: CircomGroth16Prover<P>>(
        state: &mut T::State,
        matrices: &ConstraintMatrices<P::ScalarField>,
        public_inputs: &[P::ScalarField],
        private_witness: &[T::ArithmeticShare],
    ) -> eyre::Result<Vec<T::ArithmeticHalfShare>> {
        // The reduction is written for BN254's scalar field, websnark's only field.
        if std::any::TypeId::of::<P::ScalarField>() != std::any::TypeId::of::<Fr>() {
            eyre::bail!("websnark's witness map is defined over BN254 only");
        }
        let cast = |x: Fr| -> P::ScalarField {
            P::ScalarField::from_le_bytes_mod_order(&x.into_bigint().to_bytes_le())
        };
        let m = matrices.num_constraints;
        if !m.is_power_of_two() {
            eyre::bail!("websnark's domain size is a power of two, got {m}");
        }
        let log = m.ilog2();
        let gen_m = cast(websnark_root_of_unity(log));
        let gen_2m_fr = websnark_root_of_unity(log + 1);
        let gen_2m = cast(gen_2m_fr);
        let domain_m = Domain::with_group_gen(m, gen_m).ok_or_else(|| eyre::eyre!("domain m"))?;
        let domain_2m =
            Domain::with_group_gen(2 * m, gen_2m).ok_or_else(|| eyre::eyre!("domain 2m"))?;
        let coset_table: Vec<P::ScalarField> =
            bit_reversed_powers(gen_2m_fr, m).into_iter().map(cast).collect();

        let id = state.id();
        let eval = |matrix: &[Vec<(P::ScalarField, usize)>]| -> Vec<T::ArithmeticShare> {
            matrix
                .iter()
                .map(|row| T::evaluate_constraint(id, row, public_inputs, private_witness))
                .collect()
        };
        let a_sub = eval(&matrices.a);
        let b_sub = eval(&matrices.b);

        let to_coset = |values: &[T::ArithmeticShare]| {
            let mut v = values.to_vec();
            domain_m.ifft_in_to_out(&mut v);
            T::distribute_powers_and_mul_by_const(&mut v, &coset_table);
            domain_m.fft_out_to_in(&mut v);
            v
        };
        let a_coset = to_coset(&a_sub);
        let b_coset = to_coset(&b_sub);

        let ab_sub = T::local_mul_vec(a_sub, b_sub, state);
        let ab_coset = T::local_mul_vec(a_coset, b_coset, state);

        let mut ab = Vec::with_capacity(2 * m);
        for (s, c) in ab_sub.into_iter().zip(ab_coset) {
            ab.push(s);
            ab.push(c);
        }
        domain_2m.ifft_in_to_out(&mut ab);
        bit_reverse(&mut ab);
        // A and B have degree below m, so A B has none at x^(2m-1): H has m - 1 coefficients,
        // as many as websnark's key has quotient bases.
        let mut h = ab.split_off(m);
        h.truncate(m - 1);
        Ok(h)
    }
}

/// A network that counts what one member sends and receives, per peer: messages and bytes.
/// A message is one `send`; the protocol's rounds are the sends to one peer.
pub struct Counted<N> {
    inner: N,
    sent_msgs: [AtomicUsize; MEMBERS],
    recv_msgs: [AtomicUsize; MEMBERS],
}

impl<N: Network> Counted<N> {
    pub fn new(inner: N) -> Self {
        Self { inner, sent_msgs: Default::default(), recv_msgs: Default::default() }
    }

    /// Messages sent to and received from each peer, in party order.
    pub fn messages(&self) -> [(usize, usize); MEMBERS] {
        std::array::from_fn(|i| {
            (self.sent_msgs[i].load(Ordering::Relaxed), self.recv_msgs[i].load(Ordering::Relaxed))
        })
    }

    pub fn inner(&self) -> &N {
        &self.inner
    }
}

impl<N: Network> Network for Counted<N> {
    fn id(&self) -> usize {
        self.inner.id()
    }

    fn send(&self, to: usize, data: bytes::Bytes) -> eyre::Result<()> {
        self.sent_msgs[to].fetch_add(1, Ordering::Relaxed);
        self.inner.send(to, data)
    }

    fn recv(&self, from: usize) -> eyre::Result<bytes::Bytes> {
        self.recv_msgs[from].fetch_add(1, Ordering::Relaxed);
        self.inner.recv(from)
    }

    fn flush(&self) -> eyre::Result<()> {
        self.inner.flush()
    }

    fn get_connection_stats(&self) -> ConnectionStats {
        self.inner.get_connection_stats()
    }
}

/// The circuit's inputs for spending `note` from a pool whose tree holds `leaves`, built as
/// `kohaku-tornadocash`'s `Withdrawal::prove` builds them before it proves alone.
pub fn circuit_inputs(
    note: &kohaku_tornadocash::Note,
    leaves: &[kohaku_tornadocash::Field],
    recipient: ruint::aliases::U256,
    relayer: ruint::aliases::U256,
    fee: ruint::aliases::U256,
    refund: ruint::aliases::U256,
) -> anyhow::Result<kohaku_tornadocash_circuit::CircuitInputs> {
    use kohaku_tornadocash::merkle_tree::MerkleTree;
    use ruint::aliases::U256;
    let commitment = note.commitment();
    let index = leaves
        .iter()
        .position(|l| *l == commitment)
        .ok_or_else(|| anyhow::anyhow!("the note's commitment is not among the leaves"))?;
    let tree = MerkleTree::from_leaves(leaves)?;
    let proof = tree.proof(index)?;
    let siblings = proof.sibling_paths();
    Ok(kohaku_tornadocash_circuit::CircuitInputs::new(
        proof.root.into(),
        note.nullifier_hash().into(),
        recipient,
        relayer,
        fee,
        refund,
        note.nullifier.into(),
        note.secret.into(),
        std::array::from_fn(|i| siblings[i].into()),
        std::array::from_fn(|i| U256::from(proof.path[i])),
    ))
}

/// Field elements for the six public inputs, from the full witness.
pub fn public_inputs(witness: &[Fr], num_instance_variables: usize) -> Vec<Fr> {
    witness[1..num_instance_variables].to_vec()
}

#[cfg(test)]
mod tests;
