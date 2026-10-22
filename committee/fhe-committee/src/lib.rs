//! The FHE half of a fixed committee: a TFHE decryption key held in shares by `MEMBERS`
//! members, any `THRESHOLD` of whom learn nothing, with Zama's threshold-fhe as its authors wrote
//! it; and a coprocessor that evaluates on ciphertexts with the public server key.
//!
//! - [`setup`] makes the key set and shares it: tfhe-rs's keys from threshold-fhe's
//!   `gen_key_set`, split with its `keygen_all_party_shares`, as threshold-fhe's own
//!   `distributed_decryption` example does. That is a dealer, not a DKG; see the README.
//! - [`encrypt`] is the client's side: one 64-bit value in a `ProvenCompactCiphertextList`,
//!   with tfhe-rs's proof of knowledge bound to `metadata`. This is the input format.
//! - [`evaluate`] is the coprocessor: it checks the proof, expands the input and computes.
//! - [`decrypt`] runs threshold-fhe's noise-flooding distributed decryption among all members
//!   in memory, counting what each member sends and receives.
//!
//! The BLS half, which signs what this half decrypts, is `bls-committee`.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

use aes_prng::AesRng;
use async_trait::async_trait;
use rand::{CryptoRng, Rng, SeedableRng};
use serde::{Deserialize, Serialize};
use tfhe::{
    integer::IntegerCiphertext,
    core_crypto::prelude::LweCiphertextCount,
    prelude::{CastInto, CiphertextList, FheDecrypt, FheOrd},
    safe_serialization::{safe_deserialize, safe_serialize},
    set_server_key,
    zk::{CompactPkeCrs, ZkComputeLoad},
    CompactPublicKey, FheUint64, ProvenCompactCiphertextList,
};
use threshold_fhe::{
    algebra::{
        base_ring::Z128,
        galois_rings::{common::ResiduePoly, degree_4::ResiduePolyF4Z128},
    },
    execution::{
        endpoints::{
            decryption::{run_decryption_noiseflood_64, NoiseFloodPreparation, Small},
            keygen::{FhePubKeySet, PrivateKeySet},
        },
        runtime::{
            party::{Identity, Role},
            session::{BaseSession, ParameterHandles, SessionParameters, SmallSessionStruct},
        },
        small_execution::{agree_random::RealAgreeRandom, prss::PRSSSetup},
        tfhe_internals::{
            parameters::{DKGParams, BC_PARAMS_SAM_SNS},
            test_feature::{gen_key_set, keygen_all_party_shares},
        },
    },
    networking::{local::LocalNetworkingProducer, NetworkMode, Networking},
    session_id::SessionId,
};
use tokio::time::{Duration, Instant};

/// The committee's size and the number of members that may be corrupted: 4 and 1, as in
/// threshold-fhe's example and the robust regime its protocols need (`n > 3t`).
pub const MEMBERS: usize = 4;
pub const THRESHOLD: usize = 1;
/// The extension degree threshold-fhe's default build uses.
pub const EXTENSION_DEGREE: usize = 4;
/// tfhe-rs parameters: threshold-fhe's `BC_PARAMS_SAM_SNS`, with the switch-and-squash key that
/// noise-flooding decryption needs.
pub const PARAMS: DKGParams = BC_PARAMS_SAM_SNS;
/// The input carries one 64-bit value; the CRS is sized for exactly that.
pub const INPUT_BITS: usize = 64;
/// tfhe-rs's limit on what `safe_deserialize` reads, generous for a key set.
pub const SERIALIZE_LIMIT: u64 = 1 << 34;

/// The committee's public material: what the client, the coprocessor and every member read.
pub struct Public {
    /// The compact public key the client encrypts under, the server key the coprocessor
    /// evaluates with, and the switch-and-squash key decryption uses.
    pub keys: FhePubKeySet,
    /// The CRS for the input's proof of knowledge.
    pub crs: CompactPkeCrs,
}

