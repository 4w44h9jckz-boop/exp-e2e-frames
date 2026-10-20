"""Generate the frame transaction vector set.

usage: python3 vectors/frame-tx/tools/generate.py EXP_FRAMES_CHECKOUT EXP_FRAMES_COMMIT

Reads exp-frames' mined fixtures and experiment 27's digest vectors from a
checkout at a pinned commit of its `main`, and writes the three files of
`vectors/frame-tx/`. Every expected value names its source:

- `chain`: the hash the chain gave a mined transaction; or a signature hash the
  chain confirmed, because a signature the chain accepted recovers its signer
  from it.
- `texts`: computed by the third implementation (`experiments/03-i2-one-frame-format/py`),
  written from EIP-8141, EIP-8250 and the draft ERC alone, for shapes the chain
  has not mined.
- `exp-frames experiment 27`: the digest vectors as that experiment published
  them, which it checked with viem, by hand, and inside ethrex.

A mined transaction whose fields do not encode to its on-chain hash is not
dropped: its expected hash stays the chain's, and the mismatch is reported.
Deterministic: the same checkout gives the same files.
"""

from __future__ import annotations

import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(OUT, "..", "..", "experiments", "03-i2-one-frame-format", "py"))
sys.path.insert(0, HERE)

import frametx as F  # noqa: E402
from ecdsa import SECP256K1 as _K1, p256_verify, secp256k1_recover  # noqa: E402

HEGOTA = "0x1fcd"
FIELDS = ["chainId", "nonceKeys", "nonceSeq", "sender", "frames", "signatures",
          "maxPriorityFeePerGas", "maxFeePerGas", "maxFeePerBlobGas", "blobVersionedHashes"]
FRAME_FIELDS = ["mode", "flags", "to", "gasLimit", "stateGasLimit", "value", "data"]
SIG_FIELDS = ["scheme", "signer", "msg", "signature"]


def h(b: bytes) -> str:
    return "0x" + b.hex()


def canonical(tx: dict) -> dict:
    """The fields a transaction's bytes commit to, in the testnet's JSON shape."""
    out = {k: tx[k] for k in FIELDS}
    out["frames"] = [{k: f[k] for k in FRAME_FIELDS} for f in tx["frames"]]
    out["signatures"] = [{k: s[k] for k in SIG_FIELDS} for s in tx["signatures"]]
    return out


def confirmed_by_chain(tx: F.FrameTx, sig_hash: bytes) -> list[str]:
    """Which empty-msg signatures recover (or verify) their signer over `sig_hash`."""
    who = []
    for i, s in enumerate(tx.signatures):
        if len(s["msg"]) != 0:
            continue
        signer = s["signer"] or tx.sender
        sig = s["signature"]
        if s["scheme"] == 1 and len(sig) == 65:
            Q = secp256k1_recover(sig_hash, sig[0], int.from_bytes(sig[1:33], "big"),
                                  int.from_bytes(sig[33:65], "big"))
            if Q and F.keccak256(Q[0].to_bytes(32, "big") + Q[1].to_bytes(32, "big"))[12:] == signer:
                who.append(f"signatures[{i}] SECP256K1")
        elif s["scheme"] == 2 and len(sig) == 128:
            r, ss, qx, qy = (int.from_bytes(sig[k:k + 32], "big") for k in (0, 32, 64, 96))
            if p256_verify(sig_hash, r, ss, qx, qy) and \
                    F.keccak256(sig[64:128])[12:] == signer:
                who.append(f"signatures[{i}] P256")
    return who


