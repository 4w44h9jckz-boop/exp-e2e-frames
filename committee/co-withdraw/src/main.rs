//! `co-withdraw`: the committee's command line.
//!
//! - `split`: the client's side. Extends the witness from the circuit's inputs, or takes one
//!   already extended, and writes the three members' shares and the public inputs.
//! - `member`: one member. Reads its share, joins the other two over TCP, proves, and writes
//!   the proof with what it sent and received.
//! - `local`: all three members on this machine, over loopback TCP, for a runner or a test.
//! - `verify`: checks a proof against the pool's verifying key.
//! - `demo-inputs`: the inputs for a fresh note in a tree of its own, for runs off chain.

use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use clap::{Parser, Subcommand};
use co_circom_types::Compression;
use co_withdraw::{
    Counted, MEMBERS, WithdrawKey, circuit_inputs, extend_witness, prove, public_inputs,
    read_share, share_witness, solidity_proof, verify,
};
use mpc_net::{
    Network,
    config::{Address, NetworkConfig, NetworkParty},
    tcp::TcpNetwork,
};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};

#[derive(Parser)]
#[command(about = "A three-party committee proving the withdrawal circuit with TACEO's co-snarks")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Write the members' shares, `share-0.bin` to `share-2.bin`, and `public.json`
    Split {
        /// The circuit's inputs as kohaku-tornadocash-circuit's `CircuitInputs` JSON
        #[arg(long, conflicts_with = "witness")]
        inputs: Option<PathBuf>,
        /// A full witness already extended: a JSON array of decimal strings, the constant 1 first
        #[arg(long)]
        witness: Option<PathBuf>,
        /// Write seeded replicated shares, which the members expand locally
        #[arg(long)]
        seeded: bool,
        #[arg(long)]
        out_dir: PathBuf,
    },
    /// Run one member
    Member {
        /// 0, 1 or 2
        #[arg(long)]
        id: usize,
        #[arg(long)]
        share: PathBuf,
        /// The three members' addresses, in member order, comma-separated
        #[arg(long, value_delimiter = ',', num_args = 3)]
        peers: Vec<SocketAddr>,
        #[arg(long)]
        out: PathBuf,
    },
    /// Run all three members on this machine, over loopback TCP
    Local {
        #[arg(long)]
        shares: PathBuf,
        /// The first of three consecutive ports
        #[arg(long, default_value_t = 10_000)]
        port: u16,
        #[arg(long)]
        out: PathBuf,
    },
    /// Check a proof written by `member` or `local`
    Verify {
        #[arg(long)]
        proof: PathBuf,
    },
    /// The pool's verifying key as JSON, coordinates as decimal strings, for checks elsewhere
    Vk {
        #[arg(long)]
        out: PathBuf,
    },
    /// Inputs for a fresh note, the second of three leaves, with every public input non-zero
    /// but the refund, which the refund pool fixes at zero
    DemoInputs {
        #[arg(long)]
        out: PathBuf,
    },
}

/// The public inputs as `split` writes them, in the circuit's order.
#[derive(Serialize, Deserialize)]
struct Public {
    /// Root, nullifier hash, recipient, relayer, fee, refund, as decimal strings
    inputs: Vec<String>,
}

/// What a member writes.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemberRecord {
    member: usize,
    /// The proof as websnark writes one (`pi_a`, `pi_b`, `pi_c`)
    proof: websnark_rs::proof::Proof,
    /// The proof as the pool's verifier takes it: eight 32-byte words
    solidity: String,
    public_inputs: Vec<String>,
    /// Whether the proof verifies under the pool's verifying key, checked here
    verified: bool,
    /// Per peer, in member order: messages sent and received, and bytes sent and received
    peers: Vec<PeerTraffic>,
    /// Wall-clock time of the proof alone, after the members connected; network named in `network`
    prove_ms: u128,
    network: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeerTraffic {
    peer: usize,
    messages_sent: usize,
    messages_received: usize,
    bytes_sent: usize,
    bytes_received: usize,
}

fn fr_dec(x: &Fr) -> String {
    num_dec(&x.into_bigint().to_bytes_be())
}

fn num_dec(be: &[u8]) -> String {
    ruint::aliases::U256::from_be_slice(be).to_string()
}

