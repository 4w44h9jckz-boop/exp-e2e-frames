//! C3, one key and a new committee each epoch: three committees in turn hold one ticket key,
//! the second and third by resharing, and each issues a ticket that a fresh sender spends through
//! one paymaster deployed once. Then the first committee, which kept its shares, issues one more.
//!
//! ```text
//! MODE=chain PRIVATE_KEY=0x... SEND_RPC_URL=http://127.0.0.1:14337/rpc/ RECORD=out.json \
//!   cargo run --release --manifest-path experiments/08-c3-epoch-reshare/rust/Cargo.toml
//! MODE=measure SIZES=4,7,10,13,16,32,64,128,256 RECORD=out.json cargo run --release ...
//! ```
//!
//! `chain`:
//! 1. Committee 0, four members, by Commonware's DKG. The funder deploys one `TicketPaymaster`
//!    with its key and buys four tickets, in one transaction to the chain.
//! 2. Three rounds, each in a later epoch than the last. Round k > 0 starts by resharing the key
//!    from a quorum of committee k-1 to committee k, of fresh members: seven, then ten. Each
//!    round's committee issues a ticket blindly for a fresh sender, and the spend goes to the node.
//! 3. A last round: committee 0's shares, kept after both handoffs, issue a fourth ticket, spent
//!    the same way.
//!
//! `measure`: for each size n, a DKG among n, then a reshare from a quorum of them to n fresh
//! members, each reporting every participant's messages, bytes and compute time.
//!
//! `RECORD` names a JSON file. No private key, share or blinding factor is recorded or printed.

use std::{collections::BTreeMap, env, fs, time::Duration};

use alloy::{
    eips::BlockNumberOrTag,
    primitives::{Address, B256, U256, address, keccak256},
    providers::{Provider, ProviderBuilder},
    signers::{SignerSync, local::PrivateKeySigner},
    sol,
    sol_types::{SolCall, SolEvent},
};
use anyhow::{Context, ensure};
use commonware_codec::{Encode, EncodeSize};
use commonware_cryptography::{
    Signer as _,
    bls12381::{
        dkg::feldman_desmedt::{self, Dealer, Info, Output, Player, Reveal, RunResult, Traffic, deal},
        primitives::{
            group::Share,
            sharing::{Mode, Sharing},
            variant::{MinSig, PartialSignature},
        },
    },
    ed25519,
};
use commonware_math::algebra::Random;
use commonware_parallel::Sequential;
use commonware_utils::{N3f1, TryCollect, ordered::Set};
use kohaku_frame_accounts::{
    account::{Eoa, Signer},
    builder::{Envelope, TxPlan},
};
use kohaku_frame_kit::{
    Frame, FrameSigner, FrameTx, Fees,
    gas::max_cost,
    rpc::{self, HEGOTA_RPC_URL},
    sign_all,
};
use kohaku_frame_ticket::{
    Claim, Slot, Ticket, TicketPaymaster, TicketSponsor, blind,
    issuers::{Count, Ledger, request_id},
    paymaster::Bought,
    ticket::{NAMESPACE, epoch_of, g2_eip2537},
};
use rand::RngExt;
use serde_json::{Value, json};

/// `exp-frames` experiment 33's board: `post(bytes)` logs `Posted(bytes)`.
const BOARD: Address = address!("0x93DD748B72dA1b1B6F1d5ec78Cb91ee52F01727d");
const DENOMINATION: U256 = U256::from_limbs([1_000_000_000_000_000, 0, 0, 0]);
const TIP: u128 = 1_000_000_000;
const DKG_NAMESPACE: &[u8] = b"exp-e2e-frames-c3-ticket-key";
/// The sizes of committees 0, 1 and 2.
const SIZES: [usize; 3] = [4, 7, 10];
/// Three committees' tickets and the retired committee's.
const BUY: u64 = 4;
const MARGIN: u64 = 120;
const EPOCH: u64 = 384;
const SLOT: u64 = 12;

sol! {
    function post(bytes message);
}

