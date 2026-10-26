// ExitVault: a committee holds users' notes, and a timeout the vault evaluates alone lets each
// owner redeem its own note with nobody's permission. Experiment 30's RefundPool (exp-frames),
// whose withdrawal frames it keeps byte for byte, with an intent queue, the committee's update,
// the openings it publishes, escape mode and reconciliation added.
//
// The vault is the sender of three kinds of frame transaction, told apart by their layout:
//
//   redemption (4 frames), RefundPool's layout exactly:
//     [0] VERIFY  0x8272, the recent-root tuple (source_id || slot || root)
//     [1] VERIFY  this vault, APPROVE_EXECUTION_AND_PAYMENT
//     [2] SENDER  this vault, withdraw(...) with relayer = this vault and fee >= max cost
//     [3] DEFAULT this vault, the refund: no data, no value, at least 25,000 of execution
//   The nullifier hash is the only nonce key, at sequence 0, 1 or 2, and spent[nh] must be unset.
//   VERIFY accepts it in escape mode, or in normal mode while the queue is not empty. A VERIFY
//   frame may not read the block number, so the timeout is checked in withdraw: in normal mode it
//   enters escape mode if the head has not moved for TIMEOUT blocks, and reverts otherwise. An
//   early redemption is mined, pays nothing, and uses one of its note's three sequences.
//
//   update (3 frames), the committee's:
//     [0] VERIFY  this vault, APPROVE_EXECUTION. Its data is
//                 proof (256) || root (32) || nullifierHash (32) || C (32) || openings (297)
//     [1] VERIFY  a payer other than this vault, APPROVE_PAYMENT
//     [2] SENDER  this vault, process: 0xdfefb7d7 || C (32) || openings (297), packed
//   It spends the note whose nullifier hash is its only nonce key, at sequence 0, into the new
//   note C, for the intent at the head of the queue. The proof is the withdrawal circuit's with
//   relayer, fee and refund zero and
//     recipient = uint160(keccak256(vault (32) || intent hash || C || keccak256(openings)))
//   so it is bound to the head intent, to C and to the openings it publishes.
//
//   reconcile (3 frames), the committee's, in escape mode only:
//     [0] VERIFY  this vault, APPROVE_EXECUTION. Its data is
//                 count (32) || every redeemed nullifier hash, ascending (32 each) || sigma (128)
//     [1] VERIFY  a payer other than this vault, APPROVE_PAYMENT
//     [2] SENDER  this vault, reconcile(): 0x8f0d7e35
//   The list must be every redemption so far: as many as the vault counted, strictly ascending,
//   each spent. sigma is the committee's threshold BLS signature (MinSig, Commonware's namespace
//   scheme, namespace X9_RECONCILE_V1) on
//     chain_id (32) || vault (32) || escapeAt (32) || keccak256(list) (32)
//   Its only nonce key is keccak256("X9_RECONCILE" || escapeAt), at any sequence. reconcile()
//   returns to normal mode only once escape mode has lasted ESCAPE_WINDOW blocks.
//
// Ordinary calls: deposit(bytes32) as RefundPool's; enqueue(bytes) with a 116-byte intent
// sealed to the committee; claim(address); republish(); and the views below.
//
// Storage: 0 next leaf, 2 last root, 3 packed: mode (bits 0-7, 0 normal, 1 escape), escapeAt
// (bits 8-71) and redemptions (bits 72-135), so a redemption writes at most two new slots;
// 4 head, 7 tail, 8 since, 0x100.. the tree's filled subtrees; maps by tag: 5 commitments seen,
// 6 owed, 7 intents, 8 spent, 9 known roots.
//
// initcode = <this object> || committee sealing key (33, then 31 zero bytes) || ESCAPE_WINDOW
//            || TIMEOUT || BLS group key (256, EIP-2537 G2) || verifier || hasher
//            || denomination || salt
object "ExitVault" {
    code {
        let size := datasize("runtime")
        datacopy(0, dataoffset("runtime"), size)
        codecopy(size, sub(codesize(), 512), 512)
        return(0, add(size, 512))
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

            switch shr(224, calldataload(0))
            case 0xb214faa5 { deposit(calldataload(4)) }      // deposit(bytes32)
            case 0x21a0adb6 { withdraw() }                    // withdraw(bytes,bytes32,bytes32,address,address,uint256,uint256)
            case 0xdfefb7d7 { process() }                     // process, packed (above)
            case 0x8f0d7e35 { reconcile() }                   // reconcile()
            case 0x84473fa8 { enqueue() }                     // enqueue(bytes)
            case 0x1e83409a { claim(calldataload(4)) }        // claim(address)
            case 0x8bb852fe { republish() }                   // republish()
            case 0xba70f757 { ret(sload(2)) }                 // getLastRoot()
            case 0xfc7e9c6f { ret(sload(0)) }                 // nextIndex()
            case 0xdf18e047 { ret(sload(mapslot(calldataload(4), 6))) } // owed(address)
            case 0xd069aab9 { ret(sourceId()) }               // sourceId()
            case 0x295a5212 { ret(modeOf()) }                 // mode()
            case 0x8f7dcfa3 { ret(sload(4)) }                 // head()
            case 0x13d8c840 { ret(sload(7)) }                 // tail()
            case 0x3dc54b40 { ret(sload(8)) }                 // since()
            case 0x1cde8331 { ret(escapeAtOf()) }             // escapeAt()
            case 0xae20bed3 { ret(sload(mapslot(calldataload(4), 8))) } // spent(bytes32)
            case 0xfe3c4713 { ret(sload(mapslot(calldataload(4), 9))) } // knownRoot(bytes32)
            case 0x9de7ab90 { ret(sload(mapslot(calldataload(4), 7))) } // intentAt(uint256)
            case 0xe231bff0 { ret(countOf()) }                // redeemed()
            case 0x9be76a90 {                                 // committeeKey(): bytes32, bytes1
                mstore(0, word(512))
                mstore(0x20, word(480))
                return(0, 0x40)
            }
            case 0x70dea79a { ret(timeout()) }                // timeout()
            case 0x3876c1e4 { ret(escapeWindow()) }           // escapeWindow()
            default { revert(0, 0) }

            // ---- VERIFY ----

            function validate(me) {
                if iszero(eq(txparam(0x02), address())) { revert(0, 0) }
                switch txparam(0x09)
                case 4 { validateRedemption(me) }
                case 3 {
                    if me { revert(0, 0) }
                    let s := shr(224, framedataload(0, 2))
                    switch s
                    case 0xdfefb7d7 { validateUpdate() }
                    case 0x8f0d7e35 { validateReconcile() }
                    default { revert(0, 0) }
                }
                default { revert(0, 0) }
            }

            // RefundPool's checks, with the mode, the spent set and three nonce sequences added.
            function validateRedemption(me) {
                if iszero(eq(me, 1)) { revert(0, 0) }
                if iszero(eq(frameparam(0x06, me), 3)) { revert(0, 0) }
                if txparam(0x07) { revert(0, 0) }            // no blobs: max cost is gas only
                if txparam(0x0b) { revert(0, 0) }            // no signatures

                // [2] W: SENDER, to this vault, no value, no flags, a canonical withdraw().
                let w := 2
                if iszero(eq(frameparam(0x02, w), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, w), address())) { revert(0, 0) }
                if frameparam(0x08, w) { revert(0, 0) }
                if frameparam(0x03, w) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, w), 516)) { revert(0, 0) }
                if iszero(eq(shr(224, framedataload(0, w)), 0x21a0adb6)) { revert(0, 0) }
                if iszero(eq(framedataload(0x04, w), 0xe0)) { revert(0, 0) }
                if iszero(eq(framedataload(0xe4, w), 0x100)) { revert(0, 0) }

                // [3] the refund: DEFAULT, to this vault, no value, no data, enough gas to pay out.
                let r := 3
                if frameparam(0x02, r) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, r), address())) { revert(0, 0) }
                if frameparam(0x08, r) { revert(0, 0) }
                if frameparam(0x03, r) { revert(0, 0) }
                if frameparam(0x04, r) { revert(0, 0) }
                if lt(frameparam(0x01, r), 25000) { revert(0, 0) }

                let root := framedataload(0x24, w)
                let nullifierHash := framedataload(0x44, w)
                let recipient := framedataload(0x64, w)
                let relayer := framedataload(0x84, w)
                let fee := framedataload(0xa4, w)
                if shr(160, recipient) { revert(0, 0) }
                if iszero(eq(relayer, address())) { revert(0, 0) }   // the vault is paid, nobody else
                if framedataload(0xc4, w) { revert(0, 0) }           // Tornado's refund field: ETH pool
                if gt(fee, word(64)) { revert(0, 0) }                // fee <= denomination
                if lt(fee, txparam(0x06)) { revert(0, 0) }           // and covers the worst case

                // W cannot be starved after approval.
                if lt(frameparam(0x01, w), 100000) { revert(0, 0) }
                if lt(frameparam(0x09, w), 183600) { revert(0, 0) }

                // [0] the EIP-8272 verifier frame; the protocol checks its tuple before this runs.
                if iszero(eq(frameparam(0x00, 0), 0x8272)) { revert(0, 0) }
                if iszero(eq(frameparam(0x02, 0), 1)) { revert(0, 0) }
                if frameparam(0x03, 0) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 0), 72)) { revert(0, 0) }
                if iszero(eq(framedataload(0, 0), sourceId())) { revert(0, 0) }
                if iszero(eq(framedataload(40, 0), root)) { revert(0, 0) }

                // The nullifier hash is the only nonce key, at sequence 0, 1 or 2, and unspent.
                if iszero(eq(txparam(0x0e), 1)) { revert(0, 0) }
                if iszero(eq(txparam(0x10), nullifierHash)) { revert(0, 0) }
                if gt(txparam(0x01), 2) { revert(0, 0) }
                if sload(mapslot(nullifierHash, 8)) { revert(0, 0) }

                // Escape mode, or normal mode with a queue that can stall.
                if iszero(modeOf()) {
                    if iszero(gt(sload(7), sload(4))) { revert(0, 0) }
                }

                framedatacopy(0x184, 0x104, 0x100, w)
                verifyProof(root, nullifierHash, recipient, relayer, fee)
                approve(3)
            }

            function validateUpdate() {
                if iszero(eq(frameparam(0x06, 0), 2)) { revert(0, 0) }
                if iszero(eq(calldatasize(), 649)) { revert(0, 0) }
                payerFrame()

                // [2] process: SENDER, to this vault, no value, no flags, the same C and openings.
                if iszero(eq(frameparam(0x02, 2), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, 2), address())) { revert(0, 0) }
                if frameparam(0x08, 2) { revert(0, 0) }
                if frameparam(0x03, 2) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 2), 333)) { revert(0, 0) }
                let c := calldataload(320)
                if iszero(lt(c, FIELD())) { revert(0, 0) }
                if iszero(eq(framedataload(4, 2), c)) { revert(0, 0) }
                calldatacopy(0x600, 352, 297)
                let openingsHash := keccak256(0x600, 297)
                framedatacopy(0x800, 36, 297, 2)
                if iszero(eq(keccak256(0x800, 297), openingsHash)) { revert(0, 0) }

                // Normal mode, an intent at the head, a root this vault made, an unspent note.
                if modeOf() { revert(0, 0) }
                let head := sload(4)
                if iszero(gt(sload(7), head)) { revert(0, 0) }
                let intent := sload(mapslot(head, 7))
                let root := calldataload(256)
                let nullifierHash := calldataload(288)
                if iszero(sload(mapslot(root, 9))) { revert(0, 0) }
                if sload(mapslot(nullifierHash, 8)) { revert(0, 0) }

                // The note is spent once: its nullifier hash is the only nonce key, at sequence 0.
                if iszero(eq(txparam(0x0e), 1)) { revert(0, 0) }
                if iszero(eq(txparam(0x10), nullifierHash)) { revert(0, 0) }
                if txparam(0x01) { revert(0, 0) }

                mstore(0, address())
                mstore(0x20, intent)
                mstore(0x40, c)
                mstore(0x60, openingsHash)
                let recipient := and(keccak256(0, 0x80), 0xffffffffffffffffffffffffffffffffffffffff)
                calldatacopy(0x184, 0, 256)
                verifyProof(root, nullifierHash, recipient, 0, 0)
                approve(2)
            }

            function validateReconcile() {
                if iszero(eq(frameparam(0x06, 0), 2)) { revert(0, 0) }
                payerFrame()
                if iszero(eq(frameparam(0x02, 2), 2)) { revert(0, 0) }
                if iszero(eq(frameparam(0x00, 2), address())) { revert(0, 0) }
                if frameparam(0x08, 2) { revert(0, 0) }
                if frameparam(0x03, 2) { revert(0, 0) }
                if iszero(eq(frameparam(0x04, 2), 4)) { revert(0, 0) }

                if iszero(eq(modeOf(), 1)) { revert(0, 0) }
                let escapeAt := escapeAtOf()
                let count := calldataload(0)
                if iszero(eq(count, countOf())) { revert(0, 0) }
                if iszero(eq(calldatasize(), add(add(32, shl(5, count)), 128))) { revert(0, 0) }
                // Every redemption: as many as counted, distinct (strictly ascending), each spent.
                let prev := 0
                for { let i := 0 } lt(i, count) { i := add(i, 1) } {
                    let nh := calldataload(add(32, shl(5, i)))
                    if iszero(gt(nh, prev)) { revert(0, 0) }
                    if iszero(sload(mapslot(nh, 8))) { revert(0, 0) }
                    prev := nh
                }
                calldatacopy(0x1000, 32, shl(5, count))
                let digest := keccak256(0x1000, shl(5, count))

                // Its nonce key names the escape. Any sequence: an attempt mined before the escape
                // window ends reverts in reconcile() and must not lock the committee out.
                if iszero(eq(txparam(0x0e), 1)) { revert(0, 0) }
                mstore(0, 0x58395f5245434f4e43494c450000000000000000000000000000000000000000)
                mstore(12, escapeAt)
                if iszero(eq(txparam(0x10), keccak256(0, 44))) { revert(0, 0) }

                checkGroupSignature(escapeAt, digest, add(32, shl(5, count)))
                approve(2)
            }

            // [1] a payer's VERIFY, for payment only, not this vault.
            function payerFrame() {
                if iszero(eq(frameparam(0x02, 1), 1)) { revert(0, 0) }
                if iszero(eq(frameparam(0x06, 1), 1)) { revert(0, 0) }
                if eq(frameparam(0x00, 1), address()) { revert(0, 0) }
            }

            // verifyProof(bytes proof, uint256[6] input), the proof's 256 bytes already at 0x184.
            function verifyProof(root, nullifierHash, recipient, relayer, fee) {
                let verifier := word(128)
                let p := 0x80
                mstore(p, shl(224, 0x695ef6f9))
                mstore(add(p, 0x04), 0xe0)
                mstore(add(p, 0x24), root)
                mstore(add(p, 0x44), nullifierHash)
                mstore(add(p, 0x64), recipient)
                mstore(add(p, 0x84), relayer)
                mstore(add(p, 0xa4), fee)
                mstore(add(p, 0xc4), 0)
                mstore(add(p, 0xe4), 0x100)
                if iszero(staticcall(gas(), verifier, p, 0x204, 0, 0x20)) { revert(0, 0) }
                if iszero(and(eq(returndatasize(), 0x20), eq(mload(0), 1))) { revert(0, 0) }
            }

            // e(sigma, -g2) e(H(m), PK) = 1, with H = hash_to_curve(union_unique(NAMESPACE, m)) in
            // G1 as Commonware's MinSig hashes it (experiment 10's check), and
            // m = chain_id || vault || escapeAt || digest. sigma is at calldata offset `at`.
            function checkGroupSignature(escapeAt, digest, at) {
                calldatacopy(0x200, calldatasize(), 64)                 // Z_pad: zeros
                mstore(0x240, shl(248, 15))                             // varint(len(NAMESPACE))
                mstore(0x241, 0x58395f5245434f4e43494c455f56310000000000000000000000000000000000)
                mstore(0x250, chainid())
                mstore(0x270, address())
                mstore(0x290, escapeAt)
                mstore(0x2b0, digest)
                mstore(0x2d0, shl(240, 0x0080))                         // len_in_bytes = 128
                mstore8(0x2d2, 0)
                mstore(0x2d3, DST1())
                mstore(0x2f3, DST2())
                sha256(0x200, 0xff, 0x100)                              // b_0
                let b0 := mload(0x100)
                mstore(0x161, DST1())
                mstore(0x181, DST2())
                let prev := 0
                for { let i := 1 } lt(i, 5) { i := add(i, 1) } {
                    mstore(0x140, xor(b0, prev))
                    mstore8(0x160, i)
                    let out := add(0x400, shl(5, sub(i, 1)))
                    sha256(0x140, 77, out)
                    prev := mload(out)
                }
                toField(0x400, 0x600)
                toField(0x440, 0x640)
                if iszero(staticcall(gas(), 0x10, 0x600, 64, 0x700, 128)) { revert(0, 0) }
                if iszero(staticcall(gas(), 0x10, 0x640, 64, 0x780, 128)) { revert(0, 0) }
                if iszero(staticcall(gas(), 0x0b, 0x700, 256, 0xa80, 128)) { revert(0, 0) }   // H

                calldatacopy(0x900, at, 128)                            // sigma
                datacopy(0x980, dataoffset("negG2"), 256)
                codecopy(0xb00, sub(codesize(), 384), 256)              // the group key
                if iszero(staticcall(gas(), 0x0f, 0x900, 0x300, 0x00, 0x20)) { revert(0, 0) }
                if iszero(eq(mload(0x00), 1)) { revert(0, 0) }
            }

            function sha256(from, len, to) {
                if iszero(staticcall(gas(), 0x02, from, len, to, 32)) { revert(0, 0) }
            }

            function toField(from, to) {
                mstore(0x500, 64)
                mstore(0x520, 1)
                mstore(0x540, 48)
                mstore(0x560, mload(from))
                mstore(0x580, mload(add(from, 32)))
                mstore8(0x5a0, 1)
                mstore(0x5a1, P1())
                mstore(0x5c1, P2())
                mstore(to, 0)
                if iszero(staticcall(gas(), 0x05, 0x500, 209, add(to, 16), 48)) { revert(0, 0) }
            }

            // ---- SENDER ----

            // The redemption's payout, after the timeout. Redeemed(bytes32 nullifierHash, uint256 count)
            function withdraw() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                let mode := modeOf()
                let escapeAt := escapeAtOf()
                if iszero(mode) {
                    // Normal mode: the head must have stood still for TIMEOUT blocks.
                    if iszero(gt(sload(7), sload(4))) { revert(0, 0) }
                    if lt(number(), add(sload(8), timeout())) { revert(0, 0) }
                    mode := 1
                    escapeAt := number()
                    mstore(0, sload(8))
                    mstore(0x20, number())
                    // Escape(uint256 since, uint256 at)
                    log1(0, 0x40, 0x92d79a61fe619b024b5d244cac3622b69ab51cb99c5ebdf37068768b22192fcb)
                }
                let nullifierHash := calldataload(0x44)
                let s := mapslot(nullifierHash, 8)
                if sload(s) { revert(0, 0) }
                sstore(s, 1)
                let count := add(countOf(), 1)
                setPacked(mode, escapeAt, count)
                mstore(0, nullifierHash)
                mstore(0x20, count)
                log1(0, 0x40, 0x11673c127f647a39cbf39134f14445ebf13558f7ec53c37294dabb256868c48a)

                let recipient := calldataload(0x64)
                let fee := calldataload(0xa4)
                let amount := sub(word(64), fee)
                if amount {
                    if iszero(call(sub(gas(), 30000), recipient, amount, 0, 0, 0, 0)) { credit(recipient, amount) }
                }
                mstore(0, recipient)
                mstore(0x20, nullifierHash)
                mstore(0x40, fee)
                log2(0, 0x60, 0xe9e508bad6d4c3227e881ca19068f099da81b5164dd6d62b2eaf1e8bc6c34931, address())
                stop()
            }

            // The update's effect: the new note into the tree, its openings published, the head
            // moved on. Opening(uint256 updateNumber, bytes openings), updateNumber the intent's index.
            function process() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                if iszero(eq(calldatasize(), 333)) { revert(0, 0) }
                if modeOf() { revert(0, 0) }
                let head := sload(4)
                if iszero(gt(sload(7), head)) { revert(0, 0) }
                insert(calldataload(4))
                mstore(0x100, head)
                mstore(0x120, 0x40)
                mstore(0x140, 297)
                calldatacopy(0x160, 36, 297)
                mstore(add(0x160, 297), 0)
                log1(0x100, add(0x60, 320), 0x72f73349d6f752014ce9d1c777432e0028288a3c56201abfc015b655a3aefc34)
                sstore(4, add(head, 1))
                sstore(8, number())
                stop()
            }

            // Back to normal mode, once escape has lasted ESCAPE_WINDOW blocks.
            // Reconciled(uint256 count, uint256 at)
            function reconcile() {
                if iszero(eq(caller(), address())) { revert(0, 0) }
                if iszero(eq(modeOf(), 1)) { revert(0, 0) }
                if lt(number(), add(escapeAtOf(), escapeWindow())) { revert(0, 0) }
                setPacked(0, escapeAtOf(), countOf())
                sstore(8, number())
                mstore(0, countOf())
                mstore(0x20, number())
                log1(0, 0x40, 0x0edd08e4305bd5ef9897d9d73c38c0f7408344921f6a78211d15e3183b7c9d0f)
                stop()
            }

            // ---- DEFAULT: the refund, as RefundPool's ----

            function refund(me) {
                if iszero(eq(txparam(0x02), address())) { stop() }
                if iszero(eq(txparam(0x09), 4)) { stop() }
                if iszero(eq(me, 3)) { stop() }
                if iszero(eq(frameparam(0x05, 2), 1)) { stop() }   // W did not pay out: nothing to refund

                let maxFee := txparam(0x04)
                let price := add(basefee(), txparam(0x03))
                if gt(price, maxFee) { price := maxFee }

                let charged := div(txparam(0x06), maxFee)
                for { let j := 0 } lt(j, me) { j := add(j, 1) } {
                    charged := sub(charged, sub(
                        add(frameparam(0x01, j), frameparam(0x09, j)),
                        add(frameparam(0x0a, j), frameparam(0x0b, j))
                    ))
                }
                charged := mul(charged, price)

                let fee := framedataload(0xa4, 2)
                if iszero(gt(fee, charged)) { stop() }
                let back := sub(fee, charged)
                let recipient := framedataload(0x64, 2)
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

            // ---- the queue ----

            // enqueue(bytes sealed): an intent sealed to the committee, 116 bytes.
            // Intent(uint256 index, bytes sealed)
            function enqueue() {
                if callvalue() { revert(0, 0) }
                if iszero(eq(calldataload(4), 0x20)) { revert(0, 0) }
                if iszero(eq(calldataload(36), 116)) { revert(0, 0) }
                if iszero(eq(calldatasize(), 196)) { revert(0, 0) }
                calldatacopy(0x160, 68, 128)
                let h := keccak256(0x160, 116)
                let head := sload(4)
                let tail := sload(7)
                sstore(mapslot(tail, 7), h)
                if eq(tail, head) { sstore(8, number()) }
                sstore(7, add(tail, 1))
                mstore(0x100, tail)
                mstore(0x120, 0x40)
                mstore(0x140, 116)
                mstore(add(0x160, 116), 0)
                log1(0x100, 0xe0, 0x903d4bf4fba0e73fd481f24eb864f1a3c1d845d01621067c9284ed74dd1118df)
                stop()
            }

            // ---- deposits and the tree, as RefundPool's ----

            function deposit(commitment) {
                if iszero(eq(callvalue(), word(64))) { revert(0, 0) }
                insert(commitment)
                stop()
            }

            function insert(commitment) {
                if iszero(lt(commitment, FIELD())) { revert(0, 0) }
                let seen := mapslot(commitment, 5)
                if sload(seen) { revert(0, 0) }
                sstore(seen, 1)

                let index := sload(0)
                if iszero(lt(index, shl(20, 1))) { revert(0, 0) }
                let hasher := word(96)
                let node := commitment
                let i := index
                for { let level := 0 } lt(level, 20) { level := add(level, 1) } {
                    switch and(i, 1)
                    case 0 {
                        sstore(add(0x100, level), node)
                        node := hashLeftRight(hasher, node, zero(level))
                    }
                    default {
                        node := hashLeftRight(hasher, sload(add(0x100, level)), node)
                    }
                    i := shr(1, i)
                }
                sstore(0, add(index, 1))
                sstore(2, node)
                sstore(mapslot(node, 9), 1)
                recordRoot(node)

                mstore(0, index)
                mstore(0x20, timestamp())
                log2(0, 0x40, 0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196, commitment)
            }

            function hashLeftRight(hasher, left, right) -> r {
                mstore(0, shl(224, 0xf47d33b5))   // MiMCSponge(uint256,uint256)
                mstore(0x04, left)
                mstore(0x24, 0)
                if iszero(staticcall(gas(), hasher, 0, 0x44, 0, 0x40)) { revert(0, 0) }
                let c := mload(0x20)
                let x := addmod(mload(0), right, FIELD())
                mstore(0, shl(224, 0xf47d33b5))
                mstore(0x04, x)
                mstore(0x24, c)
                if iszero(staticcall(gas(), hasher, 0, 0x44, 0, 0x40)) { revert(0, 0) }
                r := mload(0)
            }

            // EIP-8272 write: calldata salt || root, source_id = keccak256(vault || salt).
            function recordRoot(root) {
                mstore(0, word(32))
                mstore(0x20, root)
                if iszero(call(gas(), 0x8272, 0, 0, 0x40, 0, 0)) { revert(0, 0) }
                mstore(0, root)
                mstore(0x20, slotnum())
                log1(0, 0x40, 0x2fd31368794d8179a2869e743a7fb1d8819c4b52d4154ba95ddbba7cf39a8552)
            }

            function republish() {
                let root := sload(2)
                if iszero(root) { revert(0, 0) }
                recordRoot(root)
                stop()
            }

            function sourceId() -> id {
                mstore(0, address())
                mstore(0x20, word(32))
                id := keccak256(12, 52)
            }

            // ---- helpers ----

            function FIELD() -> f { f := 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001 }
            function DST1() -> v { v := 0x424c535f5349475f424c53313233383147315f584d443a5348412d3235365f53 }
            function DST2() -> v { v := 0x5357555f524f5f504f505f2b0000000000000000000000000000000000000000 }
            function P1() -> v { v := 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f624 }
            function P2() -> v { v := 0x1eabfffeb153ffffb9feffffffffaaab00000000000000000000000000000000 }

            function zero(level) -> z {
                datacopy(0x60, add(dataoffset("zeros"), shl(5, level)), 32)
                z := mload(0x60)
            }

            // A constructor word, counted from the end of the code: salt 32, denomination 64,
            // hasher 96, verifier 128, the group key 384..129, TIMEOUT 416, ESCAPE_WINDOW 448,
            // the sealing key 512..449. Uses scratch at 0x60.
            function word(fromEnd) -> v {
                codecopy(0x60, sub(codesize(), fromEnd), 32)
                v := mload(0x60)
            }
            function timeout() -> v { v := word(416) }
            function modeOf() -> v { v := and(sload(3), 0xff) }
            function escapeAtOf() -> v { v := and(shr(8, sload(3)), 0xffffffffffffffff) }
            function countOf() -> v { v := shr(72, sload(3)) }
            function setPacked(mode, escapeAt, count) {
                sstore(3, or(or(mode, shl(8, escapeAt)), shl(72, count)))
            }
            function escapeWindow() -> v { v := word(448) }

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
            function slotnum() -> v { v := verbatim_0i_1o(hex"4b") }
        }
        data "negG2" hex"00000000000000000000000000000000024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80000000000000000000000000000000013e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e000000000000000000000000000000000d1b3cc2c7027888be51d9ef691d77bcb679afda66c73f17f9ee3837a55024f78c71363275a75d75d86bab79f74782aa0000000000000000000000000000000013fa4d4a0ad8b1ce186ed5061789213d993923066dddaf1040bc3ff59f825c78df74f2d75467e25e0f55f8a00fa030ed"
        // zeros(0) .. zeros(20) of Tornado's tree, as tornado-core hard-codes them.
        data "zeros" hex"2fe54c60d3acabf3343a35b6eba15db4821b340f76e741e2249685ed4899af6c256a6135777eee2fd26f54b8b7037a25439d5235caee224154186d2b8a52e31d1151949895e82ab19924de92c40a3d6f7bcb60d92b00504b8199613683f0c20020121ee811489ff8d61f09fb89e313f14959a0f28bb428a20dba6b0b068b3bdb0a89ca6ffa14cc462cfedb842c30ed221a50a3d6bf022a6a57dc82ab24c157c924ca05c2b5cd42e890d6be94c68d0689f4f21c9cec9c0f13fe41d566dfb549591ccb97c932565a92c60156bdba2d08f3bf1377464e025cee765679e604a7315c19156fbd7d1a8bf5cba8909367de1b624534ebab4f0f79e003bccdd1b182bdb4261af8c1f0912e465744641409f622d466c3920ac6e5ff37e36604cb11dfff800058459724ff6ca5a1652fcbc3e82b93895cf08e975b19beab3f54c217d1c0071f04ef20dee48d39984d8eabe768a70eafa6310ad20849d4573c3c40c2ad1e301bea3dec5dab51567ce7e200a30f7ba6d4276aeaa53e2686f962a46c66d511e50ee0f941e2da4b9e31c3ca97a40d8fa9ce68d97c084177071b3cb46cd3372f0f1ca9503e8935884501bbaf20be14eb4c46b89772c97b96e3b2ebf3a36a948bbd133a80e30697cd55d8f7d4b0965b7be24057ba5dc3da898ee2187232446cb10813e6d8fc88839ed76e182c2a779af5b2c0da9dd18c90427a644f7e148a6253b61eb16b057a477f4bc8f572ea6bee39561098f78f15bfb3699dcbb7bd8db618540da2cb16a1ceaabf1c16b838f7a9e3f2a3a3088d9e0a6debaa748114620696ea24a3b3d822420b14b5d8cb6c28a574f01e98ea9e940551d2ebd75cee12649f9d198622acbd783d1b0d9064105b1fc8e4d8889de95c4c519b3f635809fe6afc0529d7ed391256ccc3ea596c86e933b89ff339d25ea8ddced975ae2fe30b5296d4"
    }
}
