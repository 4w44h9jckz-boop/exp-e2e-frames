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
    fn the_message_layout() {
        let m = claim().message();
        assert_eq!(&m[24..32], &8141u64.to_be_bytes());
        assert_eq!(&m[32..64], &[7u8; 32]);
        assert_eq!(&m[120..128], &42u64.to_be_bytes());
        assert!(m[..24].iter().chain(&m[96..120]).all(|&b| b == 0));
    }
}