/// One committee: its members' identities and shares, the round that made it, and what it cost.
struct Committee {
    name: String,
    output: Output<MinSig, ed25519::PublicKey>,
    keys: Vec<ed25519::PrivateKey>,
    shares: Vec<Share>,
    made: Value,
}

impl Committee {
    fn sharing(&self) -> &Sharing<MinSig> {
        self.output.public()
    }
}

fn identities(rng: &mut impl rand::CryptoRng, n: usize) -> Vec<ed25519::PrivateKey> {
    (0..n).map(|_| ed25519::PrivateKey::random(&mut *rng)).collect()
}

fn set_of(keys: &[ed25519::PrivateKey]) -> anyhow::Result<Set<ed25519::PublicKey>> {
    keys.iter()
        .map(|k| k.public_key())
        .try_collect()
        .map_err(|e| anyhow::anyhow!("{e:?}"))
}

fn traffic_json(t: &Traffic) -> Value {
    json!({
        "messagesSent": t.sent_messages,
        "bytesSent": t.sent_bytes,
        "messagesReceived": t.received_messages,
        "bytesReceived": t.received_bytes,
        "rounds": t.rounds,
        "computeMicros": t.compute.as_micros() as u64,
    })
}

/// One round, timed as a whole, with each participant's traffic and role.
fn round(
    rng: &mut impl rand::CryptoRng,
    counter: u64,
    previous: Option<&Committee>,
    dealers: &[(ed25519::PrivateKey, Option<Share>)],
    players: &[ed25519::PrivateKey],
) -> anyhow::Result<(RunResult<MinSig, ed25519::PublicKey>, Value)> {
    let dealer_keys: Vec<_> = dealers.iter().map(|(k, _)| k.clone()).collect();
    let info = Info::<MinSig, ed25519::PublicKey>::new::<N3f1>(
        DKG_NAMESPACE,
        counter,
        previous.map(|c| c.output.clone()),
        Mode::NonZeroCounter,
        Reveal::V1,
        set_of(&dealer_keys)?,
        set_of(players)?,
    )
    .map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let started = std::time::Instant::now();
    let result = feldman_desmedt::run::<MinSig, _, N3f1, ed25519::Batch>(
        rng,
        info,
        dealers.to_vec(),
        players.to_vec(),
        &Sequential,
    )
    .map_err(|e| anyhow::anyhow!("round {counter}: {e}"))?;
    let wall = started.elapsed();
    let dealer_set: Vec<_> = dealer_keys.iter().map(|k| k.public_key()).collect();
    let player_set: Vec<_> = players.iter().map(|k| k.public_key()).collect();
    let participants: Vec<Value> = result
        .traffic
        .iter()
        .map(|(pk, t)| {
            let mut v = traffic_json(t);
            v["dealer"] = json!(dealer_set.contains(pk));
            v["player"] = json!(player_set.contains(pk));
            v
        })
        .collect();
    let summary = json!({
        "kind": if previous.is_some() { "reshare" } else { "dkg" },
        "dealers": dealers.len(),
        "players": players.len(),
        "quorum": result.output.quorum::<N3f1>(),
        "wallMicros": wall.as_micros() as u64,
        "participants": participants,
    });
    Ok((result, summary))
}

fn dkg(rng: &mut impl rand::CryptoRng, name: &str, n: usize) -> anyhow::Result<Committee> {
    let keys = identities(rng, n);
    let dealers: Vec<_> = keys.iter().map(|k| (k.clone(), None)).collect();
    let (result, made) = round(rng, 0, None, &dealers, &keys)?;
    Ok(committee(name, keys, result, made))
}

/// A quorum of `from` deals to `n` fresh members.
fn reshare(
    rng: &mut impl rand::CryptoRng,
    counter: u64,
    from: &Committee,
    name: &str,
    n: usize,
) -> anyhow::Result<Committee> {
    let quorum = from.output.quorum::<N3f1>() as usize;
    let dealers: Vec<_> = from
        .keys
        .iter()
        .zip(&from.shares)
        .take(quorum)
        .map(|(k, s)| (k.clone(), Some(s.clone())))
        .collect();
    let keys = identities(rng, n);
    let (result, made) = round(rng, counter, Some(from), &dealers, &keys)?;
    Ok(committee(name, keys, result, made))
}

