//! Experiment 19 (X14): prove one leanVM program on one input, verify it, and print what it cost.
//!
//! usage: x14-prover <program.py> <input.json> [repeat]
//!        x14-prover sphincs <seed hex> <message hex>   (a leanSPHINCS key, a signature, a verify)
//!
//! input.json: { "public": [[c0, c1], [c0, c1]], "witness": { name: [[[c0, c1], ...], ...] },
//!               "sphincs": [{ "publicKey": hex, "signature": hex, "message": hex }, ...],
//!               "logInvRate": 1 }, every limb a hex string. Each `sphincs` entry is a leanSPHINCS
//!               signature the owner made (`x14-prover sphincs`), appended to the streams as
//!               leanVM's own host hints it, for version 2a's program to verify in circuit; the
//!               prover never holds a signing key. One warm-up proof, then `repeat`
//! measured ones; the last is verified. Prints one JSON line: cycles, the tables' rows, proof
//! bytes (bincode, as leanVM's own CLI counts them), proving and verifying milliseconds, peak RSS;
//! or, when the witness does not satisfy the program, `{"error": ...}` and exit status 2.
use std::{fs, time::Instant};

use leanvm_core::cpu::{prove, verify};
use primitives::field::F192;
use serde_json::{Value, json};

fn limb(v: &Value) -> u64 {
    u64::from_str_radix(v.as_str().expect("a hex limb").trim_start_matches("0x"), 16).expect("hex")
}
fn cell(v: &Value) -> F192 {
    let a = v.as_array().expect("a cell is [c0, c1]");
    F192::new(limb(&a[0]), limb(&a[1]), 0)
}

