// Experiment 19 (X14): the fixed factory that deploys and funds a stealth account in one call.
//
//   pay(uint256 version, bytes32 word, bytes32 vk, bytes32 salt) payable
//     deploys Stealth's initcode || version || word || vk at CREATE2(this, salt) with the value.
//
// Version 1's salt is C, so the account's address follows from C; version 3's is H(key, r). The
// Stealth initcode is appended to this contract's code at deployment, its length the last word.
object "Factory" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        let tail := sub(codesize(), add(dataoffset("runtime"), size))
        codecopy(size, add(dataoffset("runtime"), size), tail)
        return(0, add(size, tail))
    }
    object "runtime" {
        code {
            switch shr(224, calldataload(0))
            case 0x36f787e5 { pay() }                           // pay(uint256,bytes32,bytes32,bytes32)
            default { revert(0, 0) }
            function pay() {
                let len := word(32)
                let at := sub(sub(codesize(), 32), len)
                codecopy(0x100, at, len)
                mstore(add(0x100, len), calldataload(4))
                mstore(add(0x120, len), calldataload(0x24))
                mstore(add(0x140, len), calldataload(0x44))
                let a := create2(callvalue(), 0x100, add(len, 96), calldataload(0x64))
                if iszero(a) { revert(0, 0) }
                mstore(0, a)
                log1(0, 0x20, 0xb513ded1b789eae3295f6834e90c165f7259d31e80787c0794e8745ca3574b2c) // Paid(address account)
                return(0, 0x20)
            }
            function word(fromEnd) -> v {
                codecopy(0, sub(codesize(), fromEnd), 32)
                v := mload(0)
            }
        }
    }
}