fn committee(
    name: &str,
    keys: Vec<ed25519::PrivateKey>,
    result: RunResult<MinSig, ed25519::PublicKey>,
    made: Value,
) -> Committee {
    let shares = keys
        .iter()
        .map(|k| {
            result
                .shares
                .get_value(&k.public_key())
                .expect("every player has a share")
                .clone()
        })
        .collect();
    Committee {
        name: name.into(),
        output: result.output,
        keys,
        shares,
        made,
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match env::var("MODE").as_deref() {
        Ok("measure") => measure(),
        Ok("member") => member(),
        Ok("chain") => chain().await,
        _ => anyhow::bail!("MODE is chain or measure"),
    }
}

fn measure() -> anyhow::Result<()> {
    let sizes: Vec<usize> = env::var("SIZES")
        .unwrap_or_else(|_| "4,7,10,13,16,32,64".into())
        .split(',')
        .map(|s| s.trim().parse())
        .collect::<Result<_, _>>()?;
    let mut rng = rand::rng();
    let mut out = vec![];
    for n in sizes {
        let c0 = dkg(&mut rng, "old", n)?;
        let c1 = reshare(&mut rng, 1, &c0, "new", n)?;
        let unchanged = c0.sharing().public() == c1.sharing().public();
        ensure!(unchanged, "the reshare to {n} changed the key");
        println!(
            "n {n}: dkg {} ms, reshare {} ms in all",
            c0.made["wallMicros"].as_u64().unwrap_or(0) / 1000,
            c1.made["wallMicros"].as_u64().unwrap_or(0) / 1000
        );
        out.push(json!({
            "n": n,
            "keyUnchanged": unchanged,
            "keyEip2537": hex(&g2_eip2537(c1.sharing().public())),
            "dkg": c0.made,
            "reshare": c1.made,
        }));
    }
    if let Ok(path) = env::var("RECORD") {
        let record = json!({
            "mode": "measure",
            "network": "every participant in one process on one machine, in turn, messages passed in memory: no network time",
            "slotSeconds": SLOT,
            "epochSeconds": EPOCH,
            "sizes": out,
        });
        fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&record)?))?;
        println!("recorded in {path}");
    }
    Ok(())
}

