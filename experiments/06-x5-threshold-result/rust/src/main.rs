//! X5's result side: an FHE result, decrypted and signed by a threshold committee, posted by a
//! result contract that is its own sender and checks the committee's signature in its `VERIFY`
//! frame, sent to a skandha node and mined.
//!
//! ```text
//! PRIVATE_KEY=0x... SEND_RPC_URL=http://127.0.0.1:14337/rpc/ INPUT=in.json RECORD=out.json \
//!   cargo run --release --manifest-path experiments/06-x5-threshold-result/rust/Cargo.toml
//! ```
//!
//! `INPUT` is what run.ts made with the committee's command lines: the result contract's creation
//! code, the committee's BLS key, the result a quorum signed, the signature two members could make
//! for it, and a second request's ID.
//!
//! 1. The funder deploys the result contract with the committee's key appended and funds it, in
//!    one transaction sent to the chain.
//! 2. Each result transaction is simulated on the chain, then sent to the node:
//!    - the result signed by two members, below the quorum: refused;
//!    - the quorum's signature presented for another request: refused;
//!    - the result the quorum signed: admitted, and mined;
//!    - while it is pending, a second result for its request with another value, its fees raised
//!      by the replacement bump: refused;
//!    - once it is mined, the same bytes again: refused.
//!
//! `RECORD` names a JSON file with every transaction's bytes, the simulations, the node's answers
//! and what was mined. No private key or share is recorded or printed.

use std::{env, fs, time::Duration};

use alloy::{
    primitives::{Address, B256, Bytes, U256},
    providers::{Provider, ProviderBuilder},
    signers::local::PrivateKeySigner,
    sol,
    sol_types::SolCall,
};
use anyhow::{Context, ensure};
use kohaku_frame_accounts::{
    account::{Eoa, Signer},
    builder::{Envelope, TxPlan},
    contracts::{create2_address, deploy_frame},
};
use kohaku_frame_kit::{
    Fees, Frame, FrameSigner, FrameTx,
    constants::{STORAGE_SET_STATE_GAS, approve},
    rpc::{self, HEGOTA_RPC_URL},
    sign_all,
};
use rand::RngExt;
use serde::Deserialize;
use serde_json::{Value, json};

const TIP: u128 = 1_000_000_000;
/// What the funder leaves in the result contract for its results' gas.
const FUND: U256 = U256::from_limbs([20_000_000_000_000_000, 0, 0, 0]);
/// The result's `VERIFY` frame: the ticket paymaster's check, 122,006 gas in experiment 04,
/// and the layout and nonce-key checks around it.
const VERIFY_EXECUTION: u64 = 250_000;
const RECORD_EXECUTION: u64 = 20_000;

