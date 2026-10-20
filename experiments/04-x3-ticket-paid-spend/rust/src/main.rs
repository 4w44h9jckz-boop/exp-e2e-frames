//! X3, the private sender's whole path: a fresh sender's first transaction, paid with a blind
//! ticket, sent to a skandha node that checks the ticket itself, and mined.
//!
//! ```text
//! PRIVATE_KEY=0x... SEND_RPC_URL=http://127.0.0.1:14337/rpc/ RECORD=out.json \
//!   cargo run --release --manifest-path experiments/04-x3-ticket-paid-spend/rust/Cargo.toml
//! ```
//!
//! 1. Two issuer sets, each four issuers from its own run of Commonware's DKG, a quorum of three.
//! 2. The funder deploys a `TicketPaymaster` for each set's key and buys tickets from both, in
//!    one transaction sent to the chain. The node is told neither address nor key.
//! 3. Two spends the node must refuse before it asks its client: a signature that is no ticket,
//!    and a ticket of set A carried to set B's paymaster.
//! 4. Rounds: in each, one ticket from each set is issued blindly for a fresh sender's first
//!    slot in the current epoch, and both spends go to the node at once, one per paymaster. The
//!    next round waits until both are mined.
//!
//! `RECORD` names a JSON file for every transaction, the node's answers, both sets' public keys
//! and the issuers' transcripts. No private key, share or blinding factor is recorded or printed.

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
use commonware_codec::Encode;
use commonware_cryptography::bls12381::primitives::{
    group::{G1, Scalar},
    variant::{MinSig, PartialSignature},
};
use commonware_math::algebra::{CryptoGroup, Random};
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
    Claim, Committee, Slot, Ticket, TicketPaymaster, TicketSponsor, blind,
    issuers::{Count, Ledger, request_id},
    paymaster::Bought,
    ticket::{NAMESPACE, epoch_of, g2_eip2537},
};
use rand::RngExt;
use serde_json::{Value, json};

/// `exp-frames` experiment 33's board: `post(bytes)` logs `Posted(bytes)`.
const BOARD: Address = address!("0x93DD748B72dA1b1B6F1d5ec78Cb91ee52F01727d");
/// 0.001 ETH a ticket, as `exp-frames` experiment 36.
const DENOMINATION: U256 = U256::from_limbs([1_000_000_000_000_000, 0, 0, 0]);
const TIP: u128 = 1_000_000_000;
const ISSUERS: usize = 4;
const ROUNDS: usize = 2;
/// Set A sells one ticket more than the rounds use: the ticket carried to set B's paymaster.
const BUY: [u64; 2] = [ROUNDS as u64 + 1, ROUNDS as u64];
/// The seconds of an epoch a round needs: issuance, two spends and their admission.
const MARGIN: u64 = 120;
const EPOCH: u64 = 384;

sol! {
    function post(bytes message);
}

/// One issuer set: its committee, its paymaster, the ledger of what the funder bought, and the
/// issuers' transcripts.
struct Set {
    name: &'static str,
    committee: Committee,
    paymaster: TicketPaymaster,
    ledger: Option<Ledger>,
    transcripts: Vec<Vec<Value>>,
    issued: usize,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let url = env::var("RPC_URL").unwrap_or_else(|_| HEGOTA_RPC_URL.to_owned());
    let node_url = env::var("SEND_RPC_URL").context("SEND_RPC_URL is the node the spends go to")?;
    let funder: PrivateKeySigner = env::var("PRIVATE_KEY")
        .context("PRIVATE_KEY deploys the paymasters and buys the tickets")?
        .parse()?;
    let chain = ProviderBuilder::new().connect_http(url.parse()?);
    let node = ProviderBuilder::new().connect_http(node_url.parse()?);
    let chain_id = chain.get_chain_id().await?;
    let mut rng = rand::rng();