/// One member's share of a reshare to `n` members, for sizes where running every member in turn
/// would take hours: the previous key is dealt (`deal`), a quorum of its holders are the dealers,
/// and one dealer deals to `n` fresh players. Every player checks that dealing and acknowledges it,
/// so the dealer's log is the one a full round would publish. Exact: every message's encoded size,
/// and the counts the protocol fixes. Timed: the dealer's own work and each player's check of one
/// dealing. Not run: the other dealers (each the same work) and a player's finalization.
fn member() -> anyhow::Result<()> {
    let sizes: Vec<usize> = env::var("SIZES")
        .unwrap_or_else(|_| "423,512".into())
        .split(',')
        .map(|s| s.trim().parse())
        .collect::<Result<_, _>>()?;
    let mut rng = rand::rng();
    let mut out = vec![];
    for n in sizes {
        let old = identities(&mut rng, n);
        let (previous, old_shares) = deal::<MinSig, _, N3f1>(&mut rng, Mode::NonZeroCounter, set_of(&old)?)
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let q = previous.quorum::<N3f1>() as usize;
        let dealers: Vec<_> = old.iter().take(q).cloned().collect();
        let players = identities(&mut rng, n);
        let info = Info::<MinSig, ed25519::PublicKey>::new::<N3f1>(
            DKG_NAMESPACE,
            1,
            Some(previous.clone()),
            Mode::NonZeroCounter,
            Reveal::V1,
            set_of(&dealers)?,
            set_of(&players)?,
        )
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let share = old_shares.get_value(&dealers[0].public_key()).expect("dealer holds a share").clone();
        let started = std::time::Instant::now();
        let (mut dealer, pub_msg, priv_msgs) = Dealer::start::<N3f1>(&mut rng, info.clone(), dealers[0].clone(), Some(share))
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let dealer_start = started.elapsed();
        let mut checks = vec![];
        let mut ack_bytes = 0usize;
        let mut ack_time = std::time::Duration::ZERO;
        for (to, priv_msg) in &priv_msgs {
            let key = players.iter().find(|k| k.public_key() == *to).context("every dealing has its player")?;
            let mut player = Player::new(info.clone(), key.clone()).map_err(|e| anyhow::anyhow!("{e:?}"))?;
            let t = std::time::Instant::now();
            let ack = player
                .dealer_message::<N3f1>(dealers[0].public_key(), pub_msg.clone(), priv_msg.clone())
                .map_err(|e| anyhow::anyhow!("{e:?}"))?
                .context("a fresh dealing is acknowledged")?;
            checks.push(t.elapsed().as_micros() as u64);
            ack_bytes = ack.encode_size();
            let t = std::time::Instant::now();
            dealer.receive_player_ack(to.clone(), ack).map_err(|e| anyhow::anyhow!("{e:?}"))?;
            ack_time += t.elapsed();
        }
        let t = std::time::Instant::now();
        let log = dealer.finalize::<N3f1>();
        let finalize = t.elapsed();
        let log_b = log.encode_size();
        ensure!(log.check(&info).is_some(), "the dealer's log checks");
        let (pub_b, priv_b) = (pub_msg.encode_size(), priv_msgs[0].1.encode_size());
        checks.sort_unstable();
        let check_median = checks[checks.len() / 2];
        let t_faults = n - q;
        println!("n {n}: q {q}, dealer {} ms, a player's check {} us (median)", dealer_start.as_millis(), check_median);
        out.push(json!({
            "n": n,
            "quorum": q,
            "dealers": q,
            "bytes": {
                "dealerPubMsg": pub_b,
                "dealerPrivMsg": priv_b,
                "playerAck": ack_bytes,
                "dealerLog": log_b,
            },
            "exactPerDealer": {
                "messagesSent": 2 * n,
                "messagesReceived": n,
                "bytesSent": n * (pub_b + priv_b) + n * log_b,
                "bytesReceived": n * ack_bytes,
                "uniqueBytesSent": pub_b + n * priv_b + log_b,
                "rounds": 3,
            },
            "exactPerPlayer": {
                "messagesSent": q,
                "messagesReceived": 2 * q,
                "bytesSent": q * ack_bytes,
                "bytesReceived": q * (pub_b + priv_b + log_b),
                "rounds": 3,
            },
            "timed": {
                "dealerStartMicros": dealer_start.as_micros() as u64,
                "dealerAcksMicros": ack_time.as_micros() as u64,
                "dealerFinalizeMicros": finalize.as_micros() as u64,
                "playerCheckMicrosMedian": check_median,
                "playerChecksMeasured": checks.len(),
            },
            "derived": {
                "playerChecksMicros": check_median * q as u64,
                "note": "a player checks one dealing from each of the q dealers; its finalization (checking the q logs' acknowledgements and interpolating its share) is not measured here",
            },
            "postFigure32nPlus48t": 32 * n + 48 * t_faults,
            "faults": t_faults,
        }));
    }
    if let Ok(path) = env::var("RECORD") {
        let record = json!({
            "mode": "member",
            "network": "one dealer and every player's check of its dealing, in one process on one machine, in memory: no network time",
            "slotSeconds": SLOT,
            "epochSeconds": EPOCH,
            "sizes": out,
        });
        fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&record)?))?;
        println!("recorded in {path}");
    }
    Ok(())
}

