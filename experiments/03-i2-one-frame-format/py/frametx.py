"""A third implementation of the frame transaction encodings, from the texts alone.

Written from:
- EIP-8141 at ethereum/EIPs b75cbe6115: "Payload Encoding", "Signature Hash";
- EIP-8250 at ethereum/EIPs f3079a09e8: "Transaction payload", the decoder's
  refusals, and `nonce_keys_hash`;
- the draft ERC for the execution-scope digest, exp-frames
  `experiments/27-execution-digest/erc-draft.md`, "The digest";
- EIP-712, for `hashStruct` and the domain separator.

It shares no code with exp-frames' library or kohaku-rs. Standard library only:
keccak-256, RLP and EIP-712 are written out here. It reads a transaction in the
JSON shape the ethrex Hegota testnet serves (`eth_getTransactionByHash`).
"""

from __future__ import annotations

# ---- keccak-256 (the original Keccak padding, not SHA-3's) ----

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [
    [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
]
_M = (1 << 64) - 1


def _rol(x: int, n: int) -> int:
    n %= 64
    return ((x << n) | (x >> (64 - n))) & _M if n else x


def _keccak_f(a: list[list[int]]) -> None:
    for rc in _RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                a[x][y] ^= d[x]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], _ROT[x][y])
        for x in range(5):
            for y in range(5):
                a[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y])
        a[0][0] ^= rc


def keccak256(data: bytes) -> bytes:
    rate = 136
    msg = bytearray(data) + b"\x01"
    msg += b"\x00" * (-len(msg) % rate)
    msg[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        block = msg[off:off + rate]
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(block[8 * i:8 * i + 8], "little")
        _keccak_f(a)
    return b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))


# ---- RLP ----

class Invalid(ValueError):
    """An encoding a decoder must refuse."""


def _len_prefix(n: int, short: int) -> bytes:
    if n < 56:
        return bytes([short + n])
    ln = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([short + 55 + len(ln)]) + ln


def rlp(item) -> bytes:
    if isinstance(item, (bytes, bytearray)):
        b = bytes(item)
        if len(b) == 1 and b[0] < 0x80:
            return b
        return _len_prefix(len(b), 0x80) + b
    out = b"".join(rlp(x) for x in item)
    return _len_prefix(len(out), 0xC0) + out


def _read_len(data: bytes, pos: int, nbytes: int) -> int:
    if pos + nbytes > len(data):
        raise Invalid("length runs past the input")
    lb = data[pos:pos + nbytes]
    if lb[0] == 0:
        raise Invalid("length with a leading zero byte")
    n = int.from_bytes(lb, "big")
    if n < 56:
        raise Invalid("long form used for a length under 56")
    return n


def _decode_at(data: bytes, pos: int):
    if pos >= len(data):
        raise Invalid("input ends inside an item")
    p = data[pos]
    if p < 0x80:
        return data[pos:pos + 1], pos + 1
    if p < 0xB8:
        n = p - 0x80
        end = pos + 1 + n
        if end > len(data):
            raise Invalid("string runs past the input")
        if n == 1 and data[pos + 1] < 0x80:
            raise Invalid("a single byte under 0x80 given a length prefix")
        return data[pos + 1:end], end
    if p < 0xC0:
        k = p - 0xB7
        n = _read_len(data, pos + 1, k)
        start = pos + 1 + k
        if start + n > len(data):
            raise Invalid("string runs past the input")
        return data[start:start + n], start + n
    if p < 0xF8:
        n = p - 0xC0
        start = pos + 1
    else:
        k = p - 0xF7
        n = _read_len(data, pos + 1, k)
        start = pos + 1 + k
    end = start + n
    if end > len(data):
        raise Invalid("list runs past the input")
    items, q = [], start
    while q < end:
        it, q = _decode_at(data, q)
        items.append(it)
    if q != end:
        raise Invalid("list contents overrun its length")
    return items, end


def rlp_decode(data: bytes):
    item, end = _decode_at(data, 0)
    if end != len(data):
        raise Invalid("bytes after the item")
    return item


