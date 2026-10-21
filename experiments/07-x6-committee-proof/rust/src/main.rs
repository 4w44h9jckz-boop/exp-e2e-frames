//! X6's runner: the parts of experiment 07 that build and send transactions.
//!
//! ```text
//! x6-committee-runner inputs   --recipient <address> --out <inputs.json>
//! x6-committee-runner withdraw --withdrawal <withdrawal.json> --members <members.json>
//! x6-committee-runner update   --members <members.json> --code <CommitteeAccount.hex>
//! x6-committee-runner unproved --withdrawal <withdrawal.json>
//! ```
//!
//! - `inputs`: the stand-in's note. A fresh note, the second of three leaves in a tree of its own,
//!   and the withdrawal circuit's inputs for spending it to `recipient` with no relayer, fee or
//!   refund, as co-withdraw builds them. `inputs.json` holds the note's secrets; it is the
//!   client's, and run.ts deletes it once it is shared.
//! - `withdraw`: the committee's proof put into the withdrawal kohaku-rs's `share_withdrawal`
//!   shared, as the wallet would build it around its own proof. Simulated on the chain, sent to
//!   `SEND_RPC_URL`, awaited; then the same bytes again.
//! - `update`: the shared-state update. The funder deploys `CommitteeAccount` with the stand-in's
//!   root and the pool's verifier appended, and funds a fresh payer, in one transaction to the
//!   chain. The update is simulated, sent to `SEND_RPC_URL`, awaited; then the same bytes again,
//!   and the recipient's balance read back.
//! - `unproved`: once the committee has stopped, the withdrawal of a note it held, with 256 zero
//!   bytes where the proof goes: what the chain alone allows. Offered to `SEND_RPC_URL` and
//!   recorded whatever the node answers.
//!
//! `RECORD` names a JSON file for every transaction, its simulation and the node's answer. No key,
//! note or share is recorded or printed; the payer's key exists only in this process.

use std::{env, fs, time::Duration};

use alloy::{
    primitives::{Address, B256, Bytes, U256, address},
    providers::{Provider, ProviderBuilder},
    rpc::types::TransactionRequest,
    signers::local::PrivateKeySigner,
    sol,
    sol_types::SolCall,
};
use anyhow::{Context, bail, ensure};
use kohaku_frame_accounts::{
    account::{Eoa, Signer},
    builder::{Envelope, TxPlan},
    contracts::{create2_address, deploy_frame},
};
use kohaku_frame_kit::{
    Frame, FrameSignature, FrameSigner, FrameTx,
    constants::{NEW_ACCOUNT_STATE_GAS, STORAGE_SET_STATE_GAS, approve, scheme},
    rpc::{self, HEGOTA_RPC_URL},
    sign_all,
};
use kohaku_frame_pool::{
    PublicInputs,
    chain::WALLET_FEES,
    withdrawal::{FramePool, PoolMode, WithdrawalOpts, withdrawal_tx},
};
use rand::RngExt;
use serde::Deserialize;
use serde_json::{Value, json};

/// The patched Tornado verifier experiment 01's pool calls, and C2's proofs were checked against.
const VERIFIER: Address = address!("0x87a7C1f76b03dA00de489897d436BbEDDd2133b7");
const TIP: u128 = 1_000_000_000;
/// What the funder gives the payer for the update's gas.
const PAYER_FUND: U256 = U256::from_limbs([20_000_000_000_000_000, 0, 0, 0]);
/// The account's `VERIFY`: the layout checks and the verifier's pairing check.
const UPDATE_VERIFY_EXECUTION: u64 = 300_000;
const PAYER_VERIFY_EXECUTION: u64 = 10_000;
const CREDIT_EXECUTION: u64 = 60_000;

