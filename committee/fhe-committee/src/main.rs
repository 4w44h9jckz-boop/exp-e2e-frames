//! `fhe-committee`: the FHE half's command line.
//!
//! - `setup`: the key set, the CRS and the members' shares (`public/`, `members/`).
//! - `encrypt`: the client: one value, proven, bound to the metadata (the input format).
//! - `verify-input`: checks an input's proof alone.
//! - `evaluate`: the coprocessor: checks the proof and computes on the input.
//! - `decrypt`: every member's share, in memory: the value and what each member sent.

use std::path::PathBuf;

use aes_prng::AesRng;
use anyhow::Result;
use clap::{Parser, Subcommand};
use fhe_committee::{
    decrypt, encrypt, evaluate, read_public, setup, verify_input, write_public, Op, EXTENSION_DEGREE, MEMBERS,
};
use rand::SeedableRng;
use threshold_fhe::execution::endpoints::keygen::PrivateKeySet;

#[derive(Parser)]
#[command(about = "The FHE half of a fixed committee: threshold TFHE decryption and a coprocessor")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Write `public/` (compact_public_key.bin, crs.bin, keys.bin) and `members/member-<i>.bin`
    Setup {
        #[arg(long)]
        out: PathBuf,
    },
    Encrypt {
        #[arg(long)]
        public: PathBuf,
        #[arg(long)]
        value: u64,
        /// Hex, the bytes the proof is bound to
        #[arg(long)]
        metadata: String,
        #[arg(long)]
        out: PathBuf,
    },
    VerifyInput {
        #[arg(long)]
        public: PathBuf,
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        metadata: String,
    },
    Evaluate {
        #[arg(long)]
        public: PathBuf,
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        metadata: String,
        /// Add this constant
        #[arg(long, conflicts_with = "mul")]
        add: Option<u64>,
        /// Multiply by this constant
        #[arg(long)]
        mul: Option<u64>,
        #[arg(long)]
        out: PathBuf,
    },
    Decrypt {
        #[arg(long)]
        public: PathBuf,
        #[arg(long)]
        members: PathBuf,
        #[arg(long)]
        result: PathBuf,
        #[arg(long)]
        out: PathBuf,
    },
}

fn unhex(s: &str) -> Result<Vec<u8>> {
    Ok(hex::decode(s.trim_start_matches("0x"))?)
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Setup { out } => {
            let (public, shares) = setup(&mut AesRng::from_entropy())?;
            write_public(&public, &out.join("public"))?;
            std::fs::create_dir_all(out.join("members"))?;
            for (i, s) in shares.iter().enumerate() {
                std::fs::write(out.join("members").join(format!("member-{i}.bin")), bincode::serialize(s)?)?;
            }
            Ok(())
        }
        Cmd::Encrypt { public, value, metadata, out } => {
            let public = read_public(&public)?;
            std::fs::write(out, encrypt(&public, value, &unhex(&metadata)?)?)?;
            Ok(())
        }
        Cmd::VerifyInput { public, input, metadata } => {
            let ok = verify_input(&read_public(&public)?, &std::fs::read(input)?, &unhex(&metadata)?)?;
            println!("{}", if ok { "valid" } else { "invalid" });
            anyhow::ensure!(ok, "the input's proof does not verify");
            Ok(())
        }
        Cmd::Evaluate { public, input, metadata, add, mul, out } => {
            let op = match (add, mul) {
                (Some(k), None) => Op::Add(k),
                (None, Some(k)) => Op::Mul(k),
                _ => anyhow::bail!("give --add or --mul"),
            };
            let result = evaluate(&read_public(&public)?, &std::fs::read(input)?, &unhex(&metadata)?, op)?;
            std::fs::write(out, result)?;
            Ok(())
        }
        Cmd::Decrypt { public, members, result, out } => {
            let shares: Vec<PrivateKeySet<EXTENSION_DEGREE>> = (0..MEMBERS)
                .map(|i| Ok(bincode::deserialize(&std::fs::read(members.join(format!("member-{i}.bin")))?)?))
                .collect::<Result<_>>()?;
            let d = decrypt(&read_public(&public)?, &shares, &std::fs::read(result)?)?;
            std::fs::write(out, serde_json::to_vec_pretty(&d)?)?;
            println!("{}", d.value);
            Ok(())
        }
    }
}
