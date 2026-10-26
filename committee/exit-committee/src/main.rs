//! The committee's steps in experiment 14, one command each, for the runner to call. Every
//! command prints what it may print as JSON on stdout; a member's secrets (its sealing key, its
//! BLS share, its part of a nullifier, the intents it opened) are written to files in its own
//! directory and never printed.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use ark_bn254::Fr;
use ark_ff::PrimeField;
use clap::{Parser, Subcommand};
use commonware_codec::{Encode, Read};
use commonware_cryptography::bls12381::primitives::{sharing::{ModeVersion, Sharing}, variant::MinSig};
use exit_committee::{
    INTENT_LEN, Intent, MEMBERS, OPENINGS_LEN, Opening, a_point, babyjub::{Point, pedersen}, choose_part, commitment,
    fr_be, reconcile_message, reconcile_nonce_key, reconcile_partial, reconcile_signature, recipient, redemption_list,
    seal,
};
use kohaku_frame_ticket::ticket::{g1_eip2537, g2_eip2537};
use rand::rngs::OsRng;
use serde_json::{Value, json};

/// The vault's constructor defaults on the Hegota testnet: experiment 01's hasher and verifier,
/// and experiment 30's denomination.
const HASHER: &str = "0x38955FBe81DBf136A84A1c711619C0Ab8Ce7813b";
const VERIFIER: &str = "0x87a7C1f76b03dA00de489897d436BbEDDd2133b7";
const DENOMINATION: u128 = 1_000_000_000_000_000;

#[derive(Parser)]
#[command(about = "The committee's side of experiment 14")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Deal the committee's keys into `dir`: one sealing key every member holds, and a 3-of-3
    /// BLS key by Commonware's DKG. Prints the public halves.
    Keys {
        #[arg(long)]
        dir: PathBuf,
    },
    /// The vault's creation code: ExitVault.hex with its constructor words appended
    Initcode {
        #[arg(long)]
        dir: PathBuf,
        #[arg(long)]
        hex: PathBuf,
        #[arg(long, default_value_t = 30)]
        timeout: u64,
        #[arg(long, default_value_t = 30)]
        escape_window: u64,
        /// 32 bytes, hex: the EIP-8272 source salt
        #[arg(long)]
        salt: String,
    },
    /// Member `member` opens the intent at `index` and keeps what it reads in its directory
    OpenIntent {
        #[arg(long)]
        dir: PathBuf,
        #[arg(long)]
        member: usize,
        #[arg(long)]
        vault: String,
        #[arg(long)]
        index: u64,
        /// The sealed intent, hex, as the Intent event carries it
        #[arg(long)]
        sealed: String,
    },
    /// Member `member` chooses its part of the new note's nullifier for the intent at `index`,
    /// keeps it, and prints the point A(n_j) for the other members
    Part {
        #[arg(long)]
        dir: PathBuf,
        #[arg(long)]
        member: usize,
        #[arg(long)]
        index: u64,
    },
    /// The new note's commitment from the members' three points and the intent's B(s)
    Commit {
        #[arg(long)]
        dir: PathBuf,
        /// Any member who opened the intent, to read B(s) from
        #[arg(long, default_value_t = 0)]
        member: usize,
        #[arg(long)]
        index: u64,
        /// The three members' A(n_j), packed, hex, in member order
        #[arg(long, value_delimiter = ',', num_args = 1..=3)]
        parts: Vec<String>,
    },
    /// Member `member` seals its part to the intent's owner
    Seal {
        #[arg(long)]
        dir: PathBuf,
        #[arg(long)]
        member: usize,
        #[arg(long)]
        vault: String,
        #[arg(long)]
        index: u64,
        /// The leaf the new note will take: the vault's nextIndex() before the update
        #[arg(long)]
        leaf: u32,
    },
    /// The update's recipient, to which every member sets its witness before proving
    Recipient {
        #[arg(long)]
        vault: String,
        /// The sealed intent at the head, hex
        #[arg(long)]
        sealed: String,
        /// The new commitment, hex
        #[arg(long)]
        c: String,
        /// The three openings, concatenated, hex
        #[arg(long)]
        openings: String,
    },
    /// The update's frame data: the vault's VERIFY frame and its SENDER frame
    UpdateData {
        /// The proof, 256 bytes hex, as co-withdraw's member prints it
        #[arg(long)]
        proof: String,
        #[arg(long)]
        root: String,
        #[arg(long)]
        nullifier_hash: String,
        #[arg(long)]
        c: String,
        #[arg(long)]
        openings: String,
    },
    /// Every member signs a reconciliation; prints the vault's VERIFY data and the nonce key
    Reconcile {
        #[arg(long)]
        dir: PathBuf,
        /// The members who sign; the vault needs all three
        #[arg(long, value_delimiter = ',', default_value = "0,1,2")]
        signers: Vec<usize>,
        #[arg(long)]
        chain_id: u64,
        #[arg(long)]
        vault: String,
        #[arg(long)]
        escape_at: u64,
        /// Every redeemed nullifier hash, hex, comma-separated; sorted here
        #[arg(long, value_delimiter = ',')]
        nullifier_hashes: Vec<String>,
    },
    /// Fixed vectors for checks in another language: fake keys from a seed, an intent, an
    /// update's openings and commitment, its recipient, a digest and a nonce key
    Vectors {
        #[arg(long, default_value_t = 14)]
        seed: u64,
    },
    /// All three members pool what they hold for the intent at `index` and try to make the
    /// redemption witness of the owner's note. Prints where it fails, and a redemption's public
    /// inputs with a zero proof for the runner to send to a node.
    Steal {
        #[arg(long)]
        dir: PathBuf,
        #[arg(long)]
        index: u64,
        /// The vault's leaves, in order, hex, comma-separated
        #[arg(long, value_delimiter = ',')]
        leaves: Vec<String>,
        /// The address the members would be paid at
        #[arg(long)]
        to: String,
    },
}

fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

fn bytes(s: &str) -> Result<Vec<u8>> {
    hex::decode(s.trim_start_matches("0x")).with_context(|| format!("not hex: {s}"))
}

fn fixed<const N: usize>(s: &str) -> Result<[u8; N]> {
    bytes(s)?.try_into().map_err(|_| anyhow::anyhow!("{s} is not {N} bytes"))
}

fn fr(s: &str) -> Result<Fr> {
    let b: [u8; 32] = fixed(s)?;
    let x = Fr::from_be_bytes_mod_order(&b);
    anyhow::ensure!(fr_be(x) == b, "{s} is not below the field's order");
    Ok(x)
}

fn member_dir(dir: &Path, j: usize) -> Result<PathBuf> {
    anyhow::ensure!(j < MEMBERS, "a member is 0, 1 or 2");
    let d = dir.join(format!("member-{j}"));
    std::fs::create_dir_all(&d)?;
    Ok(d)
}

fn write_secret(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, hex::encode(bytes))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn read_secret<const N: usize>(path: &Path) -> Result<[u8; N]> {
    fixed(std::fs::read_to_string(path).with_context(|| format!("{}", path.display()))?.trim())
}

fn read_secret_vec(path: &Path) -> Result<Vec<u8>> {
    bytes(std::fs::read_to_string(path).with_context(|| format!("{}", path.display()))?.trim())
}

fn read_sharing(dir: &Path) -> Result<Sharing<MinSig>> {
    let raw = std::fs::read(dir.join("sharing.bin"))?;
    Sharing::<MinSig>::read_cfg(&mut &raw[..], &(std::num::NonZeroU32::new(1 << 16).unwrap(), ModeVersion::v0()))
        .map_err(|e| anyhow::anyhow!("{e:?}"))
}

fn public(dir: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&std::fs::read(dir.join("committee.json"))?)?)
}

fn intent_of(dir: &Path, j: usize, index: u64) -> Result<Intent> {
    let p = read_secret::<{ exit_committee::INTENT_PLAINTEXT }>(&member_dir(dir, j)?.join(format!("intent-{index}")))?;
    Intent::from_plaintext(&p)
}