fn hex32(s: &str) -> [u8; 32] {
    let v: Vec<u8> = (0..32).map(|i| u8::from_str_radix(&s.trim_start_matches("0x")[2 * i..2 * i + 2], 16).expect("hex")).collect();
    v.try_into().expect("32 bytes")
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Version 3's signer: a leanSPHINCS key from a seed, one signature on a 32-byte message, and its
/// verification, with the sizes and times, and the signature's keccak so a record can name it.
fn sphincs(seed: &str, message: &str) {
    use sha3::{Digest, Keccak256};
    use signatures::lean_sphincs as sp;
    let t = Instant::now();
    let (sk, pk) = sp::key_gen_from_seed(hex32(seed));
    let keygen_ms = t.elapsed().as_secs_f64() * 1000.0;
    let msg = hex32(message);
    let t = Instant::now();
    let sig = sp::sign(&sk, &msg).expect("a signature");
    let sign_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    let verified = sp::verify(&pk, &msg, &sig).is_ok();
    let verify_ms = t.elapsed().as_secs_f64() * 1000.0;
    let mut other = msg;
    other[0] ^= 1;
    let other_verified = sp::verify(&pk, &other, &sig).is_ok();
    let bytes = sig.to_bytes();
    println!(
        "{}",
        json!({
            "publicKey": hex(&pk.to_bytes()),
            "signature": hex(&bytes),
            "signatureBytes": bytes.len(),
            "signatureKeccak": hex(&Keccak256::digest(bytes)),
            "keygenMs": keygen_ms, "signMs": sign_ms, "verifyMs": verify_ms,
            "verified": verified, "otherMessageVerified": other_verified,
        })
    );
}

/// One leanSPHINCS signature's witness, as leanVM's aggregation host builds it for the verifier
/// that programs/v2a_rules.py lifts from its guest: ported from `lean_sphincs_hints`,
/// `digit_hints`, `exponent_bytes` and `count` in crates/rec_aggregation/src/aggregation.rs at
/// 3cbac04 (MIT or Apache-2.0, copyright 2026 leanEthereum), with the same stream names and order.
mod sphincs_hints {
    use primitives::field::{F192, g_pow};
    use signatures::{lean_sphincs, lean_xmss};

    pub type SubHints = Vec<(&'static str, Vec<F192>)>;
    const DIGIT_GROUP: usize = 3;
    const LEAN_SPHINCS_TAIL_BITS: usize = lean_sphincs::DIGEST_BITS - 256;

    fn count(n: usize) -> F192 {
        F192::new(g_pow(n).0, 0, 0)
    }
    fn exponent_bytes(value: u64, bits: usize) -> Vec<F192> {
        (0..bits.div_ceil(8)).map(|k| count((value >> (8 * k) & 0xff) as usize)).collect()
    }
    pub fn pack_16_bytes(bytes: &[u8]) -> F192 {
        let word_at = |offset: usize| u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
        F192::new(word_at(0), word_at(8), 0)
    }
    fn digit_hints(codeword: &[u8]) -> impl Iterator<Item = Vec<F192>> + '_ {
        codeword.chunks(DIGIT_GROUP).map(|group| {
            let index = group.iter().rev().fold(0, |index, &digit| index * lean_xmss::CHAIN_LEN + digit as usize);
            vec![count(index)]
        })
    }
    pub fn lean_sphincs_hints(
        pk: &lean_sphincs::LeanSphincsPublicKey,
        sig: &lean_sphincs::LeanSphincsSignature,
        message: &lean_sphincs::Message,
    ) -> SubHints {
        let pp = pk.public_param();
        let mut hints: SubHints = vec![("sp_rand", vec![pack_16_bytes(sig.randomizer())])];
        let digest = lean_sphincs::message_digest_bytes(pp, sig.randomizer(), message);
        let (idx, leaves) = lean_sphincs::digest_fields(&digest);
        let lane = u64::from_le_bytes(digest[32..40].try_into().unwrap());
        hints.push(("sp_unused", exponent_bytes(lane >> LEAN_SPHINCS_TAIL_BITS, 64 - LEAN_SPHINCS_TAIL_BITS)));
        for tree in sig.fors() {
            hints.push(("sp_fors_secrets", vec![pack_16_bytes(tree.secret())]));
        }
        let ordered = |pair: &[lean_sphincs::Digest; 2]| vec![pack_16_bytes(&pair[0]), pack_16_bytes(&pair[1])];
        let fors_key = lean_sphincs::fors_recover(pp, idx, &leaves, sig.fors(), |pair| {
            hints.push(("sp_fors_nodes", ordered(pair)));
        });
        let mut signed = lean_sphincs::fors_key_bytes(&fors_key).to_vec();
        for (layer, layer_sig) in sig.layers().iter().enumerate() {
            let key = lean_sphincs::OtsKey::of_index(layer, idx);
            let Some((codeword, leaf)) = lean_sphincs::wots_leaf(pp, &key, &signed, layer_sig.counter(), layer_sig.wots()) else {
                println!("{}", serde_json::json!({ "error": "a signature that does not open at its message" }));
                std::process::exit(2);
            };
            hints.push(("sp_counter", exponent_bytes(u64::from(layer_sig.counter()), 32)));
            hints.extend(digit_hints(&codeword).map(|entry| ("digits", entry)));
            for value in layer_sig.wots() {
                hints.push(("chain_starts", vec![pack_16_bytes(value)]));
            }
            let root = lean_sphincs::tree_fold(pp, &key, leaf, sig.path(layer), |pair| {
                hints.push(("siblings", ordered(pair)));
            });
            signed = root.to_vec();
        }
        hints
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args[1] == "sphincs" {
        return sphincs(&args[2], &args[3]);
    }
    let src = fs::read_to_string(&args[1]).expect("the program");
    let input: Value = serde_json::from_str(&fs::read_to_string(&args[2]).expect("the input")).expect("JSON");
    let repeat: usize = args.get(3).map_or(1, |s| s.parse().expect("repeat"));
    let ast = lean_compiler::parse(&src).expect("the program parses");
    let mut program = lean_compiler::compile(&ast);
    let mut streams: Vec<(String, Vec<Vec<F192>>)> = Vec::new();
    let mut push = |name: &str, entry: Vec<F192>| match streams.iter_mut().find(|(n, _)| n == name) {
        Some((_, es)) => es.push(entry),
        None => streams.push((name.to_string(), vec![entry])),
    };
    for (name, entries) in input["witness"].as_object().expect("witness streams") {
        for e in entries.as_array().unwrap() {
            push(name, e.as_array().unwrap().iter().map(cell).collect());
        }
    }
    for s in input["sphincs"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        use signatures::lean_sphincs as sp;
        let bytes = |k: &str| -> Vec<u8> {
            let h = s[k].as_str().expect("hex").trim_start_matches("0x");
            (0..h.len() / 2).map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).expect("hex")).collect()
        };
        let pk = sp::LeanSphincsPublicKey::from_bytes(&bytes("publicKey").try_into().expect("a 32-byte key"));
        let sig = sp::LeanSphincsSignature::from_bytes(&bytes("signature").try_into().expect("a 7,740-byte signature"));
        let msg: sp::Message = bytes("message").try_into().expect("a 32-byte message");
        for (name, entry) in sphincs_hints::lean_sphincs_hints(&pk, &sig, &msg) {
            push(name, entry);
        }
    }
    for (name, entries) in streams {
        program.set_witness(name, entries);
    }
    let p = input["public"].as_array().expect("two public cells");
    let public = [cell(&p[0]), cell(&p[1])];
    let rate = input["logInvRate"].as_u64().unwrap_or(1) as usize;
    let mut ms = Vec::new();
    let mut last = None;
    for _ in 0..=repeat {
        let t = Instant::now();
        let out = match prove(&program, public, rate) {
            Ok(out) => out,
            Err(e) => {
                println!("{}", json!({ "error": format!("{e:?}") }));
                std::process::exit(2);
            }
        };
        ms.push(t.elapsed().as_secs_f64() * 1000.0);
        last = Some(out);
    }
    let (proof, stats) = last.unwrap();
    let t = Instant::now();
    let verified = verify(&program, &public, &proof).is_ok();
    let verify_ms = t.elapsed().as_secs_f64() * 1000.0;
    println!(
        "{}",
        json!({
            "cycles": stats.cycles,
            "details": stats.details(),
            "proofBytes": bincode::serialized_size(&proof).expect("serializable"),
            "proveMs": &ms[1..],
            "warmupMs": ms[0],
            "verifyMs": verify_ms,
            "verified": verified,
            "peakRssBytes": bench::peak_rss_bytes(),
            "logInvRate": rate,
            "bytecodeLen": program.prog.len(),
        })
    );
}
