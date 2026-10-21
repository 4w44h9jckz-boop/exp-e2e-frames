//! `bls-committee`: the signing half's command line.
//!
//! - `dkg`: Commonware's DKG among the members: `public.json` and `member-<i>.share`.
//! - `sign`: a set of members signs a decrypted result; refuses below the quorum.
//! - `sign-below`: what a set below the quorum can make, for showing that it is refused.
//! - `verify`: checks a signed result against the group key.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use bls_committee::{
    Committee, Locks, NAMESPACE, ResultClaim, combine, forge_attempts, interpolate_below, partial, share_decode,
    share_encode, verify,
};
use clap::{Parser, Subcommand};
use commonware_codec::{Encode, ReadExt};
use commonware_utils::Faults;
use commonware_cryptography::bls12381::primitives::{
    sharing::{ModeVersion, Sharing},
    variant::MinSig,
};
use kohaku_frame_ticket::ticket::{g1_eip2537, g2_eip2537};
use serde_json::{Value, json};

#[derive(Parser)]
#[command(about = "The signing half of a fixed committee: a threshold BLS key from Commonware's DKG")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    Dkg {
        #[arg(long, default_value_t = 4)]
        members: usize,
        #[arg(long)]
        out: PathBuf,
    },
    /// Each signer checks its lock for the request first; fewer than a quorum of willing signers
    /// and no signature is made
    Sign(SignArgs),
    SignBelow(SignArgs),
    /// What the named members make from their shares and the public DKG output alone
    Forge(SignArgs),
    Verify {
        #[arg(long)]
        dir: PathBuf,
        #[arg(long)]
        signed: PathBuf,
    },
}

#[derive(clap::Args)]
struct SignArgs {
    #[arg(long)]
    dir: PathBuf,
    /// The members who sign, by index, comma-separated
    #[arg(long, value_delimiter = ',')]
    signers: Vec<usize>,
    #[arg(long)]
    chain_id: u64,
    /// 32 bytes, hex
    #[arg(long)]
    request: String,
    /// The result ciphertext, as the coprocessor wrote it
    #[arg(long)]
    ciphertext: PathBuf,
    #[arg(long)]
    value: u64,
    #[arg(long)]
    out: PathBuf,
    /// Members who ignore their locks, as corrupted members would
    #[arg(long, value_delimiter = ',')]
    ignore_lock: Vec<usize>,
}

fn hex(b: &[u8]) -> String {
    format!("0x{}", ::hex::encode(b))
}

fn sharing(dir: &Path) -> Result<Sharing<MinSig>> {
    let raw = std::fs::read(dir.join("sharing.bin"))?;
    use commonware_codec::Read;
    Sharing::<MinSig>::read_cfg(&mut &raw[..], &(std::num::NonZeroU32::new(1 << 16).unwrap(), ModeVersion::v0()))
        .map_err(|e| anyhow::anyhow!("{e:?}"))
}

fn claim(a: &SignArgs) -> Result<ResultClaim> {
    let request: [u8; 32] = ::hex::decode(a.request.trim_start_matches("0x"))?
        .try_into()
        .map_err(|_| anyhow::anyhow!("--request is 32 bytes"))?;
    Ok(ResultClaim::for_ciphertext(a.chain_id, request, &std::fs::read(&a.ciphertext)?, a.value))
}

fn sign(a: &SignArgs, below: bool) -> Result<Value> {
    let sharing = sharing(&a.dir)?;
    let claim = claim(a)?;
    let mut partials = vec![];
    let mut refusals = vec![];
    for i in &a.signers {
        let share = share_decode(&std::fs::read(a.dir.join(format!("member-{i}.share")))?)?;
        if below || a.ignore_lock.contains(i) {
            partials.push(partial(&share, &claim));
            continue;
        }
        let path = a.dir.join(format!("member-{i}.locks.json"));
        let mut locks: Locks = match std::fs::read(&path) {
            Ok(b) => serde_json::from_slice(&b)?,
            Err(_) => Locks::default(),
        };
        match locks.sign(&share, &claim) {
            Ok(p) => {
                partials.push(p);
                std::fs::write(&path, serde_json::to_vec_pretty(&locks)?)?;
            }
            Err(e) => refusals.push(json!({ "member": i, "refusal": format!("{e:?}") })),
        }
    }
    if !below && partials.len() < sharing.required() as usize {
        return Ok(json!({
            "message": hex(&claim.message()),
            "request": hex(&claim.request),
            "value": claim.value,
            "signers": a.signers,
            "ignoredLocks": a.ignore_lock,
            "refusals": refusals,
            "partials": partials.len(),
            "quorum": sharing.required(),
            "signed": false,
        }));
    }
    let signature = if below {
        anyhow::ensure!(a.signers.len() < sharing.required() as usize, "sign-below takes fewer signers than the quorum");
        interpolate_below(&partials)
    } else {
        combine(&sharing, &claim, &partials).context("a quorum of members must sign")?
    };
    let ok = verify(&sharing, &claim, &signature);
    Ok(json!({
        "namespace": String::from_utf8_lossy(NAMESPACE),
        "chainId": claim.chain_id,
        "request": hex(&claim.request),
        "handle": hex(&claim.handle),
        "value": claim.value,
        "message": hex(&claim.message()),
        "signers": a.signers,
        "quorum": sharing.required(),
        "belowQuorum": below,
        "partials": partials.iter().map(|p| json!({
            "index": p.index.get(),
            "signatureEip2537": hex(&g1_eip2537(&p.value)),
        })).collect::<Vec<_>>(),
        "signature": hex(&signature.encode()),
        "signatureEip2537": hex(&g1_eip2537(&signature)),
        "keyEip2537": hex(&g2_eip2537(sharing.public())),
        "ignoredLocks": a.ignore_lock,
        "refusals": refusals,
        "signed": true,
        "verified": ok,
    }))
}

