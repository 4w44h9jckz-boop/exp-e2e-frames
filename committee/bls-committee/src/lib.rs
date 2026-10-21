//! The signing half of a fixed committee: a BLS12-381 key held in shares, made by Commonware's
//! Joint-Feldman DKG (`dkg::feldman_desmedt`), as X3's ticket issuers made theirs. A quorum of
//! members signs a result the FHE half decrypted; the signature is the one a `VERIFY` frame
//! checks on EIP-2537, as the ticket paymaster checks a ticket.
//!
//! **The signed message (fixed).** Under `MinSig` (signatures in G1, the key in G2), with
//! Commonware's `ops::sign_message`, namespace [`NAMESPACE`]:
//!
//! ```text
//! message = chain_id (32) || request (32) || handle (32) || value (32)          128 bytes
//! ```
//!
//! - `request`: 32 bytes naming the request, chosen by whoever builds the result transaction
//!   (for example the request transaction's hash);
//! - `handle`: keccak256 of the result ciphertext as the coprocessor serialized it;
//! - `value`: the decrypted value, big-endian.
//!
//! The point signed is `hash_to_curve(union_unique(NAMESPACE, message))` in G1 under RFC 9380's
//! `BLS12381G1_XMD:SHA-256_SSWU_RO_` suite with the DST `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_`,
//! exactly as a ticket's, so the ticket paymaster's check serves with only the namespace and the
//! message changed.

use std::collections::BTreeMap;

use commonware_codec::{Encode, ReadExt};
use commonware_cryptography::{
    Signer,
    bls12381::{
        dkg::feldman_desmedt::{self, Info, Output, Reveal, Traffic},
        primitives::{
            group::{G1, Scalar, Share},
            ops::{self, threshold},
            sharing::{Mode, Sharing},
            variant::{MinSig, PartialSignature},
        },
    },
    ed25519,
};
use commonware_math::algebra::{Additive, Field, Random, Ring};
use commonware_parallel::Sequential;
use commonware_utils::{N3f1, TryCollect, ordered::Set};
use rand10::CryptoRng;
use sha3::{Digest, Keccak256};

/// The namespace of a result signature.
pub const NAMESPACE: &[u8] = b"FRAME_FHE_RESULT_V1";
/// The DKG's namespace.
pub const DKG_NAMESPACE: &[u8] = b"exp-e2e-frames-result-committee";

/// What the committee signs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResultClaim {
    pub chain_id: u64,
    pub request: [u8; 32],
    pub handle: [u8; 32],
    pub value: u64,
}

impl ResultClaim {
    /// The claim for a result ciphertext: its handle is keccak256 of its bytes.
    pub fn for_ciphertext(chain_id: u64, request: [u8; 32], ciphertext: &[u8], value: u64) -> Self {
        Self { chain_id, request, handle: Keccak256::digest(ciphertext).into(), value }
    }

    /// The 128 bytes signed.
    pub fn message(&self) -> [u8; 128] {
        let mut m = [0u8; 128];
        m[24..32].copy_from_slice(&self.chain_id.to_be_bytes());
        m[32..64].copy_from_slice(&self.request);
        m[64..96].copy_from_slice(&self.handle);
        m[120..128].copy_from_slice(&self.value.to_be_bytes());
        m
    }
}

/// The committee after its DKG: the public sharing, each member's identity and share, and what
/// each member sent and received during the DKG.
pub struct Committee {
    pub output: Output<MinSig, ed25519::PublicKey>,
    pub members: Vec<(ed25519::PublicKey, Share)>,
    pub traffic: BTreeMap<ed25519::PublicKey, Traffic>,
}

impl Committee {
    /// One Joint-Feldman round among `n` members, each a dealer and a player, in memory.
    pub fn dkg(rng: &mut impl CryptoRng, n: usize) -> anyhow::Result<Self> {
        let keys: Vec<ed25519::PrivateKey> = (0..n).map(|_| ed25519::PrivateKey::random(&mut *rng)).collect();
        let set: Set<ed25519::PublicKey> =
            keys.iter().map(Signer::public_key).try_collect().map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let info = Info::<MinSig, ed25519::PublicKey>::new::<N3f1>(
            DKG_NAMESPACE,
            0,
            None,
            Mode::NonZeroCounter,
            Reveal::V1,
            set.clone(),
            set,
        )
        .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let round = feldman_desmedt::run::<MinSig, _, N3f1, ed25519::Batch>(
            rng,
            info,
            keys.iter().map(|k| (k.clone(), None)).collect(),
            keys.clone(),
            &Sequential,
        )
        .map_err(|e| anyhow::anyhow!("dkg: {e}"))?;
        let mut members: Vec<_> = round.shares.iter_pairs().map(|(pk, s)| (pk.clone(), s.clone())).collect();
        members.sort_by_key(|(_, s)| s.index);
        Ok(Self { output: round.output, members, traffic: round.traffic })
    }

