//! C6, who signed: a committee's signature on a fresh sender's slot, checked in a paymaster's
//! `VERIFY` frame on EIP-2537, in two forms, for several committee sizes.
//!
//! ```text
//! PRIVATE_KEY=0x... SIZES=5,10,13,16,32,64,128,256 RECORD=out.json \
//!   cargo run --release --manifest-path experiments/10-c6-accountable-signers/rust/Cargo.toml
//! ```
//!
//! - **Threshold**: one BLS signature under the committee's group key, which says nothing about
//!   who signed. The key is dealt (Commonware's `deal`), and a quorum's partials are combined. The
//!   paymaster is the ticket paymaster, unchanged: its check is a threshold signature's.
//! - **Accountable**: a bitmap naming the signers and their own signatures, checked under the sum
//!   of their keys by `AccountablePaymaster`, which holds a hash of the committee's keys. Two
//!   modes: the signers' signatures aggregated off chain into one (Commonware's multisig
//!   certificate: a bitmap and one signature), and every signer's signature carried and
//!   aggregated in the frame.
//!
//! For each size `n`, a quorum of `n - f` members signs (`f = (n - 1) / 3`). One transaction
//! deploys and funds both paymasters; then three spends, each from a fresh sender with no ether,
//! go to the chain one after another. Every spend's gas, by frame, and its bytes are recorded,
//! and whether the chain took it. Off chain, the threshold signature is made from two different
//! quorums, to show whether it can be attributed.
//!
//! `RECORD` names a JSON file. No private key or share is recorded or printed.

use std::{env, fs, time::Duration};

use alloy::{
    primitives::{Address, B256, U256, address, keccak256},
    providers::{Provider, ProviderBuilder},
    signers::local::PrivateKeySigner,
    sol,
    sol_types::SolCall,
};
use anyhow::{Context, ensure};
use commonware_codec::Encode;
use commonware_cryptography::bls12381::{
    dkg::feldman_desmedt::deal,
    primitives::{
        group::{G1, Private},
        ops::{self, threshold},
        sharing::Mode,
        variant::MinSig,
    },
};
use commonware_math::algebra::Additive;
use commonware_parallel::Sequential;
use commonware_utils::{Faults, N3f1, TryCollect, ordered::Set};
use kohaku_frame_accounts::{
    account::{Eoa, Signer},
    builder::{Envelope, TxPlan},
    contracts::{create2_address, deploy_frame},
};
use kohaku_frame_kit::{Frame, FrameSigner, FrameTx, Fees, gas::max_cost, rpc::{self, HEGOTA_RPC_URL}, sign_all};
use kohaku_frame_ticket::{
    Claim, Slot, Ticket, TicketPaymaster, TicketSponsor,
    ticket::{NAMESPACE as TICKET_NAMESPACE, g1_eip2537, g2_eip2537},
};
use rand::RngExt;
use serde_json::{Value, json};

const BOARD: Address = address!("0x93DD748B72dA1b1B6F1d5ec78Cb91ee52F01727d");
/// 0.01 ETH: a paymaster refuses a transaction whose max cost exceeds it, and the keys the
/// accountable form carries as data cost more than the ticket's 0.001 ETH at 64 members and up
/// (the first run's refusals).
const DENOMINATION: U256 = U256::from_limbs([10_000_000_000_000_000, 0, 0, 0]);
const TIP: u128 = 1_000_000_000;
/// The accountable paymaster's namespace, as its code holds it.
const COMMIT_NAMESPACE: &[u8] = b"FRAME_COMMIT_V1";
const ACCOUNTABLE_HEX: &str = include_str!("../../contracts/AccountablePaymaster.hex");
const ECDSA_HEX: &str = include_str!("../../contracts/EcdsaPaymaster.hex");
/// The ECDSA control's namespace, as its code holds it.
const ECDSA_NAMESPACE: &[u8] = b"FRAME_ECDSA_V1";

sol! {
    function post(bytes message);
}

fn hex(b: &[u8]) -> String {
    format!("0x{}", ::hex::encode(b))
}

