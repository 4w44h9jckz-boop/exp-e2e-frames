//! The committee's side of experiment 14 (X9): an update proved over shares, the openings it
//! publishes, and its signature on reconciliation.
//!
//! **The note, split three ways and once more.** The withdrawal circuit's commitment is circomlib's
//! Pedersen hash of the nullifier `n` (31 bytes) and the secret `s` (31 bytes), a sum of terms
//! over four-bit windows. So, with `A(x) = H(x || 0)` and `B(s) = H(0 || s) - H(0 || 0)`,
//!
//! ```text
//! H(n || s) = A(n_0) + A(n_1) + A(n_2) - 2 H(0 || 0) + B(s)
//! ```
//!
//! where member `j` chooses `n_j`, the bits of `n` in its own windows ([`WINDOWS`]) and zero
//! elsewhere, and `n` is their OR. The owner keeps `s` and sends only the point `B(s)`, sealed
//! in its intent. A member sends the others only the point `A(n_j)`, and seals `n_j` itself
//! only to the owner. No member learns `n`, nobody but the owner learns `s`, and only the owner
//! can prove the redemption.
//!
//! **The intent** (116 bytes on chain) is [`seal`]ed to the committee's key with info
//! `x9/intent` and AAD `vault || intent index`; its 65-byte plaintext is the owner's opening key
//! `P` (33, compressed) and `B(s)` (32, packed).
//!
//! **An opening** (99 bytes, three to an update, in member order) is sealed to `P` with info
//! `x9/opening` and AAD `vault || update number`; its 48-byte plaintext is
//! `n_j (31) || member (1) || leaf index (u32 BE) || update number (u64 BE) || 4 zero bytes`.
//!
//! **The update's proof** is the withdrawal circuit's over the holder's shared witness, with the
//! recipient set by every member ([`co_withdraw::set_recipient`]) to [`recipient`], which binds
//! it to the head intent, the new commitment and the openings.
//!
//! **Reconciliation** is signed by the whole committee: a threshold BLS signature (MinSig) on
//! [`reconcile_message`], over the digest of [`redemption_list`], under [`RECONCILE_NAMESPACE`], which the vault checks on EIP-2537.

pub mod babyjub;
pub mod seal;

use ark_bn254::Fr;
use ark_ff::PrimeField;
use babyjub::{Point, pedersen};
use commonware_cryptography::bls12381::primitives::{
    group::{G1, Share},
    ops::{self, threshold},
    sharing::Sharing,
    variant::{MinSig, PartialSignature},
};
use commonware_parallel::Sequential;
use rand::{CryptoRng, RngCore};
use sha3::{Digest, Keccak256};

pub const MEMBERS: usize = 3;
/// Member `j`'s windows of the nullifier: bits `4 w .. 4 w + 3` of its 31 little-endian bytes.
pub const WINDOWS: [std::ops::Range<usize>; MEMBERS] = [0..21, 21..42, 42..62];
pub const INTENT_PLAINTEXT: usize = 65;
pub const INTENT_LEN: usize = seal::OVERHEAD + INTENT_PLAINTEXT;
pub const OPENING_PLAINTEXT: usize = 48;
pub const OPENING_LEN: usize = seal::OVERHEAD + OPENING_PLAINTEXT;
pub const OPENINGS_LEN: usize = MEMBERS * OPENING_LEN;
/// The namespace of the committee's signature on a reconciliation.
pub const RECONCILE_NAMESPACE: &[u8] = b"X9_RECONCILE_V1";

fn bit(b: &[u8], i: usize) -> bool {
    b[i / 8] >> (i % 8) & 1 == 1
}

/// Whether `part` has bits only in member `j`'s windows.
#[must_use]
pub fn in_windows(j: usize, part: &[u8; 31]) -> bool {
    (0..248).all(|i| !bit(part, i) || WINDOWS[j].contains(&(i / 4)))
}

/// Member `j`'s random part of a nullifier.
pub fn choose_part<R: RngCore + CryptoRng>(j: usize, rng: &mut R) -> [u8; 31] {
    let mut part = [0u8; 31];
    rng.fill_bytes(&mut part);
    for i in 0..248 {
        if !WINDOWS[j].contains(&(i / 4)) {
            part[i / 8] &= !(1 << (i % 8));
        }
    }
    part
}

/// `A(x) = H(x || 0)`.
#[must_use]
pub fn a_point(part: &[u8; 31]) -> Point {
    let mut pre = [0u8; 62];
    pre[..31].copy_from_slice(part);
    pedersen(&pre)
}