async fn chain() -> anyhow::Result<()> {
    let url = env::var("RPC_URL").unwrap_or_else(|_| HEGOTA_RPC_URL.to_owned());
    let node_url = env::var("SEND_RPC_URL").context("SEND_RPC_URL is the node the spends go to")?;
    let funder: PrivateKeySigner = env::var("PRIVATE_KEY")
        .context("PRIVATE_KEY deploys the paymasters and buys the tickets")?
        .parse()?;
    let chain = ProviderBuilder::new().connect_http(url.parse()?);
    let node = ProviderBuilder::new().connect_http(node_url.parse()?);
    let chain_id = chain.get_chain_id().await?;
    let mut rng = rand::rng();

    // Arm A, reshare: committee A0 by DKG and its one paymaster, four tickets.
    let a0 = dkg(&mut rng, "A0", SIZES[0])?;
    let pm_a = TicketPaymaster {
        key: *a0.sharing().public(),
        denomination: DENOMINATION,
        salt: B256::from(rng.random::<[u8; 32]>()),
    };
    // Arm B, a fresh DKG each epoch: committee B0 and its paymaster, one ticket; each later
    // committee registers its own key with a paymaster of its own.
    let b0 = dkg(&mut rng, "B0", SIZES[0])?;
    let pm_b0 = TicketPaymaster {
        key: *b0.sharing().public(),
        denomination: DENOMINATION,
        salt: B256::from(rng.random::<[u8; 32]>()),
    };
    println!("arm A paymaster {}, arm B's first {}", pm_a.address(), pm_b0.address());
    let setup = send(
        &chain,
        &funder,
        vec![pm_a.deploy_frame(), pm_a.buy_frame(BUY), pm_b0.deploy_frame(), pm_b0.buy_frame(1)],
        chain_id,
    )
    .await?;
    let mut ledger_a = Ledger::new(bought(&chain, pm_a.address()).await?);
    let fees = rpc::suggest_fees(&chain, TIP).await?;

    let mut arm_a: Vec<Committee> = vec![a0];
    let mut arm_b: Vec<(Committee, TicketPaymaster, Value)> = vec![(b0, pm_b0, json!({ "setup": setup["hash"] }))];
    let mut rounds = vec![];
    let mut last_epoch = 0u64;
    for k in 0..SIZES.len() {
        let (epoch, head_time) = next_epoch(&chain, last_epoch).await?;
        last_epoch = epoch;
        let mut handoff_a = Value::Null;
        let mut handoff_b = Value::Null;
        if k > 0 {
            // A: reshare from a quorum of the last committee.
            let started = std::time::Instant::now();
            let next = reshare(&mut rng, k as u64, &arm_a[k - 1], &format!("A{k}"), SIZES[k])?;
            ensure!(
                next.sharing().public() == arm_a[0].sharing().public(),
                "the reshare to committee A{k} changed the key"
            );
            handoff_a = json!({
                "from": k - 1,
                "to": k,
                "micros": started.elapsed().as_micros() as u64,
                "secondsIntoEpoch": head_time % EPOCH,
            });
            arm_a.push(next);
            // B: a fresh DKG, and its key registered: a new paymaster, deployed and funded.
            let started = std::time::Instant::now();
            let fresh = dkg(&mut rng, &format!("B{k}"), SIZES[k])?;
            let dkg_micros = started.elapsed().as_micros() as u64;
            let pm = TicketPaymaster {
                key: *fresh.sharing().public(),
                denomination: DENOMINATION,
                salt: B256::from(rng.random::<[u8; 32]>()),
            };
            let registration = send(&chain, &funder, vec![pm.deploy_frame(), pm.buy_frame(1)], chain_id).await?;
            handoff_b = json!({
                "dkgMicros": dkg_micros,
                "secondsIntoEpoch": head_time % EPOCH,
                "registration": registration,
                "paymaster": pm.address(),
            });
            println!("epoch {epoch}: A reshared to {} members; B registered a fresh key at {}", SIZES[k], pm.address());
            arm_b.push((fresh, pm, handoff_b.clone()));
        }
        let spent_a = spend_round(&chain, &node, &funder, chain_id, fees, &mut ledger_a, &arm_a[k], pm_a.address(), epoch, k, true).await?;
        let (cb, pmb, _) = &arm_b[k];
        let mut ledger_b = Ledger::new(bought(&chain, pmb.address()).await?);
        let spent_b = spend_round(&chain, &node, &funder, chain_id, fees, &mut ledger_b, cb, pmb.address(), epoch, k, true).await?;
        rounds.push(json!({
            "round": k,
            "epoch": epoch,
            "a": { "committee": k, "handoff": handoff_a, "spend": spent_a },
            "b": { "committee": k, "handoff": handoff_b, "paymaster": pmb.address(), "spend": spent_b },
        }));
    }

    // The first committees again, with the shares they kept: A0 at the one paymaster, B0 at the
    // paymaster B's latest key was registered with.
    let (epoch, _) = next_epoch(&chain, last_epoch).await?;
    let retired_a = spend_round(&chain, &node, &funder, chain_id, fees, &mut ledger_a, &arm_a[0], pm_a.address(), epoch, SIZES.len(), false).await?;
    let (_, latest_pm, _) = &arm_b[SIZES.len() - 1];
    let mut ledger_latest = Ledger::new(BTreeMap::from([(funder.address(), 1u64)]));
    let retired_b = spend_round(&chain, &node, &funder, chain_id, fees, &mut ledger_latest, &arm_b[0].0, latest_pm.address(), epoch, SIZES.len(), false).await?;
    rounds.push(json!({
        "round": SIZES.len(),
        "epoch": epoch,
        "retired": true,
        "a": { "committee": 0, "paymaster": pm_a.address(), "spend": retired_a },
        "b": { "committee": 0, "paymaster": latest_pm.address(), "spend": retired_b },
    }));

    if let Ok(path) = env::var("RECORD") {
        let code_of = |pm: &TicketPaymaster| {
            let chain = &chain;
            let pm = pm.address();
            async move {
                let code = chain.get_code_at(pm).await?;
                anyhow::Ok(json!({
                    "paymaster": pm,
                    "bytes": code.len(),
                    "templateHash": keccak256(&code[..code.len().saturating_sub(256 + 32)]),
                    "key": hex(&code[code.len().saturating_sub(256 + 32)..code.len().saturating_sub(32)]),
                    "denomination": hex(&code[code.len().saturating_sub(32)..]),
                }))
            }
        };
        let mut codes_b = vec![];
        for (_, pm, _) in &arm_b {
            codes_b.push(code_of(pm).await?);
        }
        let committee_json = |c: &Committee| json!({
            "name": c.name,
            "members": c.keys.len(),
            "quorum": c.sharing().required(),
            "keyEip2537": hex(&g2_eip2537(c.sharing().public())),
            "identities": c.keys.iter().map(|k| hex(&k.public_key().encode())).collect::<Vec<_>>(),
            "made": c.made,
        });
        let record = json!({
            "mode": "chain",
            "chainId": chain_id,
            "namespace": String::from_utf8_lossy(NAMESPACE),
            "denomination": DENOMINATION,
            "funder": funder.address(),
            "setup": setup,
            "a": {
                "code": code_of(&pm_a).await?,
                "committees": arm_a.iter().map(committee_json).collect::<Vec<_>>(),
            },
            "b": {
                "codes": codes_b,
                "committees": arm_b.iter().map(|(c, _, _)| committee_json(c)).collect::<Vec<_>>(),
            },
            "rounds": rounds,
        });
        fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&record)?))?;
        println!("recorded in {path}");
    }
    Ok(())
}