/// The accountable paymaster for one committee.
struct Accountable {
    keys: Vec<u8>,
    quorum: u64,
    n: u64,
    salt: B256,
    hex: &'static str,
}

impl Accountable {
    fn initcode(&self) -> Vec<u8> {
        let mut code = ::hex::decode(self.hex.trim()).expect("embedded hex");
        code.extend_from_slice(keccak256(&self.keys).as_slice());
        code.extend_from_slice(&U256::from(self.quorum).to_be_bytes::<32>());
        code.extend_from_slice(&U256::from(self.n).to_be_bytes::<32>());
        code.extend_from_slice(&DENOMINATION.to_be_bytes::<32>());
        code
    }
    fn address(&self) -> Address {
        create2_address(&self.initcode(), self.salt)
    }
}

fn claim(chain_id: u64, sender: Address, rng: &mut impl rand::Rng) -> Claim {
    Claim {
        slot: Slot { chain_id, sender, nonce_keys: vec![U256::ZERO], nonce_seq: 0 },
        epoch: 0,
        salt: B256::from(rng.random::<[u8; 32]>()),
    }
}

/// A fresh sender's first transaction paid by `paymaster` with `data` in its `VERIFY` frame.
fn spend(chain_id: u64, fees: Fees, sender: &PrivateKeySigner, paymaster: Address, data: Vec<u8>, verify: u64, note: &str) -> anyhow::Result<FrameTx> {
    let account = Eoa::new(Signer::secp256k1(sender.address()));
    let mut sponsor = TicketSponsor {
        paymaster,
        data,
        verify_execution: verify,
        state: TicketSponsor::NEW_ACCOUNT_STATE,
    };
    let mut tx = TxPlan::new(&account)
        .sponsored_by(&mut sponsor)
        .call(
            Frame::sender(Some(BOARD))
                .with_data(postCall { message: note.as_bytes().to_vec().into() }.abi_encode())
                .with_execution(30_000),
        )
        .build(&Envelope { chain_id, nonce_keys: vec![U256::ZERO], nonce_seq: 0, fees })?;
    sign_all(&mut tx, &[FrameSigner::Secp256k1(sender.clone())])?;
    Ok(tx)
}

/// The accountable frame's declared execution limit: a fit to the gas the first run measured
/// (`results/1-first-run.json`, n from 5 to 32), 170 gas a member and 875 a signer above n = 5,
/// 620 more a signer when the signatures are added in the frame, the memory for the keys, and a
/// tenth more. Declaring more than the check needs would trip the node's budget, not the check's.
fn accountable_verify_limit(n: u64, q: u64, individual: bool) -> u64 {
    let words = n * 8 + 0x80;
    let fit = 126_842 + (n - 5) * 170 + (q - 4) * 875 + if individual { q * 620 } else { 0 } + words * words / 512;
    fit + fit / 10 + 5_000
}

