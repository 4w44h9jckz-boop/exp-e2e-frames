use super::*;
use co_groth16::{Groth16, PlainGroth16Driver};
use kohaku_tornadocash::Note;
use mpc_net::local::LocalNetwork;
use rand::{RngCore, SeedableRng, rngs::StdRng};
use ruint::aliases::U256;

fn note(rng: &mut StdRng) -> Note {
    let mut n = [0u8; 31];
    let mut s = [0u8; 31];
    rng.fill_bytes(&mut n);
    rng.fill_bytes(&mut s);
    Note::new(n, s)
}

/// A full witness for a note in a tree of three leaves, with a relayer, fee and refund set so
/// every public input is non-zero.
fn witness(rng: &mut StdRng) -> Vec<Fr> {
    let notes = [note(rng), note(rng), note(rng)];
    let leaves: Vec<_> = notes.iter().map(Note::commitment).collect();
    let inputs = circuit_inputs(
        &notes[1],
        &leaves,
        U256::from(0xe196u64),
        U256::from(0xbaf9u64),
        U256::from(150_658_200_000_000u64),
        U256::from(7u64),
    )
    .unwrap();
    extend_witness(&inputs).unwrap()
}

#[test]
fn websnark_root_matches_its_field() {
    // websnark's FrSnarkjs has 7 as its generator; its 2^28-th root of unity is 7^t.
    let w = websnark_root_of_unity(28);
    assert_eq!(w.pow([1u64 << 28]), Fr::from(1u64));
    assert_ne!(w.pow([1u64 << 27]), Fr::from(1u64));
}

#[test]
fn the_wallets_own_proof_verifies_here() {
    let mut rng = StdRng::seed_from_u64(1);
    let key = WithdrawKey::load();
    let w = witness(&mut rng);
    let (proof, public) = websnark_rs::proof::prove(
        kohaku_tornadocash_circuit::artifacts::proving_key(),
        &websnark_rs::circuit::Witness::new(w.clone()),
        Fr::from(3u64),
        Fr::from(5u64),
    )
    .unwrap();
    assert_eq!(public, public_inputs(&w, key.num_instance_variables()));
    let proof = Proof { a: proof.a, b: proof.b, c: proof.c };
    assert!(verify(&proof, &public));
}

#[test]
fn the_reduction_matches_websnark_in_the_clear() {
    let mut rng = StdRng::seed_from_u64(2);
    let key = WithdrawKey::load();
    let w = witness(&mut rng);
    let n = key.num_instance_variables();
    let shared = SharedWitness { public_inputs: w[..n].to_vec(), witness: w[n..].to_vec() };
    let proof = Groth16::<Bn254>::plain_prove::<WebsnarkReduction>(&key.pk, &key.matrices, shared)
        .unwrap();
    assert!(verify(&proof, &public_inputs(&w, n)));
    let _ = PlainGroth16Driver;
}

#[test]
fn three_members_prove_what_the_verifier_accepts() {
    let mut rng = StdRng::seed_from_u64(3);
    let key = WithdrawKey::load();
    let w = witness(&mut rng);
    let n = key.num_instance_variables();
    for compression in [Compression::None, Compression::SeededShares] {
        let shares = share_witness(&w, n, compression, &mut rng).unwrap();
        let nets = LocalNetwork::new(MEMBERS);
        let proofs: Vec<_> = std::thread::scope(|s| {
            let handles: Vec<_> = nets
                .into_iter()
                .zip(shares.iter())
                .map(|(net, share)| {
                    let key = &key;
                    s.spawn(move || prove(&net, key, read_share(share).unwrap()).unwrap())
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(proofs.windows(2).all(|p| p[0] == p[1]));
        assert!(verify(&proofs[0], &public_inputs(&w, n)));
    }
}

#[test]
fn a_share_holds_no_private_value_in_the_clear() {
    let mut rng = StdRng::seed_from_u64(4);
    let key = WithdrawKey::load();
    let w = witness(&mut rng);
    let n = key.num_instance_variables();
    let shares = share_witness(&w, n, Compression::None, &mut rng).unwrap();
    for share in &shares {
        let s = read_share(share).unwrap();
        assert_eq!(s.public_inputs, w[..n].to_vec());
        // Each member holds two random-looking additive parts; neither is the value itself for
        // the note's secret material (indices past the public inputs that are not 0 or 1).
        let leaks = s
            .witness
            .iter()
            .zip(&w[n..])
            .filter(|(sh, v)| **v != Fr::from(0u64) && **v != Fr::from(1u64) && (sh.a == **v || sh.b == **v))
            .count();
        assert_eq!(leaks, 0);
    }
}

#[test]
fn a_proof_for_other_public_inputs_is_refused() {
    let mut rng = StdRng::seed_from_u64(5);
    let key = WithdrawKey::load();
    let w = witness(&mut rng);
    let n = key.num_instance_variables();
    let shared = SharedWitness { public_inputs: w[..n].to_vec(), witness: w[n..].to_vec() };
    let proof = Groth16::<Bn254>::plain_prove::<WebsnarkReduction>(&key.pk, &key.matrices, shared)
        .unwrap();
    let mut public = public_inputs(&w, n);
    public[2] += Fr::from(1u64);
    assert!(!verify(&proof, &public));
}

#[test]
fn the_keys_shape() {
    let key = WithdrawKey::load();
    assert_eq!(key.num_instance_variables(), 7);
    assert_eq!(key.pk.h_query.len(), key.domain_size - 1);
    println!("witness values {}, private {}, domain {}", key.matrices.num_instance_variables + key.matrices.num_witness_variables, key.matrices.num_witness_variables, key.domain_size);
}