    // 1. Two issuer sets.
    let mut sets = vec![];
    for name in ["A", "B"] {
        let committee = Committee::dkg(&mut rng, ISSUERS)?;
        let paymaster = TicketPaymaster {
            key: *committee.sharing.public(),
            denomination: DENOMINATION,
            salt: B256::from(rng.random::<[u8; 32]>()),
        };
        println!(
            "set {name}: {ISSUERS} issuers, quorum {}, paymaster {}",
            committee.quorum(),
            paymaster.address()
        );
        sets.push(Set {
            name,
            committee,
            paymaster,
            ledger: None,
            transcripts: vec![vec![]; ISSUERS],
            issued: 0,
        });
    }

    // 2. Deploy both paymasters and buy from both, in one transaction to the chain.
    let setup = send(
        &chain,
        &funder,
        vec![
            sets[0].paymaster.deploy_frame(),
            sets[0].paymaster.buy_frame(BUY[0]),
            sets[1].paymaster.deploy_frame(),
            sets[1].paymaster.buy_frame(BUY[1]),
        ],
        chain_id,
    )
    .await?;
    let mut code = vec![];
    for set in &mut sets {
        let pm = set.paymaster.address();
        set.ledger = Some(Ledger::new(bought(&chain, pm).await?));
        let c = chain.get_code_at(pm).await?;
        code.push(json!({
            "set": set.name,
            "paymaster": pm,
            "bytes": c.len(),
            "codeHash": keccak256(&c),
            "templateHash": keccak256(&c[..c.len().saturating_sub(256 + 32)]),
            "key": hex(&c[c.len().saturating_sub(256 + 32)..c.len().saturating_sub(32)]),
            "denomination": hex(&c[c.len().saturating_sub(32)..]),
        }));
    }
    let fees = rpc::suggest_fees(&chain, TIP).await?;

    // 3. Two spends the node must refuse before it asks its client.
    let epoch = epoch_with_margin(&chain).await?;
    let junk_sender = PrivateKeySigner::random();
    let junk = Ticket {
        claim: claim(chain_id, junk_sender.address(), epoch, &mut rng),
        signature: G1::generator() * &Scalar::random(&mut rng),
    };
    let tx = spend(chain_id, fees, &junk_sender, &junk, sets[0].paymaster.address())?;
    let mut refused = vec![refuse(&node, "a signature that is no ticket, set A's paymaster", &tx).await?];
    let (crossed_sender, crossed) = issue(&mut sets[0], &funder, chain_id, epoch)?;
    let tx = spend(
        chain_id,
        fees,
        &crossed_sender,
        &crossed,
        sets[1].paymaster.address(),
    )?;
    refused.push(
        refuse(&node, "a ticket of set A carried to set B's paymaster", &tx).await?,
    );

    // 4. Rounds of one spend from each set, sent to the node at once.
    let mut rounds = vec![];
    for r in 0..ROUNDS {
        let epoch = epoch_with_margin(&chain).await?;
        let mut sent = vec![];
        for set in &mut sets {
            let (sender, ticket) = issue(set, &funder, chain_id, epoch)?;
            let tx = spend(chain_id, fees, &sender, &ticket, set.paymaster.address())?;
            ensure!(
                max_cost(&tx, 0)? <= DENOMINATION,
                "a spend costs more than a ticket"
            );
            let answer = match rpc::send(&node, &tx).await {
                Ok(hash) => json!({ "result": hash }),
                Err(e) => json!({ "error": e.to_string() }),
            };
            println!("round {r}, set {}: {} -> {answer}", set.name, tx.hash());
            sent.push((set.name, set.paymaster.address(), sender, ticket, tx, answer));
        }
        let mut spends = vec![];
        for (name, pm, sender, ticket, tx, answer) in sent {
            ensure!(
                answer.get("result").is_some(),
                "the node refused set {name}'s spend: {answer}"
            );
            let receipt = rpc::wait_for_confirmed_receipt(
                &chain,
                tx.hash(),
                Duration::from_mins(4),
                Duration::from_secs(2),
            )
            .await?;
            let pay = &receipt.frame_receipts[1];
            println!(
                "round {r}, set {name}: block {}, payer {}, pay VERIFY {} execution",
                receipt.block_number, receipt.payer, pay.gas_used
            );
            ensure!(receipt.payer == pm, "set {name}'s paymaster did not pay");
            spends.push(json!({
                "set": name,
                "paymaster": pm,
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
            }));
        }
        rounds.push(json!({ "round": r, "epoch": epoch, "spends": spends }));
    }

