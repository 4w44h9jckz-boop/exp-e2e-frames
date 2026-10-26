//! Messages sealed to a secp256k1 key, key-privately: `exp-frames` experiment 33's announcement
//! scheme (kohaku-rs `frame-registry`'s `announce`), with its info string and version made
//! parameters and an AAD added, as agreed with the wallet:
//!
//! ```text
//! shared   = x(e * P)                                          32 bytes
//! view tag = keccak256(shared)[0]
//! key, iv  = HKDF-SHA256(ikm = shared, salt = E, info), 32 + 12 bytes
//! message  = 0x02 || view tag || E (33, compressed) || AES-256-GCM(key, iv, plaintext, aad) || tag (16)
//! ```
//!
//! `e` is fresh for every message, and the message carries neither `P` nor anything derived
//! from it but the one-byte view tag, which only a holder of `P`'s secret can recompute. So
//! nobody else learns who a message is for.

use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use hkdf::Hkdf;
use k256::{PublicKey, SecretKey, elliptic_curve::sec1::ToEncodedPoint};
use rand::{CryptoRng, RngCore};
use sha2::Sha256;
use sha3::{Digest, Keccak256};

pub const VERSION: u8 = 0x02;
/// Version, view tag, ephemeral key and the GCM tag around a plaintext.
pub const OVERHEAD: usize = 2 + 33 + 16;
pub const INFO_OPENING: &[u8] = b"x9/opening";
pub const INFO_INTENT: &[u8] = b"x9/intent";

/// A secp256k1 key pair; the public key compressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Keys {
    pub secret: [u8; 32],
    pub public: [u8; 33],
}

impl Keys {
    pub fn from_secret(secret: [u8; 32]) -> anyhow::Result<Self> {
        let sk = SecretKey::from_slice(&secret).map_err(|_| anyhow::anyhow!("not a secp256k1 secret key"))?;
        let mut public = [0u8; 33];
        public.copy_from_slice(sk.public_key().to_encoded_point(true).as_bytes());
        Ok(Self { secret, public })
    }

    pub fn random<R: RngCore + CryptoRng>(rng: &mut R) -> Self {
        loop {
            let mut s = [0u8; 32];
            rng.fill_bytes(&mut s);
            if let Ok(k) = Self::from_secret(s) {
                return k;
            }
        }
    }
}

/// The AAD both kinds of message carry: the vault's address and a 64-bit number (the update's
/// number for an opening, the intent's index for an intent).
#[must_use]
pub fn aad(vault: &[u8; 20], number: u64) -> [u8; 28] {
    let mut a = [0u8; 28];
    a[..20].copy_from_slice(vault);
    a[20..].copy_from_slice(&number.to_be_bytes());
    a
}

fn shared(secret: &[u8; 32], public: &[u8]) -> Option<[u8; 32]> {
    let sk = SecretKey::from_slice(secret).ok()?;
    let pk = PublicKey::from_sec1_bytes(public).ok()?;
    let s = k256::ecdh::diffie_hellman(sk.to_nonzero_scalar(), pk.as_affine());
    Some((*s.raw_secret_bytes()).into())
}

fn cipher(shared: &[u8; 32], ephemeral: &[u8], info: &[u8]) -> (Aes256Gcm, [u8; 12]) {
    let mut okm = [0u8; 44];
    Hkdf::<Sha256>::new(Some(ephemeral), shared)
        .expand(info, &mut okm)
        .expect("44 bytes is a valid HKDF-SHA256 length");
    let mut iv = [0u8; 12];
    iv.copy_from_slice(&okm[32..]);
    (Aes256Gcm::new_from_slice(&okm[..32]).expect("a 32-byte key"), iv)
}

/// Seals `plaintext` to `to` with a fresh ephemeral key.
pub fn seal<R: RngCore + CryptoRng>(
    to: &[u8; 33],
    plaintext: &[u8],
    info: &[u8],
    aad: &[u8],
    rng: &mut R,
) -> anyhow::Result<Vec<u8>> {
    let e = Keys::random(rng);
    let shared = shared(&e.secret, to).ok_or_else(|| anyhow::anyhow!("not a compressed secp256k1 key"))?;
    let (aes, iv) = cipher(&shared, &e.public, info);
    let body = aes
        .encrypt(&Nonce::from(iv), Payload { msg: plaintext, aad })
        .map_err(|_| anyhow::anyhow!("encryption failed"))?;
    let mut out = Vec::with_capacity(OVERHEAD + plaintext.len());
    out.push(VERSION);
    out.push(Keccak256::digest(shared)[0]);
    out.extend_from_slice(&e.public);
    out.extend_from_slice(&body);
    Ok(out)
}

/// Opens a message with `secret`, or `None` if it is not for this key.
#[must_use]
pub fn open(secret: &[u8; 32], message: &[u8], info: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
    if message.len() < OVERHEAD || message[0] != VERSION {
        return None;
    }
    let ephemeral = &message[2..35];
    let shared = shared(secret, ephemeral)?;
    if Keccak256::digest(shared)[0] != message[1] {
        return None;
    }
    let (aes, iv) = cipher(&shared, ephemeral, info);
    aes.decrypt(&Nonce::from(iv), Payload { msg: &message[35..], aad }).ok()
}
