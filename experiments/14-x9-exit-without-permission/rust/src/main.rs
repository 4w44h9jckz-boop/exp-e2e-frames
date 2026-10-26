//! X9's Rust half.
//!
//! ```text
//! x9-runner local     rehearse the whole plan against a local ethrex node (ETHREX_BIN)
//! x9-runner send-update    --vault <a> --nullifier-hash <h> --verify-data <hex> --process-data <hex>
//! x9-runner send-reconcile --vault <a> --escape-at <block> --verify-data <hex>
//! ```
//!
//! The two `send-` modes take the frame data `exit-committee update-data` and `exit-committee
//! reconcile` print, build the committee's transaction with [`update_tx`] or [`reconcile_tx`],
//! sign it with the payer's key (`PAYER_KEY`, never printed), simulate it on `RPC_URL`, send it
//! to `SEND_RPC_URL` (default `RPC_URL`), and wait for its receipt on `RPC_URL`. They print one
//! JSON object: the transaction's hash, bytes and raw encoding, the simulation, the node's answer,
//! and, if mined, its block, status, payer and gas by frame, with the vault's mode before and
//! after. A transaction the node refuses is printed, not retried.
//!
//! The rehearsal deploys experiment 01's hasher and verifier and the vault, then runs plan steps
//! 2 to 6 with the committee in memory: updates with openings, an early redemption, the timeout,
//! the members' attempt to redeem an owner's note, the owners' redemptions, a second redemption,
//! updates refused in escape mode and over a redeemed note, a reconcile before and after the
//! escape window, and the queue processed again. It writes what it saw to `RECORD` (default
//! `work/x9-local.json`), with no key, share, note secret or opening plaintext.
//!
//! The transaction builders here, [`update_tx`], [`reconcile_tx`] and [`redemption_tx`], are
//! the hooks the testnet runner builds the same transactions with.

use std::{env, fs, path::Path, time::Duration};

use alloy::{
    primitives::{Address, B256, Bytes, U256, keccak256},
    providers::{Provider, ProviderBuilder},
    rpc::types::TransactionRequest,
    signers::local::PrivateKeySigner,
};
use anyhow::{Context, bail, ensure};
use ark_bn254::Fr;
use co_circom_types::Compression;
use co_withdraw::{
    MEMBERS, WithdrawKey, circuit_inputs, extend_witness, prove, read_share, set_recipient, share_witness,
    solidity_proof,
};
use exit_committee::{
    Intent, Opening, a_point, b_point, choose_part, commitment, fr_be, reconcile_message, reconcile_nonce_key,
    reconcile_partial, reconcile_signature, recipient, redemption_list, seal,
};
use kohaku_fork_kit::ethrex::EthrexBuilder;
use kohaku_frame_accounts::contracts::{create2_address, deploy_frame};
use kohaku_frame_kit::{
    Fees, Frame, FrameSignature, FrameSigner, FrameTx,
    constants::{NEW_ACCOUNT_STATE_GAS, STORAGE_SET_STATE_GAS, approve, scheme},
    json::FrameTxReceiptJson,
    rpc, sign_all,
};
use kohaku_frame_pool::{
    PublicInputs, prove as wallet_prove,
    withdrawal::{FramePool, POOL_FEES, PoolMode, WithdrawalOpts, tightened_limits, withdrawal_tx, worst_case_max_cost},
};
use kohaku_tornadocash::{Field, Note, Payer};
use rand::RngExt;
use serde::Deserialize;
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};

const TIMEOUT: u64 = 30;
const ESCAPE_WINDOW: u64 = 30;
/// What the vault holds beyond its notes, for the gas of redemptions that pay nothing.
const FLOAT: u128 = 10_000_000_000_000_000;
/// A redemption's withdraw frame: the recipient's new account, the spent slot, and the packed
/// slot on the first redemption.
pub const WITHDRAW_STATE: u64 = NEW_ACCOUNT_STATE_GAS + 2 * STORAGE_SET_STATE_GAS;
const UPDATE_VERIFY_EXECUTION: u64 = 400_000;
const PAYER_VERIFY_EXECUTION: u64 = 10_000;
const PROCESS_EXECUTION: u64 = 1_500_000;
const PROCESS_STATE: u64 = 3_000_000;
const RECONCILE_VERIFY_EXECUTION: u64 = 300_000;
const RECONCILE_EXECUTION: u64 = 50_000;
/// RefundPool's log of a root filed with EIP-8272: root, slot.
const RECENT_ROOT: B256 = alloy::primitives::b256!("0x2fd31368794d8179a2869e743a7fb1d8819c4b52d4154ba95ddbba7cf39a8552");

#[derive(Deserialize)]
struct Deployments {
    contracts: Vec<Deployment>,
}

#[derive(Deserialize)]
struct Deployment {
    label: String,
    address: Address,
    target: Address,
    data: Bytes,
    execution: u64,
    state: u64,
}