    pub fn sharing(&self) -> &Sharing<MinSig> {
        self.output.public()
    }

    /// How many members make a signature.
    pub fn quorum(&self) -> usize {
        self.sharing().required() as usize
    }
}

/// One member's partial signature on a claim.
pub fn partial(share: &Share, claim: &ResultClaim) -> PartialSignature<MinSig> {
    threshold::sign_message::<MinSig>(share, NAMESPACE, &claim.message())
}

/// The group's signature from a quorum of partials, each checked against its member's public
/// share first.
pub fn combine(sharing: &Sharing<MinSig>, claim: &ResultClaim, partials: &[PartialSignature<MinSig>]) -> anyhow::Result<G1> {
    for p in partials {
        threshold::verify_message::<MinSig>(sharing, NAMESPACE, &claim.message(), p)
            .map_err(|e| anyhow::anyhow!("member {}'s partial does not check: {e:?}", p.index))?;
    }
    threshold::recover::<MinSig, _>(sharing, partials, &Sequential).map_err(|e| anyhow::anyhow!("{e:?}"))
}

/// The best a set below the quorum can do: interpolate its partials at zero as if they were a
/// quorum. With `q - 1` partials of a degree `q - 1` sharing, the result is a point that is not
/// the group's signature, except with negligible probability.
pub fn interpolate_below(partials: &[PartialSignature<MinSig>]) -> G1 {
    // Mode::NonZeroCounter evaluates participant i at i + 1.
    let xs: Vec<Scalar> = partials.iter().map(|p| Scalar::from_u64(u64::from(p.index.get()) + 1)).collect();
    let mut acc = G1::zero();
    for (j, p) in partials.iter().enumerate() {
        let mut w = Scalar::one();
        for (m, xm) in xs.iter().enumerate() {
            if m != j {
                let mut d = xm.clone();
                d -= &xs[j];
                let mut t = xm.clone();
                t *= &d.inv();
                w *= &t;
            }
        }
        acc += &(p.value * &w);
    }
    acc
}

/// What a member has signed, by request. A member signs at most one result for each request.
/// Any two quorums share at least `2q - n` members; with `q > (n + t) / 2` that is more than `t`,
/// so while at most `t` members ignore their locks, some honest member is in both quorums and
/// refuses the second result: two results for one request cannot both be signed.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Locks {
    /// request (hex) to the keccak256 of the message the member signed for it (hex)
    pub signed: BTreeMap<String, String>,
}

/// Why a member refused to sign.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// It already signed another result for this request.
    Locked { request: String },
}

impl Locks {
    /// Signs `claim` with `share` unless this member already signed a different result for the
    /// same request; records the lock if it signs.
    pub fn sign(&mut self, share: &Share, claim: &ResultClaim) -> Result<PartialSignature<MinSig>, Refusal> {
        let request = format!("0x{}", hex::encode(claim.request));
        let digest = format!("0x{}", hex::encode(Keccak256::digest(claim.message())));
        match self.signed.get(&request) {
            Some(d) if *d != digest => return Err(Refusal::Locked { request }),
            _ => {}
        }
        self.signed.insert(request, digest);
        Ok(partial(share, claim))
    }
}

/// What `t` members can make from their own shares and every public value of the DKG (the
/// group sharing, every member's partial key): each attempt a candidate signature on `claim`.
/// In a Feldman round a member's view is the dealers' public commitments and its own private
/// evaluations, which sum to its share; the commitments are summed into the public sharing.
pub fn forge_attempts(sharing: &Sharing<MinSig>, shares: &[Share], claim: &ResultClaim) -> Vec<(String, G1)> {
    let partials: Vec<_> = shares.iter().map(|s| partial(s, claim)).collect();
    let mut out = vec![];
    for p in &partials {
        out.push((format!("member {}'s partial alone", p.index.get()), p.value));
        // Its partial weighted as in each quorum it could belong to with the lowest-index others.
        let n = sharing.total().get() as u64;
        let q = sharing.required() as usize;
        let mut others: Vec<u64> = (0..n).filter(|&i| i != u64::from(p.index.get())).collect();
        others.truncate(q - 1);
        let mut xs: Vec<u64> = others.clone();
        xs.push(u64::from(p.index.get()));
        let x = |i: u64| Scalar::from_u64(i + 1);
        let mut w = Scalar::one();
        for &m in &others {
            let mut d = x(m);
            d -= &x(u64::from(p.index.get()));
            let mut t = x(m);
            t *= &d.inv();
            w *= &t;
        }
        out.push((format!("member {}'s partial times its Lagrange weight in quorum {:?}", p.index.get(), xs), p.value * &w));
    }
    if partials.len() > 1 {
        let mut sum = G1::zero();
        for p in &partials {
            sum += &p.value;
        }
        out.push(("the partials summed".into(), sum));
        out.push(("the partials interpolated at zero".into(), interpolate_below(&partials)));
    }
    out
}