def mined(checkout: str, commit: str):
    cases, mismatches, skipped = [], [], 0
    for path in sorted(glob.glob(os.path.join(checkout, "test/fixtures/chain/*.json"))):
        d = json.load(open(path))
        tx = d["tx"]
        if tx.get("chainId") != HEGOTA or "nonceKeys" not in tx:
            skipped += 1
            continue
        fields = canonical(tx)
        t = F.FrameTx(fields)
        name = os.path.basename(path)[:-5]
        src = {"repository": "4w44h9jckz-boop/exp-frames", "commit": commit,
               "path": f"test/fixtures/chain/{name}.json", "block": int(tx["blockNumber"], 16),
               "clientVersion": d["meta"]["clientVersion"]}
        if t.hash().hex() != tx["hash"][2:].lower():
            mismatches.append(name)
        sh = t.sig_hash()
        by = confirmed_by_chain(t, sh)
        cases.append({"name": f"mined {name[:10]}", "provenance": src, "fields": fields,
                      "raw": h(t.raw()), "hash": tx["hash"].lower(), "hashSource": "chain",
                      "sigHash": h(sh), "sigHashSource": "chain" if by else "texts",
                      "sigHashConfirmedBy": by})
    return cases, mismatches, skipped


# ---- written cases: shapes the chain has not mined, from the texts ----

SENDER = "0x2700000000000000000000000000000000000001"
OTHER = "0x2700000000000000000000000000000000000002"


def base(**over) -> dict:
    tx = {
        "chainId": HEGOTA, "nonceKeys": ["0x0"], "nonceSeq": "0x0", "sender": SENDER,
        "frames": [
            {"mode": "0x1", "flags": "0x3", "to": None, "gasLimit": "0x7530", "stateGasLimit": "0x0",
             "value": "0x0", "data": "0x"},
            {"mode": "0x2", "flags": "0x0", "to": OTHER, "gasLimit": "0x7530", "stateGasLimit": "0x0",
             "value": "0x0", "data": "0x"},
        ],
        "signatures": [{"scheme": "0x1", "signer": None, "msg": "0x", "signature": "0x" + "11" * 65}],
        "maxPriorityFeePerGas": "0x3b9aca00", "maxFeePerGas": "0x77359400", "maxFeePerBlobGas": "0x0",
        "blobVersionedHashes": [],
    }
    tx.update(over)
    return tx


def frame(**over) -> dict:
    f = {"mode": "0x2", "flags": "0x0", "to": OTHER, "gasLimit": "0x7530", "stateGasLimit": "0x0",
         "value": "0x0", "data": "0x"}
    f.update(over)
    return f


WRITTEN = [
    ("nonce_seq at 2^64 - 1", "the largest sequence EIP-8250 allows",
     base(nonceSeq=hex(2**64 - 1))),
    ("sixteen nonce keys", "EIP-8250's MAX_NONCE_KEYS, strictly increasing, the last at 2^256 - 1",
     base(nonceKeys=[hex(k) for k in list(range(1, 16)) + [2**256 - 1]])),
    ("a frame value of 2^256 - 1", "the largest value a frame can carry",
     base(frames=[base()["frames"][0], frame(value=hex(2**256 - 1))])),
    ("frame data of 55 bytes", "RLP's last short string",
     base(frames=[base()["frames"][0], frame(data="0x" + "ab" * 55)])),
    ("frame data of 56 bytes", "RLP's first long string",
     base(frames=[base()["frames"][0], frame(data="0x" + "ab" * 56)])),
    ("frame data of one byte under 0x80", "RLP encodes it as itself",
     base(frames=[base()["frames"][0], frame(data="0x7f")])),
    ("frame data of one byte at 0x80", "RLP gives it a length prefix",
     base(frames=[base()["frames"][0], frame(data="0x80")])),
    ("a null target", "an empty target, which resolves to the sender",
     base(frames=[base()["frames"][0], frame(to=None)])),
    ("the sender written as the target", "the same frame with the sender written out: different bytes",
     base(frames=[base()["frames"][0], frame(to=SENDER)])),
    ("an ARBITRARY entry with a long witness", "empty signer and msg: its 300 bytes are elided from the signature hash",
     base(signatures=[{"scheme": "0x0", "signer": None, "msg": "0x", "signature": "0x" + "cd" * 300}])),
    ("an explicit msg", "a 32-byte msg: the signature bytes stay in the signature hash",
     base(signatures=[{"scheme": "0x1", "signer": None, "msg": "0x" + "42" * 32, "signature": "0x" + "22" * 65}])),
    ("two entries, one elided", "only the empty-msg entry's bytes are elided",
     base(signatures=[{"scheme": "0x1", "signer": None, "msg": "0x", "signature": "0x" + "11" * 65},
                      {"scheme": "0x1", "signer": OTHER, "msg": "0x" + "42" * 32, "signature": "0x" + "33" * 65}])),
    ("no signatures", "the signatures list is optional",
     base(signatures=[])),
    ("blob hashes and a blob fee", "two versioned hashes and a non-zero max_fee_per_blob_gas",
     base(blobVersionedHashes=["0x01" + "11" * 31, "0x01" + "22" * 31], maxFeePerBlobGas="0xf4240")),
    ("zero fees", "every fee zero: three empty strings",
     base(maxPriorityFeePerGas="0x0", maxFeePerGas="0x0")),
    ("a chain ID over 64 bits", "chain_id is a uint256",
     base(chainId=hex(2**64 + 1))),
    ("an atomic batch", "flags with the atomic-batch bit on two SENDER frames",
     base(frames=[base()["frames"][0], frame(flags="0x4"), frame(data="0x01")])),
    ("a long frame list", "64 frames, so the frames list takes a long length prefix",
     base(frames=[base()["frames"][0]] + [frame(data="0x%02x" % i if i else "0x") for i in range(63)])),
]