fn parse_fr(s: &str) -> Result<Fr> {
    let v: ruint::aliases::U256 = s.parse().with_context(|| format!("not a number: {s}"))?;
    Ok(Fr::from_be_bytes_mod_order(&v.to_be_bytes::<32>()))
}

fn split(inputs: Option<PathBuf>, witness: Option<PathBuf>, seeded: bool, out_dir: &Path) -> Result<()> {
    let key = WithdrawKey::load();
    let n = key.num_instance_variables();
    let w = match (inputs, witness) {
        (Some(p), None) => {
            let inputs: kohaku_tornadocash_circuit::CircuitInputs =
                serde_json::from_slice(&std::fs::read(p)?)?;
            extend_witness(&inputs)?
        }
        (None, Some(p)) => {
            let raw: Vec<String> = serde_json::from_slice(&std::fs::read(p)?)?;
            raw.iter().map(|s| parse_fr(s)).collect::<Result<_>>()?
        }
        _ => anyhow::bail!("give --inputs or --witness"),
    };
    anyhow::ensure!(
        w.len() == key.matrices.num_instance_variables + key.matrices.num_witness_variables,
        "the witness has {} values, the circuit {}",
        w.len(),
        key.matrices.num_instance_variables + key.matrices.num_witness_variables
    );
    let compression = if seeded { Compression::SeededShares } else { Compression::None };
    let shares = share_witness(&w, n, compression, &mut OsRng)?;
    std::fs::create_dir_all(out_dir)?;
    for (i, share) in shares.iter().enumerate() {
        std::fs::write(out_dir.join(format!("share-{i}.bin")), share)?;
    }
    let public = Public { inputs: public_inputs(&w, n).iter().map(fr_dec).collect() };
    std::fs::write(out_dir.join("public.json"), serde_json::to_vec_pretty(&public)?)?;
    Ok(())
}

fn tcp(id: usize, peers: &[SocketAddr]) -> Result<TcpNetwork> {
    let parties = peers
        .iter()
        .enumerate()
        .map(|(i, a)| NetworkParty::new(i, Address::new(a.ip().to_string(), a.port())))
        .collect();
    let config = NetworkConfig {
        parties,
        my_id: id,
        bind_addr: peers[id],
        tls: None,
        timeout: Some(Duration::from_secs(120)),
        connect_timeout: Some(Duration::from_secs(60)),
        flush_timeout: Some(Duration::from_secs(60)),
        max_frame_length: None,
    };
    TcpNetwork::new(config).map_err(|e| anyhow::anyhow!("network: {e:?}"))
}

