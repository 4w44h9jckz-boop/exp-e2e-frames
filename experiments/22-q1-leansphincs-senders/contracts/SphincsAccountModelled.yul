// Experiment 22 (Q1), arm 4: SphincsAccount for the test network, where EIP-8288 is modelled.
//
// The test network has no dependency frame, so the triple (0x10, 0, key) travels in this
// account's own VERIFY frame's data, as experiment 19's modelled path carried it. Nothing on that
// chain checks the leanSPHINCS signature; the run checks it off chain. Everything else is
// SphincsAccount's: execute(address,uint256,bytes) from itself, any other call from itself run by
// DELEGATECALL in the implementation, a call with no data receives ETH.
//
// initcode = <this object> || implementation (32, zero for none) || key (32). The CREATE2
// deployer runs it, so the funder deploys and funds the account in one call.
object "SphincsAccountModelled" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 64), 64)
        return(0, add(size, 64))
    }
    object "runtime" {
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
                if iszero(eq(frameparam(0x04, me), 96)) { revert(0, 0) }
                if iszero(eq(framedataload(0, me), 0x10)) { revert(0, 0) }
                if framedataload(32, me) { revert(0, 0) }
                if iszero(eq(framedataload(64, me), KEY())) { revert(0, 0) }
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
}
