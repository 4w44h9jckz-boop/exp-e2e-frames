// Experiment 22 (Q1): an account authorized by a leanSPHINCS key under EIP-8288.
//
// This object is the account's runtime code, with no constructor: genesis places it at the
// account's address, followed by two words: an implementation address (zero for none), then the
// 32-byte leanSPHINCS public key (root || public parameter, EIP-8288's verification_key_hash for
// LEANSPHINCS_SCHEME).
//
// VERIFY approves execution and payment when some dependency frame (mode 4) of the transaction
// declares the triple (0x10, 0, key). A zero data_hash stands for the transaction's signature hash
// (EIP-8288 at ethereum/EIPs 46976b2), so the block's proof checks this key's signature over it.
// SENDER frames call execute(address to, uint256 value, bytes data), from the account itself.
// Any other call from itself runs the implementation by DELEGATECALL (experiment 22, amendment 3:
// the code of the sender this account replaces, so only the key check moves), or, with no
// implementation, stops, as a call to a codeless account does. A call with no data receives ETH.
object "SphincsAccount" {
    code {
        if eq(caller(), 0xaa) {
            let frame := txparam(0x0a)
            if eq(frameparam(0x02, frame), 1) { validate(frame) }
            stop()
        }
        if iszero(calldatasize()) { stop() }
        if iszero(eq(caller(), address())) { revert(0, 0) }
        switch shr(224, calldataload(0))
        case 0xb61d27f6 { execute() }   // execute(address,uint256,bytes)
        default { implementation() }

        function validate(me) {
            let key := KEY()
            let found := 0
            let n := txparam(0x09)
            for { let j := 0 } lt(j, n) { j := add(j, 1) } {
                if eq(frameparam(0x02, j), 4) {
                    let len := frameparam(0x04, j)
                    for { let o := 0 } lt(o, len) { o := add(o, 96) } {
                        if eq(framedataload(o, j), 0x10) {
                            if iszero(framedataload(add(o, 32), j)) {
                                if eq(framedataload(add(o, 64), j), key) { found := 1 }
                            }
                        }
                    }
                }
            }
            if iszero(found) { revert(0, 0) }
            approve(frameparam(0x06, me))
        }

        function execute() {
            let to := calldataload(0x04)
            let value := calldataload(0x24)
            let off := add(0x04, calldataload(0x44))
            let len := calldataload(off)
            calldatacopy(0, add(off, 0x20), len)
            if iszero(call(gas(), to, value, 0, len, 0, 0)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            stop()
        }

        function implementation() {
            codecopy(0, sub(codesize(), 64), 32)
            let impl := mload(0)
            if iszero(impl) { stop() }
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }

        function KEY() -> k {
            codecopy(0, sub(codesize(), 32), 32)
            k := mload(0)
        }
        function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
        function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
        function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
        function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
    }
}