/// One ticket from `committee`, blindly issued to the funder for a fresh sender, spent through
/// the paymaster at the node, and its receipt.
#[allow(clippy::too_many_arguments)]
async fn spend_round<P: Provider>(
    chain: &P,
    node: &P,
    funder: &PrivateKeySigner,
    chain_id: u64,
    fees: Fees,
    ledger: &mut Ledger,
    committee: &Committee,
    pm: Address,
    epoch: u64,
    round: usize,
    must: bool,
) -> anyhow::Result<Value> {
    let (sender, ticket, answers) = issue(committee, ledger, funder, chain_id, epoch, round)?;
    let tx = spend(chain_id, fees, &sender, &ticket, pm, round)?;
    ensure!(max_cost(&tx, 0)? <= DENOMINATION, "a spend costs more than a ticket");
    let answer = match rpc::send(node, &tx).await {
        Ok(hash) => json!({ "result": hash }),
        Err(e) => json!({ "error": e.to_string() }),
    };
    println!("round {round}, committee {}: {} -> {answer}", committee.name, tx.hash());
    let common = json!({
        "hash": tx.hash(),
        "raw": tx.encode(),
        "answer": answer,
        "sender": sender.address(),
        "epoch": ticket.claim.epoch,
        "salt": ticket.claim.salt,
        "signature": hex(&ticket.signature.encode()),
        "answers": answers,
    });
    if answer.get("result").is_none() {
        ensure!(!must, "the node refused committee {}'s spend: {answer}", committee.name);
        let mut v = common;
        v["admitted"] = json!(false);
        return Ok(v);
    }
    let receipt = rpc::wait_for_confirmed_receipt(chain, tx.hash(), Duration::from_mins(4), Duration::from_secs(2)).await?;
    let pay = &receipt.frame_receipts[1];
    println!("round {round}: block {}, payer {}", receipt.block_number, receipt.payer);
    ensure!(!must || receipt.payer == pm, "the paymaster did not pay");
    Ok(json!({
        "admitted": true,
        "hash": tx.hash(),
        "raw": tx.encode(),
        "answer": answer,
        "block": receipt.block_number,
        "gasUsed": receipt.gas_used,
        "payVerify": { "gasUsed": pay.gas_used, "stateGasUsed": pay.state_gas_used },
        "payer": receipt.payer,
        "sender": sender.address(),
        "epoch": ticket.claim.epoch,
        "salt": ticket.claim.salt,
        "signature": hex(&ticket.signature.encode()),
        "answers": answers,
    }))
}