fn forge(a: &SignArgs) -> Result<Value> {
    let sharing = sharing(&a.dir)?;
    let claim = claim(a)?;
    let shares: Vec<_> = a
        .signers
        .iter()
        .map(|i| share_decode(&std::fs::read(a.dir.join(format!("member-{i}.share")))?))
        .collect::<Result<_>>()?;
    let attempts: Vec<Value> = forge_attempts(&sharing, &shares, &claim)
        .into_iter()
        .map(|(what, sig)| json!({
            "what": what,
            "signatureEip2537": hex(&g1_eip2537(&sig)),
            "verified": verify(&sharing, &claim, &sig),
        }))
        .collect();
    Ok(json!({
        "members": a.signers,
        "holds": "each member's own share, and every public value of the DKG: the group sharing (the summed commitments) and every member's partial key",
        "message": hex(&claim.message()),
        "keyEip2537": hex(&g2_eip2537(sharing.public())),
        "attempts": attempts,
    }))
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Dkg { members, out } => {
            let c = Committee::dkg(&mut rand10::rng(), members)?;
            std::fs::create_dir_all(&out)?;
            std::fs::write(out.join("sharing.bin"), c.sharing().encode())?;
            for (pk, share) in &c.members {
                std::fs::write(out.join(format!("member-{}.share", share.index.get())), share_encode(share))?;
                let _ = pk;
            }
            let public = json!({
                "members": members,
                "quorum": c.quorum(),
                "commonware": {
                    "thresholdParameter": "q: Sharing::required() is the number of partials that recover a signature, n - f with f = N3f1::max_faults(n); the dealers' polynomials have degree q - 1",
                    "maxFaults": commonware_utils::N3f1::max_faults(members as u32),
                    "polynomialDegree": c.quorum() - 1,
                    "qualifiedSetFixedBeforeKeyDependentValues": false,
                    "qualifiedSet": "dkg::feldman_desmedt: each dealer broadcasts its commitment polynomial, whose constant term is its share of the group key, with its dealings in the first round; the dealers whose logs count are chosen after that, when the logs are finalized and selected. Commonware documents the consequence itself (feldman_desmedt, 'Non-Uniform Distribution'): an adversary can bias the key by O(lg N) bits, harmless for signing",
                },
                "keyEip2537": hex(&g2_eip2537(c.sharing().public())),
                "identities": c.members.iter().map(|(pk, s)| json!({
                    "index": s.index.get(),
                    "ed25519": hex(&pk.encode()),
                    "partialKeyEip2537": hex(&g2_eip2537(&c.sharing().partial_public(s.index).expect("member"))),
                })).collect::<Vec<_>>(),
                "dkg": c.traffic.iter().map(|(pk, t)| json!({
                    "ed25519": hex(&pk.encode()),
                    "messagesSent": t.sent_messages,
                    "bytesSent": t.sent_bytes,
                    "messagesReceived": t.received_messages,
                    "bytesReceived": t.received_bytes,
                    "rounds": t.rounds,
                    "computeMicros": t.compute.as_micros() as u64,
                })).collect::<Vec<_>>(),
            });
            std::fs::write(out.join("public.json"), serde_json::to_vec_pretty(&public)?)?;
            Ok(())
        }
        Cmd::Sign(a) => {
            let v = sign(&a, false)?;
            std::fs::write(&a.out, serde_json::to_vec_pretty(&v)?)?;
            anyhow::ensure!(v["signed"] == true, "fewer than a quorum would sign");
            anyhow::ensure!(v["verified"] == true, "the signature does not verify");
            Ok(())
        }
        Cmd::Forge(a) => {
            let v = forge(&a)?;
            std::fs::write(&a.out, serde_json::to_vec_pretty(&v)?)?;
            Ok(())
        }
        Cmd::SignBelow(a) => {
            let v = sign(&a, true)?;
            std::fs::write(&a.out, serde_json::to_vec_pretty(&v)?)?;
            Ok(())
        }
        Cmd::Verify { dir, signed } => {
            let s: Value = serde_json::from_slice(&std::fs::read(signed)?)?;
            let sharing = sharing(&dir)?;
            let claim = ResultClaim {
                chain_id: s["chainId"].as_u64().context("chainId")?,
                request: ::hex::decode(s["request"].as_str().context("request")?.trim_start_matches("0x"))?
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("request"))?,
                handle: ::hex::decode(s["handle"].as_str().context("handle")?.trim_start_matches("0x"))?
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("handle"))?,
                value: s["value"].as_u64().context("value")?,
            };
            let raw = ::hex::decode(s["signature"].as_str().context("signature")?.trim_start_matches("0x"))?;
            let sig = commonware_cryptography::bls12381::primitives::group::G1::read(&mut &raw[..])
                .map_err(|e| anyhow::anyhow!("{e:?}"))?;
            let ok = verify(&sharing, &claim, &sig);
            println!("{}", if ok { "valid" } else { "invalid" });
            anyhow::ensure!(ok, "the signature does not verify");
            Ok(())
        }
    }
}
