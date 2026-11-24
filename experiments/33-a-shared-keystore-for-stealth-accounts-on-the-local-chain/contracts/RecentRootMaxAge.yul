// Experiment 33, case (f): EIP-8272's recent-root predeploy with a maximum age. The client's
// RECENT_ROOT_CODE (ethrex scripts/hegota-testnet/recent_root/main.eas) rewritten in Yul, with the
// write and the 72-byte validate form unchanged in what they store and accept, and one more form:
//
//   64 bytes                       write:    salt(32) || root(32)
//   n * 72 bytes, 1 <= n <= 16     validate: n tuples of source_id(32) || slot(8) || root(32)
//   1 + n * 80 bytes, first 0x01   validate: n tuples of source_id(32) || slot(8) || root(32) || max_age(8)
//   anything else, or value > 0    revert
//
// write: source_id = keccak256(caller || salt); at the current slot S,
//   storage[keccak256(STORAGE_DOMAIN || source_id || uint64_be(S % 8192))]
//     = keccak256(ENTRY_DOMAIN || source_id || uint64_be(S) || root)
// validate, every tuple: slot < S, S - slot <= 8191, in the second form S - slot <= max_age, and
// the stored entry hash under the slot's key equals the tuple's. An odd length is never a multiple
// of 64 or 72, so the forms cannot be confused. The runtime is this object's code itself.
object "RecentRootMaxAge" {
    code {
        if callvalue() { revert(0, 0) }
        let len := calldatasize()
        if eq(len, 64) { write() }
        if and(and(gt(len, 0), iszero(gt(len, 1152))), iszero(mod(len, 72))) {
            for { let off := 0 } lt(off, len) { off := add(off, 72) } { check(off, 0) }
            stop()
        }
        if and(iszero(mod(sub(len, 1), 80)), and(gt(len, 80), iszero(gt(len, 1281)))) {
            if iszero(eq(shr(248, calldataload(0)), 1)) { revert(0, 0) }
            for { let off := 1 } lt(off, len) { off := add(off, 80) } {
                check(off, add(shr(192, calldataload(add(off, 72))), 1))
            }
            stop()
        }
        revert(0, 0)

        function write() {
            mstore(0, caller())
            calldatacopy(0x20, 0, 0x20)
            let source := keccak256(0x0c, 0x34)
            let s := slotnum()
            mstore(0x100, entryHash(source, s, calldataload(0x20)))
            sstore(storageKey(source, s), mload(0x100))
            stop()
        }
        // One tuple at calldata `off`; maxAge1 is max_age + 1, or 0 for no bound beyond the window.
        function check(off, maxAge1) {
            let source := calldataload(off)
            let slot := shr(192, calldataload(add(off, 32)))
            let root := calldataload(add(off, 40))
            let s := slotnum()
            if iszero(gt(s, slot)) { revert(0, 0) }
            let age := sub(s, slot)
            if gt(age, 0x1fff) { revert(0, 0) }
            if maxAge1 { if iszero(lt(age, maxAge1)) { revert(0, 0) } }
            if iszero(eq(sload(storageKey(source, slot)), entryHash(source, slot, root))) { revert(0, 0) }
        }
        // keccak256(ENTRY_DOMAIN || source_id || uint64_be(slot) || root), 104 bytes at 0x40.
        function entryHash(source, slot, root) -> h {
            mstore(0x40, 0x8f42481679c8e6fefa040974b3c905e0ce3f2e464ba93acdb074a41181617efc)
            mstore(0x68, slot)
            mstore(0x60, source)
            mstore(0x88, root)
            h := keccak256(0x40, 0x68)
        }
        // keccak256(STORAGE_DOMAIN || source_id || uint64_be(slot % 8192)), 72 bytes at 0x140.
        function storageKey(source, slot) -> k {
            mstore(0x140, 0xbdc897da2177d260ff5f4be5d4b2aad43f89c3347a305b584fa5a2546d053daa)
            mstore(0x168, and(slot, 0x1fff))
            mstore(0x160, source)
            k := keccak256(0x140, 0x48)
        }
        function slotnum() -> v { v := verbatim_0i_1o(hex"4b") }
    }
}