sol! {
    function credit(address recipient, bytes32 nullifierHash);
    function balanceOf(address who) returns (uint256);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Member {
    member: usize,
    solidity: String,
    public_inputs: Vec<String>,
    verified: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Withdrawal {
    chain_id: u64,
    pool: Address,
    salt: B256,
    root_slot: u64,
    public_inputs: PublicInputs,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    let arg = |name: &str| -> anyhow::Result<String> {
        let i = args.iter().position(|a| a == name).with_context(|| format!("{name} is needed"))?;
        args.get(i + 1).cloned().with_context(|| format!("{name} needs a value"))
    };
    match args.first().map(String::as_str) {
        Some("inputs") => inputs(arg("--recipient")?.parse()?, &arg("--out")?),
        Some("withdraw") => withdraw(&arg("--withdrawal")?, &arg("--members")?).await,
        Some("update") => update(&arg("--members")?, &arg("--code")?).await,
        Some("unproved") => unproved(&arg("--withdrawal")?).await,
        _ => bail!("usage: x6-committee-runner inputs|withdraw|update|unproved ..."),
    }
}

/// The stand-in's note and its circuit inputs, written to `out`; only the public half is printed.
fn inputs(recipient: Address, out: &str) -> anyhow::Result<()> {
    let note = || {
        let mut rng = rand::rng();
        kohaku_tornadocash::Note::new(rng.random::<[u8; 31]>(), rng.random::<[u8; 31]>())
    };
    let notes = [note(), note(), note()];
    let leaves: Vec<_> = notes.iter().map(kohaku_tornadocash::Note::commitment).collect();
    let zero = ruint::aliases::U256::ZERO;
    let recipient_word = ruint::aliases::U256::from_be_slice(recipient.as_slice());
    let inputs = co_withdraw::circuit_inputs(&notes[1], &leaves, recipient_word, zero, zero, zero)?;
    fs::write(out, serde_json::to_vec_pretty(&inputs)?)?;
    println!("stand-in inputs written for recipient {recipient}: a fresh note, the second of three leaves");
    Ok(())
}

/// The three members' records, which must agree; the proof's bytes and its public inputs.
fn members(path: &str) -> anyhow::Result<(Bytes, [U256; 6], Vec<usize>)> {
    let members: Vec<Member> = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(members.len() == 3, "{} member records, expected 3", members.len());
    ensure!(
        members.iter().all(|m| m.verified && m.solidity == members[0].solidity && m.public_inputs == members[0].public_inputs),
        "the members' proofs differ, or one did not verify"
    );
    let inputs: Vec<U256> = members[0].public_inputs.iter().map(|x| x.parse()).collect::<Result<_, _>>()?;
    let inputs: [U256; 6] = inputs.try_into().map_err(|_| anyhow::anyhow!("six public inputs expected"))?;
    Ok((members[0].solidity.parse()?, inputs, members.iter().map(|m| m.member).collect()))
}

async fn withdraw(withdrawal: &str, members_path: &str) -> anyhow::Result<()> {
    let (chain, node) = providers()?;
    let w: Withdrawal = serde_json::from_slice(&fs::read(withdrawal)?)?;
    let (proof, inputs, _) = members(members_path)?;
    let i = &w.public_inputs;
    let expected = [
        U256::from_be_bytes(i.root.0),
        U256::from_be_bytes(i.nullifier_hash.0),
        U256::from_be_slice(i.recipient.as_slice()),
        U256::from_be_slice(i.relayer.as_slice()),
        i.fee,
        i.refund,
    ];
    ensure!(inputs == expected, "the committee proved other public inputs than the withdrawal's");
    let pool = FramePool { address: w.pool, mode: PoolMode::Refund, salt: w.salt };
    let opts = WithdrawalOpts { root_slot: Some(w.root_slot), fees: WALLET_FEES, ..WithdrawalOpts::new(w.chain_id) };
    let tx = withdrawal_tx(&pool, &w.public_inputs, &proof, &opts)?;
    let mut sent = vec![
        offer(&chain, &node, "the committee's withdrawal", &tx, true).await?,
    ];
    let receipt = mined(&chain, tx.hash()).await?;
    sent.push(offer(&chain, &node, "the same withdrawal again, once mined", &tx, false).await?);
    record(json!({
        "part": "withdrawal",
        "pool": w.pool,
        "publicInputs": w.public_inputs,
        "sent": sent,
        "mined": receipt,
    }))
}

async fn update(members_path: &str, code_path: &str) -> anyhow::Result<()> {
    let (chain, node) = providers()?;
    let funder: PrivateKeySigner = env::var("PRIVATE_KEY")
        .context("PRIVATE_KEY deploys the account and funds the payer")?
        .parse()?;
    let chain_id = chain.get_chain_id().await?;
    let (proof, inputs, ids) = members(members_path)?;
    let [root, nullifier_hash, recipient, relayer, fee, refund] = inputs;
    ensure!(relayer.is_zero() && fee.is_zero() && refund.is_zero(), "the stand-in's relayer, fee and refund must be zero");
    let recipient = Address::from_word(B256::from(recipient));
    let nullifier_hash = B256::from(nullifier_hash);

    // The account, with the stand-in's root and the verifier appended, and a fresh payer, funded:
    // one transaction to the chain.
    let code: Bytes = fs::read_to_string(code_path)?.trim().parse()?;
    let mut initcode = code.to_vec();
    initcode.extend_from_slice(&root.to_be_bytes::<32>());
    initcode.extend_from_slice(B256::left_padding_from(VERIFIER.as_slice()).as_slice());
    let salt = B256::from(rand::rng().random::<[u8; 32]>());
    let account = create2_address(&initcode, salt);
    let payer = PrivateKeySigner::random();
    let setup = setup(&chain, &funder, chain_id, vec![
        deploy_frame(&initcode, salt, 0),
        // The payer is fresh, so the transfer creates it: EIP-8037 state gas for a new account.
        Frame::sender(Some(payer.address()))
            .with_value(PAYER_FUND)
            .with_execution(10_000)
            .with_state(NEW_ACCOUNT_STATE_GAS),
    ])
    .await?;
    let deployed = chain.get_code_at(account).await?;
    ensure!(deployed.ends_with(&initcode[initcode.len() - 64..]), "the account's code does not end with its root and verifier");

    // The update: the account as sender, its proof in its own VERIFY, the payer's VERIFY, then
    // the credit; the nullifier hash its only nonce key.
    let fees = rpc::suggest_fees(&chain, TIP).await?;
    let mut data = proof.to_vec();
    data.extend_from_slice(B256::left_padding_from(recipient.as_slice()).as_slice());
    data.extend_from_slice(nullifier_hash.as_slice());
    let mut tx = FrameTx {
        chain_id,
        nonce_keys: vec![U256::from_be_bytes(nullifier_hash.0)],
        nonce_seq: 0,
        sender: account,
        frames: vec![
            Frame::verify(approve::EXECUTION, None).with_data(data).with_execution(UPDATE_VERIFY_EXECUTION),
            Frame::verify(approve::PAYMENT, Some(payer.address()))
                .with_execution(PAYER_VERIFY_EXECUTION)
                .with_state(STORAGE_SET_STATE_GAS),
            Frame::sender(Some(account))
                .with_data(creditCall { recipient, nullifierHash: nullifier_hash }.abi_encode())
                .with_execution(CREDIT_EXECUTION)
                .with_state(STORAGE_SET_STATE_GAS),
        ],
        signatures: vec![FrameSignature {
            scheme: scheme::SECP256K1,
            signer: Some(payer.address()),
            msg: Bytes::new(),
            signature: Bytes::new(),
        }],
        fees,
        blob_versioned_hashes: vec![],
    };
    sign_all(&mut tx, &[FrameSigner::Secp256k1(payer.clone())])?;
    let mut sent = vec![offer(&chain, &node, "the shared-state update, the committee's proof in the account's VERIFY", &tx, true).await?];
    let receipt = mined(&chain, tx.hash()).await?;
    sent.push(offer(&chain, &node, "the same update again, once mined", &tx, false).await?);
    let balance = chain
        .call(TransactionRequest::default().to(account).input(balanceOfCall { who: recipient }.abi_encode().into()))
        .await?;
    record(json!({
        "part": "update",
        "account": account,
        "accountCodeBytes": deployed.len(),
        "root": B256::from(root),
        "verifier": VERIFIER,
        "payer": payer.address(),
        "recipient": recipient,
        "nullifierHash": nullifier_hash,
        "members": ids,
        "setup": setup,
        "sent": sent,
        "mined": receipt,
        "recipientBalance": U256::from_be_slice(&balance),
    }))
}

async fn unproved(withdrawal: &str) -> anyhow::Result<()> {
    let (chain, node) = providers()?;
    let w: Withdrawal = serde_json::from_slice(&fs::read(withdrawal)?)?;
    let pool = FramePool { address: w.pool, mode: PoolMode::Refund, salt: w.salt };
    let opts = WithdrawalOpts { root_slot: Some(w.root_slot), fees: WALLET_FEES, ..WithdrawalOpts::new(w.chain_id) };
    let tx = withdrawal_tx(&pool, &w.public_inputs, &Bytes::from(vec![0u8; 256]), &opts)?;
    let (sent, _) = offered(&chain, &node, "the held note's withdrawal with no proof, the committee stopped", &tx).await?;
    record(json!({
        "part": "stopped",
        "pool": w.pool,
        "publicInputs": w.public_inputs,
        "sent": [sent],
    }))
}

fn providers() -> anyhow::Result<(impl Provider + Clone, impl Provider + Clone)> {
    let url = env::var("RPC_URL").unwrap_or_else(|_| HEGOTA_RPC_URL.to_owned());
    let node_url = env::var("SEND_RPC_URL").context("SEND_RPC_URL is the node the transactions go to")?;
    Ok((ProviderBuilder::new().connect_http(url.parse()?), ProviderBuilder::new().connect_http(node_url.parse()?)))
}

/// [`offered`], requiring an admission when `admit` and a refusal otherwise.
async fn offer<P: Provider, N: Provider>(chain: &P, node: &N, what: &str, tx: &FrameTx, admit: bool) -> anyhow::Result<Value> {
    let (sent, admitted) = offered(chain, node, what, tx).await?;
    if admit {
        ensure!(admitted, "the node refused: {what}");
    } else {
        ensure!(!admitted, "the node admitted: {what}");
    }
    Ok(sent)
}

/// Simulate `tx` on the chain, send it to the node, and return the record and whether the node
/// admitted it.
async fn offered<P: Provider, N: Provider>(chain: &P, node: &N, what: &str, tx: &FrameTx) -> anyhow::Result<(Value, bool)> {
    let simulation = match rpc::simulate(chain, tx, "latest").await {
        Ok(s) => serde_json::to_value(s)?,
        Err(e) => json!({ "error": e.to_string() }),
    };
    let answer = match rpc::send(node, tx).await {
        Ok(hash) => json!({ "result": hash }),
        Err(e) => json!({ "error": e.to_string() }),
    };
    println!("{what}: {} -> {answer}", tx.hash());
    let admitted = answer.get("result").is_some();
    Ok((json!({ "what": what, "hash": tx.hash(), "raw": tx.encode(), "to": "node A", "simulation": simulation, "answer": answer }), admitted))
}

async fn mined<P: Provider>(chain: &P, hash: B256) -> anyhow::Result<Value> {
    let r = rpc::wait_for_confirmed_receipt(chain, hash, Duration::from_mins(5), Duration::from_secs(2)).await?;
    println!("mined: {hash} in block {}, status {}, gasUsed {}", r.block_number, r.status, r.gas_used);
    Ok(json!({ "hash": hash, "block": r.block_number, "status": r.status, "gasUsed": r.gas_used }))
}

/// The funder's own transaction making `calls`, simulated, sent to the chain and confirmed.
async fn setup<P: Provider>(provider: &P, key: &PrivateKeySigner, chain_id: u64, calls: Vec<Frame>) -> anyhow::Result<Value> {
    let account = Eoa::new(Signer::secp256k1(key.address()));
    let envelope = Envelope::fetch(provider, key.address(), vec![U256::ZERO], TIP).await?;
    ensure!(envelope.chain_id == chain_id);
    let mut tx = TxPlan::new(&account).calls(calls).build(&envelope)?;
    sign_all(&mut tx, &[FrameSigner::Secp256k1(key.clone())])?;
    let done = rpc::execute(provider, &tx, true).await?;
    println!("setup {}: block {}, gasUsed {}", done.hash, done.receipt.block_number, done.receipt.gas_used);
    Ok(json!({ "hash": done.hash, "raw": tx.encode(), "block": done.receipt.block_number, "gasUsed": done.receipt.gas_used }))
}

fn record(v: Value) -> anyhow::Result<()> {
    if let Ok(path) = env::var("RECORD") {
        fs::write(&path, serde_json::to_string_pretty(&v)? + "\n")?;
        println!("recorded {path}");
    }
    Ok(())
}