/// The head's epoch once it is later than `after` and at least `MARGIN` seconds of it remain,
/// with the head's timestamp.
async fn next_epoch<P: Provider>(chain: &P, after: u64) -> anyhow::Result<(u64, u64)> {
    loop {
        let head = chain.get_block_by_number(BlockNumberOrTag::Latest).await?.context("no head")?;
        let t = head.header.timestamp;
        let left = EPOCH - t % EPOCH;
        if epoch_of(t) > after && left >= MARGIN {
            return Ok((epoch_of(t), t));
        }
        let wait = if epoch_of(t) > after { left + 6 } else { left + 6 };
        println!("epoch {}, {left} s left: waiting for the next", epoch_of(t));
        tokio::time::sleep(Duration::from_secs(wait)).await;
    }
}

fn claim(chain_id: u64, sender: Address, epoch: u64, rng: &mut impl rand::Rng) -> Claim {
    Claim {
        slot: Slot { chain_id, sender, nonce_keys: vec![U256::ZERO], nonce_seq: 0 },
        epoch,
        salt: B256::from(rng.random::<[u8; 32]>()),
    }
}

/// One ticket from a quorum of `committee`, issued blindly to the funder for a fresh sender's
/// first slot; every answer checked against its member's public share.
fn issue(
    committee: &Committee,
    ledger: &mut Ledger,
    buyer: &PrivateKeySigner,
    chain_id: u64,
    epoch: u64,
    round: usize,
) -> anyhow::Result<(PrivateKeySigner, Ticket, Vec<Value>)> {
    let mut rng = rand::rng();
    let sender = PrivateKeySigner::random();
    let claim = claim(chain_id, sender.address(), epoch, &mut rng);
    let (blinded, blinding) = blind::blind(&mut rng, NAMESPACE, &claim.message());
    let digest = keccak256([b"kohaku-ticket-request".as_slice(), &blinded.encode()].concat());
    let signature = buyer.sign_hash_sync(&digest)?;
    let signer = signature.recover_address_from_prehash(&digest)?;
    ensure!(signer == buyer.address(), "a request not signed by its buyer");
    let quorum = committee.sharing().required() as usize;
    let mut answers: Vec<PartialSignature<MinSig>> = vec![];
    let mut transcript = vec![];
    // A quorum that starts at a member that moves with the round, so committees answer with
    // different members.
    let n = committee.shares.len();
    for j in 0..quorum {
        let i = (round + j) % n;
        ledger.admit(Count::Shared, i, signer, request_id(&blinded))?;
        let a = blind::answer(&committee.shares[i], &blinded);
        transcript.push(json!({
            "member": i,
            "index": a.index.get(),
            "blinded": hex(&blinded.encode()),
            "answer": hex(&a.value.encode()),
        }));
        answers.push(a);
    }
    for a in &answers {
        blind::check_answer(committee.sharing(), &blinded, a)
            .map_err(|e| anyhow::anyhow!("a member's answer does not check: {e:?}"))?;
    }
    let ticket = Ticket {
        signature: blind::unblind(committee.sharing(), &answers, &blinding).map_err(|e| anyhow::anyhow!("{e:?}"))?,
        claim,
    };
    ticket
        .verify(committee.sharing())
        .map_err(|e| anyhow::anyhow!("an unblinded ticket does not verify: {e:?}"))?;
    println!("committee {}: ticket issued by {quorum} of {n}", committee.name);
    Ok((sender, ticket, transcript))
}