/// Makes the key set and the CRS, and shares the decryption key among the members.
pub fn setup<R: Rng + CryptoRng>(rng: &mut R) -> anyhow::Result<(Public, Vec<PrivateKeySet<EXTENSION_DEGREE>>)> {
    let keyset = gen_key_set(PARAMS, rng);
    let lwe = keyset.get_raw_lwe_client_key();
    let glwe = keyset.get_raw_glwe_client_key();
    let sns = keyset.sns_secret_key.key.clone();
    let params = keyset.sns_secret_key.params;
    let shares = keygen_all_party_shares::<_, EXTENSION_DEGREE>(lwe, glwe, sns, params, rng, MEMBERS, THRESHOLD)?;
    let pke = PARAMS.get_params_basics_handle().get_compact_pk_enc_params();
    let capacity = (pke.message_modulus.0 * pke.carry_modulus.0).ilog2() as usize;
    let crs = CompactPkeCrs::from_shortint_params(pke, LweCiphertextCount(INPUT_BITS.div_ceil(capacity)))?;
    Ok((Public { keys: keyset.public_keys, crs }, shares))
}

/// The input format: one `FheUint64` in a `ProvenCompactCiphertextList`, packed, with tfhe-rs's
/// proof of knowledge under the committee's CRS and compact public key, bound to `metadata`,
/// serialized with tfhe-rs's `safe_serialize`. `ZkComputeLoad::Verify` puts the work on the
/// prover's side and leaves the verifier the cheaper check.
pub fn encrypt(public: &Public, value: u64, metadata: &[u8]) -> anyhow::Result<Vec<u8>> {
    let list = ProvenCompactCiphertextList::builder(&public.keys.public_key)
        .push(value)
        .build_with_proof_packed(&public.crs, metadata, ZkComputeLoad::Verify)?;
    let mut out = vec![];
    safe_serialize(&list, &mut out, SERIALIZE_LIMIT).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(out)
}

/// What the coprocessor computes on the input.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Op {
    /// The input plus a public constant, wrapping at 2^64.
    Add(u64),
    /// The input times a public constant, wrapping at 2^64.
    Mul(u64),
}

/// The coprocessor: checks the input's proof against `metadata`, expands it and evaluates `op`.
/// Returns the result, serialized with tfhe-rs's `safe_serialize`.
pub fn evaluate(public: &Public, input: &[u8], metadata: &[u8], op: Op) -> anyhow::Result<Vec<u8>> {
    let list: ProvenCompactCiphertextList =
        safe_deserialize(input, SERIALIZE_LIMIT).map_err(|e| anyhow::anyhow!("{e}"))?;
    set_server_key(public.keys.server_key.clone());
    let expanded = list.verify_and_expand(&public.crs, &public.keys.public_key, metadata)?;
    let x: FheUint64 = expanded.get(0)?.ok_or_else(|| anyhow::anyhow!("the input list is empty"))?;
    let y = match op {
        Op::Add(k) => x + k,
        Op::Mul(k) => x * k,
    };
    let mut out = vec![];
    safe_serialize(&y, &mut out, SERIALIZE_LIMIT).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(out)
}

/// The coprocessor on two owners' inputs, each checked against its own metadata: whether the
/// first is greater than the second, as an encrypted 0 or 1 of the same type `evaluate` returns,
/// so that `decrypt` reads it unchanged.
pub fn compare(public: &Public, a: &[u8], a_metadata: &[u8], b: &[u8], b_metadata: &[u8]) -> anyhow::Result<Vec<u8>> {
    set_server_key(public.keys.server_key.clone());
    let one = |input: &[u8], metadata: &[u8]| -> anyhow::Result<FheUint64> {
        let list: ProvenCompactCiphertextList =
            safe_deserialize(input, SERIALIZE_LIMIT).map_err(|e| anyhow::anyhow!("{e}"))?;
        let expanded = list.verify_and_expand(&public.crs, &public.keys.public_key, metadata)?;
        expanded.get(0)?.ok_or_else(|| anyhow::anyhow!("the input list is empty"))
    };
    let x = one(a, a_metadata)?;
    let y = one(b, b_metadata)?;
    let y: FheUint64 = x.gt(&y).cast_into();
    let mut out = vec![];
    safe_serialize(&y, &mut out, SERIALIZE_LIMIT).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(out)
}

/// Checks only the input's proof, as a verifier other than the coprocessor would.
pub fn verify_input(public: &Public, input: &[u8], metadata: &[u8]) -> anyhow::Result<bool> {
    let list: ProvenCompactCiphertextList =
        safe_deserialize(input, SERIALIZE_LIMIT).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(list.verify(&public.crs, &public.keys.public_key, metadata).is_valid())
}

