// Experiment 27 (X20): the board, which holds the key directory too (amendment 1). It is the
// sender and payer of every transaction that touches it, approving each in its own VERIFY, as
// experiment 26's rollup is. A party appears only as a leanSPHINCS dependency, and pays from the
// deposit its key holds here.
//
// Transactions, each [0] VERIFY, [1] DEP (one leanSPHINCS triple per signer), [2] SENDER:
//   setKey   data: key, version, kemKey (1,184 bytes)
//            triple (0x10, M, key), M = keccak256("x20/dir" || board || key || keccak256(kemKey)
//            || version); nonce key keccak256("x20/dir" || key || version); the key pays
//   post     data: relayTo, carrier (0 a blob, 1 calldata), n, then n entries of seven words,
//            senderKey, envHash, offset, length, fee, kind, tag; then, for calldata, the envelopes
//            triple i (0x10, V_i, senderKey_i), V_i = keccak256("x20/post" || board || envHash_i
//            || fee_i || relayTo || carrier); nonce key keccak256("x20/post" || envHash_0);
//            the fees pay, and the relay keeps what the most this transaction can cost leaves
//   redeem   data: recipientKey, archiver, versionedHash, fee, nonce
//            triple (0x10, R, recipientKey), R = keccak256("x20/fetch" || board || versionedHash
//            || archiver || fee || nonce); nonce key keccak256("x20/fetch" || recipientKey ||
//            versionedHash || nonce); the recipient pays the fee and the cost
// A word is 32 bytes; a key, a hash or a tag is one word; an address or an integer is a word.
//
// Storage: mapslot(key, 1) the key's ML-KEM key hash; mapslot(key, 2) its version, the number of
// writes so far; mapslot(key, 3) its deposit, credited at genesis.
object "Board" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        return(0, size)
    }
    object "runtime" {
        code {
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) }   // VERIFY
                stop()
            }
            if iszero(calldatasize()) { stop() }
            // The SENDER frames' selectors are those of setKey(), post() and redeem(); their data is
            // the fixed layout above, not ABI arguments.
            switch shr(224, calldataload(0))
            case 0x3701294c { doSetKey() }
            case 0x05c1f502 { doPost() }
            case 0xbe040fb0 { doRedeem() }
            case 0xdf78bce2 { ret(sload(mapslot(calldataload(4), 1))) }   // keyOf(bytes32)
            case 0x586e05a5 { ret(sload(mapslot(calldataload(4), 2))) }   // versionOf(bytes32)
            case 0xcca304de { ret(sload(mapslot(calldataload(4), 3))) }   // depositOf(bytes32)
            default { revert(0, 0) }

            // ---------------------------------------------------------------- VERIFY

            function validate(me) {
                if me { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }
                if iszero(eq(txparam(0x09), 3)) { revert(0, 0) }
                if txparam(0x0b) { revert(0, 0) }                    // no signatures
                if iszero(eq(frameparam(0x02, 1), 4)) { revert(0, 0) }
                let s := 2
                if iszero(eq(frameparam(0x02, s), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, s), address())) { revert(0, 0) }
                if frameparam(0x08, s) { revert(0, 0) }
                if frameparam(0x03, s) { revert(0, 0) }
                if iszero(eq(txparam(0x0e), 1)) { revert(0, 0) }
                if txparam(0x01) { revert(0, 0) }
                if lt(frameparam(0x01, s), 100000) { revert(0, 0) }
                if lt(frameparam(0x09, s), 300000) { revert(0, 0) }
                switch shr(224, framedataload(0, s))
                case 0x3701294c { vSetKey(s) }
                case 0x05c1f502 { vPost(s) }
                case 0xbe040fb0 { vRedeem(s) }
                default { revert(0, 0) }
                approve(3)
            }

            function vSetKey(s) {
                if iszero(eq(frameparam(0x04, s), 1252)) { revert(0, 0) }
                if txparam(0x07) { revert(0, 0) }
                let key := framedataload(0x04, s)
                let version := framedataload(0x24, s)
                if iszero(eq(version, sload(mapslot(key, 2)))) { revert(0, 0) }
                if lt(sload(mapslot(key, 3)), txparam(0x06)) { revert(0, 0) }
                mstore(0x400, 0x7832302f646972)                      // "x20/dir"
                mstore(0x420, key)
                mstore(0x440, version)
                if iszero(eq(txparam(0x10), keccak256(0x400, 0x60))) { revert(0, 0) }
                framedatacopy(0x1000, 0x44, 1184, s)
                mstore(0x400, 0x7832302f646972)
                mstore(0x420, address())
                mstore(0x440, key)
                mstore(0x460, keccak256(0x1000, 1184))
                mstore(0x480, version)
                if iszero(eq(frameparam(0x04, 1), 96)) { revert(0, 0) }
                triple(0, key, keccak256(0x400, 0xa0))
            }

            function vPost(s) {
                let relayTo := framedataload(0x04, s)
                let carrier := framedataload(0x24, s)
                let n := framedataload(0x44, s)
                if shr(160, relayTo) { revert(0, 0) }
                if or(iszero(n), gt(n, 16)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 1), mul(n, 96))) { revert(0, 0) }
                let region := add(0x64, mul(n, 224))
                switch carrier
                case 0 {
                    if iszero(eq(txparam(0x07), 1)) { revert(0, 0) }
                    if iszero(eq(frameparam(0x04, s), region)) { revert(0, 0) }
                }
                case 1 {
                    if txparam(0x07) { revert(0, 0) }
                    if lt(frameparam(0x04, s), region) { revert(0, 0) }
                }
                default { revert(0, 0) }
                let fees := 0
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    let e := add(0x64, mul(i, 224))
                    let sender := framedataload(e, s)
                    let envHash := framedataload(add(e, 0x20), s)
                    let fee := framedataload(add(e, 0x80), s)
                    if gt(fee, sload(mapslot(sender, 3))) { revert(0, 0) }
                    fees := add(fees, fee)
                    if eq(carrier, 1) {
                        // The envelope is in this frame's data, at its offset after the entries.
                        let off := framedataload(add(e, 0x40), s)
                        let len := framedataload(add(e, 0x60), s)
                        if gt(add(add(region, off), len), frameparam(0x04, s)) { revert(0, 0) }
                        framedatacopy(0x1000, add(region, off), len, s)
                        if iszero(eq(keccak256(0x1000, len), envHash)) { revert(0, 0) }
                    }
                    mstore(0x400, 0x7832302f706f7374)                // "x20/post"
                    mstore(0x420, address())
                    mstore(0x440, envHash)
                    mstore(0x460, fee)
                    mstore(0x480, relayTo)
                    mstore(0x4a0, carrier)
                    triple(mul(i, 96), sender, keccak256(0x400, 0xc0))
                }
                if lt(fees, txparam(0x06)) { revert(0, 0) }          // the fees cover the worst case
                mstore(0x400, 0x7832302f706f7374)
                mstore(0x420, framedataload(0x84, s))
                if iszero(eq(txparam(0x10), keccak256(0x400, 0x40))) { revert(0, 0) }
            }

            function vRedeem(s) {
                if iszero(eq(frameparam(0x04, s), 0xa4)) { revert(0, 0) }
                if txparam(0x07) { revert(0, 0) }
                let key := framedataload(0x04, s)
                let archiver := framedataload(0x24, s)
                let vh := framedataload(0x44, s)
                let fee := framedataload(0x64, s)
                let nonce := framedataload(0x84, s)
                if shr(160, archiver) { revert(0, 0) }
                if lt(sload(mapslot(key, 3)), add(fee, txparam(0x06))) { revert(0, 0) }
                mstore(0x400, 0x7832302f6665746368)                  // "x20/fetch"
                mstore(0x420, key)
                mstore(0x440, vh)
                mstore(0x460, nonce)
                if iszero(eq(txparam(0x10), keccak256(0x400, 0x80))) { revert(0, 0) }
                mstore(0x400, 0x7832302f6665746368)
                mstore(0x420, address())
                mstore(0x440, vh)
                mstore(0x460, archiver)
                mstore(0x480, fee)
                mstore(0x4a0, nonce)
                if iszero(eq(frameparam(0x04, 1), 96)) { revert(0, 0) }
                triple(0, key, keccak256(0x400, 0xc0))
            }

            // ---------------------------------------------------------------- SENDER frames

            function doSetKey() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let key := calldataload(0x04)
                let version := calldataload(0x24)
                let d := mapslot(key, 3)
                sstore(d, sub(sload(d), txparam(0x06)))
                calldatacopy(0x1000, 0x44, 1184)
                sstore(mapslot(key, 1), keccak256(0x1000, 1184))
                sstore(mapslot(key, 2), add(version, 1))
                // KeySet(bytes32 indexed key, uint256 version, bytes kemKey)
                mstore(0xfa0, version)
                mstore(0xfc0, 0x40)
                mstore(0xfe0, 1184)
                log2(0xfa0, add(0x60, 1184), 0x4be471d942b571edad2d1841c69493f8442908a01bcc5337d7be2d32ff8e2c52, key)
                stop()
            }

            function doPost() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let relayTo := calldataload(0x04)
                let n := calldataload(0x44)
                let vh := 0
                if iszero(calldataload(0x24)) { vh := blobhash(0) }
                let fees := 0
                for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                    let e := add(0x64, mul(i, 224))
                    let sender := calldataload(e)
                    let fee := calldataload(add(e, 0x80))
                    let d := mapslot(sender, 3)
                    sstore(d, sub(sload(d), fee))
                    fees := add(fees, fee)
                    // Announce(bytes32 indexed envHash, uint256 kind, bytes32 tag, bytes32 versionedHash,
                    //          uint256 offset, uint256 length, bytes32 senderKey)
                    mstore(0, calldataload(add(e, 0xa0)))
                    mstore(0x20, calldataload(add(e, 0xc0)))
                    mstore(0x40, vh)
                    mstore(0x60, calldataload(add(e, 0x40)))
                    mstore(0x80, calldataload(add(e, 0x60)))
                    mstore(0xa0, sender)
                    log2(0, 0xc0, 0x8e76e31d2014d4b460431883aaf880cfb2ca1e6c5716ce037c234aeb840710ab, calldataload(add(e, 0x20)))
                }
                let tip := sub(fees, txparam(0x06))
                if tip { pop(call(gas(), relayTo, tip, 0, 0, 0, 0)) }
                stop()
            }

            function doRedeem() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let key := calldataload(0x04)
                let archiver := calldataload(0x24)
                let fee := calldataload(0x64)
                let d := mapslot(key, 3)
                sstore(d, sub(sload(d), add(fee, txparam(0x06))))
                if fee { pop(call(gas(), archiver, fee, 0, 0, 0, 0)) }
                // Redeemed(bytes32 indexed versionedHash, address archiver, uint256 fee)
                mstore(0, archiver)
                mstore(0x20, fee)
                log2(0, 0x40, 0x61d905e697374527439f5c64f060ae521e3b586e8f61ef3f160057e7150e153e, calldataload(0x44))
                stop()
            }

            // ---------------------------------------------------------------- helpers

            function triple(at, key, dataHash) {
                if iszero(eq(framedataload(at, 1), 0x10)) { revert(0, 0) }
                if iszero(eq(framedataload(add(at, 32), 1), dataHash)) { revert(0, 0) }
                if iszero(eq(framedataload(add(at, 64), 1), key)) { revert(0, 0) }
            }
            function mapslot(key, tag) -> slot {
                mstore(0, key)
                mstore(0x20, tag)
                slot := keccak256(0, 0x40)
            }
            function ret(v) {
                mstore(0, v)
                return(0, 0x20)
            }
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function framedatacopy(memOffset, dataOffset, length, frame) {
                verbatim_4i_0o(hex"b2", memOffset, dataOffset, length, frame)
            }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
    }
}