/// `B(s) = H(0 || s) - H(0 || 0)`: what the owner sends of its secret.
#[must_use]
pub fn b_point(secret: &[u8; 31]) -> Point {
    let mut pre = [0u8; 62];
    pre[31..].copy_from_slice(secret);
    pedersen(&pre).add(&pedersen(&[0u8; 62]).neg())
}

/// The new note's commitment from the members' parts and the owner's: the x-coordinate of
/// `A(n_0) + A(n_1) + A(n_2) - 2 H(0 || 0) + B(s)`.
#[must_use]
pub fn commitment(parts: &[Point; MEMBERS], b: &Point) -> Fr {
    let zero = pedersen(&[0u8; 62]);
    let mut acc = b.add(&zero.neg()).add(&zero.neg());
    for p in parts {
        acc = acc.add(p);
    }
    acc.x
}

/// What the committee reads from an intent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Intent {
    /// The owner's opening key, compressed.
    pub owner: [u8; 33],
    /// `B(s)`.
    pub b: Point,
}

impl Intent {
    #[must_use]
    pub fn plaintext(&self) -> [u8; INTENT_PLAINTEXT] {
        let mut p = [0u8; INTENT_PLAINTEXT];
        p[..33].copy_from_slice(&self.owner);
        p[33..].copy_from_slice(&self.b.pack());
        p
    }

    pub fn from_plaintext(p: &[u8]) -> anyhow::Result<Self> {
        anyhow::ensure!(p.len() == INTENT_PLAINTEXT, "an intent's plaintext is {INTENT_PLAINTEXT} bytes");
        let owner: [u8; 33] = p[..33].try_into()?;
        k256::PublicKey::from_sec1_bytes(&owner).map_err(|_| anyhow::anyhow!("the owner's key is not on secp256k1"))?;
        let b = Point::unpack(&p[33..].try_into()?).ok_or_else(|| anyhow::anyhow!("B(s) is not a point of the subgroup"))?;
        Ok(Self { owner, b })
    }

    /// Opens a sealed intent with the committee's secret.
    pub fn open(committee: &[u8; 32], sealed: &[u8], vault: &[u8; 20], index: u64) -> anyhow::Result<Self> {
        anyhow::ensure!(sealed.len() == INTENT_LEN, "a sealed intent is {INTENT_LEN} bytes");
        let p = seal::open(committee, sealed, seal::INFO_INTENT, &seal::aad(vault, index))
            .ok_or_else(|| anyhow::anyhow!("the intent does not open with the committee's key"))?;
        Self::from_plaintext(&p)
    }

    /// Seals this intent to the committee, as the holder's side does.
    pub fn seal<R: RngCore + CryptoRng>(&self, committee: &[u8; 33], vault: &[u8; 20], index: u64, rng: &mut R) -> anyhow::Result<Vec<u8>> {
        seal::seal(committee, &self.plaintext(), seal::INFO_INTENT, &seal::aad(vault, index), rng)
    }
}

/// One member's opening, before sealing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Opening {
    pub part: [u8; 31],
    pub member: u8,
    pub leaf: u32,
    pub update: u64,
}

impl Opening {
    #[must_use]
    pub fn plaintext(&self) -> [u8; OPENING_PLAINTEXT] {
        let mut p = [0u8; OPENING_PLAINTEXT];
        p[..31].copy_from_slice(&self.part);
        p[31] = self.member;
        p[32..36].copy_from_slice(&self.leaf.to_be_bytes());
        p[36..44].copy_from_slice(&self.update.to_be_bytes());
        p
    }

    pub fn from_plaintext(p: &[u8]) -> anyhow::Result<Self> {
        anyhow::ensure!(p.len() == OPENING_PLAINTEXT, "an opening's plaintext is {OPENING_PLAINTEXT} bytes");
        anyhow::ensure!(p[44..] == [0u8; 4], "an opening's padding is zero");
        let o = Self {
            part: p[..31].try_into()?,
            member: p[31],
            leaf: u32::from_be_bytes(p[32..36].try_into()?),
            update: u64::from_be_bytes(p[36..44].try_into()?),
        };
        anyhow::ensure!((o.member as usize) < MEMBERS && in_windows(o.member as usize, &o.part), "a part outside its member's windows");
        Ok(o)
    }

    pub fn seal<R: RngCore + CryptoRng>(&self, owner: &[u8; 33], vault: &[u8; 20], rng: &mut R) -> anyhow::Result<Vec<u8>> {
        seal::seal(owner, &self.plaintext(), seal::INFO_OPENING, &seal::aad(vault, self.update), rng)
    }
}