/// The committee's update: the vault as sender, its proof in the vault's VERIFY, a payer's
/// VERIFY, then process; the spent note's nullifier hash its only nonce key.
pub fn update_tx(
    chain_id: u64,
    vault: Address,
    nullifier_hash: B256,
    verify_data: Bytes,
    process_data: Bytes,
    payer: Address,
    fees: Fees,
) -> FrameTx {
    committee_tx(chain_id, vault, U256::from_be_bytes(nullifier_hash.0), verify_data, process_data, payer, fees, (UPDATE_VERIFY_EXECUTION, PROCESS_EXECUTION, PROCESS_STATE))
}

/// The committee's reconciliation: the same layout, its nonce key named by the escape.
pub fn reconcile_tx(chain_id: u64, vault: Address, escape_at: u64, verify_data: Bytes, payer: Address, fees: Fees) -> FrameTx {
    let key = U256::from_be_bytes(reconcile_nonce_key(escape_at));
    committee_tx(chain_id, vault, key, verify_data, Bytes::from_static(&[0x8f, 0x0d, 0x7e, 0x35]), payer, fees, (RECONCILE_VERIFY_EXECUTION, RECONCILE_EXECUTION, 0))
}

#[allow(clippy::too_many_arguments)]
fn committee_tx(
    chain_id: u64,
    vault: Address,
    nonce_key: U256,
    verify_data: Bytes,
    sender_data: Bytes,
    payer: Address,
    fees: Fees,
    (verify_execution, sender_execution, sender_state): (u64, u64, u64),
) -> FrameTx {
    FrameTx {
        chain_id,
        nonce_keys: vec![nonce_key],
        nonce_seq: 0,
        sender: vault,
        frames: vec![
            Frame::verify(approve::EXECUTION, None).with_data(verify_data).with_execution(verify_execution),
            // EIP-8250 charges a nonce key's first use to the frame that approves payment.
            Frame::verify(approve::PAYMENT, Some(payer)).with_execution(PAYER_VERIFY_EXECUTION).with_state(STORAGE_SET_STATE_GAS),
            Frame::sender(Some(vault)).with_data(sender_data).with_execution(sender_execution).with_state(sender_state),
        ],
        // A payment-only payer's signature sits at index 1; index 0 is an empty ARBITRARY entry
        // the vault never reads (experiment 07).
        signatures: vec![
            FrameSignature { scheme: scheme::ARBITRARY, signer: None, msg: Bytes::new(), signature: Bytes::new() },
            FrameSignature { scheme: scheme::SECP256K1, signer: Some(payer), msg: Bytes::new(), signature: Bytes::new() },
        ],
        fees,
        blob_versioned_hashes: vec![],
    }
}

/// An owner's redemption: kohaku-frame-pool's refund-pool withdrawal, with the withdraw frame's
/// state budget raised to [`WITHDRAW_STATE`] and the note's nonce sequence `seq`. Priced as
/// `kohaku_frame_pool::chain::priced_withdrawal` prices one when its draft succeeds in
/// simulation; otherwise the draft itself, at the default limits, for a caller who sends a
/// redemption the vault will not pay.
pub async fn redemption_tx<P: Provider>(
    provider: &P,
    pool: &FramePool,
    note: &Note,
    leaves: &[Field],
    to: Address,
    root_slot: u64,
    seq: u64,
) -> anyhow::Result<(FrameTx, PublicInputs, bool)> {
    let chain_id = provider.get_chain_id().await?;
    let opts = WithdrawalOpts { root_slot: Some(root_slot), ..WithdrawalOpts::new(chain_id) };
    let shaped = |inputs: &PublicInputs, proof: &Bytes, limits: Option<Vec<u64>>| -> anyhow::Result<FrameTx> {
        let mut tx = withdrawal_tx(pool, inputs, proof, &WithdrawalOpts { execution_limits: limits, ..opts.clone() })?;
        tx.frames[2].limits.state = WITHDRAW_STATE;
        tx.nonce_seq = seq;
        Ok(tx)
    };
    let worst = |limits: Option<Vec<u64>>| -> anyhow::Result<U256> {
        let inputs = PublicInputs { root: B256::ZERO, nullifier_hash: B256::ZERO, recipient: to, relayer: pool.address, fee: U256::MAX, refund: U256::ZERO };
        Ok(worst_case_max_cost(&shaped(&inputs, &Bytes::from(vec![0; 256]), limits)?)?)
    };
    let proved = |fee: U256| {
        wallet_prove(note.clone(), leaves, to, Payer { address: pool.address, fee, refund: U256::ZERO }, &mut rand::rng())
    };
    let draft = proved(worst(None)?)?;
    let draft_tx = shaped(&draft.inputs, &draft.proof, None)?;
    let sim = rpc::simulate(provider, &draft_tx, "latest").await?;
    if !(sim.valid && sim.execution_status.as_deref() == Some("success")) {
        return Ok((draft_tx, draft.inputs, false));
    }
    let used: Vec<u64> = sim.frames.context("no frames in the simulation")?.iter().map(|f| f.gas_used.to()).collect();
    let limits = tightened_limits(&draft_tx, &used);
    let p = proved(worst(Some(limits.clone()))?)?;
    Ok((shaped(&p.inputs, &p.proof, Some(limits))?, p.inputs, true))
}

