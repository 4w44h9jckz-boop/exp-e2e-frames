//! Experiment 26 (X19): the constants the transfer program is instantiated with, from leanVM's own
//! field arithmetic at its pin, so the host never re-implements GF(2^192).
//!
//! usage: x19-tool tables
//!
//! Prints one JSON line:
//! - `gpow`: g^v for v = 0..255, g leanVM's generator of GF(2^64)^*, each a hex limb, as the
//!   program's `bytes` stream carries a byte;
//! - `hpow`: HGEN^(v 256^p) for p = 0..7 and v = 0..255, each [c0, c1, c2] in decimal, HGEN = 7 + 8Y,
//!   the primitive element of GF(2^192)^* that exp-frames experiment 41's program uses and pins;
//! - `yInv`: Y^-1, [c0, c1, c2] in decimal, for splitting a cell into its limbs;
//! - `checks`: HGEN^(2^64) computed two ways, and g^256's distinctness from 1, so a record can
//!   show the tables were built consistently.
use primitives::field::{F192, g_pow};
use serde_json::json;

const HGEN: F192 = F192::new(7, 8, 0);

fn pow(mut b: F192, mut e: u128) -> F192 {
    let mut r = F192::ONE;
    while e > 0 {
        if e & 1 == 1 {
            r *= b;
        }
        b = b * b;
        e >>= 1;
    }
    r
}

fn lit(f: F192) -> [String; 3] {
    [f.c0.to_string(), f.c1.to_string(), f.c2.to_string()]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("tables") {
        eprintln!("usage: x19-tool tables");
        std::process::exit(2);
    }
    let gpow: Vec<String> = (0..256).map(|v| format!("{:x}", g_pow(v).0)).collect();
    let hpow: Vec<[String; 3]> = (0..8u32)
        .flat_map(|p| (0..256u128).map(move |v| lit(pow(HGEN, v << (8 * p)))))
        .collect();
    let y_inv = F192::new(0, 1, 0).inv();
    // HGEN^(2^64) as (HGEN^(2^56))^256, against the direct power.
    let via = pow(pow(HGEN, 1u128 << 56), 256);
    let direct = pow(HGEN, 1u128 << 64);
    println!(
        "{}",
        json!({
            "gpow": gpow,
            "hpow": hpow,
            "yInv": lit(y_inv),
            "checks": { "hgen2to64Agree": via == direct, "gTo256IsNotOne": g_pow(256).0 != 1 },
        })
    );
}