def written():
    cases = []
    for name, note, fields in WRITTEN:
        t = F.FrameTx(fields)
        cases.append({"name": name, "note": note, "fields": fields, "raw": h(t.raw()),
                      "hash": h(t.hash()), "hashSource": "texts", "sigHash": h(t.sig_hash()),
                      "sigHashSource": "texts", "sigHashConfirmedBy": []})
    return cases


# ---- encodings a decoder must refuse ----

def _payload(tx: dict) -> list:
    return F.FrameTx(tx)._fields(False)


def _raw(fields: list) -> str:
    return h(bytes([0x06]) + F.rlp(fields))


def rejects():
    ok = _payload(base())
    cases = []

    def add(name, why, raw):
        cases.append({"name": name, "why": why, "raw": raw})

    def mutate(i, value):
        f = list(ok)
        f[i] = value
        return _raw(f)

    add("no nonce keys", "EIP-8250: len(nonce_keys) < 1", mutate(1, []))
    add("seventeen nonce keys", "EIP-8250: len(nonce_keys) > MAX_NONCE_KEYS",
        mutate(1, [F.int_bytes(k) for k in range(1, 18)]))
    add("nonce keys out of order", "EIP-8250: not strictly increasing", mutate(1, [b"\x02", b"\x01"]))
    add("a repeated nonce key", "EIP-8250: not strictly increasing", mutate(1, [b"\x01", b"\x01"]))
    add("key 0 with another key", "EIP-8250: a zero key and nonce_keys != [0]", mutate(1, [b"", b"\x01"]))
    add("a nonce key with a leading zero", "EIP-8250: not a canonical RLP integer", mutate(1, [b"\x00\x01"]))
    add("nonce_seq of 2^64", "EIP-8250: nonce_seq >= 2**64", mutate(2, F.int_bytes(2**64)))
    add("nonce_seq with a leading zero", "EIP-8250: not a canonical RLP integer", mutate(2, b"\x00\x05"))
    add("a chain ID with a leading zero", "not a canonical integer", mutate(0, b"\x00" + F.int_bytes(0x1fcd)))
    add("a 19-byte sender", "EIP-8141: len(tx.sender) == 20", mutate(3, b"\x27" * 19))
    add("no frames", "EIP-8141: len(tx.frames) > 0", mutate(4, []))
    add("a frame of five fields", "the frame is [mode, flags, target, limits, value, data]",
        mutate(4, [ok[4][0][:5]]))
    add("limits of three fields", "limits = [execution, state]",
        mutate(4, [[*ok[4][0][:3], [b"\x75\x30", b"", b""], *ok[4][0][4:]]]))
    add("a 19-byte frame target", "a target is empty or 20 bytes",
        mutate(4, [[*ok[4][0][:2], b"\x27" * 19, *ok[4][0][3:]]]))
    add("fees of two fields", "fees = [max_priority_fee_per_gas, max_fee_per_gas, max_fee_per_blob_gas]",
        mutate(6, ok[6][:2]))
    good = _raw(ok)
    add("bytes after the payload", "the payload is exactly one RLP item", good + "00")
    add("the type byte 0x02", "not FRAME_TX_TYPE", "0x02" + good[4:])
    # RLP's own canonical form, in the nonce_keys field: [5] written as c2 81 05, and [0]
    # written with a long-form list length, f8 01 80.
    add("a single byte given a length prefix", "RLP: a byte under 0x80 is its own encoding",
        _rebuild(ok, 1, b"\xc2\x81\x05"))
    add("a long length for a short list", "RLP: a length under 56 in the long form",
        _rebuild(ok, 1, b"\xf8\x01\x80"))
    for c in cases:
        try:
            F.decode(bytes.fromhex(c["raw"][2:]))
        except F.Invalid as e:
            c["texts"] = str(e)
            continue
        raise SystemExit(f"the third implementation accepts reject case {c['name']!r}")
    return cases


