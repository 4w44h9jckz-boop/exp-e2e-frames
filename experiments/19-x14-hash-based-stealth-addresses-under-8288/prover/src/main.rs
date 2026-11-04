//! Experiment 19 (X14): prove one leanVM program on one input, verify it, and print what it cost.
//!
//! usage: x14-prover <program.py> <input.json> [repeat]
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

fn main() {
    let args: Vec<String> = std::env::args().collect();
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
