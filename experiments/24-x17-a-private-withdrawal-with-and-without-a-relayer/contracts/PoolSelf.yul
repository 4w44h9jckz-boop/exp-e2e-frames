// Experiment 24 (X17), arm B: Tornado Cash's statement in a pool that sends and pays for its own
// withdrawal. Written here, not copied (tornado-core is GPL-3.0).
//
// The same circuit, verifier, tree and hasher as experiment 19's version 4 (Pool4.yul): one
// denomination, Tornado's height-20 MiMC tree through experiment 06's deployed hasher, and a Groth16
// proof of tornado.sh's circuit over root, nullifierHash, recipient, relayer, fee and refund. What
// changes is the contract around the verifier, after exp-frames experiment 30's RefundPool:
// - the proof is checked in the pool's own VERIFY frame, which approves execution and payment;
// - the nullifier hash is the transaction's one EIP-8250 nonce key, so the protocol refuses a second
//   spend and the pool keeps no nullifier mapping;
// - the relayer field is the pool itself, and the fee must cover the transaction's maximum cost;
// - a last frame refunds the recipient whatever of the fee the gas did not use;
// - the root is one this pool's own tree produced, read from its own storage.
//
// Layout VERIFY accepts, and nothing else:
//   [0] VERIFY  this pool, APPROVE_EXECUTION_AND_PAYMENT
//   [1] SENDER  this pool, withdraw(uint256[8],bytes32,bytes32,address,address,uint256,uint256),
//               with relayer = this pool, refund = 0 and fee >= max cost
//   [2] DEFAULT this pool, the refund: no data, no value, at least 25,000 gas
//
// Storage: 0 leaf count; 2 the current root; 0x100 + level the filled subtrees;
// keccak(root || 4) a known root; keccak(account || 6) what a recipient that refused ETH is owed.
// initcode = <this object> || verifier || hasher
object "PoolSelf" {
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
                switch frameparam(0x02, frame)
                case 1 { validate(frame) }   // VERIFY
                case 0 { refund(frame) }     // DEFAULT
                stop()
            }
            if iszero(calldatasize()) { stop() }
            switch shr(224, calldataload(0))
            case 0xb214faa5 { deposit(calldataload(4)) }        // deposit(bytes32)
            case 0xf2cdb14a { withdraw() }                      // withdraw(uint256[8],bytes32,bytes32,address,address,uint256,uint256)
            case 0x1e83409a { claim(calldataload(4)) }          // claim(address)
            case 0xebf0c717 { ret(sload(2)) }                   // root()
            case 0x30e69fc3 { ret(sload(0)) }                   // leafCount()
            default { revert(0, 0) }

            // ---- VERIFY ----

            function validate(me) {
                if iszero(eq(me, 0)) { revert(0, 0) }
                if iszero(eq(txparam(0x09), 3)) { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }
                if txparam(0x07) { revert(0, 0) }            // no blobs: max cost is gas only
                if txparam(0x0b) { revert(0, 0) }            // no signatures

                // [1] W: SENDER, to this pool, no value, no flags, a withdraw() of 0x1c4 bytes.
                let w := 1
                if iszero(eq(frameparam(0x02, w), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, w), address())) { revert(0, 0) }
                if frameparam(0x08, w) { revert(0, 0) }
                if frameparam(0x03, w) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, w), 0x1c4)) { revert(0, 0) }
                if iszero(eq(shr(224, framedataload(0, w)), 0xf2cdb14a)) { revert(0, 0) }

                // [2] the refund: DEFAULT, to this pool, no value, no data, enough gas to pay out.
                let r := 2
                if frameparam(0x02, r) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, r), address())) { revert(0, 0) }
                if frameparam(0x08, r) { revert(0, 0) }
                if frameparam(0x03, r) { revert(0, 0) }
                if frameparam(0x04, r) { revert(0, 0) }
                if lt(frameparam(0x01, r), 25000) { revert(0, 0) }

                let root := framedataload(0x104, w)
                let nullifierHash := framedataload(0x124, w)
                let recipient := framedataload(0x144, w)
                let relayer := framedataload(0x164, w)
                let fee := framedataload(0x184, w)
                if shr(160, recipient) { revert(0, 0) }
                if iszero(eq(relayer, address())) { revert(0, 0) }   // the pool is paid, nobody else
                if framedataload(0x1a4, w) { revert(0, 0) }          // Tornado's refund field: an ETH pool
                if gt(fee, DENOM()) { revert(0, 0) }
                if lt(fee, txparam(0x06)) { revert(0, 0) }           // the fee covers the worst case

                // W cannot be starved after approval: a failed W would burn the note.
                if lt(frameparam(0x01, w), 100000) { revert(0, 0) }
                if lt(frameparam(0x09, w), 183600) { revert(0, 0) }

                if iszero(sload(mapslot(root, 4))) { revert(0, 0) }  // a root this tree produced

                // The nullifier hash is the only nonce key, at sequence 0.
                if iszero(eq(txparam(0x0e), 1)) { revert(0, 0) }
                if iszero(eq(txparam(0x10), nullifierHash)) { revert(0, 0) }
                if txparam(0x01) { revert(0, 0) }

                // The proof's 8 words and its 6 inputs, in Tornado's order, as W carries them.
                framedatacopy(0x200, 0x04, 0x1c0, w)
                if iszero(staticcall(gas(), VERIFIER(), 0x200, 0x1c0, 0, 0x20)) { revert(0, 0) }
                if iszero(and(eq(returndatasize(), 0x20), eq(mload(0), 1))) { revert(0, 0) }
                approve(3)
            }

            // ---- SENDER: the withdrawal frame ----

            function withdraw() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let recipient := calldataload(0x144)
                let fee := calldataload(0x184)
                let amount := sub(DENOM(), fee)
                if amount {
                    if iszero(call(sub(gas(), 30000), recipient, amount, 0, 0, 0, 0)) { credit(recipient, amount) }
                }
                mstore(0, recipient)
                mstore(0x20, calldataload(0x124))
                mstore(0x40, address())
                mstore(0x60, fee)
                log1(0, 0x80, 0xe9e508bad6d4c3227e881ca19068f099da81b5164dd6d62b2eaf1e8bc6c34931) // Withdrawal(address to, bytes32 nullifierHash, address relayer, uint256 fee)
                stop()
            }

            // ---- DEFAULT: the refund, as RefundPool's ----

            function refund(me) {
                // Only in a transaction this pool approved: its sender is the pool, so VERIFY has
                // checked the layout, and this is frame 2 of 3.
                if iszero(eq(txparam(0x02), address())) { stop() }
                if iszero(eq(me, 2)) { stop() }
                if iszero(eq(frameparam(0x05, 1), 1)) { stop() }   // W did not pay out: nothing to refund

                let maxFee := txparam(0x04)
                let price := add(basefee(), txparam(0x03))
                if gt(price, maxFee) { price := maxFee }

                // intrinsic + every limit, then less what frames 0 and 1 left unused.
                let charged := div(txparam(0x06), maxFee)
                for { let j := 0 } lt(j, me) { j := add(j, 1) } {
                    charged := sub(charged, sub(
                        add(frameparam(0x01, j), frameparam(0x09, j)),
                        add(frameparam(0x0a, j), frameparam(0x0b, j))
                    ))
                }
                charged := mul(charged, price)

                let fee := framedataload(0x184, 1)
                if iszero(gt(fee, charged)) { stop() }
                let back := sub(fee, charged)
                let recipient := framedataload(0x144, 1)
                if iszero(call(gas(), recipient, back, 0, 0, 0, 0)) { stop() }
                mstore(0, back)
                mstore(0x20, charged)
                // FeeRefund(address indexed recipient, uint256 refunded, uint256 chargedAtMost)
                log2(0, 0x40, 0x32eb933bf48f87eb8469184574aaecf94ff754f8b092bb9d4b92d1fcddee9f1d, recipient)
            }

            function credit(who, amount) {
                let s := mapslot(who, 6)
                sstore(s, add(sload(s), amount))
            }

            function claim(who) {
                let s := mapslot(who, 6)
                let amount := sload(s)
                sstore(s, 0)
                if iszero(call(gas(), who, amount, 0, 0, 0, 0)) { revert(0, 0) }
                stop()
            }

            // ---- deposits and the tree, as Pool4.yul's ----

            function deposit(c) {
                if iszero(eq(callvalue(), DENOM())) { revert(0, 0) }
                if iszero(lt(c, FIELD())) { revert(0, 0) }
                let index := sload(0)
                if iszero(lt(index, shl(20, 1))) { revert(0, 0) }
                let node := c
                let i := index
                for { let level := 0 } lt(level, 20) { level := add(level, 1) } {
                    switch and(i, 1)
                    case 0 {
                        sstore(add(0x100, level), node)
                        node := hashLeftRight(node, zero(level))
                    }
                    default { node := hashLeftRight(sload(add(0x100, level)), node) }
                    i := shr(1, i)
                }
                sstore(2, node)
                sstore(mapslot(node, 4), 1)
                sstore(0, add(index, 1))
                mstore(0, c)
                mstore(0x20, index)
                log1(0, 0x40, 0x98e783c3864bbf744a057ef605a2a61701c3b62b5ed68b3745b99094497daf1f) // Deposit(bytes32 commitment, uint256 leafIndex)
                stop()
            }

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
            function DENOM() -> v { v := 1000000000000000 }
            function FIELD() -> f { f := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001 }
            function HASHER() -> v { v := word(32) }
            function VERIFIER() -> v { v := word(64) }
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
            function txparam(param) -> v { v := verbatim_1i_1o(hex"b0", param) }
            function frameparam(param, frame) -> v { v := verbatim_2i_1o(hex"b3", frame, param) }
            function framedataload(offset, frame) -> v { v := verbatim_2i_1o(hex"b1", offset, frame) }
            function framedatacopy(memOffset, dataOffset, length, frame) {
                verbatim_4i_0o(hex"b2", memOffset, dataOffset, length, frame)
            }
            function approve(scope) { verbatim_3i_0o(hex"aa", 0, 0, scope) }
        }
        // zeros(0) .. zeros(20) of Tornado's tree, as tornado-core hard-codes them; Pool4.yul's.
        data "zeros" hex"2fe54c60d3acabf3343a35b6eba15db4821b340f76e741e2249685ed4899af6c256a6135777eee2fd26f54b8b7037a25439d5235caee224154186d2b8a52e31d1151949895e82ab19924de92c40a3d6f7bcb60d92b00504b8199613683f0c20020121ee811489ff8d61f09fb89e313f14959a0f28bb428a20dba6b0b068b3bdb0a89ca6ffa14cc462cfedb842c30ed221a50a3d6bf022a6a57dc82ab24c157c924ca05c2b5cd42e890d6be94c68d0689f4f21c9cec9c0f13fe41d566dfb549591ccb97c932565a92c60156bdba2d08f3bf1377464e025cee765679e604a7315c19156fbd7d1a8bf5cba8909367de1b624534ebab4f0f79e003bccdd1b182bdb4261af8c1f0912e465744641409f622d466c3920ac6e5ff37e36604cb11dfff800058459724ff6ca5a1652fcbc3e82b93895cf08e975b19beab3f54c217d1c0071f04ef20dee48d39984d8eabe768a70eafa6310ad20849d4573c3c40c2ad1e301bea3dec5dab51567ce7e200a30f7ba6d4276aeaa53e2686f962a46c66d511e50ee0f941e2da4b9e31c3ca97a40d8fa9ce68d97c084177071b3cb46cd3372f0f1ca9503e8935884501bbaf20be14eb4c46b89772c97b96e3b2ebf3a36a948bbd133a80e30697cd55d8f7d4b0965b7be24057ba5dc3da898ee2187232446cb10813e6d8fc88839ed76e182c2a779af5b2c0da9dd18c90427a644f7e148a6253b61eb16b057a477f4bc8f572ea6bee39561098f78f15bfb3699dcbb7bd8db618540da2cb16a1ceaabf1c16b838f7a9e3f2a3a3088d9e0a6debaa748114620696ea24a3b3d822420b14b5d8cb6c28a574f01e98ea9e940551d2ebd75cee12649f9d198622acbd783d1b0d9064105b1fc8e4d8889de95c4c519b3f635809fe6afc0529d7ed391256ccc3ea596c86e933b89ff339d25ea8ddced975ae2fe30b5296d4"
    }
}