/// The ECDSA frame's: 18,108 at n = 5, about 3,514 a signature (the first run, n from 5 to 128),
/// and a tenth more.
fn ecdsa_verify_limit(n: u64, q: u64) -> u64 {
    let fit = 18_108 + (q - 4) * 3_514 + (n - 5) * 30;
    fit + fit / 10 + 5_000
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let url = env::var("RPC_URL").unwrap_or_else(|_| HEGOTA_RPC_URL.to_owned());
    let funder: PrivateKeySigner = env::var("PRIVATE_KEY").context("PRIVATE_KEY deploys and funds the paymasters")?.parse()?;
    let sizes: Vec<u64> = env::var("SIZES")
        .unwrap_or_else(|_| "5,10,13,16,32,64,128,256".into())
        .split(',')
        .map(|s| s.trim().parse())
        .collect::<Result<_, _>>()?;
    let chain = ProviderBuilder::new().connect_http(url.parse()?);
    let chain_id = chain.get_chain_id().await?;
    let mut rng = rand::rng();
    let mut out = vec![];

    for n in sizes {
        let f = N3f1::max_faults(n as u32) as u64;
        let q = n - f;
        println!("n {n}: quorum {q}");

        // The threshold key, dealt; and n independent keys for the accountable form.
        let players: Set<u32> = (0..n as u32).try_collect().map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let (output, shares) = deal::<MinSig, _, N3f1>(&mut rng, Mode::NonZeroCounter, players).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let sharing = output.public().clone();
        ensure!(sharing.required() as u64 == q, "the dealt quorum is not n - f");
        let keypairs: Vec<(Private, _)> = (0..n).map(|_| ops::keypair::<_, MinSig>(&mut rng)).collect();
        let keys: Vec<u8> = keypairs.iter().flat_map(|(_, pk)| g2_eip2537(pk)).collect();

        let ticket_pm = TicketPaymaster { key: *sharing.public(), denomination: DENOMINATION, salt: B256::from(rng.random::<[u8; 32]>()) };
        let acc = Accountable { keys: keys.clone(), quorum: q, n, salt: B256::from(rng.random::<[u8; 32]>()), hex: ACCOUNTABLE_HEX };
        // The control: n ordinary secp256k1 keys, the committee's addresses committed.
        let ecdsa_signers: Vec<PrivateKeySigner> = (0..n).map(|_| PrivateKeySigner::random()).collect();
        let addresses: Vec<u8> = ecdsa_signers.iter().flat_map(|k| k.address().to_vec()).collect();
        let ecdsa = Accountable { keys: addresses.clone(), quorum: q, n, salt: B256::from(rng.random::<[u8; 32]>()), hex: ECDSA_HEX };
        let setup = send(&chain, &funder, vec![
            ticket_pm.deploy_frame(),
            ticket_pm.buy_frame(1),
            deploy_frame(&acc.initcode(), acc.salt, 0),
            Frame::sender(Some(acc.address())).with_value(DENOMINATION * U256::from(2)).with_execution(10_000),
            deploy_frame(&ecdsa.initcode(), ecdsa.salt, 0),
            Frame::sender(Some(ecdsa.address())).with_value(DENOMINATION).with_execution(10_000),
        ], chain_id).await?;
        let fees = rpc::suggest_fees(&chain, TIP).await?;

        // Threshold: a quorum's partials combined; and again from another quorum, off chain.
        let sender = PrivateKeySigner::random();
        let c = claim(chain_id, sender.address(), &mut rng);
        let share_list = shares.values();
        let partials = |from: usize| -> Vec<_> {
            (0..q as usize).map(|j| threshold::sign_message::<MinSig>(&share_list[(from + j) % n as usize], TICKET_NAMESPACE, &c.message())).collect()
        };
        let sig_a = threshold::recover::<MinSig, _>(&sharing, &partials(0), &Sequential).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let sig_b = threshold::recover::<MinSig, _>(&sharing, &partials(f as usize + 1), &Sequential).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let ticket = Ticket { claim: c, signature: sig_a };
        ticket.verify(&sharing).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let tx = spend(chain_id, fees, &sender, ticket_pm.address(), ticket.pay_data(), TicketSponsor::VERIFY_EXECUTION, &format!("C6: threshold, n {n}"))?;
        let mut threshold_spend = submit(&chain, &tx, ticket_pm.address(), ticket.pay_data().len()).await?;
        threshold_spend["sender"] = json!(sender.address());
        threshold_spend["salt"] = json!(ticket.claim.salt);
        threshold_spend["signatureEip2537"] = json!(hex(&g1_eip2537(&ticket.signature)));
        threshold_spend["verifyData"] = json!(hex(&ticket.pay_data()));

        // Accountable: the first q members sign.
        let mut accountable = vec![];
        for mode in [0u8, 1] {
            let sender = PrivateKeySigner::random();
            let c = claim(chain_id, sender.address(), &mut rng);
            let sigs: Vec<G1> = keypairs.iter().take(q as usize).map(|(sk, _)| ops::sign_message::<MinSig>(sk, COMMIT_NAMESPACE, &c.message())).collect();
            let mut bitmap = vec![0u8; n.div_ceil(8) as usize];
            for i in 0..q as usize {
                bitmap[i / 8] |= 1 << (i % 8);
            }
            let mut data = vec![];
            data.extend_from_slice(&c.epoch.to_be_bytes());
            data.extend_from_slice(c.salt.as_slice());
            data.push(mode);
            data.extend_from_slice(&bitmap);
            data.extend_from_slice(&keys);
            if mode == 0 {
                let mut agg = G1::zero();
                for s in &sigs {
                    agg += s;
                }
                let sum_pk = keypairs.iter().take(q as usize).fold(<MinSig as commonware_cryptography::bls12381::primitives::variant::Variant>::Public::zero(), |mut a, (_, pk)| { a += pk; a });
                ensure!(ops::verify_message::<MinSig>(&sum_pk, COMMIT_NAMESPACE, &c.message(), &agg).is_ok(), "the aggregate does not verify");
                data.extend_from_slice(&g1_eip2537(&agg));
            } else {
                for s in &sigs {
                    data.extend_from_slice(&g1_eip2537(s));
                }
            }
            let limit = accountable_verify_limit(n, q, mode == 1);
            let tx = spend(chain_id, fees, &sender, acc.address(), data.clone(), limit, &format!("C6: accountable mode {mode}, n {n}"))?;
            let mut r = submit(&chain, &tx, acc.address(), data.len()).await?;
            r["sender"] = json!(sender.address());
            r["salt"] = json!(c.salt);
            r["signaturesEip2537"] = json!(sigs.iter().map(|s| hex(&g1_eip2537(s))).collect::<Vec<_>>());
            r["verifyData"] = json!(hex(&data));
            r["mode"] = json!(if mode == 0 { "aggregate" } else { "individual" });
            r["bitmap"] = json!(hex(&bitmap));
            accountable.push(r);
        }

        // The control: k = q members sign the digest with ECDSA, each checked on chain on its own.
        let ecdsa_spend = {
            let sender = PrivateKeySigner::random();
            let c = claim(chain_id, sender.address(), &mut rng);
            let digest = keccak256([ECDSA_NAMESPACE, &c.message()[..]].concat());
            let mut bitmap = vec![0u8; n.div_ceil(8) as usize];
            let mut data = vec![];
            data.extend_from_slice(&c.epoch.to_be_bytes());
            data.extend_from_slice(c.salt.as_slice());
            for i in 0..q as usize {
                bitmap[i / 8] |= 1 << (i % 8);
            }
            data.extend_from_slice(&bitmap);
            data.extend_from_slice(&addresses);
            let mut sigs = vec![];
            for k in ecdsa_signers.iter().take(q as usize) {
                let sig = alloy::signers::SignerSync::sign_hash_sync(k, &digest)?;
                let mut b = [0u8; 65];
                b[..32].copy_from_slice(&sig.r().to_be_bytes::<32>());
                b[32..64].copy_from_slice(&sig.s().to_be_bytes::<32>());
                b[64] = 27 + u8::from(sig.v());
                data.extend_from_slice(&b);
                sigs.push(hex(&b));
            }
            let verify = ecdsa_verify_limit(n, q);
            let tx = spend(chain_id, fees, &sender, ecdsa.address(), data.clone(), verify, &format!("C6: ECDSA control, n {n}"))?;
            let mut r = submit(&chain, &tx, ecdsa.address(), data.len()).await?;
            r["sender"] = json!(sender.address());
            r["salt"] = json!(c.salt);
            r["digest"] = json!(digest);
            r["bitmap"] = json!(hex(&bitmap));
            r["signatures"] = json!(sigs);
            r["verifyData"] = json!(hex(&data));
            r["verifyLimit"] = json!(verify);
            r
        };

        out.push(json!({
            "n": n,
            "f": f,
            "quorum": q,
            "setup": setup,
            "threshold": {
                "paymaster": ticket_pm.address(),
                "keyEip2537": hex(&g2_eip2537(sharing.public())),
                "spend": threshold_spend,
                "sameSignatureFromTwoQuorums": sig_a == sig_b,
                "quorums": [[0, q - 1], [f + 1, (f + q) % n]],
                "signatureFromQuorumA": hex(&sig_a.encode()),
                "signatureFromQuorumB": hex(&sig_b.encode()),
            },
            "ecdsa": {
                "paymaster": ecdsa.address(),
                "addressesCommit": keccak256(&addresses),
                "addresses": hex(&addresses),
                "spend": ecdsa_spend,
            },
            "accountable": {
                "paymaster": acc.address(),
                "keysCommit": keccak256(&keys),
                "keysEip2537": hex(&keys),
                "spends": accountable,
            },
        }));
    }

    if let Ok(path) = env::var("RECORD") {
        let record = json!({
            "chainId": chain_id,
            "denomination": DENOMINATION,
            "funder": funder.address(),
            "ticketNamespace": String::from_utf8_lossy(TICKET_NAMESPACE),
            "accountableNamespace": String::from_utf8_lossy(COMMIT_NAMESPACE),
            "ecdsaNamespace": String::from_utf8_lossy(ECDSA_NAMESPACE),
            "whoSeesPartials": "the combiner: each signing member sends its partial to whoever recovers the threshold signature, here this runner; only the recovered signature reaches the chain. The accountable and ECDSA forms put every signer's own contribution, or their aggregate with the bitmap, in the transaction",
            "sizes": out,
        });
        fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&record)?))?;
        println!("recorded in {path}");
    }
    Ok(())
}