/// The committee, in memory: its sealing key, its BLS key in shares, and each member's parts.
struct Committee {
    sealing: seal::Keys,
    bls: bls_committee::Committee,
    parts: std::collections::BTreeMap<u64, [[u8; 31]; MEMBERS]>,
    intents: std::collections::BTreeMap<u64, Intent>,
}

/// A holder's note as the committee will spend it: the holder shares the witness, then forgets.
struct Held {
    note: Note,
}

struct Chain<P> {
    provider: P,
    chain_id: u64,
    funder: FrameSigner,
    vault: Address,
    pool: FramePool,
    payer: PrivateKeySigner,
    log: Vec<Value>,
}

fn word_u64(b: &[u8]) -> u64 {
    U256::from_be_slice(b).to::<u64>()
}

impl<P: Provider> Chain<P> {
    async fn call(&self, selector: [u8; 4], arg: Option<B256>) -> anyhow::Result<U256> {
        let mut data = selector.to_vec();
        if let Some(a) = arg {
            data.extend_from_slice(a.as_slice());
        }
        let out = self.provider.call(TransactionRequest::default().to(self.vault).input(data.into())).await?;
        Ok(U256::from_be_slice(&out))
    }
    async fn mode(&self) -> anyhow::Result<u64> {
        Ok(self.call([0x29, 0x5a, 0x52, 0x12], None).await?.to())
    }
    async fn view(&self, selector: [u8; 4]) -> anyhow::Result<u64> {
        Ok(self.call(selector, None).await?.to())
    }

    /// An ordinary frame transaction from the funder: one SENDER frame.
    async fn from_funder(&self, to: Address, value: U256, data: Vec<u8>, execution: u64, state: u64) -> anyhow::Result<FrameTxReceiptJson> {
        let from = self.funder.address();
        let mut tx = FrameTx {
            chain_id: self.chain_id,
            nonce_keys: vec![U256::ZERO],
            nonce_seq: rpc::nonce_seq(&self.provider, from, &[U256::ZERO]).await?,
            sender: from,
            frames: vec![
                Frame::verify(approve::EXECUTION_AND_PAYMENT, None).with_execution(20_000),
                Frame::sender(Some(to)).with_value(value).with_data(data).with_execution(execution).with_state(state),
            ],
            signatures: vec![self.funder.placeholder(None)],
            fees: POOL_FEES,
            blob_versioned_hashes: vec![],
        };
        sign_all(&mut tx, std::slice::from_ref(&self.funder))?;
        Ok(rpc::execute(&self.provider, &tx, true).await?.receipt)
    }

    /// Offers `tx` to the node and records what happened: refused, or mined with each frame's
    /// status and gas, and the vault's mode before and after.
    async fn offer(&mut self, step: &str, tx: &FrameTx) -> anyhow::Result<Option<FrameTxReceiptJson>> {
        let before = self.mode().await?;
        let sim = rpc::simulate(&self.provider, tx, "latest").await?;
        if !sim.valid {
            let refused = rpc::send(&self.provider, tx).await.err().map(|e| e.to_string());
            self.log.push(json!({
                "step": step, "hash": tx.hash(), "bytes": tx.encode().len(),
                "admitted": false, "simulation": sim.violation, "node": refused, "modeBefore": before,
            }));
            return Ok(None);
        }
        rpc::send(&self.provider, tx).await?;
        let r = rpc::wait_for_confirmed_receipt(&self.provider, tx.hash(), Duration::from_mins(2), Duration::from_millis(500)).await?;
        let after = self.mode().await?;
        self.log.push(json!({
            "step": step, "hash": tx.hash(), "bytes": tx.encode().len(), "admitted": true,
            "block": r.block_number, "payer": r.payer, "status": r.status,
            "frames": r.frame_receipts.iter().map(|f| json!({ "status": f.status, "gasUsed": f.gas_used, "stateGasUsed": f.state_gas_used })).collect::<Vec<_>>(),
            "gasUsed": r.gas_used, "modeBefore": before, "modeAfter": after,
        }));
        Ok(Some(r))
    }

    async fn leaves(&self) -> anyhow::Result<Vec<Field>> {
        let n = self.view([0xfc, 0x7e, 0x9c, 0x6f]).await? as usize;
        Ok(if n == 0 { vec![] } else { kohaku_frame_pool::chain::leaves(&self.provider, self.vault, n - 1).await? })
    }