fn run(cmd: Cmd) -> Result<Value> {
    match cmd {
        Cmd::Keys { dir } => {
            std::fs::create_dir_all(&dir)?;
            let sealing = seal::Keys::random(&mut OsRng);
            let mut rng = <rand10::rngs::StdRng as rand10::SeedableRng>::from_rng(&mut rand10::rng());
            let committee = bls_committee::Committee::dkg(&mut rng, MEMBERS)?;
            for (j, (_, share)) in committee.members.iter().enumerate() {
                let d = member_dir(&dir, j)?;
                write_secret(&d.join("seal"), &sealing.secret)?;
                write_secret(&d.join("bls"), &bls_committee::share_encode(share))?;
            }
            std::fs::write(dir.join("sharing.bin"), committee.sharing().encode())?;
            let out = json!({
                "sealingKey": hex0x(&sealing.public),
                "blsKeyEip2537": hex0x(&g2_eip2537(committee.sharing().public())),
                "blsQuorum": committee.quorum(),
                "members": MEMBERS,
                "dkg": committee.traffic.values().map(|t| json!({
                    "messagesSent": t.sent_messages, "bytesSent": t.sent_bytes,
                    "messagesReceived": t.received_messages, "bytesReceived": t.received_bytes,
                })).collect::<Vec<_>>(),
            });
            std::fs::write(dir.join("committee.json"), serde_json::to_vec_pretty(&out)?)?;
            Ok(out)
        }
        Cmd::Initcode { dir, hex, timeout, escape_window, salt } => {
            let p = public(&dir)?;
            let code = bytes(std::fs::read_to_string(hex)?.trim())?;
            let mut init = code;
            let mut sealing = bytes(p["sealingKey"].as_str().context("sealingKey")?)?;
            sealing.resize(64, 0);
            init.extend_from_slice(&sealing);
            init.extend_from_slice(&word(escape_window as u128));
            init.extend_from_slice(&word(timeout as u128));
            init.extend_from_slice(&bytes(p["blsKeyEip2537"].as_str().context("blsKeyEip2537")?)?);
            init.extend_from_slice(&address_word(VERIFIER)?);
            init.extend_from_slice(&address_word(HASHER)?);
            init.extend_from_slice(&word(DENOMINATION));
            init.extend_from_slice(&fixed::<32>(&salt)?);
            Ok(json!({
                "initcode": hex0x(&init),
                "timeout": timeout, "escapeWindow": escape_window,
                "verifier": VERIFIER, "hasher": HASHER, "denomination": DENOMINATION.to_string(), "salt": salt,
            }))
        }
        Cmd::OpenIntent { dir, member, vault, index, sealed } => {
            let d = member_dir(&dir, member)?;
            let key: [u8; 32] = read_secret(&d.join("seal"))?;
            let sealed = bytes(&sealed)?;
            anyhow::ensure!(sealed.len() == INTENT_LEN, "a sealed intent is {INTENT_LEN} bytes");
            let intent = Intent::open(&key, &sealed, &fixed(&vault)?, index)?;
            write_secret(&d.join(format!("intent-{index}")), &intent.plaintext())?;
            Ok(json!({ "member": member, "index": index, "opened": true }))
        }
        Cmd::Part { dir, member, index } => {
            let d = member_dir(&dir, member)?;
            let part = choose_part(member, &mut OsRng);
            write_secret(&d.join(format!("part-{index}")), &part)?;
            Ok(json!({ "member": member, "index": index, "point": hex0x(&a_point(&part).pack()) }))
        }
        Cmd::Commit { dir, member, index, parts } => {
            anyhow::ensure!(parts.len() == MEMBERS, "three points, in member order");
            let points: Vec<Point> = parts
                .iter()
                .map(|p| Point::unpack(&fixed(p)?).ok_or_else(|| anyhow::anyhow!("{p} is not a point of the subgroup")))
                .collect::<Result<_>>()?;
            let b = intent_of(&dir, member, index)?.b;
            let c = commitment(&[points[0], points[1], points[2]], &b);
            Ok(json!({ "index": index, "commitment": hex0x(&fr_be(c)) }))
        }
        Cmd::Seal { dir, member, vault, index, leaf } => {
            let d = member_dir(&dir, member)?;
            let intent = intent_of(&dir, member, index)?;
            let part: [u8; 31] = read_secret(&d.join(format!("part-{index}")))?;
            let o = Opening { part, member: member as u8, leaf, update: index };
            let sealed = o.seal(&intent.owner, &fixed(&vault)?, &mut OsRng)?;
            Ok(json!({ "member": member, "index": index, "leaf": leaf, "opening": hex0x(&sealed) }))
        }
        Cmd::Recipient { vault, sealed, c, openings } => {
            let sealed = bytes(&sealed)?;
            let h: [u8; 32] = sha3_keccak(&sealed);
            let openings = bytes(&openings)?;
            anyhow::ensure!(openings.len() == OPENINGS_LEN, "three openings, {OPENINGS_LEN} bytes");
            let r = recipient(&fixed(&vault)?, &h, fr(&c)?, &openings);
            Ok(json!({ "intentHash": hex0x(&h), "recipient": hex0x(&fr_be(r)) }))
        }
        Cmd::UpdateData { proof, root, nullifier_hash, c, openings } => {
            let proof = bytes(&proof)?;
            anyhow::ensure!(proof.len() == 256, "a proof is 256 bytes");
            let openings = bytes(&openings)?;
            anyhow::ensure!(openings.len() == OPENINGS_LEN, "three openings, {OPENINGS_LEN} bytes");
            let c = fr_be(fr(&c)?);
            let mut verify = proof;
            verify.extend_from_slice(&fixed::<32>(&root)?);
            verify.extend_from_slice(&fixed::<32>(&nullifier_hash)?);
            verify.extend_from_slice(&c);
            verify.extend_from_slice(&openings);
            let mut process = vec![0xdf, 0xef, 0xb7, 0xd7];
            process.extend_from_slice(&c);
            process.extend_from_slice(&openings);
            Ok(json!({ "verifyData": hex0x(&verify), "processData": hex0x(&process), "nonceKey": nullifier_hash }))
        }
        Cmd::Reconcile { dir, signers, chain_id, vault, escape_at, nullifier_hashes } => {
            let sharing = read_sharing(&dir)?;
            let nhs: Vec<[u8; 32]> = nullifier_hashes.iter().map(|s| fixed(s)).collect::<Result<_>>()?;
            let (nhs, digest) = redemption_list(&nhs);
            let m = reconcile_message(chain_id, &fixed(&vault)?, escape_at, &digest);
            let partials: Vec<_> = signers
                .iter()
                .map(|&j| {
                    let share = bls_committee::share_decode(&read_secret_vec(&member_dir(&dir, j)?.join("bls"))?)?;
                    Ok(reconcile_partial(&share, &m))
                })
                .collect::<Result<_>>()?;
            let sig = reconcile_signature(&sharing, &m, &partials)?;
            let mut data = word(nhs.len() as u128).to_vec();
            for nh in &nhs {
                data.extend_from_slice(nh);
            }
            data.extend_from_slice(&g1_eip2537(&sig));
            Ok(json!({
                "signers": signers, "digest": hex0x(&digest), "message": hex0x(&m),
                "verifyData": hex0x(&data), "processData": "0x8f0d7e35",
                "nonceKey": hex0x(&reconcile_nonce_key(escape_at)),
            }))
        }
        Cmd::Steal { dir, index, leaves, to } => steal(&dir, index, &leaves, &to),
        Cmd::Vectors { seed } => vectors(seed),
    }
}