async fn send<P: Provider>(provider: &P, key: &PrivateKeySigner, calls: Vec<Frame>, chain_id: u64) -> anyhow::Result<Value> {
    let account = Eoa::new(Signer::secp256k1(key.address()));
    let envelope = Envelope::fetch(provider, key.address(), vec![U256::ZERO], TIP).await?;
    ensure!(envelope.chain_id == chain_id);
    let mut tx = TxPlan::new(&account).calls(calls).build(&envelope)?;
    sign_all(&mut tx, &[FrameSigner::Secp256k1(key.clone())])?;
    let done = rpc::execute(provider, &tx, true).await?;
    println!("setup {}: block {}, gasUsed {}", done.hash, done.receipt.block_number, done.receipt.gas_used);
    Ok(json!({
        "hash": done.hash,
        "raw": tx.encode(),
        "block": done.receipt.block_number,
        "gasUsed": done.receipt.gas_used,
    }))
}

async fn bought<P: Provider>(provider: &P, paymaster: Address) -> anyhow::Result<BTreeMap<Address, u64>> {
    let logs = provider
        .get_logs(
            &alloy::rpc::types::Filter::new()
                .address(paymaster)
                .event_signature(Bought::SIGNATURE_HASH)
                .from_block(provider.get_block_number().await?.saturating_sub(1_000)),
        )
        .await?;
    let mut out = BTreeMap::new();
    for l in &logs {
        let e = Bought::decode_log(&l.inner)?;
        *out.entry(e.buyer).or_default() += e.count.to::<u64>();
    }
    Ok(out)
}

fn hex(b: &[u8]) -> String {
    format!("0x{}", ::hex::encode(b))
}

fn spend(chain_id: u64, fees: Fees, sender: &PrivateKeySigner, ticket: &Ticket, paymaster: Address, round: usize) -> anyhow::Result<FrameTx> {
    let account = Eoa::new(Signer::secp256k1(sender.address()));
    let mut sponsor = TicketSponsor::new(paymaster, ticket);
    let message = format!("C3: paid with a ticket from round {round}");
    let mut tx = TxPlan::new(&account)
        .sponsored_by(&mut sponsor)
        .call(
            Frame::sender(Some(BOARD))
                .with_data(postCall { message: message.into_bytes().into() }.abi_encode())
                .with_execution(30_000),
        )
        .build(&Envelope { chain_id, nonce_keys: vec![U256::ZERO], nonce_seq: 0, fees })?;
    sign_all(&mut tx, &[FrameSigner::Secp256k1(sender.clone())])?;
    Ok(tx)
}