    /// The slot the vault last filed its root in with EIP-8272.
    async fn root_slot(&self) -> anyhow::Result<u64> {
        let logs = self
            .provider
            .get_logs(&alloy::rpc::types::Filter::new().address(self.vault).event_signature(RECENT_ROOT).from_block(0))
            .await?;
        let last = logs.last().context("no root filed")?;
        Ok(word_u64(&last.data().data[32..64]))
    }

    async fn wait_until(&self, block: u64) -> anyhow::Result<()> {
        while self.provider.get_block_number().await? < block {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        Ok(())
    }
}

fn vault_logs(r: &FrameTxReceiptJson, vault: Address, topic: B256) -> Vec<Bytes> {
    r.frame_receipts.iter().flat_map(|f| &f.logs).filter(|l| l.address == vault && l.topics.first() == Some(&topic)).map(|l| l.data.clone()).collect()
}

fn topic(sig: &str) -> B256 {
    keccak256(sig.as_bytes())
}

fn fr_of(f: Field) -> Fr {
    let u: U256 = f.into();
    <Fr as ark_ff::PrimeField>::from_be_bytes_mod_order(&u.to_be_bytes::<32>())
}

/// The committee's update for the intent at `index`: open it, choose parts, the commitment and
/// the openings, bind the recipient, and prove over the holder's shared witness.
async fn committee_update<P: Provider>(
    chain: &Chain<P>,
    committee: &mut Committee,
    key: &WithdrawKey,
    index: u64,
    sealed: &[u8],
    shares: &[Vec<u8>; MEMBERS],
    held_nullifier_hash: B256,
    root: B256,
) -> anyhow::Result<FrameTx> {
    let mut rng = rand08::rngs::OsRng;
    let vault: [u8; 20] = chain.vault.into_array();
    let intent = Intent::open(&committee.sealing.secret, sealed, &vault, index)?;
    let parts: [[u8; 31]; MEMBERS] = std::array::from_fn(|j| choose_part(j, &mut rng));
    let c = commitment(&parts.map(|p| a_point(&p)), &intent.b);
    let leaf = chain.view([0xfc, 0x7e, 0x9c, 0x6f]).await? as u32;
    let openings: Vec<u8> = parts
        .iter()
        .enumerate()
        .map(|(j, p)| Opening { part: *p, member: j as u8, leaf, update: index }.seal(&intent.owner, &vault, &mut rng))
        .collect::<anyhow::Result<Vec<_>>>()?
        .concat();
    let intent_hash: [u8; 32] = Keccak256::digest(sealed).into();
    let r = recipient(&vault, &intent_hash, c, &openings);
    committee.parts.insert(index, parts);
    committee.intents.insert(index, intent);

    let nets = mpc_net::local::LocalNetwork::new(MEMBERS);
    let proofs: Vec<anyhow::Result<_>> = std::thread::scope(|s| {
        let hs: Vec<_> = nets
            .into_iter()
            .zip(shares.iter())
            .enumerate()
            .map(|(id, (net, share))| {
                s.spawn(move || {
                    let mut share = read_share(share)?;
                    set_recipient(&mut share, id, r)?;
                    prove(&net, key, share)
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().expect("a member's thread")).collect()
    });
    let proof = proofs.into_iter().next().context("no member")??;
    let mut verify = solidity_proof(&proof).to_vec();
    verify.extend_from_slice(root.as_slice());
    verify.extend_from_slice(held_nullifier_hash.as_slice());
    verify.extend_from_slice(&fr_be(c));
    verify.extend_from_slice(&openings);
    let mut process = vec![0xdf, 0xef, 0xb7, 0xd7];
    process.extend_from_slice(&fr_be(c));
    process.extend_from_slice(&openings);
    let fees = rpc::suggest_fees(&chain.provider, 1_000_000_000).await?;
    let mut tx = update_tx(chain.chain_id, chain.vault, held_nullifier_hash, verify.into(), process.into(), chain.payer.address(), fees);
    sign_all(&mut tx, &[FrameSigner::Secp256k1(chain.payer.clone())])?;
    Ok(tx)
}

/// What the holder does before the committee proves: its note's witness, shared three ways.
fn holder_shares(key: &WithdrawKey, held: &Held, leaves: &[Field]) -> anyhow::Result<([Vec<u8>; MEMBERS], B256, B256)> {
    let inputs = circuit_inputs(&held.note, leaves, U256::ZERO, U256::ZERO, U256::ZERO, U256::ZERO)?;
    let w = extend_witness(&inputs)?;
    let shares = share_witness(&w, key.num_instance_variables(), Compression::SeededShares, &mut rand08::rngs::OsRng)?;
    Ok((shares, B256::from(fr_be(w[1])), B256::from(fr_be(w[2]))))
}

async fn local() -> anyhow::Result<()> {
    let builder = EthrexBuilder::from_env().context("ETHREX_BIN must name an ethrex binary built at the testnet's commit")?;
    let funder = PrivateKeySigner::random();
    let ethrex = builder.prefund(funder.address(), U256::from(10u128.pow(20))).block_time(Duration::from_millis(500)).spawn().await?;
    let provider = ProviderBuilder::new().connect_http(ethrex.rpc_url().parse()?);
    let chain_id = ethrex.chain_id();
    let funder = FrameSigner::Secp256k1(funder);
    let key = WithdrawKey::load();

    // Experiment 01's hasher and verifier, at their testnet addresses.
    let deployments: Deployments = serde_json::from_slice(&fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/deployments.json"))?)?;
    let mut chain = Chain { provider, chain_id, funder: funder.clone(), vault: Address::ZERO, pool: FramePool { address: Address::ZERO, mode: PoolMode::Refund, salt: B256::ZERO }, payer: PrivateKeySigner::random(), log: vec![] };
    for d in &deployments.contracts {
        chain.from_funder(d.target, U256::ZERO, d.data.to_vec(), d.execution, d.state).await?;
        ensure!(!chain.provider.get_code_at(d.address).await?.is_empty(), "{} is not at {}", d.label, d.address);
    }

    // The committee's keys, and the vault with them in its code and a float for gas.
    let mut rng10 = <rand::rngs::StdRng as rand::SeedableRng>::from_rng(&mut rand::rng());
    let mut committee = Committee {
        sealing: seal::Keys::random(&mut rand08::rngs::OsRng),
        bls: bls_committee::Committee::dkg(&mut rng10, MEMBERS)?,
        parts: Default::default(),
        intents: Default::default(),
    };
    let salt = B256::from(rand::rng().random::<[u8; 32]>());
    let code: Bytes = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../contracts/ExitVault.hex"))?.trim().parse()?;
    let mut init = code.to_vec();
    let mut sealing = committee.sealing.public.to_vec();
    sealing.resize(64, 0);
    init.extend_from_slice(&sealing);
    init.extend_from_slice(&U256::from(ESCAPE_WINDOW).to_be_bytes::<32>());
    init.extend_from_slice(&U256::from(TIMEOUT).to_be_bytes::<32>());
    init.extend_from_slice(&kohaku_frame_ticket_g2(&committee.bls));
    for a in [deployments.contracts[1].address, deployments.contracts[0].address] {
        init.extend_from_slice(B256::left_padding_from(a.as_slice()).as_slice());
    }
    init.extend_from_slice(&U256::from(kohaku_frame_pool::withdrawal::DENOMINATION).to_be_bytes::<32>());
    init.extend_from_slice(salt.as_slice());
    let vault = create2_address(&init, salt);
    let deploy = deploy_frame(&init, salt, 0).with_value(U256::from(FLOAT));
    chain.from_funder(deploy.target.context("deployer")?, deploy.value, deploy.data.to_vec(), deploy.limits.execution, deploy.limits.state.max(5_000_000)).await?;
    ensure!(!chain.provider.get_code_at(vault).await?.is_empty(), "the vault is not deployed");
    chain.vault = vault;
    chain.pool = FramePool { address: vault, mode: PoolMode::Refund, salt };
    chain.from_funder(chain.payer.address(), U256::from(10u128.pow(18)), vec![], 10_000, NEW_ACCOUNT_STATE_GAS).await?;

    // Three holders' notes, deposited; three owners, each with its opening key and secret.
    let held: Vec<Held> = (0..3).map(|_| Held { note: rand::rng().random() }).collect();
    for h in &held {
        kohaku_frame_pool::chain::deposit(&chain.provider, &chain.pool, &chain.funder, &h.note).await?;
    }
    let owners: Vec<seal::Keys> = (0..3).map(|_| seal::Keys::random(&mut rand08::rngs::OsRng)).collect();
    let secrets: Vec<[u8; 31]> = (0..3).map(|_| rand::rng().random()).collect();

    // Step 2: two intents, each sent by its holder, and two updates with openings.
    let enqueue = |sealed: &[u8]| {
        let mut d = vec![0x84, 0x47, 0x3f, 0xa8];
        d.extend_from_slice(&U256::from(32).to_be_bytes::<32>());
        d.extend_from_slice(&U256::from(116).to_be_bytes::<32>());
        let mut padded = sealed.to_vec();
        padded.resize(128, 0);
        d.extend_from_slice(&padded);
        d
    };
    let mut notes_out: Vec<(Note, u64)> = vec![];
    let _ = &notes_out;
    for i in 0..2u64 {
        let intent = Intent { owner: owners[i as usize].public, b: b_point(&secrets[i as usize]) };
        let sealed = intent.seal(&committee.sealing.public, &vault.into_array(), i, &mut rand08::rngs::OsRng)?;
        chain.from_funder(vault, U256::ZERO, enqueue(&sealed), 200_000, 3 * STORAGE_SET_STATE_GAS).await?;
        let leaves = chain.leaves().await?;
        let (shares, root, nh) = holder_shares(&key, &held[i as usize], &leaves)?;
        let tx = committee_update(&chain, &mut committee, &key, i, &sealed, &shares, nh, root).await?;
        let r = chain.offer(&format!("update {i}"), &tx).await?.context("an update was refused")?;
        ensure!(r.frame_receipts.iter().all(|f| f.status == U256::from(1)), "update {i} reverted a frame");
        // The owner reads its opening from the chain and checks it.
        let data = &vault_logs(&r, vault, topic("Opening(uint256,bytes)"))[0];
        let openings = &data[96..96 + exit_committee::OPENINGS_LEN];
        let deposit = &vault_logs(&r, vault, topic("Deposit(bytes32,uint32,uint256)"))[0];
        let leaf = word_u64(&deposit[..32]) as u32;
        let c_log = r.frame_receipts.iter().flat_map(|f| &f.logs).find(|l| l.topics.first() == Some(&topic("Deposit(bytes32,uint32,uint256)"))).context("Deposit")?.topics[1];
        let c = <Fr as ark_ff::PrimeField>::from_be_bytes_mod_order(c_log.as_slice());
        let n = exit_committee::assemble(&owners[i as usize].secret, openings, &vault.into_array(), i, leaf, &b_point(&secrets[i as usize]), c)?;
        let note = Note::new(n, secrets[i as usize]);
        ensure!(fr_of(note.commitment()) == c, "owner {i}'s note is not the leaf");
        notes_out.push((note, 0));
        chain.log.push(json!({ "step": format!("owner {i} opens its update's openings"), "opened": true, "leaf": leaf }));
    }

    // Step 3: the queue stalls; a redemption before TIMEOUT blocks pays nothing.
    let sealed2 = Intent { owner: owners[2].public, b: b_point(&secrets[2]) }.seal(&committee.sealing.public, &vault.into_array(), 2, &mut rand08::rngs::OsRng)?;
    chain.from_funder(vault, U256::ZERO, enqueue(&sealed2), 200_000, 3 * STORAGE_SET_STATE_GAS).await?;
    let since = chain.view([0x3d, 0xc5, 0x4b, 0x40]).await?;
    let leaves = chain.leaves().await?;
    let to0 = PrivateKeySigner::random().address();
    let (early, _, priced) = redemption_tx(&chain.provider, &chain.pool, &notes_out[0].0, &leaves, to0, chain.root_slot().await?, 0).await?;
    ensure!(!priced, "an early redemption simulated as paying out");
    let r = chain.offer("an early redemption, before TIMEOUT blocks", &early).await?;
    let early_paid = chain.provider.get_balance(to0).await?;
    chain.log.push(json!({ "step": "after the early redemption", "since": since, "recipientBalance": early_paid, "mined": r.is_some() }));

    // Step 4: the committee stops; the head stays put for TIMEOUT blocks.
    chain.wait_until(since + TIMEOUT).await?;

    // Step 5: the members together try the owner's note first, then the owners redeem.
    let parts = committee.parts[&0];
    let mut n = [0u8; 31];
    for p in &parts {
        for (x, y) in n.iter_mut().zip(p) {
            *x |= y;
        }
    }
    let leaves = chain.leaves().await?;
    let witness = [[0u8; 31], [0xffu8; 31]].iter().any(|g| circuit_inputs(&Note::new(n, *g), &leaves, U256::ZERO, U256::ZERO, U256::ZERO, U256::ZERO).is_ok());
    chain.log.push(json!({ "step": "the members pool everything for owner 0's note", "witnessExists": witness }));
    // The best they can send: the note's public inputs with a proof they cannot make.
    let (mut stolen, inputs, _) = redemption_tx(&chain.provider, &chain.pool, &notes_out[0].0, &leaves, PrivateKeySigner::random().address(), chain.root_slot().await?, 1).await?;
    let mut w = stolen.frames[2].data.to_vec();
    w[0x104..0x204].fill(0);
    stolen.frames[2].data = w.into();
    let _ = inputs;
    chain.offer("the members' redemption of owner 0's note, with no proof", &stolen).await?;

    let (tx0, _, ok0) = redemption_tx(&chain.provider, &chain.pool, &notes_out[0].0, &leaves, to0, chain.root_slot().await?, 1).await?;
    ensure!(ok0, "owner 0's redemption does not simulate");
    chain.offer("owner 0 redeems, sequence 1", &tx0).await?;
    let to1 = PrivateKeySigner::random().address();
    let (tx1, inputs1, ok1) = redemption_tx(&chain.provider, &chain.pool, &notes_out[1].0, &leaves, to1, chain.root_slot().await?, 0).await?;
    ensure!(ok1, "owner 1's redemption does not simulate");
    chain.offer("owner 1 redeems, sequence 0", &tx1).await?;
    let (again, _, _) = redemption_tx(&chain.provider, &chain.pool, &notes_out[0].0, &leaves, to0, chain.root_slot().await?, 2).await?;
    chain.offer("owner 0 redeems again, sequence 2", &again).await?;
    chain.log.push(json!({
        "step": "balances after the escape",
        "recipient0": chain.provider.get_balance(to0).await?, "recipient1": chain.provider.get_balance(to1).await?,
        "redeemed": chain.view([0xe2, 0x31, 0xbf, 0xf0]).await?,
    }));

    // Step 6: the committee returns. An update in escape mode, and one over a redeemed note.
    let leaves = chain.leaves().await?;
    let (shares, root, nh) = holder_shares(&key, &held[2], &leaves)?;
    let pending = committee_update(&chain, &mut committee, &key, 2, &sealed2, &shares, nh, root).await?;
    chain.offer("an update in escape mode, before reconciling", &pending).await?;
    // Owner 1 hands over its redeemed note's witness, as a holder would: the committee proves it.
    let (shares1, root1, nh1) = holder_shares(&key, &Held { note: notes_out[1].0.clone() }, &leaves)?;
    ensure!(nh1 == inputs1.nullifier_hash, "the redeemed note's nullifier hash");
    let over_redeemed = committee_update(&chain, &mut committee, &key, 2, &sealed2, &shares1, nh1, root1).await?;
    chain.offer("an update spending a redeemed note, in escape mode", &over_redeemed).await?;

    // Reconcile before the escape window ends, then after.
    let escape_at = chain.view([0x1c, 0xde, 0x83, 0x31]).await?;
    let redeemed: Vec<[u8; 32]> = vec![B256::from(notes_out[0].0.nullifier_hash()).0, inputs1.nullifier_hash.0];
    let payer = chain.payer.address();
    let reconcile = |escape_at: u64| -> anyhow::Result<FrameTx> {
        let (list, digest) = redemption_list(&redeemed);
        let m = reconcile_message(chain_id, &vault.into_array(), escape_at, &digest);
        let partials: Vec<_> = committee.bls.members.iter().map(|(_, s)| reconcile_partial(s, &m)).collect();
        let sig = reconcile_signature(committee.bls.sharing(), &m, &partials)?;
        let mut data = U256::from(list.len()).to_be_bytes::<32>().to_vec();
        for nh in &list {
            data.extend_from_slice(nh);
        }
        data.extend_from_slice(&kohaku_frame_ticket::ticket::g1_eip2537(&sig));
        Ok(reconcile_tx(chain_id, vault, escape_at, data.into(), payer, POOL_FEES))
    };
    let mut early_reconcile = reconcile(escape_at)?;
    sign_all(&mut early_reconcile, &[FrameSigner::Secp256k1(chain.payer.clone())])?;
    if chain.provider.get_block_number().await? < escape_at + ESCAPE_WINDOW {
        chain.offer("a reconcile before the escape window ends", &early_reconcile).await?;
    }
    chain.wait_until(escape_at + ESCAPE_WINDOW).await?;
    let mut rec = reconcile(escape_at)?;
    // The early attempt, if mined, used the key's sequence 0.
    rec.nonce_seq = rpc::nonce_seq(&chain.provider, vault, &rec.nonce_keys).await?;
    sign_all(&mut rec, &[FrameSigner::Secp256k1(chain.payer.clone())])?;
    chain.offer("the committee reconciles", &rec).await?;
    chain.offer("an update spending a redeemed note, after reconciling", &over_redeemed).await?;
    let leaves = chain.leaves().await?;
    let (shares, root, nh) = holder_shares(&key, &held[2], &leaves)?;
    let next = committee_update(&chain, &mut committee, &key, 2, &sealed2, &shares, nh, root).await?;
    chain.offer("the queue processed again", &next).await?;

    let out = env::var("RECORD").unwrap_or_else(|_| "work/x9-local.json".into());
    if let Some(dir) = Path::new(&out).parent() {
        fs::create_dir_all(dir)?;
    }
    let record = json!({
        "rehearsal": "local ethrex at the testnet's commit, block time 500 ms",
        "timeout": TIMEOUT, "escapeWindow": ESCAPE_WINDOW, "withdrawState": WITHDRAW_STATE,
        "vault": vault, "vaultCodeBytes": chain.provider.get_code_at(vault).await?.len(),
        "steps": chain.log,
    });
    fs::write(&out, serde_json::to_vec_pretty(&record)?)?;
    println!("{}", serde_json::to_string_pretty(&record)?);
    Ok(())
}

fn kohaku_frame_ticket_g2(c: &bls_committee::Committee) -> [u8; 256] {
    kohaku_frame_ticket::ticket::g2_eip2537(c.sharing().public())
}

/// `--name value` pairs after the mode.
fn flag(args: &[String], name: &str) -> anyhow::Result<String> {
    args.windows(2)
        .find(|w| w[0] == format!("--{name}"))
        .map(|w| w[1].clone())
        .with_context(|| format!("--{name} is required"))
}

/// What the testnet runner calls: build, sign, simulate, send, wait, print.
async fn send(kind: &str, args: &[String]) -> anyhow::Result<()> {
    let rpc_url = env::var("RPC_URL").unwrap_or_else(|_| rpc::HEGOTA_RPC_URL.to_owned());
    let send_url = env::var("SEND_RPC_URL").unwrap_or_else(|_| rpc_url.clone());
    let chain = ProviderBuilder::new().connect_http(rpc_url.parse()?);
    let node = ProviderBuilder::new().connect_http(send_url.parse()?);
    let payer: PrivateKeySigner = env::var("PAYER_KEY").context("PAYER_KEY: the payer's secret key")?.parse()?;
    let chain_id = chain.get_chain_id().await?;
    let vault: Address = flag(args, "vault")?.parse()?;
    let verify: Bytes = flag(args, "verify-data")?.parse()?;
    let fees = rpc::suggest_fees(&chain, TIP).await?;
    let mut tx = match kind {
        "send-update" => {
            let nh: B256 = flag(args, "nullifier-hash")?.parse()?;
            let process: Bytes = flag(args, "process-data")?.parse()?;
            update_tx(chain_id, vault, nh, verify, process, payer.address(), fees)
        }
        _ => {
            let escape_at: u64 = flag(args, "escape-at")?.parse()?;
            let mut tx = reconcile_tx(chain_id, vault, escape_at, verify, payer.address(), fees);
            tx.nonce_seq = rpc::nonce_seq(&chain, vault, &tx.nonce_keys).await?;
            tx
        }
    };
    sign_all(&mut tx, &[FrameSigner::Secp256k1(payer)])?;
    let mode = |p: &_| {
        let p: &alloy::providers::RootProvider = p;
        let p = p.clone();
        async move {
            let out = p.call(TransactionRequest::default().to(vault).input(vec![0x29, 0x5a, 0x52, 0x12].into())).await?;
            anyhow::Ok(U256::from_be_slice(&out).to::<u64>())
        }
    };
    let before = mode(chain.root()).await?;
    let sim = rpc::simulate(&chain, &tx, "latest").await?;
    let answer = rpc::send(&node, &tx).await;
    let mut out = json!({
        "kind": kind,
        "hash": tx.hash(),
        "bytes": tx.encode().len(),
        "raw": Bytes::from(tx.encode()),
        "nonceKey": tx.nonce_keys[0],
        "nonceSeq": tx.nonce_seq,
        "simulation": { "valid": sim.valid, "violation": sim.violation, "executionStatus": sim.execution_status, "executionError": sim.execution_error },
        "node": match &answer { Ok(h) => json!({ "accepted": h }), Err(e) => json!({ "error": e.to_string() }) },
        "modeBefore": before,
    });
    if answer.is_ok() {
        let r = rpc::wait_for_confirmed_receipt(&chain, tx.hash(), Duration::from_mins(5), Duration::from_secs(2)).await?;
        out["mined"] = json!({
            "block": r.block_number, "status": r.status, "payer": r.payer, "gasUsed": r.gas_used,
            "frames": r.frame_receipts.iter().map(|f| json!({ "status": f.status, "gasUsed": f.gas_used, "stateGasUsed": f.state_gas_used })).collect::<Vec<_>>(),
        });
        out["modeAfter"] = json!(mode(chain.root()).await?);
    }
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}

/// The priority fee the committee's transactions offer, as experiment 07's did.
const TIP: u128 = 1_000_000_000;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("local") => local().await,
        Some(kind @ ("send-update" | "send-reconcile")) => send(kind, &args[2..]).await,
        // The send path against a local node and a vault that is not there: refused, printed.
        Some("smoke-send") => {
            let ethrex = EthrexBuilder::from_env().context("ETHREX_BIN")?.spawn().await?;
            // SAFETY: nothing else in this process reads or writes the environment while this mode runs.
            unsafe {
                env::set_var("RPC_URL", ethrex.rpc_url());
                env::set_var("PAYER_KEY", B256::from(rand::rng().random::<[u8; 32]>()).to_string());
            }
            let a = |s: &str| s.to_owned();
            send("send-update", &[a("--vault"), a("0x00000000000000000000000000000000000000aa"), a("--nullifier-hash"), B256::repeat_byte(1).to_string(), a("--verify-data"), a("0x00"), a("--process-data"), a("0xdfefb7d7")]).await
        }
        _ => bail!("usage: x9-runner local | send-update ... | send-reconcile ..."),
    }
}