def _rebuild(fields: list, index: int, enc: bytes) -> str:
    """The payload with field `index` replaced by raw RLP bytes `enc`."""
    parts = [F.rlp(x) if i != index else enc for i, x in enumerate(fields)]
    body = b"".join(parts)
    return h(bytes([0x06]) + F._len_prefix(len(body), 0xC0) + body)


def digests(checkout: str, commit: str):
    v = json.load(open(os.path.join(checkout, "experiments/27-execution-digest/vectors.json")))
    out = []
    for c in v["cases"]:
        t = F.from_raw(bytes.fromhex(c["raw"][2:]))
        got = (h(F.domain_separator(t)), h(F.execution_struct_hash(t)), h(F.execution_digest(t)))
        want = (c["domainSeparator"], c["structHash"], c["executionDigest"])
        out.append({"name": c["name"], "note": c.get("note", ""), "source": "exp-frames experiment 27",
                    "provenance": {"repository": "4w44h9jckz-boop/exp-frames", "commit": commit,
                                   "path": "experiments/27-execution-digest/vectors.json"},
                    "raw": c["raw"], "domainSeparator": want[0], "structHash": want[1],
                    "executionDigest": want[2], "textsAgree": got == want})
    return out


def write(name: str, header: dict, cases: list) -> None:
    with open(os.path.join(OUT, name), "w") as fh:
        json.dump({**header, "cases": cases}, fh, indent=1)
        fh.write("\n")


def main() -> None:
    checkout, commit = sys.argv[1], sys.argv[2]
    if len(commit) != 40:
        raise SystemExit("pin a full 40-character commit")
    tx_m, mismatches, skipped = mined(checkout, commit)
    tx_w = written()
    rej = rejects()
    dig = digests(checkout, commit)
    head = {"generated": "python3 vectors/frame-tx/tools/generate.py <exp-frames checkout> " + commit,
            "doNotEdit": "generated; rerun the command and compare",
            "exp-frames": commit}
    write("transactions.json", {**head, "what": "fields -> raw bytes, hash, and canonical signature hash "
                                                 "(EIP-8141 compute_sig_hash)"}, tx_m + tx_w)
    write("reject.json", {**head, "what": "raw bytes a decoder must refuse"}, rej)
    write("execution-digest.json", {**head, "what": "raw bytes -> the draft ERC's execution digest"}, dig)
    by_chain = sum(1 for c in tx_m if c["sigHashSource"] == "chain")
    print(f"transactions: {len(tx_m)} mined ({skipped} fixtures not Hegota-keyed, left out), "
          f"{len(tx_w)} written; mined hashes the texts do not reproduce: {len(mismatches)} {mismatches}")
    print(f"signature hashes: {by_chain} of {len(tx_m)} mined confirmed by a signature the chain accepted")
    print(f"reject: {len(rej)}; execution-digest: {len(dig)}, texts agree on "
          f"{sum(c['textsAgree'] for c in dig)}")


if __name__ == "__main__":
    main()