/// What one member sent and received during a decryption, and how many communication rounds
/// it took part in, by threshold-fhe's own round counter.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Traffic {
    pub member: usize,
    pub messages_sent: usize,
    pub bytes_sent: usize,
    pub messages_received: usize,
    pub bytes_received: usize,
    pub rounds: usize,
}

/// threshold-fhe's in-memory networking, counting what passes through it.
struct Counted {
    inner: Arc<dyn Networking + Send + Sync>,
    sent: AtomicUsize,
    sent_bytes: AtomicUsize,
    received: AtomicUsize,
    received_bytes: AtomicUsize,
}

#[async_trait]
impl Networking for Counted {
    async fn send(&self, value: Vec<u8>, receiver: &Identity) -> anyhow::Result<()> {
        self.sent.fetch_add(1, Ordering::Relaxed);
        self.sent_bytes.fetch_add(value.len(), Ordering::Relaxed);
        self.inner.send(value, receiver).await
    }
    async fn receive(&self, sender: &Identity) -> anyhow::Result<Vec<u8>> {
        let v = self.inner.receive(sender).await?;
        self.received.fetch_add(1, Ordering::Relaxed);
        self.received_bytes.fetch_add(v.len(), Ordering::Relaxed);
        Ok(v)
    }
    fn increase_round_counter(&self) -> anyhow::Result<()> {
        self.inner.increase_round_counter()
    }
    fn get_timeout_current_round(&self) -> anyhow::Result<Instant> {
        self.inner.get_timeout_current_round()
    }
    fn get_current_round(&self) -> anyhow::Result<usize> {
        self.inner.get_current_round()
    }
    fn set_timeout_for_next_round(&self, timeout: Duration) -> anyhow::Result<()> {
        self.inner.set_timeout_for_next_round(timeout)
    }
    fn set_timeout_for_bk(&self) -> anyhow::Result<()> {
        self.inner.set_timeout_for_bk()
    }
    fn set_timeout_for_bk_sns(&self) -> anyhow::Result<()> {
        self.inner.set_timeout_for_bk_sns()
    }
    fn get_network_mode(&self) -> NetworkMode {
        self.inner.get_network_mode()
    }
}

/// A decryption's result: the value every member reconstructed, each member's traffic, and the
/// wall-clock time of the whole run on this machine.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decryption {
    pub value: u64,
    pub members: Vec<Traffic>,
    pub millis: u128,
}

