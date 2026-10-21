//! g5-shares: whether two REP3 members' input shares rebuild a value in the clear.
//!
//! ```text
//! g5-shares <share of member i> <share of member i+1 mod 3> <input name>
//! ```
//!
//! Member `i` holds `a = x_i` and `b = x_{i-1}` of the value `x_0 + x_1 + x_2`, so members `i` and
//! `i + 1` together hold all three parts. Prints the rebuilt value in decimal, and nothing else.

use std::{env, fs};

use anyhow::{Context, bail, ensure};
use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use co_circom_types::{Rep3InputType, Rep3SharedInput};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    ensure!(args.len() == 3, "usage: g5-shares <share i> <share i+1> <name>");
    let read = |p: &str| -> anyhow::Result<Rep3SharedInput<Fr>> { Ok(serde_json::from_slice(&fs::read(p)?)?) };
    let (si, sj) = (read(&args[0])?, read(&args[1])?);
    let pick = |s: &Rep3SharedInput<Fr>| -> anyhow::Result<_> {
        match s.get(&args[2]).with_context(|| format!("no input {}", args[2]))? {
            Rep3InputType::Shared(x) => Ok(*x),
            Rep3InputType::Public(_) => bail!("{} is public", args[2]),
        }
    };
    let (i, j) = (pick(&si)?, pick(&sj)?);
    ensure!(j.b == i.a, "the shares are not of consecutive members");
    let x = i.a + i.b + j.a;
    let be = x.into_bigint().to_bytes_be();
    let mut v = 0u128;
    for byte in &be[be.len() - 16..] {
        v = (v << 8) | *byte as u128;
    }
    ensure!(be[..be.len() - 16].iter().all(|b| *b == 0), "the value does not fit 128 bits");
    println!("{v}");
    Ok(())
}
