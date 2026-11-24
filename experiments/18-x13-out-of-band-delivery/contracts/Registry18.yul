// Experiment 18 (X13): a registry of notes that commit to their delivery (circuits/deliver.circom),
// in Tornado Cash's height-20 MiMC tree, as experiment 15's MODE 0 inserts it. It is the sender
// and payer of its own spends:
//
//   [0] VERIFY -> registry  checks: two frames; the proof against (root, nullifier, tNow,
//                           outCommitment); root among the registry's known roots; tNow not later
//                           than the registry's own clock; the nullifier as the one nonce key, at
//                           sequence 0; the SENDER frame's floors; APPROVE(EXECUTION|PAYMENT)
//   [1] SENDER -> registry  deliver(w): inserts H(outCommitment, timestamp), ticks the clock
//
// w = root, nullifier, tNow, outCommitment, proof (8 words), 12 words.
//
// The clock (Amendment 1): EIP-8141 bans TIMESTAMP in validation, so every deposit, spend and
// tick() stores the block's timestamp in slot 5, and VERIFY checks tNow <= slot 5. The slot only
// grows, so a spend that passes stays valid.
//
// A deposit of exactly DENOM inserts H(c, timestamp). The registry holds one denomination, and a
// spend moves it to a fresh note; no withdrawal is modelled. Spends' gas is paid from a float
// sent as plain ether.
//
// Storage: 0 leaf count; 2 current root; 5 the clock; 0x100 + level the filled subtrees;
// keccak(root || 4) a known root.
//
// initcode = <this object> || verifier || hasher || salt
object "Registry18" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 96), 96)
        return(0, add(size, 96))
    }
    object "runtime" {
        code {
            // ENTRY_POINT (0xaa) calls in DEFAULT and VERIFY frames. Only VERIFY does anything.
            if eq(caller(), 0xaa) {
                let frame := txparam(0x0a)
                if eq(frameparam(0x02, frame), 1) { validate(frame) }
                stop()
            }

            // Plain ether tops up the float the registry pays its spends from.
            if iszero(calldatasize()) { stop() }

            switch shr(224, calldataload(0))
            case 0xb214faa5 { deposit(calldataload(4)) }        // deposit(bytes32)
            case 0xd3dcde9a { deliver() }                       // deliver(uint256[])
            case 0x3eaf5d9f { tick() }                          // tick()
            case 0xebf0c717 { ret(sload(2)) }                   // root()
            case 0x30e69fc3 { ret(sload(0)) }                   // leafCount()
            case 0x91ddadf4 { ret(sload(5)) }                   // clock()
            case 0x6d9833e3 { ret(sload(mapslot(calldataload(4), 4))) } // isKnownRoot(bytes32)
            default { revert(0, 0) }

            // ---- VERIFY ----

            function validate(me) {
                if me { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }
                if iszero(eq(txparam(0x09), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x02, 1), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, 1), address())) { revert(0, 0) }
                if frameparam(0x08, 1) { revert(0, 0) }
                if frameparam(0x03, 1) { revert(0, 0) }
                if txparam(0x0b) { revert(0, 0) }
                if txparam(0x07) { revert(0, 0) }
                if txparam(0x01) { revert(0, 0) }
                if iszero(eq(shr(224, framedataload(0, 1)), 0xd3dcde9a)) { revert(0, 0) }
                if iszero(eq(framedataload(0x04, 1), 0x20)) { revert(0, 0) }
                if iszero(eq(framedataload(0x24, 1), 12)) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 1), add(0x44, shl(5, 12)))) { revert(0, 0) }

                let root := fw(0)
                let nullifier := fw(1)
                let tNow := w(2)
                let out := fw(3)
                if iszero(sload(mapslot(root, 4))) { revert(0, 0) }
                if shr(40, tNow) { revert(0, 0) }
                if gt(tNow, sload(5)) { revert(0, 0) }
                if iszero(out) { revert(0, 0) }

                // The one nonce key is the nullifier, at sequence 0 (EIP-8250's
                // nonce_keys_hash = keccak256(1 || nullifier)).
                if iszero(eq(txparam(0x0e), 1)) { revert(0, 0) }
                mstore(0x400, 1)
                mstore(0x420, nullifier)
                if iszero(eq(keccak256(0x400, 0x40), txparam(0x0f))) { revert(0, 0) }

                // The proof (words 4..11), then its four inputs.
                let p := 0x80
                framedatacopy(p, add(0x44, shl(5, 4)), 256, 1)
                mstore(add(p, 0x100), root)
                mstore(add(p, 0x120), nullifier)
                mstore(add(p, 0x140), tNow)
                mstore(add(p, 0x160), out)
                if iszero(staticcall(gas(), VERIFIER(), p, 0x180, 0, 0x20)) { revert(0, 0) }
                if iszero(and(eq(returndatasize(), 0x20), eq(mload(0), 1))) { revert(0, 0) }

                // So that nobody can starve frame 1 once the nonce key is used: an insertion, and
                // up to three fresh slots (a subtree, the root, the root's mark).
                if lt(frameparam(0x01, 1), LEAF_EXECUTION()) { revert(0, 0) }
                if lt(frameparam(0x09, 1), mul(3, 97920)) { revert(0, 0) }
                approve(3)
            }

            function w(i) -> v { v := framedataload(add(0x44, shl(5, i)), 1) }
            function fw(i) -> v {
                v := w(i)
                if iszero(lt(v, FIELD())) { revert(0, 0) }
            }

            // ---- SENDER and plain calls ----

            function deliver() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let nullifier := calldataload(0x64)
                let out := calldataload(0xa4)
                let index := addLeaf(hashLeftRight(out, timestamp()))
                sstore(5, timestamp())
                mstore(0, out)
                mstore(0x20, index)
                mstore(0x40, timestamp())
                log2(0, 0x60, 0x4887a8e5555b030428aa0fb458100c1f6298f43d7d2308e673d0122e1c551e7d, nullifier) // Spent(uint256 indexed nullifier, bytes32 outCommitment, uint256 index, uint256 t0)
                stop()
            }

            function deposit(c) {
                if iszero(eq(callvalue(), DENOM())) { revert(0, 0) }
                if iszero(lt(c, FIELD())) { revert(0, 0) }
                let index := addLeaf(hashLeftRight(c, timestamp()))
                sstore(5, timestamp())
                mstore(0, c)
                mstore(0x20, index)
                mstore(0x40, timestamp())
                log1(0, 0x60, 0xb39477ecc06c5293391f8b73168b655d9c1310af93dbbf043187d79f881bbb8f) // Deposited(bytes32 c, uint256 index, uint256 t0)
                stop()
            }

            function tick() {
                sstore(5, timestamp())
                stop()
            }

            // Tornado's MerkleTreeWithHistory._insert, as experiment 15; the new root is kept.
            function addLeaf(leaf) -> index {
                index := sload(0)
                if iszero(lt(index, shl(20, 1))) { revert(0, 0) }
                let node := leaf
                let i := index
                for { let level := 0 } lt(level, 20) { level := add(level, 1) } {
                    switch and(i, 1)
                    case 0 {
                        sstore(add(0x100, level), node)
                        node := hashLeftRight(node, zero(level))
                    }
                    default {
                        node := hashLeftRight(sload(add(0x100, level)), node)
                    }
                    i := shr(1, i)
                }
                sstore(2, node)
                sstore(mapslot(node, 4), 1)
                sstore(0, add(index, 1))
            }

            // One MiMC permutation of the deployed hasher: (xL, xR) -> (xL, xR) at 0 and 0x20.
            function permute(xL, xR) {
                mstore(0, shl(224, 0xf47d33b5))   // MiMCSponge(uint256,uint256)
                mstore(0x04, xL)
                mstore(0x24, xR)
                if iszero(staticcall(gas(), HASHER(), 0, 0x44, 0, 0x40)) { revert(0, 0) }
            }
            function hashLeftRight(left, right) -> r {
                permute(left, 0)
                permute(addmod(mload(0), right, FIELD()), mload(0x20))
                r := mload(0)
            }

            // ---- constants ----

            function LEAF_EXECUTION() -> g { g := 1200000 }
            function DENOM() -> v { v := 1000000000000000 }
            function FIELD() -> f { f := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001 }
            function SALT() -> v { v := word(32) }
            function HASHER() -> v { v := word(64) }
            function VERIFIER() -> v { v := word(96) }
            function word(fromEnd) -> v {
                codecopy(0x60, sub(codesize(), fromEnd), 32)
                v := mload(0x60)
            }
            function zero(level) -> z {
                datacopy(0x60, add(dataoffset("zeros"), shl(5, level)), 32)
                z := mload(0x60)
            }
            function mapslot(key, tag) -> s {
                mstore(0, key)
                mstore(0x20, tag)
                s := keccak256(0, 0x40)
            }
            function ret(v) {
                mstore(0, v)
                return(0, 0x20)
            }

            // EIP-8141 opcodes. verbatim puts its first argument on top.
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function framedatacopy(memOffset, dataOffset, length, frame) {
                verbatim_4i_0o(hex"b2", memOffset, dataOffset, length, frame)
            }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
        // zeros(0) .. zeros(20) of Tornado's tree, as tornado-core hard-codes them.
        data "zeros" hex"2fe54c60d3acabf3343a35b6eba15db4821b340f76e741e2249685ed4899af6c256a6135777eee2fd26f54b8b7037a25439d5235caee224154186d2b8a52e31d1151949895e82ab19924de92c40a3d6f7bcb60d92b00504b8199613683f0c20020121ee811489ff8d61f09fb89e313f14959a0f28bb428a20dba6b0b068b3bdb0a89ca6ffa14cc462cfedb842c30ed221a50a3d6bf022a6a57dc82ab24c157c924ca05c2b5cd42e890d6be94c68d0689f4f21c9cec9c0f13fe41d566dfb549591ccb97c932565a92c60156bdba2d08f3bf1377464e025cee765679e604a7315c19156fbd7d1a8bf5cba8909367de1b624534ebab4f0f79e003bccdd1b182bdb4261af8c1f0912e465744641409f622d466c3920ac6e5ff37e36604cb11dfff800058459724ff6ca5a1652fcbc3e82b93895cf08e975b19beab3f54c217d1c0071f04ef20dee48d39984d8eabe768a70eafa6310ad20849d4573c3c40c2ad1e301bea3dec5dab51567ce7e200a30f7ba6d4276aeaa53e2686f962a46c66d511e50ee0f941e2da4b9e31c3ca97a40d8fa9ce68d97c084177071b3cb46cd3372f0f1ca9503e8935884501bbaf20be14eb4c46b89772c97b96e3b2ebf3a36a948bbd133a80e30697cd55d8f7d4b0965b7be24057ba5dc3da898ee2187232446cb10813e6d8fc88839ed76e182c2a779af5b2c0da9dd18c90427a644f7e148a6253b61eb16b057a477f4bc8f572ea6bee39561098f78f15bfb3699dcbb7bd8db618540da2cb16a1ceaabf1c16b838f7a9e3f2a3a3088d9e0a6debaa748114620696ea24a3b3d822420b14b5d8cb6c28a574f01e98ea9e940551d2ebd75cee12649f9d198622acbd783d1b0d9064105b1fc8e4d8889de95c4c519b3f635809fe6afc0529d7ed391256ccc3ea596c86e933b89ff339d25ea8ddced975ae2fe30b5296d4"
    }
}
