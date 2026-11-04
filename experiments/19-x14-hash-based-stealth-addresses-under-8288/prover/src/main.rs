//! Experiment 19 (X14): prove one leanVM program on one input, verify it, and print what it cost.
//!
//! usage: x14-prover <program.py> <input.json> [repeat]
//!        x14-prover sphincs <seed hex> <message hex>   (a leanSPHINCS key, a signature, a verify)
//!
//! input.json: { "public": [[c0, c1], [c0, c1]], "witness": { name: [[[c0, c1], ...], ...] },
//!               "logInvRate": 1 }, every limb a hex string. One warm-up proof, then `repeat`
//! measured ones; the last is verified. Prints one JSON line: cycles, the tables' rows, proof
//! bytes (bincode, as leanVM's own CLI counts them), proving and verifying milliseconds, peak RSS.
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
            "signatureBytes": bytes.len(),
            "signatureKeccak": hex(&Keccak256::digest(bytes)),
            "keygenMs": keygen_ms, "signMs": sign_ms, "verifyMs": verify_ms,
            "verified": verified, "otherMessageVerified": other_verified,
        })
    );
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
    for (name, entries) in input["witness"].as_object().expect("witness streams") {
        let es: Vec<Vec<F192>> = entries.as_array().unwrap().iter().map(|e| e.as_array().unwrap().iter().map(cell).collect()).collect();
        program.set_witness(name.clone(), es);
    }
    let p = input["public"].as_array().expect("two public cells");
    let public = [cell(&p[0]), cell(&p[1])];
    let rate = input["logInvRate"].as_u64().unwrap_or(1) as usize;
    let mut ms = Vec::new();
    let mut last = None;
    for _ in 0..=repeat {
        let t = Instant::now();
        let out = prove(&program, public, rate).expect("a proof");
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
        })
    );
}