    if let Ok(path) = env::var("RECORD") {
        let record = json!({
            "chainId": chain_id,
            "namespace": String::from_utf8_lossy(NAMESPACE),
            "denomination": DENOMINATION,
            "sets": sets.iter().map(|s| json!({
                "name": s.name,
                "issuers": ISSUERS,
                "quorum": s.committee.quorum(),
                "paymaster": s.paymaster.address(),
                "keyEip2537": hex(&g2_eip2537(s.committee.sharing.public())),
                "bought": BUY[if s.name == "A" { 0 } else { 1 }],
                "issued": s.issued,
                "transcripts": s.committee.issuers.iter().zip(&s.transcripts).map(|(i, t)| json!({
                    "index": i.index(),
                    "answers": t,
                })).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "funder": funder.address(),
            "setup": setup,
            "code": code,
            "refused": refused,
            "rounds": rounds,
        });
        fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&record)?))?;
        println!("recorded in {path}");
    }
    Ok(())
}

/// The head's epoch, once at least `MARGIN` seconds of it remain: otherwise wait for the next.
async fn epoch_with_margin<P: Provider>(chain: &P) -> anyhow::Result<u64> {
    loop {
        let head = chain
            .get_block_by_number(BlockNumberOrTag::Latest)
            .await?
            .context("no head")?;
        let t = head.header.timestamp;
        let left = EPOCH - t % EPOCH;
        if left >= MARGIN {
            return Ok(epoch_of(t));
        }
        println!("{left} s left in epoch {}: waiting for the next", epoch_of(t));
        tokio::time::sleep(Duration::from_secs(left + 6)).await;
    }
}

fn claim(chain_id: u64, sender: Address, epoch: u64, rng: &mut impl rand::Rng) -> Claim {
    Claim {
        slot: Slot {
            chain_id,
            sender,
            nonce_keys: vec![U256::ZERO],
            nonce_seq: 0,
        },
        epoch,
        salt: B256::from(rng.random::<[u8; 32]>()),
    }
}

/// One ticket from `set`, issued blindly to the funder for a fresh sender's first slot: a
/// quorum that leaves out one issuer in turn, each answer checked against its issuer's share.
fn issue(
    set: &mut Set,
    buyer: &PrivateKeySigner,
    chain_id: u64,
    epoch: u64,
) -> anyhow::Result<(PrivateKeySigner, Ticket)> {
    let mut rng = rand::rng();
    let sender = PrivateKeySigner::random();
    let claim = claim(chain_id, sender.address(), epoch, &mut rng);
    let (blinded, blinding) = blind::blind(&mut rng, NAMESPACE, &claim.message());
    let left_out = set.issued % ISSUERS;
    let digest = keccak256(
        [
            b"kohaku-ticket-request".as_slice(),
            &blinded.encode(),
        ]
        .concat(),
    );
    let signature = buyer.sign_hash_sync(&digest)?;
    let ledger = set.ledger.as_mut().context("no ledger before the purchase")?;
    let mut answers: Vec<PartialSignature<MinSig>> = vec![];
    for (i, issuer) in set.committee.issuers.iter_mut().enumerate() {
        if i == left_out {
            continue;
        }
        let signer = signature.recover_address_from_prehash(&digest)?;
        ensure!(signer == buyer.address(), "a request not signed by its buyer");
        ledger.admit(Count::Shared, i, signer, request_id(&blinded))?;
        let a = issuer.answer(&blinded);
        set.transcripts[i].push(json!({
            "buyer": signer,
            "blinded": hex(&blinded.encode()),
            "answer": hex(&a.value.encode()),
        }));
        answers.push(a);
    }
    for a in &answers {
        blind::check_answer(&set.committee.sharing, &blinded, a)
            .map_err(|e| anyhow::anyhow!("an issuer's answer does not check: {e:?}"))?;
    }
    let ticket = Ticket {
        signature: blind::unblind(&set.committee.sharing, &answers, &blinding)
            .map_err(|e| anyhow::anyhow!("{e:?}"))?,
        claim,
    };
    ticket
        .verify(&set.committee.sharing)
        .map_err(|e| anyhow::anyhow!("an unblinded ticket does not verify: {e:?}"))?;
    set.issued += 1;
    println!("set {}: ticket issued, issuer {left_out} left out", set.name);
    Ok((sender, ticket))
}