sol! {
    function record(bytes32 request, bytes32 handle, uint256 value);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    /// ResultBoard.hex: the creation code before the key.
    board_code: Bytes,
    /// The committee's BLS key, EIP-2537's encoding of a G2 point (256 bytes).
    key_eip2537: Bytes,
    quorum: Signed,
    below: Signed,
    other_request: B256,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Signed {
    request: B256,
    handle: B256,
    value: u64,
    /// EIP-2537's encoding of a G1 point (128 bytes).
    signature_eip2537: Bytes,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let url = env::var("RPC_URL").unwrap_or_else(|_| HEGOTA_RPC_URL.to_owned());
    let node_url = env::var("SEND_RPC_URL").context("SEND_RPC_URL is the node the results go to")?;
    let funder: PrivateKeySigner = env::var("PRIVATE_KEY")
        .context("PRIVATE_KEY deploys and funds the result contract")?
        .parse()?;
    let input: Input = serde_json::from_slice(&fs::read(env::var("INPUT").context("INPUT")?)?)?;
    ensure!(input.key_eip2537.len() == 256, "the key is not 256 bytes");
    let chain = ProviderBuilder::new().connect_http(url.parse()?);
    let node = ProviderBuilder::new().connect_http(node_url.parse()?);
    let chain_id = chain.get_chain_id().await?;

    // 1. The result contract, deployed with the committee's key and funded, in one transaction.
    let mut initcode = input.board_code.to_vec();
    initcode.extend_from_slice(&input.key_eip2537);
    let salt = B256::from(rand::rng().random::<[u8; 32]>());
    let board = create2_address(&initcode, salt);
    let setup = setup(&chain, &funder, chain_id, vec![
        deploy_frame(&initcode, salt, 0),
        Frame::sender(Some(board)).with_value(FUND).with_execution(10_000),
    ])
    .await?;
    let code = chain.get_code_at(board).await?;
    ensure!(code.ends_with(&input.key_eip2537), "the deployed code does not end with the key");
    // The rest is the runtime, which the creation code carries whole.
    let runtime = &code[..code.len() - 256];
    ensure!(
        !runtime.is_empty() && input.board_code.windows(runtime.len()).any(|w| w == runtime),
        "the deployed code is not ResultBoard's runtime and the key"
    );
    println!("result contract {board}: {} bytes of code", code.len());

    let fees = rpc::suggest_fees(&chain, TIP).await?;
    let q = &input.quorum;
    let below = result_tx(chain_id, board, fees, &input.below, None, None);
    let elsewhere = result_tx(chain_id, board, fees, q, Some(input.other_request), None);
    let original = result_tx(chain_id, board, fees, q, None, None);
    let second = result_tx(chain_id, board, fees.bumped(), q, None, Some(q.value + 1));

    // 2. Each simulated on the chain first, then sent to the node.
    let mut sent = vec![];
    sent.push(offer(&chain, &node, "below the quorum: two members' signature", &below, false).await?);
    sent.push(offer(&chain, &node, "the quorum's signature presented for another request", &elsewhere, false).await?);
    sent.push(offer(&chain, &node, "the result the quorum signed", &original, true).await?);
    sent.push(offer(&chain, &node, "a second result for the same request, another value, fees bumped, while the first is pending", &second, false).await?);
    let receipt = rpc::wait_for_confirmed_receipt(
        &chain,
        original.hash(),
        Duration::from_mins(5),
        Duration::from_secs(2),
    )
    .await?;
    println!(
        "the result: {} in block {}, status {}, gasUsed {}",
        original.hash(),
        receipt.block_number,
        receipt.status,
        receipt.gas_used
    );
    sent.push(offer(&chain, &node, "the same result again, once mined", &original, false).await?);

    if let Ok(path) = env::var("RECORD") {
        let record = json!({
            "chainId": chain_id,
            "board": board,
            "boardCodeBytes": code.len(),
            "salt": salt,
            "key": input.key_eip2537,
            "setup": setup,
            "results": {
                "quorum": signed_json(q),
                "below": signed_json(&input.below),
                "otherRequest": input.other_request,
            },
            "sent": sent,
            "mined": {
                "hash": original.hash(),
                "block": receipt.block_number,
                "status": receipt.status,
                "gasUsed": receipt.gas_used,
            },
        });
        fs::write(&path, serde_json::to_string_pretty(&record)? + "\n")?;
        println!("recorded {path}");
    }
    Ok(())
}

/// One result transaction: the result contract as sender, its `VERIFY` frame carrying the result
/// and the signature, its `SENDER` frame recording the same words, and the request as the only
/// nonce key. `request` and `value` override the signed ones, for the variants.
fn result_tx(
    chain_id: u64,
    board: Address,
    fees: Fees,
    s: &Signed,
    request: Option<B256>,
    value: Option<u64>,
) -> FrameTx {
    let request = request.unwrap_or(s.request);
    let value = U256::from(value.unwrap_or(s.value));
    let mut data = Vec::with_capacity(224);
    data.extend_from_slice(request.as_slice());
    data.extend_from_slice(s.handle.as_slice());
    data.extend_from_slice(&value.to_be_bytes::<32>());
    data.extend_from_slice(&s.signature_eip2537);
    let call = recordCall { request, handle: s.handle, value }.abi_encode();
    FrameTx {
        chain_id,
        nonce_keys: vec![U256::from_be_bytes(request.0)],
        nonce_seq: 0,
        sender: board,
        frames: vec![
            Frame::verify(approve::EXECUTION_AND_PAYMENT, None)
                .with_data(data)
                .with_execution(VERIFY_EXECUTION)
                .with_state(STORAGE_SET_STATE_GAS),
            Frame::sender(Some(board))
                .with_data(call)
                .with_execution(RECORD_EXECUTION),
        ],
        signatures: vec![],
        fees,
        blob_versioned_hashes: vec![],
    }
}

/// Simulate `tx` on the chain, then send it to the node, and require the node's answer to be an
/// admission when `admit` and a refusal otherwise.
async fn offer<P: Provider, N: Provider>(
    chain: &P,
    node: &N,
    what: &str,
    tx: &FrameTx,
    admit: bool,
) -> anyhow::Result<Value> {
    let simulation = match rpc::simulate(chain, tx, "latest").await {
        Ok(s) => serde_json::to_value(s)?,
        Err(e) => json!({ "error": e.to_string() }),
    };
    let answer = match rpc::send(node, tx).await {
        Ok(hash) => json!({ "result": hash }),
        Err(e) => json!({ "error": e.to_string() }),
    };
    println!("{what}: {} -> {answer}", tx.hash());
    if admit {
        ensure!(answer.get("result").is_some(), "the node refused: {what}");
    } else {
        ensure!(answer.get("result").is_none(), "the node admitted: {what}");
    }
    Ok(json!({
        "what": what,
        "hash": tx.hash(),
        "raw": tx.encode(),
        "to": "node A",
        "simulation": simulation,
        "answer": answer,
    }))
}

/// The funder's own transaction making `calls`, simulated, sent to the chain and confirmed.
async fn setup<P: Provider>(
    provider: &P,
    key: &PrivateKeySigner,
    chain_id: u64,
    calls: Vec<Frame>,
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

fn signed_json(s: &Signed) -> Value {
    json!({
        "request": s.request,
        "handle": s.handle,
        "value": s.value,
        "signatureEip2537": s.signature_eip2537,
    })
}