/// Sends a spend to the chain and waits for it, recording the chain's answer, its bytes and its
/// gas by frame. A refusal is recorded, not fatal: it is a result.
async fn submit<P: Provider>(chain: &P, tx: &FrameTx, paymaster: Address, data_len: usize) -> anyhow::Result<Value> {
    let raw = tx.encode();
    let cost = max_cost(tx, 0)?;
    let base = json!({
        "hash": tx.hash(),
        "raw": hex(&raw),
        "txBytes": raw.len(),
        "verifyDataBytes": data_len,
        "maxCost": cost,
    });
    let answer = rpc::send(chain, tx).await;
    let mut v = base;
    match answer {
        Err(e) => {
            println!("  refused {}: {e}", tx.hash());
            v["answer"] = json!({ "error": e.to_string() });
            v["mined"] = json!(false);
        }
        Ok(hash) => {
            v["answer"] = json!({ "result": hash });
            let receipt = rpc::wait_for_confirmed_receipt(chain, tx.hash(), Duration::from_mins(4), Duration::from_secs(2)).await?;
            let pay = &receipt.frame_receipts[1];
            println!("  {} block {}, VERIFY {} gas, {} bytes", tx.hash(), receipt.block_number, pay.gas_used, raw.len());
            v["mined"] = json!(true);
            v["block"] = json!(receipt.block_number);
            v["gasUsed"] = json!(receipt.gas_used);
            v["payer"] = json!(receipt.payer);
            v["paidByPaymaster"] = json!(receipt.payer == paymaster);
            v["frames"] = json!(receipt.frame_receipts.iter().map(|f| json!({
                "status": f.status,
                "gasUsed": f.gas_used,
                "stateGasUsed": f.state_gas_used,
            })).collect::<Vec<_>>());
        }
    }
    Ok(v)
}

async fn send<P: Provider>(provider: &P, key: &PrivateKeySigner, calls: Vec<Frame>, chain_id: u64) -> anyhow::Result<Value> {
    let account = Eoa::new(Signer::secp256k1(key.address()));
    let envelope = Envelope::fetch(provider, key.address(), vec![U256::ZERO], TIP).await?;
    ensure!(envelope.chain_id == chain_id);
    let mut tx = TxPlan::new(&account).calls(calls).build(&envelope)?;
    sign_all(&mut tx, &[FrameSigner::Secp256k1(key.clone())])?;
    let done = rpc::execute(provider, &tx, true).await?;
    println!("setup {}: block {}, gasUsed {}", done.hash, done.receipt.block_number, done.receipt.gas_used);
    Ok(json!({ "hash": done.hash, "block": done.receipt.block_number, "gasUsed": done.receipt.gas_used }))
}