/// Decrypts `result` with every member's share, by threshold-fhe's noise-flooding protocol
/// (`NoiseFloodSmall`): each member sets up its PRSS, makes its noise preprocessing, and opens
/// its partial decryption to the others. All members run in this process over threshold-fhe's
/// in-memory networking, so the time is a LAN time at best. The switch-and-squash step, which
/// each member would run alone on the public ciphertext, runs once here, as threshold-fhe's own
/// test endpoint does; it is local and adds no traffic.
pub fn decrypt(
    public: &Public,
    shares: &[PrivateKeySet<EXTENSION_DEGREE>],
    result: &[u8],
) -> anyhow::Result<Decryption> {
    anyhow::ensure!(shares.len() == MEMBERS, "every member's share");
    let ct: FheUint64 = safe_deserialize(result, SERIALIZE_LIMIT).map_err(|e| anyhow::anyhow!("{e}"))?;
    let (raw, _, _) = ct.into_raw_parts();
    let sns = public.keys.sns_key.clone().ok_or_else(|| anyhow::anyhow!("no switch-and-squash key"))?;
    let started = std::time::Instant::now();
    let large = sns.to_large_ciphertext(&raw)?;

    let identities: Vec<Identity> = (1..=MEMBERS).map(|i| Identity(format!("member-{i}"))).collect();
    let roles: HashMap<Role, Identity> =
        identities.iter().enumerate().map(|(i, id)| (Role::indexed_by_zero(i), id.clone())).collect();
    let producer = LocalNetworkingProducer::from_ids(&identities);
    let nets: Vec<Arc<Counted>> = identities
        .iter()
        .map(|id| {
            Arc::new(Counted {
                inner: Arc::new(producer.user_net(id.clone(), NetworkMode::Sync, None)),
                sent: AtomicUsize::new(0),
                sent_bytes: AtomicUsize::new(0),
                received: AtomicUsize::new(0),
                received_bytes: AtomicUsize::new(0),
            })
        })
        .collect();
    let session_id = SessionId::new(&raw)?;
    let blocks = raw.blocks().len();

    let rt = tokio::runtime::Runtime::new()?;
    let values = rt.block_on(async {
        let mut set = tokio::task::JoinSet::new();
        for (i, id) in identities.iter().enumerate() {
            let params = SessionParameters::new(THRESHOLD as u8, session_id, id.clone(), roles.clone())?;
            let net: Arc<dyn Networking + Send + Sync> = nets[i].clone();
            let mut base = BaseSession::new(params, net, AesRng::from_entropy())?;
            let share = shares[i].clone();
            let large = large.clone();
            set.spawn(async move {
                let sid = base.session_id();
                let prss = PRSSSetup::<ResiduePolyF4Z128>::init_with_abort::<RealAgreeRandom, AesRng, _>(&mut base).await?;
                let mut session = SmallSessionStruct::new_from_prss_state(base, prss.new_prss_session_state(sid))?;
                let mut prep = Small::<EXTENSION_DEGREE>::new(session.clone())
                    .init_prep_noiseflooding(blocks)
                    .await?;
                let out = run_decryption_noiseflood_64(&mut session, prep.as_mut(), &share, large).await?;
                anyhow::Ok((i, out.0))
            });
        }
        let mut values = vec![0u64; MEMBERS];
        while let Some(r) = set.join_next().await {
            let (i, v) = r??;
            values[i] = v;
        }
        anyhow::Ok(values)
    })?;
    let millis = started.elapsed().as_millis();
    anyhow::ensure!(values.windows(2).all(|w| w[0] == w[1]), "members reconstructed different values: {values:?}");
    let members = nets
        .iter()
        .enumerate()
        .map(|(i, n)| Traffic {
            member: i,
            messages_sent: n.sent.load(Ordering::Relaxed),
            bytes_sent: n.sent_bytes.load(Ordering::Relaxed),
            messages_received: n.received.load(Ordering::Relaxed),
            bytes_received: n.received_bytes.load(Ordering::Relaxed),
            rounds: n.inner.get_current_round().unwrap_or_default(),
        })
        .collect();
    Ok(Decryption { value: values[0], members, millis })
}

/// For tests: decrypts with the whole key, which no member holds.
pub fn decrypt_in_the_clear(client_key: &tfhe::ClientKey, result: &[u8]) -> anyhow::Result<u64> {
    let ct: FheUint64 = safe_deserialize(result, SERIALIZE_LIMIT).map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(ct.decrypt(client_key))
}

/// Writes the public material: the compact public key and the CRS alone (what a client needs),
/// and the whole key set (what the coprocessor and the members need).
pub fn write_public(public: &Public, dir: &std::path::Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    let mut pk = vec![];
    safe_serialize(&public.keys.public_key, &mut pk, SERIALIZE_LIMIT).map_err(|e| anyhow::anyhow!("{e}"))?;
    std::fs::write(dir.join("compact_public_key.bin"), pk)?;
    let mut crs = vec![];
    safe_serialize(&public.crs, &mut crs, SERIALIZE_LIMIT).map_err(|e| anyhow::anyhow!("{e}"))?;
    std::fs::write(dir.join("crs.bin"), crs)?;
    std::fs::write(dir.join("keys.bin"), bincode::serialize(&public.keys)?)?;
    Ok(())
}

/// Reads what [`write_public`] wrote.
pub fn read_public(dir: &std::path::Path) -> anyhow::Result<Public> {
    let keys: FhePubKeySet = bincode::deserialize(&std::fs::read(dir.join("keys.bin"))?)?;
    let crs: CompactPkeCrs = safe_deserialize(&std::fs::read(dir.join("crs.bin"))?[..], SERIALIZE_LIMIT)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(Public { keys, crs })
}

/// The compact public key alone, as a client reads it.
pub fn read_compact_public_key(bytes: &[u8]) -> anyhow::Result<CompactPublicKey> {
    safe_deserialize(bytes, SERIALIZE_LIMIT).map_err(|e| anyhow::anyhow!("{e}"))
}

#[allow(dead_code)]
type Z128F4 = ResiduePoly<Z128, EXTENSION_DEGREE>;

#[cfg(test)]
mod tests;