/// What the owner does with an update's openings: open all three, check each, OR the parts,
/// and check the commitment at the leaf. Returns the nullifier.
pub fn assemble(
    owner_secret: &[u8; 32],
    openings: &[u8],
    vault: &[u8; 20],
    update: u64,
    leaf: u32,
    b: &Point,
    c: Fr,
) -> anyhow::Result<[u8; 31]> {
    anyhow::ensure!(openings.len() == OPENINGS_LEN, "an update publishes {OPENINGS_LEN} bytes of openings");
    let mut n = [0u8; 31];
    let mut parts = [Point::IDENTITY; MEMBERS];
    for (j, m) in openings.chunks(OPENING_LEN).enumerate() {
        let p = seal::open(owner_secret, m, seal::INFO_OPENING, &seal::aad(vault, update))
            .ok_or_else(|| anyhow::anyhow!("opening {j} does not open with this key"))?;
        let o = Opening::from_plaintext(&p)?;
        anyhow::ensure!(o.member as usize == j && o.leaf == leaf && o.update == update, "opening {j} names another member, leaf or update");
        for (x, y) in n.iter_mut().zip(o.part) {
            *x |= y;
        }
        parts[j] = a_point(&o.part);
    }
    anyhow::ensure!(commitment(&parts, b) == c, "the openings do not make the commitment at the leaf");
    Ok(n)
}

/// The update's recipient: `uint160(keccak256(vault (32) || intent hash || C || keccak256(openings)))`.
#[must_use]
pub fn recipient(vault: &[u8; 20], intent_hash: &[u8; 32], c: Fr, openings: &[u8]) -> Fr {
    let mut pre = [0u8; 128];
    pre[12..32].copy_from_slice(vault);
    pre[32..64].copy_from_slice(intent_hash);
    pre[64..96].copy_from_slice(&fr_be(c));
    pre[96..].copy_from_slice(&Keccak256::digest(openings));
    let h = Keccak256::digest(pre);
    Fr::from_be_bytes_mod_order(&h[12..])
}

/// A field element as 32 big-endian bytes.
#[must_use]
pub fn fr_be(x: Fr) -> [u8; 32] {
    use ark_ff::BigInteger;
    let b = x.into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - b.len()..].copy_from_slice(&b);
    out
}

/// The redemptions as reconciliation lists them, strictly ascending, and their digest
/// `keccak256(list)`, which the committee signs.
#[must_use]
pub fn redemption_list(nullifier_hashes: &[[u8; 32]]) -> (Vec<[u8; 32]>, [u8; 32]) {
    let mut list = nullifier_hashes.to_vec();
    list.sort_unstable();
    list.dedup();
    (list.clone(), Keccak256::digest(list.concat()).into())
}

/// The 128 bytes the committee signs to reconcile: `chain_id || vault || escapeAt || digest`.
#[must_use]
pub fn reconcile_message(chain_id: u64, vault: &[u8; 20], escape_at: u64, digest: &[u8; 32]) -> [u8; 128] {
    let mut m = [0u8; 128];
    m[24..32].copy_from_slice(&chain_id.to_be_bytes());
    m[44..64].copy_from_slice(vault);
    m[88..96].copy_from_slice(&escape_at.to_be_bytes());
    m[96..].copy_from_slice(digest);
    m
}

/// The reconciliation's only nonce key: `keccak256("X9_RECONCILE" || escapeAt (32))`.
#[must_use]
pub fn reconcile_nonce_key(escape_at: u64) -> [u8; 32] {
    let mut pre = [0u8; 44];
    pre[..12].copy_from_slice(b"X9_RECONCILE");
    pre[36..].copy_from_slice(&escape_at.to_be_bytes());
    Keccak256::digest(pre).into()
}

/// One member's partial signature on a reconciliation.
#[must_use]
pub fn reconcile_partial(share: &Share, message: &[u8; 128]) -> PartialSignature<MinSig> {
    threshold::sign_message::<MinSig>(share, RECONCILE_NAMESPACE, message)
}

/// The committee's signature from every member's partial, each checked first.
pub fn reconcile_signature(sharing: &Sharing<MinSig>, message: &[u8; 128], partials: &[PartialSignature<MinSig>]) -> anyhow::Result<G1> {
    for p in partials {
        threshold::verify_message::<MinSig>(sharing, RECONCILE_NAMESPACE, message, p)
            .map_err(|e| anyhow::anyhow!("member {}'s partial does not check: {e:?}", p.index))?;
    }
    let sig = threshold::recover::<MinSig, _>(sharing, partials, &Sequential).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    ops::verify_message::<MinSig>(sharing.public(), RECONCILE_NAMESPACE, message, &sig)
        .map_err(|e| anyhow::anyhow!("the recovered signature does not check: {e:?}"))?;
    Ok(sig)
}

#[cfg(test)]
mod tests;