def int_bytes(n: int) -> bytes:
    if n < 0:
        raise Invalid("negative integer")
    return b"" if n == 0 else n.to_bytes((n.bit_length() + 7) // 8, "big")


def bytes_int(b, what: str, bits: int = 256) -> int:
    if isinstance(b, list):
        raise Invalid(f"{what}: a list where an integer belongs")
    if len(b) > 0 and b[0] == 0:
        raise Invalid(f"{what}: integer with a leading zero byte")
    n = int.from_bytes(b, "big") if b else 0
    if n >= 1 << bits:
        raise Invalid(f"{what}: over {bits} bits")
    return n


# ---- the transaction ----

FRAME_TX_TYPE = 0x06
VERIFY = 1
APPROVE_SCOPE_MASK = 0x3
APPROVE_PAYMENT = 0x1
MAX_NONCE_KEYS = 16  # EIP-8250


def _hx(s: str) -> bytes:
    s = s[2:] if s.startswith("0x") else s
    return bytes.fromhex(s)


def _int(s) -> int:
    return int(s, 16) if isinstance(s, str) else int(s)


def _addr(s) -> bytes:
    if s is None or s in ("", "0x"):
        return b""
    b = _hx(s)
    if len(b) != 20:
        raise Invalid("an address that is not 20 bytes")
    return b


class FrameTx:
    """EIP-8141's payload with EIP-8250's nonce, or EIP-8141's own (`plain`)."""

    def __init__(self, j: dict):
        self.chain_id = _int(j["chainId"])
        if "nonceKeys" in j:
            self.plain = False
            self.nonce_keys = [_int(k) for k in j["nonceKeys"]]
            self.nonce_seq = _int(j["nonceSeq"])
        else:
            self.plain = True
            self.nonce_keys = [0]
            self.nonce_seq = _int(j["nonce"])
        self.sender = _addr(j.get("sender") or j.get("from"))
        self.frames = [
            {
                "mode": _int(f["mode"]),
                "flags": _int(f["flags"]),
                "target": _addr(f.get("to")),
                "execution": _int(f["gasLimit"]),
                "state": _int(f["stateGasLimit"]),
                "value": _int(f["value"]),
                "data": _hx(f["data"]),
            }
            for f in j["frames"]
        ]
        self.signatures = [
            {
                "scheme": _int(s["scheme"]),
                "signer": _addr(s.get("signer")),
                "msg": _hx(s["msg"]),
                "signature": _hx(s["signature"]),
            }
            for s in j["signatures"]
        ]
        self.fees = [_int(j["maxPriorityFeePerGas"]), _int(j["maxFeePerGas"]), _int(j["maxFeePerBlobGas"])]
        self.blobs = [_hx(h) for h in j.get("blobVersionedHashes", [])]

    def _fields(self, elide: bool) -> list:
        nonce = (
            [int_bytes(self.nonce_seq)]
            if self.plain
            else [[int_bytes(k) for k in self.nonce_keys], int_bytes(self.nonce_seq)]
        )
        frames = [
            [int_bytes(f["mode"]), int_bytes(f["flags"]), f["target"],
             [int_bytes(f["execution"]), int_bytes(f["state"])], int_bytes(f["value"]), f["data"]]
            for f in self.frames
        ]
        sigs = [
            [int_bytes(s["scheme"]), s["signer"], s["msg"],
             b"" if elide and len(s["msg"]) == 0 else s["signature"]]
            for s in self.signatures
        ]
        return [int_bytes(self.chain_id), *nonce, self.sender, frames, sigs,
                [int_bytes(x) for x in self.fees], list(self.blobs)]

    def raw(self) -> bytes:
        """EIP-2718: the type byte, then the RLP payload."""
        return bytes([FRAME_TX_TYPE]) + rlp(self._fields(False))

    def hash(self) -> bytes:
        return keccak256(self.raw())

    def sig_hash(self) -> bytes:
        """EIP-8141 `compute_sig_hash`: every empty-`msg` signature's bytes elided."""
        return keccak256(bytes([FRAME_TX_TYPE]) + rlp(self._fields(True)))


def decode(raw: bytes) -> list:
    """Structural decoding of a keyed (EIP-8250) envelope, with EIP-8250's refusals.

    Returns the decoded field list. Raises Invalid for what a decoder must refuse.
    """
    if len(raw) == 0 or raw[0] != FRAME_TX_TYPE:
        raise Invalid("not a type 0x06 transaction")
    f = rlp_decode(raw[1:])
    if not isinstance(f, list) or len(f) != 8:
        raise Invalid("payload is not the 8-field keyed envelope")
    chain_id, keys, seq, sender, frames, sigs, fees, blobs = f
    bytes_int(chain_id, "chain_id")
    if not isinstance(keys, list):
        raise Invalid("nonce_keys is not a list")
    if not 1 <= len(keys) <= MAX_NONCE_KEYS:
        raise Invalid("nonce_keys count out of range")
    ks = [bytes_int(k, "nonce_key") for k in keys]
    if any(b <= a for a, b in zip(ks, ks[1:])):
        raise Invalid("nonce_keys not strictly increasing")
    if 0 in ks and ks != [0]:
        raise Invalid("key 0 alongside other keys")
    bytes_int(seq, "nonce_seq", 64)
    if isinstance(sender, list) or len(sender) != 20:
        raise Invalid("sender is not 20 bytes")
    if not isinstance(frames, list) or len(frames) == 0:
        raise Invalid("no frames")
    for fr in frames:
        if not isinstance(fr, list) or len(fr) != 6:
            raise Invalid("a frame is not 6 fields")
        mode, flags, target, limits, value, data = fr
        bytes_int(mode, "mode")
        bytes_int(flags, "flags")
        if isinstance(target, list) or len(target) not in (0, 20):
            raise Invalid("a frame target that is neither empty nor 20 bytes")
        if not isinstance(limits, list) or len(limits) != 2:
            raise Invalid("limits is not 2 fields")
        bytes_int(limits[0], "limits.execution", 64)
        bytes_int(limits[1], "limits.state", 64)
        bytes_int(value, "value")
        if isinstance(data, list):
            raise Invalid("frame data is a list")
    if not isinstance(sigs, list):
        raise Invalid("signatures is not a list")
    for s in sigs:
        if not isinstance(s, list) or len(s) != 4:
            raise Invalid("a signature is not 4 fields")
        if any(isinstance(x, list) for x in s):
            raise Invalid("a signature field is a list")
        bytes_int(s[0], "scheme")
    if not isinstance(fees, list) or len(fees) != 3:
        raise Invalid("fees is not 3 fields")
    for x in fees:
        bytes_int(x, "fee")
    if not isinstance(blobs, list):
        raise Invalid("blob_versioned_hashes is not a list")
    return f


# ---- the execution-scope digest E (draft ERC, exp-frames experiment 27) ----

def _word(n: int) -> bytes:
    return n.to_bytes(32, "big")


def _addr_word(a: bytes) -> bytes:
    return b"\x00" * 12 + a


FRAME_TYPE = b"Frame(uint8 mode,uint8 flags,address target,uint64 executionLimit,uint64 stateLimit,uint256 value,bytes data)"
EXEC_TYPE = (b"FrameExecution(bytes32 nonceKeysHash,uint64 nonceSeq,Frame[] frames,bytes32[] blobVersionedHashes)"
             + FRAME_TYPE)
DOMAIN_TYPE = b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"


def nonce_keys_hash(keys: list[int]) -> bytes:
    """EIP-8250: keccak256 of the key count and each key, as 32-byte words."""
    return keccak256(_word(len(keys)) + b"".join(_word(k) for k in keys))


def _frame_struct(tx: FrameTx, f: dict) -> bytes:
    pay = f["mode"] == VERIFY and f["flags"] & APPROVE_SCOPE_MASK == APPROVE_PAYMENT
    target = b"\x00" * 20 if pay else (f["target"] or tx.sender)
    execution, state = (0, 0) if pay else (f["execution"], f["state"])
    data = b"" if pay else f["data"]
    return keccak256(keccak256(FRAME_TYPE) + _word(f["mode"]) + _word(f["flags"]) + _addr_word(target)
                     + _word(execution) + _word(state) + _word(f["value"]) + keccak256(data))


def domain_separator(tx: FrameTx) -> bytes:
    return keccak256(keccak256(DOMAIN_TYPE) + keccak256(b"FrameExecution") + keccak256(b"1")
                     + _word(tx.chain_id) + _addr_word(tx.sender))


def execution_struct_hash(tx: FrameTx) -> bytes:
    frames = keccak256(b"".join(_frame_struct(tx, f) for f in tx.frames))
    blobs = keccak256(b"".join(tx.blobs))
    return keccak256(keccak256(EXEC_TYPE) + nonce_keys_hash(tx.nonce_keys) + _word(tx.nonce_seq)
                     + frames + blobs)


def execution_digest(tx: FrameTx) -> bytes:
    return keccak256(b"\x19\x01" + domain_separator(tx) + execution_struct_hash(tx))


def from_raw(raw: bytes) -> FrameTx:
    """A keyed envelope's raw bytes, as a FrameTx (for the digest vectors, which carry raw bytes)."""
    f = decode(raw)
    chain_id, keys, seq, sender, frames, sigs, fees, blobs = f
    h = lambda b: "0x" + b.hex()
    return FrameTx({
        "chainId": h(chain_id) if chain_id else "0x0",
        "nonceKeys": [h(k) if k else "0x0" for k in keys],
        "nonceSeq": h(seq) if seq else "0x0",
        "sender": h(sender),
        "frames": [{"mode": h(m) if m else "0x0", "flags": h(fl) if fl else "0x0",
                    "to": h(t) if t else None, "gasLimit": h(l[0]) if l[0] else "0x0",
                    "stateGasLimit": h(l[1]) if l[1] else "0x0", "value": h(v) if v else "0x0",
                    "data": h(d)} for m, fl, t, l, v, d in frames],
        "signatures": [{"scheme": h(s[0]) if s[0] else "0x0", "signer": h(s[1]) if s[1] else None,
                        "msg": h(s[2]), "signature": h(s[3])} for s in sigs],
        "maxPriorityFeePerGas": h(fees[0]) if fees[0] else "0x0",
        "maxFeePerGas": h(fees[1]) if fees[1] else "0x0",
        "maxFeePerBlobGas": h(fees[2]) if fees[2] else "0x0",
        "blobVersionedHashes": [h(b) for b in blobs],
    })