fn member(id: usize, share: &[u8], peers: &[SocketAddr], key: &WithdrawKey) -> Result<MemberRecord> {
    anyhow::ensure!(peers.len() == MEMBERS && id < MEMBERS, "three peers, and an id below 3");
    let share = read_share(share)?;
    let net = Counted::new(tcp(id, peers)?);
    let start = Instant::now();
    let proof = prove(&net, key, share.clone())?;
    net.flush().map_err(|e| anyhow::anyhow!("flush: {e:?}"))?;
    let prove_ms = start.elapsed().as_millis();
    let public = share.public_inputs[1..].to_vec();
    let stats = net.get_connection_stats();
    let msgs = net.messages();
    let peers_traffic = (0..MEMBERS)
        .filter(|&p| p != id)
        .map(|p| {
            let (bytes_sent, bytes_received) = stats.get(p).unwrap_or_default();
            PeerTraffic {
                peer: p,
                messages_sent: msgs[p].0,
                messages_received: msgs[p].1,
                bytes_sent,
                bytes_received,
            }
        })
        .collect();
    let all_loopback = peers.iter().all(|a| a.ip().is_loopback());
    Ok(MemberRecord {
        member: id,
        proof: websnark_rs::proof::Proof { a: proof.a, b: proof.b, c: proof.c },
        solidity: format!("0x{}", hex::encode(solidity_proof(&proof))),
        public_inputs: public.iter().map(fr_dec).collect(),
        verified: verify(&proof, &public),
        peers: peers_traffic,
        prove_ms,
        network: if all_loopback {
            "loopback TCP on one machine: a LAN time, not a WAN one".into()
        } else {
            format!("TCP to {peers:?}")
        },
    })
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Split { inputs, witness, seeded, out_dir } => split(inputs, witness, seeded, &out_dir),
        Cmd::Member { id, share, peers, out } => {
            let key = WithdrawKey::load();
            let record = member(id, &std::fs::read(share)?, &peers, &key)?;
            std::fs::write(out, serde_json::to_vec_pretty(&record)?)?;
            anyhow::ensure!(record.verified, "the proof does not verify");
            Ok(())
        }
        Cmd::Local { shares, port, out } => {
            let key = WithdrawKey::load();
            let peers: Vec<SocketAddr> =
                (0..MEMBERS as u16).map(|i| SocketAddr::from(([127, 0, 0, 1], port + i))).collect();
            let shares: Vec<Vec<u8>> = (0..MEMBERS)
                .map(|i| std::fs::read(shares.join(format!("share-{i}.bin"))))
                .collect::<Result<_, _>>()?;
            let records: Vec<MemberRecord> = std::thread::scope(|s| {
                let handles: Vec<_> = (0..MEMBERS)
                    .map(|i| {
                        let (key, peers, share) = (&key, &peers, &shares[i]);
                        s.spawn(move || member(i, share, peers, key))
                    })
                    .collect();
                handles.into_iter().map(|h| h.join().expect("member thread")).collect::<Result<_>>()
            })?;
            anyhow::ensure!(
                records.windows(2).all(|r| r[0].solidity == r[1].solidity),
                "the members disagree on the proof"
            );
            std::fs::write(&out, serde_json::to_vec_pretty(&records)?)?;
            anyhow::ensure!(records.iter().all(|r| r.verified), "the proof does not verify");
            Ok(())
        }
        Cmd::Verify { proof } => {
            let raw = std::fs::read(proof)?;
            let records: Vec<MemberRecord> = serde_json::from_slice(&raw)
                .or_else(|_| serde_json::from_slice::<MemberRecord>(&raw).map(|r| vec![r]))?;
            for r in &records {
                let public: Vec<Fr> = r.public_inputs.iter().map(|s| parse_fr(s)).collect::<Result<_>>()?;
                let p = ark_groth16::Proof { a: r.proof.a, b: r.proof.b, c: r.proof.c };
                anyhow::ensure!(verify(&p, &public), "member {}'s proof does not verify", r.member);
            }
            println!("verified");
            Ok(())
        }
        Cmd::Vk { out } => {
            use ark_bn254::{Fq, G1Affine, G2Affine};
            let fq = |x: &Fq| num_dec(&x.into_bigint().to_bytes_be());
            let g1 = |p: &G1Affine| vec![fq(&p.x), fq(&p.y)];
            let g2 = |p: &G2Affine| vec![vec![fq(&p.x.c0), fq(&p.x.c1)], vec![fq(&p.y.c0), fq(&p.y.c1)]];
            let vk = co_withdraw::verifying_key();
            let json = serde_json::json!({
                "alpha": g1(&vk.alpha_g1),
                "beta": g2(&vk.beta_g2),
                "gamma": g2(&vk.gamma_g2),
                "delta": g2(&vk.delta_g2),
                "ic": vk.gamma_abc_g1.iter().map(g1).collect::<Vec<_>>(),
            });
            std::fs::write(out, serde_json::to_vec_pretty(&json)?)?;
            Ok(())
        }
        Cmd::DemoInputs { out } => {
            let note = || {
                let (mut n, mut s) = ([0u8; 31], [0u8; 31]);
                OsRng.fill_bytes(&mut n);
                OsRng.fill_bytes(&mut s);
                kohaku_tornadocash::Note::new(n, s)
            };
            let notes = [note(), note(), note()];
            let leaves: Vec<_> = notes.iter().map(kohaku_tornadocash::Note::commitment).collect();
            use ruint::aliases::U256;
            let inputs = circuit_inputs(
                &notes[1],
                &leaves,
                U256::from(0xe196u64),
                U256::from(0xbaf9u64),
                U256::from(150_658_200_000_000u64),
                U256::ZERO,
            )?;
            std::fs::write(out, serde_json::to_vec_pretty(&inputs)?)?;
            Ok(())
        }
    }
}
