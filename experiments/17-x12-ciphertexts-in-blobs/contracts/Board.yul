// Experiment 17 (X12): a board that records blobs of ciphertexts. It is the sender and payer of
// its own blob-carrying frame transactions, and L1 keeps 32 bytes and a header per blob:
//
//   [0] VERIFY -> board  checks: one blob; the packer's signature over (blob, header, fee); one KZG
//                        opening of the blob's element 0 at z = 1 equal to the header, through the
//                        point-evaluation precompile; the blob not yet recorded; the board's own
//                        nonce (key 0); the fee against the deposit; APPROVE(EXECUTION|PAYMENT)
//   [1] SENDER -> board  record(w): stores BLOBHASH(0) and the header
//
// Anyone proves one entry of a recorded blob with prove(): one opening at the domain point of the
// entry's hash slot, element 1 + index, recomputed here with MODEXP from the index.
//
// A blob is the experiment's layout (blob.ts): element 0 the header
// 0x00 || version || kind || count(2) || entryLen(2) || zeros, elements 1..count the entries'
// hash slots 0x00 || keccak256(entry)[0..31], then the entries.
//
// Constructor words, appended to the initcode: packer, salt.
object "Board" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 64), 64)
        return(0, add(size, 64))
    }
    object "runtime" {
        code {
            // ENTRY_POINT (0xaa) calls in DEFAULT and VERIFY frames. Only VERIFY does anything.
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) }
                stop()
            }

            // Plain ether is the deposit the board pays its own gas from.
            if iszero(calldatasize()) {
                sstore(1, add(sload(1), callvalue()))
                stop()
            }

            switch shr(224, calldataload(0))
            case 0xc1d15262 { record() }                         // record(uint256[])
            case 0x02a3041b { prove() }                          // prove(uint256,uint256,bytes32,bytes32,bytes32,bytes)
            case 0x0b1e7f83 { posts(calldataload(4)) }           // posts(uint256)
            case 0x06661abd { ret(sload(0)) }                    // count()
            case 0xd0e30db0 { ret(sload(1)) }                    // deposit()
            case 0x81af30b8 { ret(PACKER()) }                    // packer()
            default { revert(0, 0) }

            // ---- VERIFY ----

            function validate(me) {
                if me { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }
                // Exactly one SENDER frame follows, to this board, with no value and no flags.
                if iszero(eq(txparam(0x09), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x02, 1), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, 1), address())) { revert(0, 0) }
                if frameparam(0x08, 1) { revert(0, 0) }
                if frameparam(0x03, 1) { revert(0, 0) }
                if txparam(0x0b) { revert(0, 0) }
                // Exactly one blob.
                if iszero(eq(txparam(0x07), 1)) { revert(0, 0) }
                if iszero(eq(shr(224, framedataload(0, 1)), 0xc1d15262)) { revert(0, 0) }
                if iszero(eq(framedataload(0x04, 1), 0x20)) { revert(0, 0) }
                checkWords(8)
                // record(w): header, fee, commitment || proof (three words), r, s, v.
                let vh := blobhash(0)
                let header := w(0)
                let fee := w(1)
                checkHeader(header)
                if lt(fee, txparam(0x06)) { revert(0, 0) }
                if gt(fee, sload(1)) { revert(0, 0) }
                signedBy(postDigest(vh, header, fee), w(5), w(6), w(7))
                // The blob opens at z = 1, its element 0, to the header.
                if iszero(opens(vh, 1, header, w(2), w(3), w(4))) { revert(0, 0) }
                // A blob is recorded once: refused here from the board's own storage.
                if sload(recordedSlot(vh)) { revert(0, 0) }
                ownNonce()
                // The SENDER frame can always finish: up to four fresh slots (the count, the first
                // time; the hash, the header and the recorded mark) and the writes around them.
                if lt(frameparam(0x01, 1), 80000) { revert(0, 0) }
                if lt(frameparam(0x09, 1), mul(4, 97920)) { revert(0, 0) }
                approve(3)
            }

            function checkWords(n) {
                if iszero(eq(framedataload(0x24, 1), n)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 1), add(0x44, shl(5, n)))) { revert(0, 0) }
            }
            function w(i) -> v { v := framedataload(add(0x44, shl(5, i)), 1) }

            // 0x00 || version 1 || kind 1 or 2 || count > 0 || entryLen > 0.
            function checkHeader(h) {
                if shr(248, h) { revert(0, 0) }
                if iszero(eq(byte(1, h), 1)) { revert(0, 0) }
                let kind := byte(2, h)
                if iszero(or(eq(kind, 1), eq(kind, 2))) { revert(0, 0) }
                if iszero(countOf(h)) { revert(0, 0) }
                if iszero(lenOf(h)) { revert(0, 0) }
            }
            function countOf(h) -> c { c := and(shr(216, h), 0xffff) }
            function lenOf(h) -> l { l := and(shr(200, h), 0xffff) }

            function postDigest(vh, header, fee) -> d {
                mstore(0x100, 0xbdc1fa277dc120d380ba0ea81da296e8b9ab1ced576bacb50708cf3220ce50df) // keccak256("exp-e2e-frames/17/post")
                mstore(0x120, chainid())
                mstore(0x140, address())
                mstore(0x160, vh)
                mstore(0x180, header)
                mstore(0x1a0, fee)
                d := keccak256(0x100, 0xc0)
            }

            // ecrecover(digest, v, r, s) is the packer, with a low s.
            // `gas()` is evaluated last, so GAS sits immediately before STATICCALL.
            function signedBy(digest, r, s, v) {
                if iszero(or(eq(v, 27), eq(v, 28))) { revert(0, 0) }
                if gt(s, 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) { revert(0, 0) }
                mstore(0, digest)
                mstore(0x20, v)
                mstore(0x40, r)
                mstore(0x60, s)
                if iszero(staticcall(gas(), 1, 0, 0x80, 0x80, 0x20)) { revert(0, 0) }
                if iszero(eq(returndatasize(), 0x20)) { revert(0, 0) }
                let signer := mload(0x80)
                if iszero(signer) { revert(0, 0) }
                if iszero(eq(signer, PACKER())) { revert(0, 0) }
            }

            // The board's own nonce orders its posts: one nonce key, key 0, whose sequence is the
            // account nonce (EIP-8250's nonce_keys_hash = keccak256(1 || 0)). A fresh key per blob
            // was the first design; the test network dropped every second post on one (passes d4).
            function ownNonce() {
                if iszero(eq(txparam(0x0e), 1)) { revert(0, 0) }
                mstore(0x100, 1)
                mstore(0x120, 0)
                if iszero(eq(keccak256(0x100, 0x40), txparam(0x0f))) { revert(0, 0) }
            }

            // ---- the point-evaluation precompile (EIP-4844) ----

            // versioned_hash || z || y || commitment(48) || proof(48), the last two as three words.
            function opens(vh, z, y, k0, k1, k2) -> ok {
                mstore(0x200, vh)
                mstore(0x220, z)
                mstore(0x240, y)
                mstore(0x260, k0)
                mstore(0x280, k1)
                mstore(0x2a0, k2)
                ok := staticcall(gas(), 0x0a, 0x200, 0xc0, 0x300, 0x40)
                if ok { ok := eq(returndatasize(), 0x40) }
            }

            // ---- SENDER ----

            function cw(i) -> v { v := calldataload(add(0x44, shl(5, i))) }

            function record() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let vh := blobhash(0)
                if iszero(vh) { revert(0, 0) }
                if sload(recordedSlot(vh)) { revert(0, 0) }
                let header := cw(0)
                let seq := sload(0)
                sstore(0, add(seq, 1))
                sstore(postSlot(seq), vh)
                sstore(add(postSlot(seq), 1), header)
                sstore(recordedSlot(vh), add(seq, 1))
                sstore(1, sub(sload(1), cw(1)))
                mstore(0, header)
                log3(0, 0x20, 0xa1f76143e7f1de78326f1fb1cc1d8d1c2f9ab37aa589d53ebd919721b644beed, seq, vh) // Posted(uint256 indexed seq, bytes32 indexed versionedHash, uint256 header)
                stop()
            }

            // ---- prove(seq, index, k0, k1, k2, entry) ----

            function prove() {
                let seq := calldataload(4)
                let index := calldataload(0x24)
                let vh := sload(postSlot(seq))
                if iszero(vh) { revert(0, 0) }
                let header := sload(add(postSlot(seq), 1))
                if iszero(lt(index, countOf(header))) { revert(0, 0) }
                // The entry, the one dynamic argument, at the offset its head word gives.
                let at := add(4, calldataload(0xa4))
                let len := calldataload(at)
                if iszero(eq(len, lenOf(header))) { revert(0, 0) }
                calldatacopy(0x400, add(at, 0x20), len)
                let entryHash := keccak256(0x400, len)
                // y = 0x00 || keccak256(entry)[0..31]; z = OMEGA ^ brp(1 + index).
                let y := shr(8, entryHash)
                let z := rootOf(add(index, 1))
                if iszero(opens(vh, z, y, calldataload(0x44), calldataload(0x64), calldataload(0x84))) { revert(0, 0) }
                mstore(0, entryHash)
                log3(0, 0x20, 0x0640e9988c4f12e3d2007438e51a4982405667accd209040941f4485a772ac03, seq, index) // Included(uint256 indexed seq, uint256 indexed index, bytes32 entryHash)
                stop()
            }

            // The 12-bit bit reversal of i, then MODEXP(OMEGA, that, BLS_MODULUS).
            function rootOf(i) -> z {
                let r := 0
                for { let b := 0 } lt(b, 12) { b := add(b, 1) } {
                    r := or(r, shl(sub(11, b), and(shr(b, i), 1)))
                }
                mstore(0x200, 0x20)
                mstore(0x220, 0x20)
                mstore(0x240, 0x20)
                mstore(0x260, 0x564c0a11a0f704f4fc3e8acfe0f8245f0ad1347b378fbf96e206da11a5d36306) // OMEGA = 7^((r - 1) / 4096)
                mstore(0x280, r)
                mstore(0x2a0, 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001) // BLS_MODULUS
                if iszero(staticcall(gas(), 0x05, 0x200, 0xc0, 0x300, 0x20)) { revert(0, 0) }
                z := mload(0x300)
            }

            // ---- storage, constants and helpers ----

            function postSlot(seq) -> s { s := add(0x1000, shl(1, seq)) }
            function recordedSlot(vh) -> s {
                mstore(0, vh)
                mstore(0x20, 2)
                s := keccak256(0, 0x40)
            }
            function posts(seq) {
                mstore(0, sload(postSlot(seq)))
                mstore(0x20, sload(add(postSlot(seq), 1)))
                return(0, 0x40)
            }
            function PACKER() -> v {
                codecopy(0x1e0, sub(codesize(), 64), 32)
                v := mload(0x1e0)
            }
            function ret(v) {
                mstore(0, v)
                return(0, 0x20)
            }

            // EIP-8141 opcodes. verbatim puts its first argument on top.
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