/// Send a spend the node must refuse: its answer.
async fn refuse<P: Provider>(node: &P, what: &str, tx: &FrameTx) -> anyhow::Result<Value> {
    let answer = match rpc::send(node, tx).await {
        Ok(hash) => json!({ "result": hash }),
        Err(e) => json!({ "error": e.to_string() }),
    };
    println!("{what}: {} -> {answer}", tx.hash());
    ensure!(answer.get("result").is_none(), "the node admitted: {what}");
    Ok(json!({
        "what": what,
        "hash": tx.hash(),
        "raw": tx.encode(),
        "answer": answer,
    }))
}

/// The funder's own transaction making `calls`, simulated, sent to the chain and confirmed.
async fn send<P: Provider>(
    provider: &P,
    key: &PrivateKeySigner,
    calls: Vec<Frame>,
    chain_id: u64,
) -> anyhow::Result<Value> {
    let account = Eoa::new(Signer::secp256k1(key.address()));
    let envelope = Envelope::fetch(provider, key.address(), vec![U256::ZERO], TIP).await?;
    ensure!(envelope.chain_id == chain_id);
    let mut tx = TxPlan::new(&account).calls(calls).build(&envelope)?;
    sign_all(&mut tx, &[FrameSigner::Secp256k1(key.clone())])?;
    let done = rpc::execute(provider, &tx, true).await?;
    println!(
        "setup {}: block {}, gasUsed {}",
        done.hash, done.receipt.block_number, done.receipt.gas_used
    );
    Ok(json!({
        "hash": done.hash,
        "raw": tx.encode(),
        "block": done.receipt.block_number,
        "gasUsed": done.receipt.gas_used,
    }))
}

/// Tickets bought from `paymaster`, by buyer, from its `Bought` logs.
async fn bought<P: Provider>(
    provider: &P,
    paymaster: Address,
) -> anyhow::Result<BTreeMap<Address, u64>> {
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

/// A fresh sender's first transaction, paid with `ticket` through `paymaster`: it posts to the
/// board.
fn spend(
    chain_id: u64,
    fees: Fees,
    sender: &PrivateKeySigner,
    ticket: &Ticket,
    paymaster: Address,
) -> anyhow::Result<FrameTx> {
    let account = Eoa::new(Signer::secp256k1(sender.address()));
    let mut sponsor = TicketSponsor::new(paymaster, ticket);
    let mut tx = TxPlan::new(&account)
        .sponsored_by(&mut sponsor)
        .call(
            Frame::sender(Some(BOARD))
                .with_data(
                    postCall {
                        message: b"X3: paid with a blind ticket".to_vec().into(),
                    }
                    .abi_encode(),
                )
                .with_execution(30_000),
        )
        .build(&Envelope {
            chain_id,
            nonce_keys: vec![U256::ZERO],
            nonce_seq: 0,
            fees,
        })?;
    sign_all(&mut tx, &[FrameSigner::Secp256k1(sender.clone())])?;
    Ok(tx)
}
