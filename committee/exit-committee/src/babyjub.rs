//! Baby Jubjub and circomlib's Pedersen hash, as points. `kohaku-tornadocash` computes the same
//! hash but returns only its x-coordinate; the committee needs the point, to add the members'
//! parts and the owner's part before taking x. Written from that crate's code (its generators,
//! window encoding and point packing), and checked against its `Note::commitment` in the tests.

use std::sync::LazyLock;

use ark_bn254::Fr;
use ark_ff::{AdditiveGroup, BigInteger, Field, PrimeField};
use blake_hash::{Blake256, Digest, digest::FixedOutput};
use num_bigint::{BigInt, Sign};

const A: u64 = 168_700;
const D: u64 = 168_696;
const WINDOW: usize = 4;
const WINDOWS_PER_SEGMENT: usize = 50;
const BITS_PER_SEGMENT: usize = WINDOW * WINDOWS_PER_SEGMENT;
/// The order of Baby Jubjub's prime-order subgroup.
const SUBORDER: &str = "2736030358979909402780800718157159386076813972158567259200215660948447373041";

/// A point in affine coordinates. The identity is (0, 1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Point {
    pub x: Fr,
    pub y: Fr,
}

impl Point {
    pub const IDENTITY: Point = Point { x: Fr::ZERO, y: Fr::ONE };

    /// Twisted Edwards addition, `a x^2 + y^2 = 1 + d x^2 y^2`.
    #[must_use]
    pub fn add(&self, q: &Point) -> Point {
        let (a, d) = (Fr::from(A), Fr::from(D));
        let x1y2 = self.x * q.y;
        let y1x2 = self.y * q.x;
        let x1x2 = self.x * q.x;
        let y1y2 = self.y * q.y;
        let t = d * x1x2 * y1y2;
        Point {
            x: (x1y2 + y1x2) * (Fr::ONE + t).inverse().expect("the curve is complete"),
            y: (y1y2 - a * x1x2) * (Fr::ONE - t).inverse().expect("the curve is complete"),
        }
    }

    #[must_use]
    pub fn neg(&self) -> Point {
        Point { x: -self.x, y: self.y }
    }

    #[must_use]
    pub fn mul(&self, n: &BigInt) -> Point {
        let (sign, bytes) = n.to_bytes_le();
        let mut r = Point::IDENTITY;
        let mut e = *self;
        for byte in bytes {
            for bit in 0..8 {
                if byte >> bit & 1 == 1 {
                    r = r.add(&e);
                }
                e = e.add(&e);
            }
        }
        if sign == Sign::Minus { r.neg() } else { r }
    }

    /// circomlib's packing: y little-endian, and the top bit of byte 31 set when x > q / 2.
    #[must_use]
    pub fn pack(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        out.copy_from_slice(&self.y.into_bigint().to_bytes_le());
        if big(self.x) > half() {
            out[31] |= 0x80;
        }
        out
    }

    /// circomlib's unpacking; `None` for bytes that name no point of the subgroup.
    pub fn unpack(b: &[u8; 32]) -> Option<Point> {
        let mut y = *b;
        let sign = y[31] & 0x80 != 0;
        y[31] &= 0x7f;
        let y_big = BigInt::from_bytes_le(Sign::Plus, &y);
        if y_big >= modulus() {
            return None;
        }
        let y = Fr::from_le_bytes_mod_order(&y);
        let y2 = y.square();
        let x2 = (Fr::ONE - y2) * (Fr::from(A) - Fr::from(D) * y2).inverse()?;
        let mut x = x2.sqrt()?;
        if big(x) > half() {
            x = -x;
        }
        if sign {
            x = -x;
        }
        let p = Point { x, y };
        p.in_subgroup().then_some(p)
    }

    #[must_use]
    pub fn in_subgroup(&self) -> bool {
        self.mul(&SUBORDER.parse().expect("a number")) == Point::IDENTITY
    }
}

fn big(f: Fr) -> BigInt {
    BigInt::from_bytes_le(Sign::Plus, &f.into_bigint().to_bytes_le())
}

fn modulus() -> BigInt {
    BigInt::from_bytes_le(Sign::Plus, &Fr::MODULUS.to_bytes_le())
}

fn half() -> BigInt {
    modulus() / 2u32
}

/// circomlib's Pedersen hash of `data` as a point; its x-coordinate is the hash. Bits are taken
/// least significant first, byte by byte, in segments of 50 four-bit windows; window `w` adds
/// `(1 + b0 + 2 b1 + 4 b2) (1 - 2 b3) 2^(5w)` to its segment's scalar.
#[must_use]
pub fn pedersen(data: &[u8]) -> Point {
    let bits: Vec<bool> = (0..data.len() * 8).map(|i| data[i / 8] >> (i % 8) & 1 == 1).collect();
    let segments = bits.len().saturating_sub(1) / BITS_PER_SEGMENT + 1;
    let mut acc = Point::IDENTITY;
    for s in 0..segments {
        let seg = &bits[s * BITS_PER_SEGMENT..((s + 1) * BITS_PER_SEGMENT).min(bits.len())];
        let mut scalar = BigInt::ZERO;
        let mut exp = BigInt::from(1u8);
        for window in seg.chunks(WINDOW) {
            let mut v = BigInt::from(1u8);
            for (b, bit) in window.iter().take(WINDOW - 1).enumerate() {
                if *bit {
                    v += BigInt::from(1u8) << b;
                }
            }
            if window.len() == WINDOW && window[WINDOW - 1] {
                v = -v;
            }
            scalar += &v * &exp;
            exp <<= WINDOW + 1;
        }
        acc = acc.add(&generator(s).mul(&scalar));
    }
    acc
}

fn generator(s: usize) -> Point {
    static GENERATORS: LazyLock<Vec<Point>> = LazyLock::new(|| (0..3).map(derive_generator).collect());
    GENERATORS.get(s).copied().unwrap_or_else(|| derive_generator(s))
}

/// The `s`-th generator: Blake-256 of `PedersenGenerator_{s:032}_{try:032}` with bit 254
/// cleared, unpacked, times 8, the first try that lands in the subgroup.
fn derive_generator(s: usize) -> Point {
    for attempt in 0.. {
        let seed = format!("PedersenGenerator_{s:032}_{attempt:032}");
        let mut h = Blake256::default();
        h.input(seed.as_bytes());
        let mut b = [0u8; 32];
        b.copy_from_slice(&h.fixed_result());
        b[31] &= 0xbf;
        if let Some(p) = unpack_any(&b) {
            let p8 = p.mul(&BigInt::from(8u8));
            if p8.in_subgroup() {
                return p8;
            }
        }
    }
    unreachable!()
}

/// [`Point::unpack`] without the subgroup check, for deriving generators.
fn unpack_any(b: &[u8; 32]) -> Option<Point> {
    let mut y = *b;
    let sign = y[31] & 0x80 != 0;
    y[31] &= 0x7f;
    if BigInt::from_bytes_le(Sign::Plus, &y) >= modulus() {
        return None;
    }
    let y = Fr::from_le_bytes_mod_order(&y);
    let y2 = y.square();
    let x2 = (Fr::ONE - y2) * (Fr::from(A) - Fr::from(D) * y2).inverse()?;
    let mut x = x2.sqrt()?;
    if big(x) > half() {
        x = -x;
    }
    if sign {
        x = -x;
    }
    Some(Point { x, y })
}