/// Whether `signature` is the group's on `claim`.
pub fn verify(sharing: &Sharing<MinSig>, claim: &ResultClaim, signature: &G1) -> bool {
    ops::verify_message::<MinSig>(sharing.public(), NAMESPACE, &claim.message(), signature).is_ok()
}

/// A G1 point back from its Commonware encoding.
pub fn g1_decode(bytes: &[u8]) -> anyhow::Result<G1> {
    G1::read(&mut &bytes[..]).map_err(|e| anyhow::anyhow!("{e:?}"))
}

/// A share back from its Commonware encoding.
pub fn share_decode(bytes: &[u8]) -> anyhow::Result<Share> {
    Share::read(&mut &bytes[..]).map_err(|e| anyhow::anyhow!("{e:?}"))
}

pub fn share_encode(share: &Share) -> Vec<u8> {
    share.encode().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand10::{SeedableRng, rngs::StdRng};

    fn claim() -> ResultClaim {
        ResultClaim::for_ciphertext(8141, [7; 32], b"ciphertext", 42)
    }

    #[test]
    fn a_quorum_signs_and_one_fewer_cannot() {
        let mut rng = StdRng::seed_from_u64(1);
        let c = Committee::dkg(&mut rng, 4).unwrap();
        assert_eq!(c.quorum(), 3);
        let partials: Vec<_> = c.members.iter().map(|(_, s)| partial(s, &claim())).collect();
        let sig = combine(c.sharing(), &claim(), &partials[..3]).unwrap();
        assert!(verify(c.sharing(), &claim(), &sig));
        // Any quorum makes the same signature.
        assert_eq!(combine(c.sharing(), &claim(), &partials[1..]).unwrap(), sig);
        // Two of four: recover refuses, and interpolating them anyway is not the signature.
        assert!(combine(c.sharing(), &claim(), &partials[..2]).is_err());
        let below = interpolate_below(&partials[..2]);
        assert!(!verify(c.sharing(), &claim(), &below));
        // Three interpolated by hand is the signature: the interpolation is right.
        assert_eq!(interpolate_below(&partials[..3]), sig);
        // Another claim does not verify.
        let mut other = claim();
        other.value = 43;
        assert!(!verify(c.sharing(), &other, &sig));
    }

    #[test]
    fn a_member_signs_one_result_per_request() {
        let mut rng = StdRng::seed_from_u64(2);
        let c = Committee::dkg(&mut rng, 4).unwrap();
        let mut locks: Vec<Locks> = (0..4).map(|_| Locks::default()).collect();
        let first = claim();
        let mut second = claim();
        second.value = 43;
        // Members 0, 1, 2 sign the first result; signing it again is allowed.
        for i in 0..3 {
            locks[i].sign(&c.members[i].1, &first).unwrap();
            locks[i].sign(&c.members[i].1, &first).unwrap();
        }
        // The second result for the same request: 1 and 2 refuse; 0 ignores its lock (corrupt)
        // and 3 never signed, so two partials, below the quorum of three.
        assert!(locks[1].sign(&c.members[1].1, &second).is_err());
        assert!(locks[2].sign(&c.members[2].1, &second).is_err());
        let p3 = locks[3].sign(&c.members[3].1, &second).unwrap();
        let p0 = partial(&c.members[0].1, &second);
        assert!(combine(c.sharing(), &second, &[p0, p3]).is_err());
        // Another request is a fresh lock.
        let mut other = claim();
        other.request = [9; 32];
        assert!(locks[1].sign(&c.members[1].1, &other).is_ok());
    }

    #[test]
    fn t_members_forge_nothing_from_their_view() {
        let mut rng = StdRng::seed_from_u64(3);
        let c = Committee::dkg(&mut rng, 4).unwrap();
        let shares: Vec<_> = c.members.iter().map(|(_, s)| s.clone()).collect();
        for set in [&shares[3..4], &shares[0..2]] {
            for (what, sig) in forge_attempts(c.sharing(), set, &claim()) {
                assert!(!verify(c.sharing(), &claim(), &sig), "{what}");
            }
        }
        // A quorum's weighted partials do sum to the signature: the weights are right.
        let all = forge_attempts(c.sharing(), &shares[0..3], &claim());
        assert!(all.iter().any(|(w, s)| w.contains("interpolated") && verify(c.sharing(), &claim(), s)));
    }

    #[test]
    fn the_message_layout() {
        let m = claim().message();
        assert_eq!(&m[24..32], &8141u64.to_be_bytes());
        assert_eq!(&m[32..64], &[7u8; 32]);
        assert_eq!(&m[120..128], &42u64.to_be_bytes());
        assert!(m[..24].iter().chain(&m[96..120]).all(|&b| b == 0));
    }
}