fn word(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

fn address_word(a: &str) -> Result<[u8; 32]> {
    let b: [u8; 20] = fixed(a)?;
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(&b);
    Ok(w)
}

fn sha3_keccak(b: &[u8]) -> [u8; 32] {
    use sha3::{Digest, Keccak256};
    Keccak256::digest(b).into()
}

/// The eighth condition, tried: everything the members hold, together, for the intent's note.
fn steal(dir: &Path, index: u64, leaves: &[String], to: &str) -> Result<Value> {
    let intent = intent_of(dir, 0, index)?;
    let mut n = [0u8; 31];
    for j in 0..MEMBERS {
        let part: [u8; 31] = read_secret(&member_dir(dir, j)?.join(format!("part-{index}")))?;
        for (x, y) in n.iter_mut().zip(part) {
            *x |= y;
        }
    }
    let nullifier_hash = pedersen(&n).x;
    let leaves: Vec<Fr> = leaves.iter().map(|l| fr(l)).collect::<Result<_>>()?;
    let target = commitment(
        &[0, 1, 2].map(|j| {
            let p: [u8; 31] = read_secret(&member_dir(dir, j).unwrap().join(format!("part-{index}"))).unwrap();
            a_point(&p)
        }),
        &intent.b,
    );
    let leaf = leaves.iter().position(|l| *l == target);

    // The circuit needs s. The members hold B(s) = H(0 || s) - H(0 || 0), a point; the best
    // they can put in its place is a guess. A witness needs H(n || guess) among the leaves.
    let guesses: [[u8; 31]; 2] = [[0u8; 31], [0xffu8; 31]];
    let mut attempts = vec![];
    for g in guesses {
        let mut pre = [0u8; 62];
        pre[..31].copy_from_slice(&n);
        pre[31..].copy_from_slice(&g);
        let c = pedersen(&pre).x;
        attempts.push(json!({
            "secretGuess": if g[0] == 0 { "zero" } else { "all ones" },
            "commitmentAmongLeaves": leaves.contains(&c),
        }));
    }
    let witness = attempts.iter().any(|a| a["commitmentAmongLeaves"] == json!(true));
    Ok(json!({
        "index": index,
        "pooled": ["every member's part of the nullifier", "the intent's B(s) and owner key", "every member's sealing key and BLS share"],
        "nullifierHash": hex0x(&fr_be(nullifier_hash)),
        "noteLeaf": leaf,
        "attempts": attempts,
        "witnessExists": witness,
        "where": if witness { "a witness was found" } else {
            "no witness: the circuit takes the secret s, the members hold only the point B(s), and no guess puts H(n || s') among the leaves"
        },
        "redemptionToTry": {
            "nullifierHash": hex0x(&fr_be(nullifier_hash)),
            "recipient": to,
            "proof": hex0x(&[0u8; 256]),
        },
    }))
}

fn vectors(seed: u64) -> Result<Value> {
    use rand::{RngCore, SeedableRng};
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let committee = seal::Keys::random(&mut rng);
    let owner = seal::Keys::random(&mut rng);
    let vault: [u8; 20] = std::array::from_fn(|i| 0x10 + i as u8);
    let (index, leaf) = (5u64, 9u32);
    let mut s = [0u8; 31];
    rng.fill_bytes(&mut s);
    let intent = Intent { owner: owner.public, b: exit_committee::b_point(&s) };
    let sealed = intent.seal(&committee.public, &vault, index, &mut rng)?;
    let parts: [[u8; 31]; MEMBERS] = std::array::from_fn(|j| choose_part(j, &mut rng));
    let points = parts.map(|p| a_point(&p));
    let c = commitment(&points, &intent.b);
    let openings: Vec<u8> = parts
        .iter()
        .enumerate()
        .map(|(j, p)| Opening { part: *p, member: j as u8, leaf, update: index }.seal(&owner.public, &vault, &mut rng))
        .collect::<Result<Vec<_>>>()?
        .concat();
    let h = sha3_keccak(&sealed);
    let nhs = [[0x22u8; 32], [0x11u8; 32]];
    let (_, digest) = redemption_list(&nhs);
    let mut n = [0u8; 31];
    for p in &parts {
        for (x, y) in n.iter_mut().zip(p) {
            *x |= y;
        }
    }
    Ok(json!({
        "note": "fake keys from a seed, for checks only",
        "seed": seed,
        "committeeSecret": hex0x(&committee.secret), "committeeKey": hex0x(&committee.public),
        "ownerSecret": hex0x(&owner.secret), "ownerKey": hex0x(&owner.public),
        "vault": hex0x(&vault), "index": index, "leaf": leaf,
        "secret": hex0x(&s), "b": hex0x(&intent.b.pack()),
        "sealedIntent": hex0x(&sealed), "intentHash": hex0x(&h),
        "parts": parts.iter().map(|p| hex0x(p)).collect::<Vec<_>>(),
        "points": points.iter().map(|p| hex0x(&p.pack())).collect::<Vec<_>>(),
        "nullifier": hex0x(&n),
        "commitment": hex0x(&fr_be(c)),
        "openings": hex0x(&openings),
        "recipient": hex0x(&fr_be(recipient(&vault, &h, c, &openings))),
        "nullifierHashes": nhs.iter().map(|x| hex0x(x)).collect::<Vec<_>>(),
        "digest": hex0x(&digest),
        "escapeAt": 1234,
        "reconcileMessage": hex0x(&reconcile_message(8141, &vault, 1234, &digest)),
        "reconcileNonceKey": hex0x(&reconcile_nonce_key(1234)),
    }))
}

fn main() -> Result<()> {
    let out = run(Cli::parse().cmd)?;
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}
